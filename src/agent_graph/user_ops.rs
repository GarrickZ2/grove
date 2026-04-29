//! User-facing graph operations (REST API layer).
//!
//! These functions wrap the low-level storage/ACP calls with validation,
//! error mapping, and side-effects (broadcast, duty lock) needed by the
//! HTTP handlers. They are the "service layer" between the thin Axum
//! handlers and the raw DB/ACP primitives.

use crate::acp::{self, AcpStartConfig, AcpUpdate, QueuedMessage};
use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
use crate::storage::{agent_graph as graph_db, database, tasks, workspace};
use chrono::Utc;
use std::time::Duration;

use super::tools::ACP_SESSION_READY_TIMEOUT;

pub struct SpawnResult {
    pub chat_id: String,
    pub name: String,
    pub duty: Option<String>,
    pub agent: String,
}

pub async fn user_spawn_node(
    project_key: &str,
    task_id: &str,
    from_chat_id: Option<&str>,
    agent: &str,
    name: &str,
    duty: Option<&str>,
    purpose: Option<&str>,
) -> Result<SpawnResult, String> {
    // 1. Name uniqueness
    let chats = tasks::load_chat_sessions(project_key, task_id)
        .map_err(|e| format!("load_sessions: {}", e))?;
    if chats.iter().any(|c| c.title == name) {
        return Err("name_taken".into());
    }

    // 2. Resolve agent — Custom Agent (persona) ids resolve to their
    //    underlying base_agent here; the persona's system_prompt is then
    //    injected once on the **create** session path inside ACP bootstrap.
    let (effective_agent, persona_injection) =
        match crate::storage::custom_agent::try_get_persona(agent) {
            Ok(Some(persona)) => {
                let injection = Some(acp::PersonaInjection {
                    persona_id: persona.id.clone(),
                    persona_name: persona.name.clone(),
                    base_agent: persona.base_agent.clone(),
                    system_prompt: persona.system_prompt.clone(),
                    model: persona.model.clone(),
                    mode: persona.mode.clone(),
                    effort: persona.effort.clone(),
                });
                (persona.base_agent.clone(), injection)
            }
            _ => (agent.to_string(), None),
        };
    let resolved =
        acp::resolve_agent(&effective_agent).ok_or_else(|| "agent_spawn_failed".to_string())?;

    // 3. Create chat — store the original agent string (persona id when applicable)
    //    so resume / icon / label resolution can find the persona later.
    let new_chat_id = tasks::generate_chat_id();
    let new_chat = tasks::ChatSession {
        id: new_chat_id.clone(),
        title: name.to_string(),
        agent: agent.to_string(),
        acp_session_id: None,
        created_at: Utc::now(),
        duty: None,
    };
    tasks::add_chat_session(project_key, task_id, new_chat)
        .map_err(|e| format!("add_session: {}", e))?;

    // 4. Optional edge
    if let Some(from_id) = from_chat_id {
        let conn = database::connection();
        if let Err(e) =
            graph_db::add_edge(&conn, project_key, task_id, from_id, &new_chat_id, purpose)
        {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err(format!("add_edge: {}", e));
        }
    }

    // 5. Build ACP launch config. Rollback the chat (and its auto-edge) if
    //    project / task lookup fails — at this point the chat row exists in
    //    the DB but no ChatListChanged has fired yet, so the UI would never
    //    see it on a normal session and we'd leave orphan rows behind.
    let project = match workspace::load_project_by_hash(project_key) {
        Ok(Some(p)) => p,
        Ok(None) => {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err("project_not_found".to_string());
        }
        Err(e) => {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err(format!("load_project: {}", e));
        }
    };
    let task = match tasks::get_task(project_key, task_id) {
        Ok(Some(t)) => t,
        Ok(None) => {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err("task_not_found".to_string());
        }
        Err(e) => {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err(format!("get_task: {}", e));
        }
    };

    let env_vars = crate::api::handlers::acp::build_grove_env(
        project_key,
        &project.path,
        &project.name,
        &task,
    );
    let session_key = format!("{}:{}:{}", project_key, task_id, new_chat_id);
    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_name: resolved.agent_name,
        agent_args: resolved.args,
        working_dir: std::path::PathBuf::from(&task.worktree_path),
        env_vars,
        project_key: project_key.to_string(),
        task_id: task_id.to_string(),
        chat_id: Some(new_chat_id.clone()),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
        suppress_initial_connecting: true,
        persona_injection,
    };

    // 6. Set duty BEFORE the broadcast so the new chat row is fully formed
    //    when consumers refetch in response to ChatListChanged. Rollback the
    //    chat (and its auto-edge) on failure so we don't leave orphan rows
    //    invisible to the UI (no ChatListChanged would have fired yet).
    if let Some(d) = duty {
        if let Err(e) = tasks::update_chat_duty(
            project_key,
            task_id,
            &new_chat_id,
            Some(d.to_string()),
            true, // 用户路径，允许覆盖
        ) {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err(format!("update_duty: {}", e));
        }
    }

    // 7. Broadcast topology change + initial connecting status immediately —
    //    frontend graph picks up the new node before ACP has even started, so
    //    the user sees the node in "connecting" the moment they hit Create
    //    (no flicker through "disconnected" while waiting for the ACP thread
    //    to register the handle and emit its own ChatStatus).
    broadcast_radio_event(RadioEvent::ChatListChanged {
        project_id: project_key.to_string(),
        task_id: task_id.to_string(),
    });
    broadcast_radio_event(RadioEvent::ChatStatus {
        project_id: project_key.to_string(),
        task_id: task_id.to_string(),
        chat_id: new_chat_id.clone(),
        status: "connecting".to_string(),
        permission: None,
    });

    // 8. Fire-and-forget ACP spawn. The session's lifecycle (connecting →
    //    idle / disconnected) reaches the UI through `RadioEvent::ChatStatus`
    //    pushed from acp/mod.rs at session registration and SessionReady, so
    //    no one else has to wait on us. Log failures — the node will sit at
    //    "disconnected" until the user retries by opening the chat.
    let project_key_clone = project_key.to_string();
    let task_id_clone = task_id.to_string();
    let new_chat_id_clone = new_chat_id.clone();
    tokio::spawn(async move {
        // H2: 任何启动失败 / SessionReady 等不到都广播一次 disconnected，
        // 让前端图上能看到死节点而不是停在 "connecting"。
        let broadcast_disconnected = |msg: &str| {
            eprintln!(
                "[user_spawn_node] (project={} task={} chat={}): {}",
                project_key_clone, task_id_clone, new_chat_id_clone, msg
            );
            broadcast_radio_event(RadioEvent::ChatStatus {
                project_id: project_key_clone.clone(),
                task_id: task_id_clone.clone(),
                chat_id: new_chat_id_clone.clone(),
                status: "disconnected".to_string(),
                permission: None,
            });
        };

        let (_handle, mut rx) = match acp::get_or_start_session(session_key, config).await {
            Ok(t) => t,
            Err(e) => {
                broadcast_disconnected(&format!("start_session failed: {}", e));
                return;
            }
        };
        let wait = tokio::time::timeout(ACP_SESSION_READY_TIMEOUT, async {
            loop {
                match rx.recv().await {
                    Ok(AcpUpdate::SessionReady { .. }) => return Ok::<_, String>(()),
                    Ok(AcpUpdate::Error { message }) => {
                        return Err(format!("acp_error: {}", message))
                    }
                    Ok(AcpUpdate::SessionEnded) => return Err("session_ended".to_string()),
                    Err(_) => return Err("session_terminated".to_string()),
                    Ok(_) => continue,
                }
            }
        })
        .await;
        match wait {
            Ok(Ok(())) => {}
            Ok(Err(m)) => broadcast_disconnected(&format!("session never ready: {}", m)),
            Err(_) => broadcast_disconnected("timeout waiting for SessionReady"),
        }
    });

    Ok(SpawnResult {
        chat_id: new_chat_id,
        name: name.to_string(),
        duty: duty.map(|s| s.to_string()),
        agent: agent.to_string(),
    })
}

