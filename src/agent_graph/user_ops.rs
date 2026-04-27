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

    // 2. Resolve agent
    let resolved = acp::resolve_agent(agent).ok_or_else(|| "agent_spawn_failed".to_string())?;

    // 3. Create chat
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
        if let Err(e) = graph_db::add_edge(&conn, task_id, from_id, &new_chat_id, purpose) {
            let _ = tasks::delete_chat_session(project_key, task_id, &new_chat_id);
            return Err(format!("add_edge: {}", e));
        }
    }

    // 5. Start ACP
    let project = workspace::load_project_by_hash(project_key)
        .map_err(|e| format!("load_project: {}", e))?
        .ok_or_else(|| "project_not_found".to_string())?;
    let task = tasks::get_task(project_key, task_id)
        .map_err(|e| format!("get_task: {}", e))?
        .ok_or_else(|| "task_not_found".to_string())?;

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
    };

    let (_handle, mut rx) = acp::get_or_start_session(session_key, config)
        .await
        .map_err(|e| format!("start_session: {}", e))?;

    let ready = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            match rx.recv().await {
                Ok(AcpUpdate::SessionReady { .. }) => return Ok::<_, String>(()),
                Ok(AcpUpdate::Error { message }) => return Err(format!("acp_error: {}", message)),
                Ok(AcpUpdate::SessionEnded) => return Err("session_ended".to_string()),
                Err(_) => return Err("session_terminated".to_string()),
                Ok(_) => continue,
            }
        }
    })
    .await;
    ready.map_err(|_| "timeout".to_string())??;

    // 6. Set duty
    if let Some(d) = duty {
        tasks::update_chat_duty(project_key, task_id, &new_chat_id, Some(d.to_string()))
            .map_err(|e| format!("update_duty: {}", e))?;
    }

    // 7. Broadcast
    broadcast_radio_event(RadioEvent::ChatListChanged {
        project_id: project_key.to_string(),
        task_id: task_id.to_string(),
    });

    Ok(SpawnResult {
        chat_id: new_chat_id,
        name: name.to_string(),
        duty: duty.map(|s| s.to_string()),
        agent: agent.to_string(),
    })
}

pub fn user_add_edge(
    task_id: &str,
    from_session: &str,
    to_session: &str,
    purpose: Option<&str>,
) -> Result<i64, String> {
    let conn = database::connection();
    graph_db::add_edge(&conn, task_id, from_session, to_session, purpose).map_err(|e| {
        let s = e.to_string();
        if s.contains("cycle_would_form") {
            "cycle_would_form".to_string()
        } else if s.contains("bidirectional_edge") {
            "bidirectional_edge".to_string()
        } else if s.contains("duplicate_edge") {
            "duplicate_edge".to_string()
        } else if s.contains("same_task_required") {
            "same_task_required".to_string()
        } else if s.contains("endpoint_not_found") {
            "target_not_found".to_string()
        } else {
            format!("internal_error: {}", s)
        }
    })
}

pub async fn user_send_message(
    project_key: &str,
    task_id: &str,
    target_chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let key = format!("{}:{}:{}", project_key, task_id, target_chat_id);
    let handle = acp::get_session_handle(&key).ok_or_else(|| "target_not_available".to_string())?;

    if handle.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
        let messages = handle.queue_message(QueuedMessage {
            text: text.to_string(),
            attachments: Vec::new(),
            sender: Some("user".to_string()),
        });
        handle.emit(AcpUpdate::QueueUpdate { messages });
    } else {
        tokio::time::timeout(
            Duration::from_secs(10),
            handle.send_prompt(
                text.to_string(),
                Vec::new(),
                Some("user".to_string()),
                false,
            ),
        )
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| format!("send_prompt: {}", e))?;
    }
    Ok(())
}

pub async fn user_remind(project_key: &str, task_id: &str, edge_id: i64) -> Result<(), String> {
    let (from_session, to_session, msg_id) = {
        let conn = database::connection();
        let edge = graph_db::get_edge(&conn, edge_id)
            .map_err(|e| format!("get_edge: {}", e))?
            .ok_or_else(|| "target_not_found".to_string())?;

        let pending = graph_db::list_pending_for_task(&conn, task_id)
            .map_err(|e| format!("list_pending: {}", e))?
            .into_iter()
            .find(|p| p.from_session == edge.from_session && p.to_session == edge.to_session)
            .ok_or_else(|| "no_pending_to_remind".to_string())?;

        (edge.from_session, edge.to_session, pending.msg_id)
    };

    let key = format!("{}:{}:{}", project_key, task_id, to_session);
    let handle = acp::get_session_handle(&key).ok_or_else(|| "target_not_available".to_string())?;

    if handle.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("target_is_busy".to_string());
    }

    let sender_name = tasks::load_chat_sessions(project_key, task_id)
        .ok()
        .and_then(|chats| {
            chats
                .iter()
                .find(|c| c.id == from_session)
                .map(|c| c.title.clone())
        })
        .unwrap_or_else(|| from_session.clone());

    let prompt = format!(
        "[Remind] The message from {} (msg: {}) is still awaiting your reply. Please check and respond.",
        sender_name, msg_id
    );

    user_send_message(project_key, task_id, &to_session, &prompt).await?;
    // TODO(WO-009): broadcast RadioEvent for pending status change
    Ok(())
}
