//! 5 个 agent_graph MCP 工具的核心实现（transport 无关）。
//!
//! 单测覆盖错误分支与 DB 状态校验。成功路径中涉及 ACP 子进程的部分由 Commit 4 的
//! 集成测试覆盖（mock agent + 起 axum server）。

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::error::AgentGraphError;
use super::inject::{build_injected_prompt, InjectKind};
use crate::acp::{self, AcpSessionHandle, AcpStartConfig, AcpUpdate, QueuedConfig, QueuedMessage};
use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
use crate::storage::{agent_graph as graph_db, custom_agent, database, tasks, workspace};

pub type AgentGraphResult<T> = Result<T, AgentGraphError>;

pub(crate) const ACP_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(90);

/// caller 视角的工具上下文。每次 HTTP MCP `tools/call` 解析 token 后构造一份。
#[derive(Debug, Clone)]
pub struct ToolContext {
    /// 调工具的 agent 自己的 chat_id（即 caller）。来自 token→chat_id 映射，不来自 env。
    pub caller_chat_id: String,
}

impl ToolContext {
    pub fn new(caller_chat_id: String) -> Self {
        Self { caller_chat_id }
    }

    /// 解析 caller 的 (project_key, task_id, ChatSession)，找不到 → CallerUnknown。
    fn caller_context(&self) -> AgentGraphResult<(String, String, tasks::ChatSession)> {
        tasks::find_chat_session(&self.caller_chat_id)
            .map_err(AgentGraphError::from)?
            .ok_or(AgentGraphError::CallerUnknown)
    }
}

// ─── grove_agent_send ─────────────────────────────────────────────────────────

/// Optional config overrides applied to the target session before message delivery.
/// Use `grove_agent_capability` to discover which values are valid for a session.
/// Config is applied atomically with delivery: the target session is started on demand
/// if offline, then the override is applied before the message is sent or queued.
/// If the message is queued (session busy), the config snapshot travels with the
/// message and is re-applied at dequeue time.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SendConfig {
    /// Model id to switch to (e.g. `"claude-opus-4-5"`).
    /// Must be one of `grove_agent_capability.available.models[][0]`.
    #[serde(default)]
    pub model: Option<String>,
    /// Mode id to switch to (e.g. `"auto"`).
    /// Must be one of `grove_agent_capability.available.modes[][0]`.
    #[serde(default)]
    pub mode: Option<String>,
    /// Thought-level value id (e.g. `"high"`).
    /// Must be one of `grove_agent_capability.available.thought_levels[][0]`.
    #[serde(default)]
    pub thought_level: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SendInput {
    /// Target session id (chat_id of the recipient).
    pub to: String,
    /// Message body to deliver. The agent_graph layer prefixes it with a
    /// `<grove-meta>{...}</grove-meta>` envelope (type=agent_inject_send) before
    /// injection — see `agent_graph::inject`.
    pub message: String,
    /// Required only when the target session has no duty yet; forbidden otherwise.
    #[serde(default)]
    pub duty: Option<String>,
    /// Optional model / mode / thought-level overrides applied to the target
    /// session before delivery. Use `grove_agent_capability` to discover valid values.
    #[serde(default)]
    pub config: Option<SendConfig>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SendOutput {
    pub msg_id: String,
    pub delivered_at: String,
}

pub async fn grove_agent_send(cx: &ToolContext, input: SendInput) -> AgentGraphResult<SendOutput> {
    let (caller_project, caller_task, caller_chat) = cx.caller_context()?;

    // 目标存在 + 同 task
    let (target_project, target_task, target_chat) = tasks::find_chat_session(&input.to)
        .map_err(AgentGraphError::from)?
        .ok_or(AgentGraphError::TargetNotFound)?;
    if target_project != caller_project || target_task != caller_task {
        return Err(AgentGraphError::SameTaskRequired);
    }

    // duty 三态
    let mut duty_set_by_this_call = false;
    match (&target_chat.duty, &input.duty) {
        (Some(_), Some(_)) => return Err(AgentGraphError::DutyForbidden),
        (None, None) => return Err(AgentGraphError::DutyRequired),
        (None, Some(new_duty)) => {
            tasks::update_chat_duty(
                &target_project,
                &target_task,
                &target_chat.id,
                Some(new_duty.clone()),
                false,
            )
            .map_err(AgentGraphError::from)?;
            duty_set_by_this_call = true;
        }
        (Some(_), None) => {
            // 目标已有 duty，且本次没传，正常路径
        }
    }

    // 单线在途 + edge 校验由 insert_pending_message 内部完成（spec §5）
    let msg_id = format!("msg-{}", uuid::Uuid::new_v4());
    {
        let conn = database::connection();
        graph_db::insert_pending_message(
            &conn,
            &msg_id,
            &caller_task,
            &caller_chat.id,
            &target_chat.id,
            &input.message,
        )
        .map_err(AgentGraphError::from)?;
    }

    // Announce the new pending ticket so graph clients can flip the edge
    // state without polling /graph. body_excerpt mirrors what GET /graph
    // would compute for the popup card (shared helper guarantees identical
    // output across event push and REST re-hydration).
    broadcast_radio_event(RadioEvent::PendingChanged {
        project_id: caller_project.clone(),
        task_id: caller_task.clone(),
        msg_id: msg_id.clone(),
        from_chat_id: caller_chat.id.clone(),
        to_chat_id: target_chat.id.clone(),
        op: "inserted".to_string(),
        body_excerpt: Some(super::pending_body_excerpt(&input.message)),
    });

    // 投递：busy → 排队；idle → send_prompt 同步 broadcast UserMessage
    // Config 覆盖（model / mode / thought_level）在 deliver_to_session 内部完成，
    // 确保离线 session 唤醒后也能正确应用。
    // On any failure we MUST roll back the pending row we just inserted —
    // otherwise the sender's edge stays stuck in "blocked" forever for a
    // message that never reached the target's queue. The MCP error returned
    // is the source of truth for the calling AI: success ⇒ delivered.
    let delivery = deliver_to_session(
        &caller_project,
        &caller_task,
        &target_chat.id,
        &caller_chat,
        InjectKind::Send,
        &input.message,
        Some(&msg_id),
        input.config.clone(),
    )
    .await;
    if let Err(e) = delivery {
        {
            let conn = database::connection();
            let _ = graph_db::delete_pending_message(&conn, &msg_id);
        }
        // M6: 如果 duty 是本次调用刚设上的，delivery 失败时把它一起回滚，
        // 否则下次重试会撞 DutyForbidden。
        if duty_set_by_this_call {
            let _ =
                tasks::update_chat_duty(&target_project, &target_task, &target_chat.id, None, true);
        }
        broadcast_radio_event(RadioEvent::PendingChanged {
            project_id: caller_project.clone(),
            task_id: caller_task.clone(),
            msg_id: msg_id.clone(),
            from_chat_id: caller_chat.id.clone(),
            to_chat_id: target_chat.id.clone(),
            op: "deleted".to_string(),
            body_excerpt: None,
        });
        return Err(e);
    }

    Ok(SendOutput {
        msg_id,
        delivered_at: Utc::now().to_rfc3339(),
    })
}

// ─── grove_agent_reply ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReplyInput {
    /// The msg_id of the pending message to reply to.
    pub msg_id: String,
    /// Reply body.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplyOutput {
    pub delivered_at: String,
}