pub fn user_add_edge(
    project_key: &str,
    task_id: &str,
    from_session: &str,
    to_session: &str,
    purpose: Option<&str>,
) -> Result<i64, String> {
    let conn = database::connection();
    graph_db::add_edge(
        &conn,
        project_key,
        task_id,
        from_session,
        to_session,
        purpose,
    )
    .map_err(|e| match e.storage_tag() {
        Some("cycle_would_form") => "cycle_would_form".to_string(),
        Some("bidirectional_edge") => "bidirectional_edge".to_string(),
        Some("duplicate_edge") => "duplicate_edge".to_string(),
        Some("same_task_required") => "same_task_required".to_string(),
        Some("endpoint_not_found") => "target_not_found".to_string(),
        _ => format!("internal_error: {}", e),
    })
}

pub async fn user_send_message(
    project_key: &str,
    task_id: &str,
    target_chat_id: &str,
    text: &str,
) -> Result<(), String> {
    // Reuse the MCP path's spawn-on-demand: if the target's ACP isn't
    // running, start it synchronously and wait for SessionReady. Without
    // this, user-side direct send would fail on disconnected nodes that
    // an AI peer could still talk to via grove_agent_send — confusing.
    let handle =
        crate::agent_graph::tools::ensure_target_handle(project_key, task_id, target_chat_id)
            .await
            .map_err(|e| e.code().to_string())?;

    // CAS-claim is_busy to close the race with concurrent dispatchers.
    let claimed = handle
        .is_busy
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok();
    if !claimed {
        let messages = handle.queue_message(QueuedMessage {
            text: text.to_string(),
            attachments: Vec::new(),
            sender: Some("user".to_string()),
        });
        handle.emit(AcpUpdate::QueueUpdate { messages });
        return Ok(());
    }

    let res = tokio::time::timeout(
        Duration::from_secs(10),
        handle.send_prompt(
            text.to_string(),
            Vec::new(),
            Some("user".to_string()),
            false,
        ),
    )
    .await;
    match res {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            handle
                .is_busy
                .store(false, std::sync::atomic::Ordering::Release);
            Err(format!("send_prompt: {}", e))
        }
        Err(_) => {
            handle
                .is_busy
                .store(false, std::sync::atomic::Ordering::Release);
            Err("timeout".to_string())
        }
    }
}