pub async fn grove_agent_reply(
    cx: &ToolContext,
    input: ReplyInput,
) -> AgentGraphResult<ReplyOutput> {
    let (caller_project, caller_task, caller_chat) = cx.caller_context()?;

    // 取 pending message
    let pending = {
        let conn = database::connection();
        graph_db::get_pending_message(&conn, &input.msg_id).map_err(AgentGraphError::from)?
    }
    .ok_or(AgentGraphError::TicketNotFound)?;

    // ticket 必须是 *给 caller 的*（caller 是 to_session）
    if pending.to_session != caller_chat.id {
        return Err(AgentGraphError::TicketNotFound);
    }
    if pending.task_id != caller_task {
        return Err(AgentGraphError::SameTaskRequired);
    }

    // 投递到原发送方（pending.from_session）。这条 chat 的存活性由
    // ensure_target_handle 内部 find_chat_session 校验，不在这里重复 lookup。
    deliver_to_session(
        &caller_project,
        &caller_task,
        &pending.from_session,
        &caller_chat,
        InjectKind::Reply,
        &input.message,
        None,
        None,
    )
    .await?;

    // 投递成功后消费 ticket
    {
        let conn = database::connection();
        graph_db::delete_pending_message(&conn, &input.msg_id).map_err(AgentGraphError::from)?;
    }
    broadcast_radio_event(RadioEvent::PendingChanged {
        project_id: caller_project.clone(),
        task_id: caller_task.clone(),
        msg_id: input.msg_id.clone(),
        from_chat_id: pending.from_session.clone(),
        to_chat_id: pending.to_session.clone(),
        op: "deleted".to_string(),
        body_excerpt: None,
    });

    Ok(ReplyOutput {
        delivered_at: Utc::now().to_rfc3339(),
    })
}

// ─── grove_agent_contacts ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, JsonSchema, Default)]
pub struct ContactsInput {}

#[derive(Debug, Clone, Serialize)]
pub struct ContactsSelf {
    pub session_id: String,
    pub name: String,
    pub duty: Option<String>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContactsCanContact {
    pub session_id: String,
    pub name: String,
    pub duty: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContactsPendingReply {
    pub msg_id: String,
    pub from: String,
    pub message_excerpt: String,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContactsAwaitingReply {
    pub msg_id: String,
    pub to: String,
    pub message_excerpt: String,
    pub sent_at: String,
}

/// Kind of spawnable target returned in `can_spawn`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CanSpawnKind {
    /// System built-in ACP agent (e.g. "claude", "codex").
    Base,
    /// User-configured custom ACP server.
    CustomServer,
    /// User-defined persona: a base agent pre-seeded with a system prompt.
    Persona,
}

/// An entry in `ContactsOutput.can_spawn` — a target the caller can pass
/// as the `agent` argument to `grove_agent_spawn`.
///
/// Personas are user-scoped (per Grove install), not task-scoped. Every
/// session in every task sees the full persona list — by design, so a persona
/// created in one task can be reused elsewhere.
#[derive(Debug, Clone, Serialize)]
pub struct ContactsCanSpawn {
    /// Value to pass as `grove_agent_spawn.agent`.
    pub id: String,
    pub kind: CanSpawnKind,
    pub display_name: String,
    /// Underlying base agent id. For personas, this is the persona's
    /// `base_agent`; for base/custom-server entries it equals `id`.
    pub base_agent: String,
    /// Pre-set duty for personas (not exposed for base/custom-server).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
    /// Icon hint (base agents only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContactsOutput {
    #[serde(rename = "self")]
    pub self_: ContactsSelf,
    pub can_contact: Vec<ContactsCanContact>,
    pub pending_replies: Vec<ContactsPendingReply>,
    pub awaiting_reply: Vec<ContactsAwaitingReply>,
    /// All targets the caller can pass as `grove_agent_spawn.agent`:
    /// base agents, custom ACP servers, and personas — in that order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub can_spawn: Vec<ContactsCanSpawn>,
}

pub async fn grove_agent_contacts(
    cx: &ToolContext,
    _input: ContactsInput,
) -> AgentGraphResult<ContactsOutput> {
    let (_caller_project, caller_task, caller_chat) = cx.caller_context()?;

    let conn = database::connection();
    let outgoing =
        graph_db::outgoing_for_session(&conn, &caller_chat.id).map_err(AgentGraphError::from)?;
    let incoming_pending =
        graph_db::pending_replies_for(&conn, &caller_chat.id).map_err(AgentGraphError::from)?;
    let outgoing_pending =
        graph_db::awaiting_reply_for(&conn, &caller_chat.id).map_err(AgentGraphError::from)?;
    drop(conn);

    let can_contact = outgoing
        .into_iter()
        .map(|c| ContactsCanContact {
            session_id: c.to_session_id,
            name: c.to_session_name,
            duty: c.to_session_duty,
            purpose: c.purpose,
        })
        .collect();
    let pending_replies = incoming_pending
        .into_iter()
        .map(|p| ContactsPendingReply {
            msg_id: p.msg_id,
            from: p.from_session,
            message_excerpt: excerpt(&p.body),
            received_at: p.created_at.to_rfc3339(),
        })
        .collect();
    let awaiting_reply = outgoing_pending
        .into_iter()
        .map(|p| ContactsAwaitingReply {
            msg_id: p.msg_id,
            to: p.to_session,
            message_excerpt: excerpt(&p.body),
            sent_at: p.created_at.to_rfc3339(),
        })
        .collect();

    // can_spawn: base agents → custom servers → personas (user-scoped, cross-task by design)
    let mut can_spawn: Vec<ContactsCanSpawn> = Vec::new();
    for base in acp::available_base_acp_agents() {
        can_spawn.push(ContactsCanSpawn {
            id: base.id.to_string(),
            kind: CanSpawnKind::Base,
            display_name: base.display_name.to_string(),
            base_agent: base.id.to_string(),
            duty: None,
            icon_id: Some(base.icon_id.to_string()),
        });
    }
    let config = crate::storage::config::load_config();
    for server in config.acp.custom_agents {
        if acp::resolve_agent(&server.id).is_some() {
            can_spawn.push(ContactsCanSpawn {
                id: server.id.clone(),
                kind: CanSpawnKind::CustomServer,
                display_name: server.name,
                base_agent: server.id,
                duty: None,
                icon_id: None,
            });
        }
    }
    for persona in custom_agent::list().unwrap_or_default() {
        if acp::resolve_agent(&persona.base_agent).is_some() {
            can_spawn.push(ContactsCanSpawn {
                id: persona.id,
                kind: CanSpawnKind::Persona,
                display_name: persona.name,
                base_agent: persona.base_agent,
                duty: persona.duty,
                icon_id: None,
            });
        }
    }

    Ok(ContactsOutput {
        self_: ContactsSelf {
            session_id: caller_chat.id.clone(),
            name: caller_chat.title.clone(),
            duty: caller_chat.duty.clone(),
            task_id: caller_task,
        },
        can_contact,
        pending_replies,
        awaiting_reply,
        can_spawn,
    })
}

fn excerpt(body: &str) -> String {
    super::excerpt_chars(body, 160)
}

// ─── grove_agent_capability ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CapabilityInput {
    /// Session id whose capabilities (models / modes / thought_levels) to inspect.
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AvailableSet {
    pub models: Vec<(String, String)>,
    pub modes: Vec<(String, String)>,
    pub thought_levels: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapabilityOutput {
    pub session_id: String,
    pub available: AvailableSet,
}

pub async fn grove_agent_capability(
    cx: &ToolContext,
    input: CapabilityInput,
) -> AgentGraphResult<CapabilityOutput> {
    let (caller_project, caller_task, _caller_chat) = cx.caller_context()?;

    let (target_project, target_task, _target_chat) = tasks::find_chat_session(&input.session_id)
        .map_err(AgentGraphError::from)?
        .ok_or(AgentGraphError::TargetNotFound)?;

    // agent_graph 是 per-task 视图。caller 不能查另一个 task 的 session 元数据，
    // 否则 token 闭包的"caller 仅访问自己 task 内对象"边界就被绕过。
    if target_project != caller_project || target_task != caller_task {
        return Err(AgentGraphError::SameTaskRequired);
    }

    let meta = acp::read_session_metadata(&target_project, &target_task, &input.session_id)
        .ok_or(AgentGraphError::AgentOffline)?;

    Ok(CapabilityOutput {
        session_id: input.session_id,
        available: AvailableSet {
            models: meta.available_models,
            modes: meta.available_modes,
            thought_levels: meta.available_thought_levels,
        },
    })
}

// ─── grove_agent_spawn ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SpawnInput {
    /// Base agent kind (e.g. "claude", "codex", "opencode") OR a Custom Agent
    /// (persona) id from `grove_agent_contacts.can_spawn[].id`.
    /// When you pass a persona id the spawn will start that persona's
    /// underlying base agent and seed it with the user-defined system prompt.
    pub agent: String,
    /// Human-readable session name. Must be unique within the task.
    pub name: String,
    /// Duty description. Locked once set — the new session's AI cannot change it.
    pub duty: String,
    /// Optional purpose label for the auto-created caller→child edge.
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpawnOutput {
    pub session_id: String,
    pub name: String,
    pub duty: String,
    pub task_id: String,
    pub parent_session_id: String,
    pub available: AvailableSet,
}

pub async fn grove_agent_spawn(
    cx: &ToolContext,
    input: SpawnInput,
) -> AgentGraphResult<SpawnOutput> {
    let (project_key, task_id, caller_chat) = cx.caller_context()?;

    // name 同 task 唯一
    let chats = tasks::load_chat_sessions(&project_key, &task_id).map_err(AgentGraphError::from)?;
    if chats.iter().any(|c| c.title == input.name) {
        return Err(AgentGraphError::NameTaken);
    }

    // Custom Agent (persona) → resolve to base_agent + capture system_prompt
    let (effective_agent, persona_injection) =
        match crate::storage::custom_agent::try_get_persona(&input.agent) {
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
            _ => (input.agent.clone(), None),
        };
    let resolved = acp::resolve_agent(&effective_agent).ok_or(AgentGraphError::AgentSpawnFailed)?;

    let project = workspace::load_project_by_hash(&project_key)
        .map_err(AgentGraphError::from)?
        .ok_or_else(|| AgentGraphError::Internal("project not registered".into()))?;
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(AgentGraphError::from)?
        .ok_or_else(|| AgentGraphError::Internal("caller task vanished".into()))?;

    let new_chat_id = tasks::generate_chat_id();
    let now = Utc::now();
    let new_chat = tasks::ChatSession {
        id: new_chat_id.clone(),
        title: input.name.clone(),
        agent: input.agent.clone(),
        acp_session_id: None,
        created_at: now,
        duty: None, // duty 等 ACP ready 之后再设定，避免半成品记录被外界看到锁定的 duty
    };
    tasks::add_chat_session(&project_key, &task_id, new_chat.clone())
        .map_err(AgentGraphError::from)?;

    // 自动建 caller→new edge（带 purpose）
    let caller_to_child_edge_id = {
        let conn = database::connection();
        match graph_db::add_edge(
            &conn,
            &project_key,
            &task_id,
            &caller_chat.id,
            &new_chat_id,
            input.purpose.as_deref(),
        ) {
            Ok(id) => id,
            Err(e) => {
                // 回滚 chat
                let _ = tasks::delete_chat_session(&project_key, &task_id, &new_chat_id);
                return Err(AgentGraphError::from(e));
            }
        }
    };

    // 启动 ACP 子进程
    let env_vars = crate::api::handlers::acp::build_grove_env(
        &project_key,
        &project.path,
        &project.name,
        &task,
        Some(&new_chat_id),
    );
    let working_dir = std::path::PathBuf::from(&task.worktree_path);
    let session_key = format!("{}:{}:{}", project_key, task_id, new_chat_id);
    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_name: resolved.agent_name,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key: project_key.clone(),
        task_id: task_id.clone(),
        chat_id: Some(new_chat_id.clone()),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
        suppress_initial_connecting: false,
        persona_injection,
    };

    let start_res = acp::get_or_start_session(session_key.clone(), config).await;
    let (_handle, mut rx) = match start_res {
        Ok(t) => t,
        Err(e) => {
            // 回滚 chat + edge，并通知前端刷新（客户端可能通过轮询已看到新 chat）
            let _ = tasks::delete_chat_session(&project_key, &task_id, &new_chat_id);
            let conn = database::connection();
            let _ = graph_db::delete_edge(&conn, caller_to_child_edge_id);
            broadcast_radio_event(RadioEvent::ChatListChanged {
                project_id: project_key.clone(),
                task_id: task_id.clone(),
            });
            return Err(AgentGraphError::Internal(format!(
                "spawn ACP session failed: {}",
                e
            )));
        }
    };

    // 等 SessionReady
    let ready = tokio::time::timeout(ACP_SESSION_READY_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Ok(AcpUpdate::SessionReady {
                    session_id,
                    available_modes,
                    available_models,
                    available_thought_levels,
                    ..
                }) => {
                    return Ok::<_, AgentGraphError>((
                        session_id,
                        available_modes,
                        available_models,
                        available_thought_levels,
                    ));
                }
                Ok(AcpUpdate::Error { message }) => {
                    return Err(AgentGraphError::Internal(format!("acp error: {}", message)))
                }
                Ok(AcpUpdate::SessionEnded) => return Err(AgentGraphError::SessionTerminated),
                Ok(_) => continue,
                Err(_lagged_or_closed) => return Err(AgentGraphError::SessionTerminated),
            }
        }
    })
    .await;

    let (_acp_session_id, modes, models, thought_levels) = match ready {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            let _ = tasks::delete_chat_session(&project_key, &task_id, &new_chat_id);
            let conn = database::connection();
            let _ = graph_db::delete_edge(&conn, caller_to_child_edge_id);
            let _ = acp::kill_session(&session_key);
            broadcast_radio_event(RadioEvent::ChatListChanged {
                project_id: project_key.clone(),
                task_id: task_id.clone(),
            });
            return Err(e);
        }
        Err(_) => {
            let _ = tasks::delete_chat_session(&project_key, &task_id, &new_chat_id);
            let conn = database::connection();
            let _ = graph_db::delete_edge(&conn, caller_to_child_edge_id);
            let _ = acp::kill_session(&session_key);
            broadcast_radio_event(RadioEvent::ChatListChanged {
                project_id: project_key.clone(),
                task_id: task_id.clone(),
            });
            return Err(AgentGraphError::Timeout);
        }
    };

    // duty lock — spawn 路径首次设置，force=false 即可（既然 chat 是刚建的，
    // 不会撞 lock；保留 force=false 防御万一并发）。
    if let Err(e) = tasks::update_chat_duty(
        &project_key,
        &task_id,
        &new_chat_id,
        Some(input.duty.clone()),
        false,
    ) {
        let _ = tasks::delete_chat_session(&project_key, &task_id, &new_chat_id);
        let conn = database::connection();
        let _ = graph_db::delete_edge(&conn, caller_to_child_edge_id);
        let _ = acp::kill_session(&session_key);
        broadcast_radio_event(RadioEvent::ChatListChanged {
            project_id: project_key.clone(),
            task_id: task_id.clone(),
        });
        return Err(AgentGraphError::from(e));
    }

    // 通知前端 chat 列表变更（用户需求：前端自动看到新 chat）
    broadcast_radio_event(RadioEvent::ChatListChanged {
        project_id: project_key,
        task_id: task_id.clone(),
    });

    Ok(SpawnOutput {
        session_id: new_chat_id,
        name: input.name,
        duty: input.duty,
        task_id,
        parent_session_id: caller_chat.id,
        available: AvailableSet {
            models,
            modes,
            thought_levels,
        },
    })
}