pub async fn user_remind(project_key: &str, task_id: &str, edge_id: i64) -> Result<(), String> {
    let (from_session, to_session, msg_id) = {
        let conn = database::connection();
        let edge = graph_db::get_edge(&conn, edge_id)
            .map_err(|e| format!("get_edge: {}", e))?
            .ok_or_else(|| "target_not_found".to_string())?;

        let pending = graph_db::list_pending_for_task(&conn, project_key, task_id)
            .map_err(|e| format!("list_pending: {}", e))?
            .into_iter()
            .find(|p| p.from_session == edge.from_session && p.to_session == edge.to_session)
            .ok_or_else(|| "no_pending_to_remind".to_string())?;

        (edge.from_session, edge.to_session, pending.msg_id)
    };

    let sender_chat = tasks::load_chat_sessions(project_key, task_id)
        .ok()
        .and_then(|chats| chats.into_iter().find(|c| c.id == from_session))
        .ok_or_else(|| "sender_not_found".to_string())?;

    // M11: 用 grove-meta envelope 包 reminder，目标 agent 能区分 reminder vs 新 user 请求。
    let injected = crate::agent_graph::inject::build_injected_prompt(
        &sender_chat.id,
        &sender_chat.title,
        &sender_chat.agent,
        crate::agent_graph::inject::InjectKind::Remind,
        "", // body 空，全部信息由 system-prompt 承载
        Some(&msg_id),
    );

    // 直接送达（包括 spawn-on-demand + busy 判定 + CAS 并发保护）
    crate::agent_graph::tools::deliver_user_remind(project_key, task_id, &to_session, injected)
        .await
}