// ─── 共用：注入到目标 session（busy → queue, idle → send_prompt） ─────────────

#[allow(clippy::too_many_arguments)]
async fn deliver_to_session(
    project_key: &str,
    task_id: &str,
    target_chat_id: &str,
    caller_chat: &tasks::ChatSession,
    kind: InjectKind,
    body: &str,
    msg_id: Option<&str>,
    config: Option<SendConfig>,
) -> AgentGraphResult<()> {
    // Synchronous spawn-on-demand: if the target session isn't running, start
    // it and wait for SessionReady before delivering. Errors here mean the
    // message was NOT queued — the caller MUST treat that as a failure.
    let target_handle = ensure_target_handle(project_key, task_id, target_chat_id).await?;

    // Apply config now that the session is guaranteed online (covers the offline case).
    // We also build a QueuedConfig snapshot to re-apply if the message ends up queued.
    let queued_config = if let Some(cfg) = &config {
        if let Some(ref model) = cfg.model {
            let _ = target_handle.set_model(model.clone()).await;
        }
        if let Some(ref mode) = cfg.mode {
            let _ = target_handle.set_mode(mode.clone()).await;
        }
        let thought_level_config_id =
            acp::read_session_metadata(project_key, task_id, target_chat_id)
                .and_then(|m| m.thought_level_config_id);
        if let (Some(ref thought_level), Some(ref config_id)) =
            (&cfg.thought_level, &thought_level_config_id)
        {
            let _ = target_handle
                .set_thought_level(config_id.clone(), thought_level.clone())
                .await;
        } else if cfg.thought_level.is_some() && thought_level_config_id.is_none() {
            eprintln!(
                "[ACP] deliver_to_session: thought_level requested but thought_level_config_id \
                 not yet in session.json for chat {target_chat_id} — thought_level will also be \
                 skipped at dequeue (config_id snapshot is None)"
            );
        }
        Some(QueuedConfig {
            model: cfg.model.clone(),
            mode: cfg.mode.clone(),
            thought_level: cfg.thought_level.clone(),
            thought_level_config_id,
        })
    } else {
        None
    };

    let injected = build_injected_prompt(
        &caller_chat.id,
        &caller_chat.title,
        &caller_chat.agent,
        kind,
        body,
        msg_id,
    );
    let sender = format!("agent:{}", caller_chat.id);

    // Atomically claim the busy slot. compare_exchange closes the race where
    // two concurrent callers both observe is_busy=false and both fall through
    // to send_prompt — the second one would silently get treated as a queued
    // continuation by the cmd loop instead of an explicit queue entry the
    // user can see.
    let claimed = target_handle
        .is_busy
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok();
    if !claimed {
        let messages = target_handle.queue_message(QueuedMessage {
            text: injected,
            attachments: Vec::new(),
            sender: Some(sender),
            config: queued_config,
        });
        target_handle.emit(AcpUpdate::QueueUpdate { messages });
        return Ok(());
    }

    let send_res = tokio::time::timeout(
        Duration::from_secs(10),
        target_handle.send_prompt(injected, Vec::new(), Some(sender), false),
    )
    .await;
    match send_res {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            // Release the claim so future calls aren't permanently blocked.
            // The cmd loop will re-assert is_busy when it actually picks up
            // the next prompt.
            target_handle
                .is_busy
                .store(false, std::sync::atomic::Ordering::Release);
            Err(AgentGraphError::Internal(format!("send_prompt: {}", e)))
        }
        Err(_) => {
            target_handle
                .is_busy
                .store(false, std::sync::atomic::Ordering::Release);
            Err(AgentGraphError::Timeout)
        }
    }
}

/// 用户在图上点 "remind" 时的投递入口。已经组装好 grove-meta envelope，
/// 这里负责 spawn-on-demand + busy 判断 + CAS 并发。语义上与 deliver_to_session
/// 几乎相同，但消息已经是 envelope，sender 标记成 "user:remind"。
pub async fn deliver_user_remind(
    project_key: &str,
    task_id: &str,
    target_chat_id: &str,
    injected: String,
) -> std::result::Result<(), String> {
    let session_key = format!("{}:{}:{}", project_key, task_id, target_chat_id);
    let target_handle =
        acp::get_session_handle(&session_key).ok_or_else(|| "target_not_idle".to_string())?;
    if target_handle.derive_node_status() != "idle" {
        return Err("target_not_idle".to_string());
    }

    let claimed = target_handle
        .is_busy
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok();
    if !claimed {
        // Reminder 不入队 — 用户感知不到队列里多一条 reminder，反而更困惑。
        // 若 target busy，直接拒绝，让 UI 显示 "target_is_busy"。
        return Err("target_is_busy".to_string());
    }

    let send_res = tokio::time::timeout(
        Duration::from_secs(10),
        target_handle.send_prompt(injected, Vec::new(), Some("user:remind".to_string()), false),
    )
    .await;
    match send_res {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            target_handle
                .is_busy
                .store(false, std::sync::atomic::Ordering::Release);
            Err(format!("send_prompt: {}", e))
        }
        Err(_) => {
            target_handle
                .is_busy
                .store(false, std::sync::atomic::Ordering::Release);
            Err("timeout".to_string())
        }
    }
}

/// Ensure an ACP session handle exists for `target_chat_id` — returning the
/// running handle if it's already up, otherwise synchronously spawning the
/// agent subprocess for that chat record and waiting for `SessionReady` (with
/// timeout). Mirrors `grove_agent_spawn`'s startup flow but operates on an
/// existing chat row rather than creating one.
///
/// Errors map cleanly to MCP error codes so the calling AI knows whether the
/// message reached the target's queue (`Ok(handle)` followed by successful
/// `deliver_to_session`) or never made it (any error from this function).
pub(crate) async fn ensure_target_handle(
    project_key: &str,
    task_id: &str,
    target_chat_id: &str,
) -> AgentGraphResult<Arc<AcpSessionHandle>> {
    let session_key = format!("{}:{}:{}", project_key, task_id, target_chat_id);
    if let Some(h) = acp::get_session_handle(&session_key) {
        return Ok(h);
    }

    // No handle — spawn the agent subprocess for this chat. We need:
    // - the chat record (for the agent kind)
    // - the project record (for workspace path / name → env vars)
    // - the task record (for working_dir + env vars)
    let (_, _, target_chat) = tasks::find_chat_session(target_chat_id)
        .map_err(AgentGraphError::from)?
        .ok_or(AgentGraphError::TargetNotFound)?;
    let project = workspace::load_project_by_hash(project_key)
        .map_err(AgentGraphError::from)?
        .ok_or_else(|| AgentGraphError::Internal("project not registered".into()))?;
    let task = tasks::get_task(project_key, task_id)
        .map_err(AgentGraphError::from)?
        .ok_or_else(|| AgentGraphError::Internal("target task vanished".into()))?;

    // ensure_target_handle is the "wake an existing chat's agent" path. It's
    // idempotent over Resume: if a session id was previously persisted, the
    // ACP layer takes the LoadSession branch and skips persona_injection.
    // Pass the persona payload anyway so a fresh-create fallback also re-seeds.
    let (effective_agent, persona_injection) =
        match crate::storage::custom_agent::try_get_persona(&target_chat.agent) {
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
            _ => (target_chat.agent.clone(), None),
        };
    let resolved = acp::resolve_agent(&effective_agent).ok_or(AgentGraphError::AgentSpawnFailed)?;

    let env_vars = crate::api::handlers::acp::build_grove_env(
        project_key,
        &project.path,
        &project.name,
        &task,
        Some(target_chat_id),
    );
    let working_dir = std::path::PathBuf::from(&task.worktree_path);
    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_name: resolved.agent_name,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key: project_key.to_string(),
        task_id: task_id.to_string(),
        chat_id: Some(target_chat_id.to_string()),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
        suppress_initial_connecting: false,
        persona_injection,
    };

    let (handle, mut rx) = acp::get_or_start_session(session_key.clone(), config)
        .await
        .map_err(|e| AgentGraphError::Internal(format!("spawn ACP session failed: {}", e)))?;

    // Wait for SessionReady with the same budget grove_agent_spawn uses.
    // SessionReady → Ok; SessionEnded / Error / Lagged → propagate as a clean
    // failure so the caller knows nothing was delivered.
    let wait = tokio::time::timeout(ACP_SESSION_READY_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Ok(AcpUpdate::SessionReady { .. }) => return Ok::<(), AgentGraphError>(()),
                Ok(AcpUpdate::Error { message }) => {
                    return Err(AgentGraphError::Internal(format!("acp error: {}", message)))
                }
                Ok(AcpUpdate::SessionEnded) => return Err(AgentGraphError::SessionTerminated),
                Ok(_) => continue,
                Err(_) => return Err(AgentGraphError::SessionTerminated),
            }
        }
    })
    .await;

    match wait {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AgentGraphError::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::database::test_lock;
    use rusqlite::Connection;

    /// 设 HOME 到临时目录，让 storage 写隔离的 grove.db
    struct TempHome {
        _tmp: tempfile::TempDir,
        prev: Option<std::ffi::OsString>,
    }

    impl TempHome {
        fn new() -> Self {
            let tmp = tempfile::tempdir().expect("tmpdir");
            let prev = std::env::var_os("HOME");
            // SAFETY: 仅在测试中调，且通过 test_lock 串行化所有 HOME 改动。
            unsafe {
                std::env::set_var("HOME", tmp.path());
            }
            Self { _tmp: tmp, prev }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            unsafe {
                if let Some(p) = self.prev.take() {
                    std::env::set_var("HOME", p);
                } else {
                    std::env::remove_var("HOME");
                }
            }
        }
    }

    fn seed_chat(project: &str, task_id: &str, chat_id: &str, title: &str, duty: Option<&str>) {
        let conn = database::connection();
        conn.execute(
            "INSERT OR REPLACE INTO session
             (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
            rusqlite::params![
                chat_id,
                project,
                task_id,
                title,
                "claude",
                duty,
                Utc::now().to_rfc3339(),
            ],
        )
        .expect("insert chat");
    }

    fn seed_edge(conn: &Connection, task_id: &str, from: &str, to: &str) {
        graph_db::add_edge(conn, "p", task_id, from, to, None).expect("edge");
    }

    #[tokio::test]
    async fn caller_unknown_send() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        // No chat seeded.
        let cx = ToolContext::new("chat-bogus".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-other".into(),
                message: "hi".into(),
                duty: None,
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "caller_unknown");
    }

    #[tokio::test]
    async fn target_not_found_send() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-missing".into(),
                message: "hi".into(),
                duty: Some("x".into()),
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "target_not_found");
    }

    #[tokio::test]
    async fn cross_task_rejected() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t1", "chat-A", "A", None);
        seed_chat("p", "t2", "chat-B", "B", None);
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "hi".into(),
                duty: Some("x".into()),
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "same_task_required");
    }

    #[tokio::test]
    async fn duty_required() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        seed_chat("p", "t", "chat-B", "B", None); // B 没 duty
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        drop(conn);

        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "hi".into(),
                duty: None, // 没传 duty 但 B 也没 duty
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "duty_required");
    }

    #[tokio::test]
    async fn duty_forbidden() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        seed_chat("p", "t", "chat-B", "B", Some("existing")); // B 已有 duty
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        drop(conn);

        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "hi".into(),
                duty: Some("override".into()),
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "duty_forbidden");
    }

    #[tokio::test]
    async fn no_edge_send() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        seed_chat("p", "t", "chat-B", "B", Some("d"));
        // 故意不建 edge
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "hi".into(),
                duty: None,
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "no_edge");
    }

    #[tokio::test]
    async fn previous_message_pending() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        seed_chat("p", "t", "chat-B", "B", Some("d"));
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        graph_db::insert_pending_message(&conn, "msg-1", "t", "chat-A", "chat-B", "first")
            .expect("first pending");
        drop(conn);

        // target_not_available 会在第二条 send 投递阶段触发（因为 chat-B 没有真起 ACP），
        // 但单线在途校验在投递之前，所以期望 previous_message_pending。
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "second".into(),
                duty: None,
                config: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "previous_message_pending");
    }

    #[tokio::test]
    async fn ticket_not_found_reply() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_reply(
            &cx,
            ReplyInput {
                msg_id: "msg-bogus".into(),
                message: "ok".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "ticket_not_found");
    }

    #[tokio::test]
    async fn reply_wrong_recipient() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        // A→B pending；C 来 reply 不该过
        seed_chat("p", "t", "chat-A", "A", None);
        seed_chat("p", "t", "chat-B", "B", Some("d"));
        seed_chat("p", "t", "chat-C", "C", None);
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        graph_db::insert_pending_message(&conn, "msg-1", "t", "chat-A", "chat-B", "hi")
            .expect("pending");
        drop(conn);

        let cx = ToolContext::new("chat-C".into());
        let err = grove_agent_reply(
            &cx,
            ReplyInput {
                msg_id: "msg-1".into(),
                message: "fake".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "ticket_not_found");
    }

    #[tokio::test]
    async fn contacts_basic() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", Some("dispatcher"));
        seed_chat("p", "t", "chat-B", "B", Some("worker"));
        seed_chat("p", "t", "chat-C", "C", Some("reviewer"));
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        seed_edge(&conn, "t", "chat-A", "chat-C");
        graph_db::insert_pending_message(&conn, "msg-1", "t", "chat-A", "chat-B", "do x")
            .expect("p1");
        drop(conn);

        let cx = ToolContext::new("chat-A".into());
        let out = grove_agent_contacts(&cx, ContactsInput::default())
            .await
            .expect("ok");
        assert_eq!(out.self_.session_id, "chat-A");
        assert_eq!(out.self_.duty.as_deref(), Some("dispatcher"));
        assert_eq!(out.can_contact.len(), 2);
        assert_eq!(out.awaiting_reply.len(), 1);
        assert_eq!(out.pending_replies.len(), 0);
        assert_eq!(out.awaiting_reply[0].msg_id, "msg-1");
    }

    #[tokio::test]
    async fn capability_target_not_found() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        // Caller must exist in DB before target is even resolved (caller_context
        // runs first).
        seed_chat("p", "t", "chat-A", "A", None);
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_capability(
            &cx,
            CapabilityInput {
                session_id: "chat-missing".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "target_not_found");
    }

    #[tokio::test]
    async fn capability_cross_task_rejected() {
        // Regression: previously `grove_agent_capability` ignored the caller
        // context and allowed any token-bearing agent to read capability
        // metadata for a session in another task. Reviewer flagged this as a
        // boundary violation since the URL-token closure is supposed to confine
        // the caller to their own task. Now must return same_task_required.
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t1", "chat-A", "A", None);
        seed_chat("p", "t2", "chat-B", "B", None);
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_capability(
            &cx,
            CapabilityInput {
                session_id: "chat-B".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "same_task_required");
    }

    #[tokio::test]
    async fn capability_agent_offline() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "A", None);
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_capability(
            &cx,
            CapabilityInput {
                session_id: "chat-A".into(),
            },
        )
        .await
        .unwrap_err();
        // session.json 没写过 → AgentOffline
        assert_eq!(err.code(), "agent_offline");
    }

    #[tokio::test]
    async fn name_taken_spawn() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "Tester", None); // 已有 name=Tester
        let cx = ToolContext::new("chat-A".into());
        let err = grove_agent_spawn(
            &cx,
            SpawnInput {
                agent: "claude".into(),
                name: "Tester".into(), // 撞名
                duty: "test".into(),
                purpose: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "name_taken");
    }

    #[test]
    fn excerpt_truncates() {
        let long = "a".repeat(200);
        let s = excerpt(&long);
        assert_eq!(s.chars().count(), 161);
        assert!(s.ends_with('…'));
    }

    // ─── Integration tests (mock cmd loop, real handle, real broadcast) ──────
    //
    // These exercise the full send / reply / busy-queue paths end-to-end up to
    // (but not including) the real ACP subprocess. They use the
    // `acp::new_handle_for_test` helper which wires a minimal mock cmd loop
    // that emits `UserMessage` on `Prompt` commands — the same observable
    // behaviour as the real `run_acp_session` cmd loop.

    async fn drain_until<F>(rx: &mut broadcast::Receiver<AcpUpdate>, mut f: F) -> AcpUpdate
    where
        F: FnMut(&AcpUpdate) -> bool,
    {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(2);
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                panic!("timed out waiting for matching AcpUpdate");
            }
            match tokio::time::timeout(deadline - now, rx.recv()).await {
                Ok(Ok(u)) => {
                    if f(&u) {
                        return u;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => panic!("broadcast closed"),
                Err(_) => panic!("timed out waiting for matching AcpUpdate"),
            }
        }
    }

    use tokio::sync::broadcast;

    #[tokio::test]
    async fn send_idle_broadcasts_user_message_with_sender() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "Alice", Some("dispatcher"));
        seed_chat("p", "t", "chat-B", "Bob", Some("worker"));
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        drop(conn);

        // Mock B's session handle so send_prompt is observable.
        let key_b = "p:t:chat-B".to_string();
        let (_handle_b, mut rx_b, _guard_b) = acp::new_handle_for_test(&key_b, "p", "t", "chat-B");

        let cx = ToolContext::new("chat-A".into());
        let out = grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "hello from A".into(),
                duty: None,
                config: None,
            },
        )
        .await
        .expect("send ok");
        assert!(out.msg_id.starts_with("msg-"));

        // Wait for the UserMessage event from the mock cmd loop.
        let event = drain_until(&mut rx_b, |u| matches!(u, AcpUpdate::UserMessage { .. })).await;
        match event {
            AcpUpdate::UserMessage { text, sender, .. } => {
                assert!(
                    text.starts_with("<grove-meta>"),
                    "missing grove-meta envelope in {text:?}"
                );
                assert!(text.contains("\"type\":\"agent_inject_send\""));
                assert!(text.contains("\"sid\":\"chat-A\""));
                assert!(text.contains("\"name\":\"Alice\""));
                assert!(text.contains("\"msg_id\":\"msg-"));
                assert!(text.contains("\n\nhello from A"));
                assert!(text.contains("grove_agent_reply"));
                assert_eq!(sender.as_deref(), Some("agent:chat-A"));
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }

        // Pending message persisted to SQLite.
        let conn = database::connection();
        let p = graph_db::get_pending_message(&conn, &out.msg_id)
            .expect("query pending")
            .expect("row exists");
        assert_eq!(p.from_session, "chat-A");
        assert_eq!(p.to_session, "chat-B");
        assert_eq!(p.body, "hello from A");
    }

    #[tokio::test]
    async fn send_busy_queues_with_sender_preserved() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "Alice", Some("dispatcher"));
        seed_chat("p", "t", "chat-B", "Bob", Some("worker"));
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        drop(conn);

        let key_b = "p:t:chat-B".to_string();
        let (handle_b, mut rx_b, _guard_b) = acp::new_handle_for_test(&key_b, "p", "t", "chat-B");
        // Mark B busy so the tool routes through the queue.
        handle_b
            .is_busy
            .store(true, std::sync::atomic::Ordering::Relaxed);

        let cx = ToolContext::new("chat-A".into());
        grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "queued msg".into(),
                duty: None,
                config: None,
            },
        )
        .await
        .expect("send ok");

        let event = drain_until(&mut rx_b, |u| matches!(u, AcpUpdate::QueueUpdate { .. })).await;
        match event {
            AcpUpdate::QueueUpdate { messages } => {
                assert_eq!(messages.len(), 1, "queue should have 1 msg");
                assert!(
                    messages[0].text.starts_with("<grove-meta>"),
                    "envelope in queued message"
                );
                assert!(messages[0].text.contains("\"name\":\"Alice\""));
                assert_eq!(messages[0].sender.as_deref(), Some("agent:chat-A"));
            }
            other => panic!("expected QueueUpdate, got {:?}", other),
        }

        // Drain remaining events; ensure no UserMessage was broadcast (busy → queued).
        let mut saw_user = false;
        while let Ok(u) = rx_b.try_recv() {
            if matches!(u, AcpUpdate::UserMessage { .. }) {
                saw_user = true;
            }
        }
        assert!(!saw_user, "busy session should not broadcast UserMessage");
    }

    #[tokio::test]
    async fn busy_dequeue_preserves_sender_via_handle_path() {
        // Verify the cmd-loop dequeue path that fires after a turn ends keeps
        // the sender intact (this exercises the change in
        // `try_enqueue_prompt(text, attachments, sender)` from Commit 1).
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "Alice", Some("d"));
        seed_chat("p", "t", "chat-B", "Bob", Some("w"));
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        drop(conn);

        let key_b = "p:t:chat-B".to_string();
        let (handle_b, mut rx_b, _guard_b) = acp::new_handle_for_test(&key_b, "p", "t", "chat-B");
        handle_b
            .is_busy
            .store(true, std::sync::atomic::Ordering::Relaxed);

        let cx = ToolContext::new("chat-A".into());
        grove_agent_send(
            &cx,
            SendInput {
                to: "chat-B".into(),
                message: "delayed msg".into(),
                duty: None,
                config: None,
            },
        )
        .await
        .expect("send ok");

        // Let the QueueUpdate land first, then simulate "turn ended → resume queue".
        drain_until(&mut rx_b, |u| matches!(u, AcpUpdate::QueueUpdate { .. })).await;
        handle_b
            .is_busy
            .store(false, std::sync::atomic::Ordering::Relaxed);
        handle_b.resume_queue();

        // Now we should see a UserMessage with sender preserved.
        let event = drain_until(&mut rx_b, |u| matches!(u, AcpUpdate::UserMessage { .. })).await;
        match event {
            AcpUpdate::UserMessage { text, sender, .. } => {
                assert!(text.starts_with("<grove-meta>"));
                assert!(text.contains("\"name\":\"Alice\""));
                assert_eq!(sender.as_deref(), Some("agent:chat-A"));
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn reply_consumes_ticket_and_injects_to_origin() {
        let _l = test_lock().lock().await;
        let _h = TempHome::new();
        seed_chat("p", "t", "chat-A", "Alice", Some("d"));
        seed_chat("p", "t", "chat-B", "Bob", Some("w"));
        let conn = database::connection();
        seed_edge(&conn, "t", "chat-A", "chat-B");
        // Pre-stage a pending message A→B that B will reply to.
        graph_db::insert_pending_message(&conn, "msg-1", "t", "chat-A", "chat-B", "do x")
            .expect("p1");
        drop(conn);

        // Mock A so we can observe the reply being injected back to it.
        let key_a = "p:t:chat-A".to_string();
        let (_handle_a, mut rx_a, _guard_a) = acp::new_handle_for_test(&key_a, "p", "t", "chat-A");

        let cx_b = ToolContext::new("chat-B".into());
        let out = grove_agent_reply(
            &cx_b,
            ReplyInput {
                msg_id: "msg-1".into(),
                message: "done".into(),
            },
        )
        .await
        .expect("reply ok");
        assert!(!out.delivered_at.is_empty());

        let event = drain_until(&mut rx_a, |u| matches!(u, AcpUpdate::UserMessage { .. })).await;
        match event {
            AcpUpdate::UserMessage { text, sender, .. } => {
                assert!(text.starts_with("<grove-meta>"));
                assert!(text.contains("\"type\":\"agent_inject_reply\""));
                assert!(text.contains("\"sid\":\"chat-B\""));
                assert!(text.contains("\"name\":\"Bob\""));
                assert!(text.ends_with("done"));
                assert_eq!(sender.as_deref(), Some("agent:chat-B"));
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }

        // Pending row consumed.
        let conn = database::connection();
        assert!(graph_db::get_pending_message(&conn, "msg-1")
            .expect("query")
            .is_none());
    }
}
