//! ACP WebSocket handler for Grove Web

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::acp::{
    self, AcpStartConfig, AcpUpdate, ContentBlockData, PromptCapabilitiesData, QueuedMessage,
};
use crate::storage::{chat_attachments, chat_history, config, tasks, workspace};

/// Client-to-server messages
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Prompt {
        text: String,
        #[serde(default)]
        attachments: Vec<ContentBlockData>,
        #[serde(default)]
        sender: Option<String>,
        #[serde(default)]
        terminal: bool,
    },
    Cancel,
    /// Explicitly kill the ACP session
    Kill,
    /// Switch agent mode dynamically
    SetMode {
        mode_id: String,
    },
    /// Switch agent model dynamically
    SetModel {
        model_id: String,
    },
    /// Change the thought-level / reasoning-effort selector
    SetThoughtLevel {
        config_id: String,
        value_id: String,
    },
    /// Respond to a permission request. `id` is the request id (ACP tool_call_id)
    /// so the server can verify the response targets the live pending tx and not
    /// a stale dialog the frontend was still rendering from history.
    PermissionResponse {
        #[serde(default)]
        id: String,
        option_id: String,
    },
    /// Add a message to the pending queue
    QueueMessage {
        text: String,
        #[serde(default)]
        attachments: Vec<ContentBlockData>,
    },
    /// Remove a message from the pending queue by index
    DequeueMessage {
        index: usize,
    },
    /// Edit a queued message by index
    UpdateQueuedMessage {
        index: usize,
        text: String,
    },
    /// Clear all pending messages
    ClearQueue,
    /// Pause queue auto-send (user is editing a queued message)
    PauseQueue,
    /// Resume queue auto-send (user finished editing)
    ResumeQueue,
    /// Execute a terminal command directly (Shell mode, bypasses AI)
    TerminalExecute {
        command: String,
    },
    /// Kill a running user terminal command
    TerminalKill,
    /// 用户在 AuthRequired 横幅上点击登录按钮。method_id 来自前端从
    /// `auth_required` server message 拿到的同名字段,原样回传。
    Authenticate {
        method_id: String,
    },
}

/// Server-to-client messages (serialized AcpUpdate)
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    SessionReady {
        session_id: String,
        agent_name: String,
        agent_version: String,
        available_modes: Vec<ModeOption>,
        current_mode_id: Option<String>,
        available_models: Vec<ModelOption>,
        current_model_id: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        available_thought_levels: Vec<ThoughtLevelOption>,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_thought_level_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thought_level_config_id: Option<String>,
        prompt_capabilities: PromptCapabilitiesData,
        /// agent 是否声明了 `session.fork` 能力 — 前端据此显示 Fork 按钮
        fork_capable: bool,
    },
    MessageChunk {
        text: String,
    },
    ThoughtChunk {
        text: String,
    },
    ToolCall {
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        locations: Vec<LocationMsg>,
    },
    ToolCallUpdate {
        id: String,
        status: String,
        content: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        locations: Vec<LocationMsg>,
    },
    PermissionRequest {
        id: String,
        description: String,
        options: Vec<PermOptionMsg>,
    },
    PermissionResponse {
        id: String,
        option_id: String,
    },
    Complete {
        stop_reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<crate::acp::TurnUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        start_ts: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        end_ts: Option<i64>,
    },
    Busy {
        value: bool,
    },
    Error {
        message: String,
    },
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<ContentBlockData>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sender: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        terminal: bool,
    },
    /// Session is owned by another process (read-only observation mode)
    RemoteSession {
        owner_pid: u32,
        agent_name: String,
    },
    ModeChanged {
        mode_id: String,
    },
    ModelChanged {
        model_id: String,
    },
    ThoughtLevelsUpdate {
        #[serde(skip_serializing_if = "Vec::is_empty")]
        available: Vec<ThoughtLevelOption>,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        config_id: Option<String>,
    },
    PlanUpdate {
        entries: Vec<PlanEntryMsg>,
    },
    AvailableCommands {
        commands: Vec<CommandMsg>,
    },
    QueueUpdate {
        messages: Vec<QueuedMessage>,
    },
    PlanFileUpdate {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    SessionEnded,
    /// 用户直接执行终端命令（Shell 模式）
    TerminalExecute {
        command: String,
    },
    /// 终端输出片段
    TerminalChunk {
        output: String,
    },
    /// 终端命令执行完成
    TerminalComplete {
        exit_code: Option<i32>,
    },
    /// Pre-spawn UI hint — see `AcpUpdate::ConnectPhase`.
    ConnectPhase {
        phase: String,
    },
    /// Context window usage update — see `AcpUpdate::UsageUpdate`.
    UsageUpdate {
        used: u64,
        size: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost: Option<crate::acp::UsageCost>,
    },
    /// agent 通过 -32000 报需登录。`methods` 是 agent 在 initialize 时声明的
    /// 全部登录方法 — 前端为每个渲染一个按钮,用户点哪个就用哪个 method_id
    /// 走 ClientMessage::Authenticate 回传。空数组表示 agent 没声明任何方法,
    /// UI 显示提示让用户在终端里用 agent 自己的 CLI 登录。
    AuthRequired {
        #[serde(skip_serializing_if = "Vec::is_empty")]
        methods: Vec<AuthMethodMsg>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_name: Option<String>,
    },
    /// authenticate 调用成功。前端把 banner 状态切到"登录成功,正在重试...",
    /// 后续会自动收到原 prompt 的 UserMessage / Busy 流。
    AuthSucceeded,
}

#[derive(Debug, Serialize, Clone)]
struct AuthMethodMsg {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ModeOption {
    id: String,
    name: String,
}

#[derive(Debug, Serialize, Clone)]
struct ModelOption {
    id: String,
    name: String,
}

#[derive(Debug, Serialize, Clone)]
struct ThoughtLevelOption {
    id: String,
    name: String,
}

#[derive(Debug, Serialize, Clone)]
struct PlanEntryMsg {
    content: String,
    status: String,
}

#[derive(Debug, Serialize, Clone)]
struct CommandMsg {
    name: String,
    description: String,
    input_hint: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct LocationMsg {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
struct PermOptionMsg {
    option_id: String,
    name: String,
    kind: String,
}

#[derive(Debug, Deserialize)]
pub struct UploadAttachmentRequest {
    name: String,
    #[serde(default)]
    mime_type: Option<String>,
    data: String,
}

#[derive(Debug, Serialize)]
pub struct UploadAttachmentResponse {
    r#type: String,
    uri: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    size: i64,
}

impl From<AcpUpdate> for ServerMessage {
    fn from(update: AcpUpdate) -> Self {
        match update {
            AcpUpdate::SessionReady {
                session_id,
                agent_name,
                agent_version,
                available_modes,
                current_mode_id,
                available_models,
                current_model_id,
                available_thought_levels,
                current_thought_level_id,
                thought_level_config_id,
                prompt_capabilities,
                fork_capable,
            } => ServerMessage::SessionReady {
                session_id,
                agent_name,
                agent_version,
                available_modes: available_modes
                    .into_iter()
                    .map(|(id, name)| ModeOption { id, name })
                    .collect(),
                current_mode_id,
                available_models: available_models
                    .into_iter()
                    .map(|(id, name)| ModelOption { id, name })
                    .collect(),
                current_model_id,
                available_thought_levels: available_thought_levels
                    .into_iter()
                    .map(|(id, name)| ThoughtLevelOption { id, name })
                    .collect(),
                current_thought_level_id,
                thought_level_config_id,
                prompt_capabilities,
                fork_capable,
            },
            AcpUpdate::MessageChunk { text } => ServerMessage::MessageChunk { text },
            AcpUpdate::ThoughtChunk { text } => ServerMessage::ThoughtChunk { text },
            AcpUpdate::ToolCall {
                id,
                title,
                locations,
                ..
            } => ServerMessage::ToolCall {
                id,
                title,
                locations: locations
                    .into_iter()
                    .map(|(path, line)| LocationMsg { path, line })
                    .collect(),
            },
            AcpUpdate::ToolCallUpdate {
                id,
                status,
                content,
                locations,
            } => ServerMessage::ToolCallUpdate {
                id,
                status,
                content,
                locations: locations
                    .into_iter()
                    .map(|(path, line)| LocationMsg { path, line })
                    .collect(),
            },
            AcpUpdate::PermissionRequest {
                id,
                description,
                options,
            } => ServerMessage::PermissionRequest {
                id,
                description,
                options: options
                    .into_iter()
                    .map(|o| PermOptionMsg {
                        option_id: o.option_id,
                        name: o.name,
                        kind: o.kind,
                    })
                    .collect(),
            },
            AcpUpdate::PermissionResponse { id, option_id } => {
                ServerMessage::PermissionResponse { id, option_id }
            }
            AcpUpdate::Complete {
                stop_reason,
                usage,
                start_ts,
                end_ts,
            } => ServerMessage::Complete {
                stop_reason,
                usage,
                start_ts,
                end_ts,
            },
            AcpUpdate::Busy { value } => ServerMessage::Busy { value },
            AcpUpdate::Error { message } => ServerMessage::Error { message },
            AcpUpdate::UserMessage {
                text,
                attachments,
                sender,
                terminal,
            } => ServerMessage::UserMessage {
                text,
                attachments,
                sender,
                terminal,
            },
            AcpUpdate::ModeChanged { mode_id } => ServerMessage::ModeChanged { mode_id },
            AcpUpdate::ModelChanged { model_id } => ServerMessage::ModelChanged { model_id },
            AcpUpdate::ThoughtLevelsUpdate {
                available,
                current,
                config_id,
            } => ServerMessage::ThoughtLevelsUpdate {
                available: available
                    .into_iter()
                    .map(|(id, name)| ThoughtLevelOption { id, name })
                    .collect(),
                current,
                config_id,
            },
            AcpUpdate::PlanUpdate { entries } => ServerMessage::PlanUpdate {
                entries: entries
                    .into_iter()
                    .map(|e| PlanEntryMsg {
                        content: e.content,
                        status: e.status,
                    })
                    .collect(),
            },
            AcpUpdate::AvailableCommands { commands } => ServerMessage::AvailableCommands {
                commands: commands
                    .into_iter()
                    .map(|c| CommandMsg {
                        name: c.name,
                        description: c.description,
                        input_hint: c.input_hint,
                    })
                    .collect(),
            },
            AcpUpdate::QueueUpdate { messages } => ServerMessage::QueueUpdate { messages },
            AcpUpdate::PlanFileUpdate { path, content } => {
                ServerMessage::PlanFileUpdate { path, content }
            }
            AcpUpdate::SessionEnded => ServerMessage::SessionEnded,
            AcpUpdate::TerminalExecute { command } => ServerMessage::TerminalExecute { command },
            AcpUpdate::TerminalChunk { output } => ServerMessage::TerminalChunk { output },
            AcpUpdate::TerminalComplete { exit_code } => {
                ServerMessage::TerminalComplete { exit_code }
            }
            AcpUpdate::ConnectPhase { phase } => ServerMessage::ConnectPhase { phase },
            AcpUpdate::UsageUpdate { used, size, cost } => {
                ServerMessage::UsageUpdate { used, size, cost }
            }
            AcpUpdate::AuthRequired {
                methods,
                agent_name,
            } => ServerMessage::AuthRequired {
                methods: methods
                    .into_iter()
                    .map(|m| AuthMethodMsg {
                        id: m.id,
                        name: m.name,
                        description: m.description,
                    })
                    .collect(),
                agent_name,
            },
            AcpUpdate::AuthSucceeded => ServerMessage::AuthSucceeded,
        }
    }
}

/// Handle the ACP WebSocket connection
async fn handle_acp_ws(socket: WebSocket, session_key: String, config: AcpStartConfig) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Check if we're reattaching to an existing session
    let is_existing = acp::session_exists(&session_key);
    let should_cancel_replayed_unresolved_events = !is_existing
        && config.chat_id.as_ref().is_some_and(|chat_id| {
            tasks::get_chat_session(&config.project_key, &config.task_id, chat_id)
                .ok()
                .flatten()
                .and_then(|chat| chat.acp_session_id)
                .is_some()
        });

    // Guard: if session is owned by another process, notify frontend for read-only mode
    if !is_existing {
        if let Some(ref chat_id) = config.chat_id {
            let session_key_check =
                format!("{}:{}:{}", config.project_key, config.task_id, chat_id);
            if let Some(acp::SessionAccess::Remote { .. }) = acp::discover_session(
                &config.project_key,
                &config.task_id,
                chat_id,
                &session_key_check,
            ) {
                // Read session metadata for owner info
                let metadata =
                    acp::read_session_metadata(&config.project_key, &config.task_id, chat_id);
                let msg = ServerMessage::RemoteSession {
                    owner_pid: metadata.as_ref().map(|m| m.pid).unwrap_or(0),
                    agent_name: metadata
                        .as_ref()
                        .map(|m| m.agent_name.clone())
                        .unwrap_or_else(|| "Unknown".to_string()),
                };
                if let Ok(json) = serde_json::to_string(&msg) {
                    let _ = ws_sender.send(Message::Text(json.into())).await;
                }
                return;
            }
        }
    }

    // Cancel unresolved events for new sessions
    if !is_existing {
        if let Some(ref chat_id) = config.chat_id {
            if should_cancel_replayed_unresolved_events {
                let _ = crate::storage::chat_history::cancel_unresolved_events(
                    &config.project_key,
                    &config.task_id,
                    chat_id,
                );
            }
        }
    }

    // History is loaded by the frontend via HTTP GET /history (separate path).
    // WS only handles real-time events going forward.

    // Snapshot fields we still need after config is moved into get_or_start_session.
    let history_project_key = config.project_key.clone();
    let history_task_id = config.task_id.clone();
    let history_chat_id = config.chat_id.clone();

    // Get or start ACP session (thread managed by acp module)
    let (handle, mut update_rx) = match acp::get_or_start_session(session_key, config).await {
        Ok(r) => r,
        Err(e) => {
            let msg = ServerMessage::Error {
                message: format!("Failed to start ACP session: {}", e),
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_sender.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    // For existing sessions, construct SessionReady from metadata so frontend can interact.
    // History is already loaded via HTTP.
    if is_existing {
        // Reconnect 时 agent 还卡在 -32000 等登录:跳过假 SessionReady,
        // 改发 AuthRequired 让前端继续显示 banner。否则前端误以为已 Connected,
        // 用户发的 prompt 会落进 inner auth-wait loop 被静默丢弃。
        let pending_auth_snapshot = handle.pending_auth.lock().ok().and_then(|s| s.clone());
        let auth_pending = pending_auth_snapshot.is_some();
        if let Some(pending) = pending_auth_snapshot {
            let msg = ServerMessage::AuthRequired {
                methods: pending
                    .methods
                    .into_iter()
                    .map(|m| AuthMethodMsg {
                        id: m.id,
                        name: m.name,
                        description: m.description,
                    })
                    .collect(),
                agent_name: pending.agent_name,
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_sender.send(Message::Text(json.into())).await;
            }
            // 保留 ws_sender / receiver 走主消息循环,不 return — 用户点登录的
            // ClientMessage::Authenticate 仍要进 cmd 通道。session/new 还没成功,
            // 后续 SessionReady / AvailableCommands 拉取也跳过。
        }
        let meta = (|| {
            let (persist_proj, persist_tsk, persist_cid) = handle.persist_info();
            let cid = persist_cid?;
            acp::read_session_metadata(&persist_proj, &persist_tsk, &cid)
        })();
        let meta_msg = meta
            .clone()
            .map(|meta| {
                let info = handle.agent_info.read().ok().and_then(|i| i.clone());
                let (sid, _name, _ver) = info.unwrap_or_default();
                ServerMessage::SessionReady {
                    session_id: sid,
                    agent_name: meta.agent_name,
                    agent_version: meta.agent_version,
                    available_modes: meta
                        .available_modes
                        .into_iter()
                        .map(|(id, name)| ModeOption { id, name })
                        .collect(),
                    current_mode_id: meta.current_mode_id,
                    available_models: meta
                        .available_models
                        .into_iter()
                        .map(|(id, name)| ModelOption { id, name })
                        .collect(),
                    current_model_id: meta.current_model_id,
                    available_thought_levels: meta
                        .available_thought_levels
                        .into_iter()
                        .map(|(id, name)| ThoughtLevelOption { id, name })
                        .collect(),
                    current_thought_level_id: meta.current_thought_level_id,
                    thought_level_config_id: meta.thought_level_config_id,
                    prompt_capabilities: meta.prompt_capabilities,
                    fork_capable: handle
                        .fork_capable
                        .load(std::sync::atomic::Ordering::Relaxed),
                }
            })
            .unwrap_or_else(|| {
                // Fallback: metadata missing or corrupt — send minimal SessionReady with defaults
                let info = handle.agent_info.read().ok().and_then(|i| i.clone());
                let (sid, name, ver) = info.unwrap_or_default();
                ServerMessage::SessionReady {
                    session_id: sid,
                    agent_name: name,
                    agent_version: ver,
                    available_modes: Vec::new(),
                    current_mode_id: None,
                    available_models: Vec::new(),
                    current_model_id: None,
                    available_thought_levels: Vec::new(),
                    current_thought_level_id: None,
                    thought_level_config_id: None,
                    prompt_capabilities: PromptCapabilitiesData::default(),
                    fork_capable: handle
                        .fork_capable
                        .load(std::sync::atomic::Ordering::Relaxed),
                }
            });
        if !auth_pending {
            if let Ok(json) = serde_json::to_string(&meta_msg) {
                let _ = ws_sender.send(Message::Text(json.into())).await;
            }
        }
        if let Some(meta) = meta
            .as_ref()
            .filter(|meta| !meta.available_commands.is_empty())
        {
            let msg = ServerMessage::AvailableCommands {
                commands: meta
                    .available_commands
                    .iter()
                    .cloned()
                    .map(|c| CommandMsg {
                        name: c.name,
                        description: c.description,
                        input_hint: c.input_hint,
                    })
                    .collect(),
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_sender.send(Message::Text(json.into())).await;
            }
        }
        // Restore the persisted context-window snapshot. Hydrate the in-memory
        // mutex on cold reattach (process restart) so subsequent reads stay
        // consistent, and push a UsageUpdate to this WS so the pill renders
        // immediately without waiting for the next agent push.
        if let Some(snapshot) = meta.as_ref().and_then(|m| m.current_usage.clone()) {
            if let Ok(mut guard) = handle.current_usage.lock() {
                if guard.is_none() {
                    *guard = Some(snapshot.clone());
                }
            }
            let msg = ServerMessage::UsageUpdate {
                used: snapshot.used,
                size: snapshot.size,
                cost: snapshot.cost,
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_sender.send(Message::Text(json.into())).await;
            }
        }
    }

    // Reconcile permission state on every WS connect (both fresh and reattach).
    //
    // History 与 backend live state 之间唯一的对账规则：每条 history 中
    // unresolved 的 PermissionRequest，按 id 与 backend 的 live pending 比对：
    //   - 同 id → 它就是 live pending 本身，留给前端按 history 渲染并响应；
    //     前端 GET /history 里那条 PermissionRequest 就是 dialog 的来源。
    //   - 异 id 或 backend 无 pending → 真孤儿（进程崩、take-control kill、
    //     旧 session 没人响应就关闭等），通过 emit 落盘 + 广播 Cancelled，
    //     下次重连就不会再看到。
    //
    // 不再发 WS-only synthetic Cancelled —— 所有 cancel 都走 emit，确保多 WS
    // 视图状态一致。
    if let Some(ref chat_id) = history_chat_id {
        let history = chat_history::load_history(&history_project_key, &history_task_id, chat_id);
        let unresolved_ids = chat_history::unresolved_permission_ids(&history);
        let live_id = handle.pending_permission_id();
        for id in unresolved_ids {
            if Some(&id) == live_id.as_ref() {
                continue;
            }
            handle.emit(AcpUpdate::PermissionResponse {
                id,
                option_id: "Cancelled".to_string(),
            });
        }
    }

    // Sync busy state on (re)connect
    if is_existing && handle.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
        let msg = ServerMessage::Busy { value: true };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = ws_sender.send(Message::Text(json.into())).await;
        }
    }

    // Send current pending queue state on (re)connect
    let queue = handle.get_queue();
    if !queue.is_empty() {
        let msg = ServerMessage::QueueUpdate { messages: queue };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = ws_sender.send(Message::Text(json.into())).await;
        }
    }

    let handle_for_input = handle.clone();

    // Task: Forward ACP updates to WebSocket
    let updates_to_ws = tokio::spawn(async move {
        loop {
            match update_rx.recv().await {
                Ok(update) => {
                    let is_ended = matches!(update, AcpUpdate::SessionEnded);
                    let msg: ServerMessage = update.into();
                    if let Ok(json) = serde_json::to_string(&msg) {
                        if ws_sender.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    if is_ended {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    });

    // Task: Forward WebSocket messages to ACP
    let ws_to_acp = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                        match client_msg {
                            ClientMessage::Prompt {
                                text,
                                attachments,
                                sender,
                                terminal,
                            } => {
                                if let Err(e) = handle_for_input
                                    .send_prompt(text, attachments, sender, terminal)
                                    .await
                                {
                                    eprintln!("Failed to send prompt: {}", e);
                                    break;
                                }
                            }
                            ClientMessage::Cancel => {
                                let _ = handle_for_input.cancel().await;
                            }
                            ClientMessage::Kill => {
                                let _ = handle_for_input.kill().await;
                                break;
                            }
                            ClientMessage::SetMode { mode_id } => {
                                let _ = handle_for_input.set_mode(mode_id).await;
                            }
                            ClientMessage::SetModel { model_id } => {
                                let _ = handle_for_input.set_model(model_id).await;
                            }
                            ClientMessage::SetThoughtLevel {
                                config_id,
                                value_id,
                            } => {
                                let _ = handle_for_input
                                    .set_thought_level(config_id, value_id)
                                    .await;
                            }
                            ClientMessage::PermissionResponse { id, option_id } => {
                                // Reject responses targeting a stale dialog —
                                // when the frontend rendered it from history but
                                // the live pending has moved on or never matched.
                                let live_id = handle_for_input.pending_permission_id();
                                if !id.is_empty() && live_id.as_deref() != Some(id.as_str()) {
                                    handle_for_input.emit(AcpUpdate::Error {
                                        message: format!(
                                            "Permission request {} is no longer pending",
                                            id
                                        ),
                                    });
                                } else if !handle_for_input.respond_permission(option_id) {
                                    handle_for_input.emit(AcpUpdate::Error {
                                        message: "No pending permission request".to_string(),
                                    });
                                }
                            }
                            ClientMessage::QueueMessage { text, attachments } => {
                                // 快照当前 config，确保出队时使用正确的 model/mode/thought_level
                                let config = Some(handle_for_input.snapshot_config());
                                let messages = handle_for_input.queue_message(QueuedMessage {
                                    text,
                                    attachments,
                                    sender: None,
                                    config,
                                });
                                handle_for_input.emit(AcpUpdate::QueueUpdate { messages });
                            }
                            ClientMessage::DequeueMessage { index } => {
                                let messages = handle_for_input.dequeue_message(index);
                                handle_for_input.emit(AcpUpdate::QueueUpdate { messages });
                            }
                            ClientMessage::UpdateQueuedMessage { index, text } => {
                                let messages = handle_for_input.update_queued_message(index, text);
                                handle_for_input.emit(AcpUpdate::QueueUpdate { messages });
                            }
                            ClientMessage::ClearQueue => {
                                let messages = handle_for_input.clear_queue();
                                handle_for_input.emit(AcpUpdate::QueueUpdate { messages });
                            }
                            ClientMessage::PauseQueue => {
                                handle_for_input.pause_queue();
                            }
                            ClientMessage::ResumeQueue => {
                                handle_for_input.resume_queue();
                            }
                            ClientMessage::TerminalExecute { command } => {
                                handle_for_input.execute_terminal(command);
                            }
                            ClientMessage::TerminalKill => {
                                handle_for_input.kill_terminal();
                            }
                            ClientMessage::Authenticate { method_id } => {
                                if let Err(e) = handle_for_input.authenticate(method_id).await {
                                    handle_for_input.emit(AcpUpdate::Error {
                                        message: format!("Authenticate dispatch failed: {}", e),
                                    });
                                }
                            }
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish, detect panics
    tokio::select! {
        result = updates_to_ws => {
            if let Err(ref e) = result { if e.is_panic() { eprintln!("[Grove] ACP updates-to-WS task panicked"); } }
        },
        result = ws_to_acp => {
            if let Err(ref e) = result { if e.is_panic() { eprintln!("[Grove] ACP WS-to-ACP task panicked"); } }
        },
    }

    // Note: we do NOT kill the session here.
    // The session stays alive for future WebSocket connections.
    // It's only killed explicitly via ClientMessage::Kill.
}

/// Error type for ACP handler
pub enum AcpError {
    NotFound(String),
    Internal(String),
}

impl IntoResponse for AcpError {
    fn into_response(self) -> Response {
        match self {
            AcpError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            AcpError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response(),
        }
    }
}

// ─── Chat CRUD DTOs ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChatSessionResponse {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub created_at: String,
    /// Absolute path to this chat's history.jsonl on disk. Surfaced so the
    /// `Read History` @-mention can hand the path to the AI; the AI uses its
    /// own Read tool to inspect the file.
    pub history_path: String,
}

#[derive(Serialize)]
pub struct ChatListResponse {
    pub chats: Vec<ChatSessionResponse>,
}

#[derive(Deserialize)]
pub struct CreateChatRequest {
    pub title: Option<String>,
    pub agent: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateChatRequest {
    pub title: String,
}

impl ChatSessionResponse {
    fn build(project_key: &str, task_id: &str, chat: &tasks::ChatSession) -> Self {
        let abs = crate::storage::chat_history::history_file_path(project_key, task_id, &chat.id);
        // Render as `~/...` when under HOME so the absolute username never
        // leaks through the API. AI agents resolve `~` themselves.
        let history_path = match dirs::home_dir() {
            Some(home) => match abs.strip_prefix(&home) {
                Ok(rel) => format!("~/{}", rel.display()),
                Err(_) => abs.to_string_lossy().into_owned(),
            },
            None => abs.to_string_lossy().into_owned(),
        };
        Self {
            id: chat.id.clone(),
            title: chat.title.clone(),
            agent: chat.agent.clone(),
            created_at: chat.created_at.to_rfc3339(),
            history_path,
        }
    }
}

/// 构建 GROVE_* 环境变量，注入 task 上下文给 ACP agent
pub(crate) fn build_grove_env(
    project_key: &str,
    project_path: &str,
    project_name: &str,
    task: &tasks::Task,
    chat_id: Option<&str>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("GROVE_TASK_ID".into(), task.id.clone());
    env.insert("GROVE_TASK_NAME".into(), task.name.clone());
    env.insert("GROVE_BRANCH".into(), task.branch.clone());
    env.insert("GROVE_TARGET".into(), task.target.clone());
    env.insert("GROVE_WORKTREE".into(), task.worktree_path.clone());
    env.insert("GROVE_PROJECT_NAME".into(), project_name.into());
    env.insert("GROVE_PROJECT".into(), project_path.into());
    env.insert("GROVE_PROJECT_KEY".into(), project_key.into());
    if let Some(cid) = chat_id {
        env.insert("GROVE_CHAT_ID".into(), cid.into());
    }
    env
}

/// Helper: resolve project key, path, name from project_id path param
fn resolve_project_key(project_id: &str) -> Result<(String, String, String), AcpError> {
    let projects = workspace::load_projects()
        .map_err(|e| AcpError::Internal(format!("Failed to load projects: {}", e)))?;
    let project = projects
        .iter()
        .find(|p| workspace::project_hash(&p.path) == project_id)
        .ok_or(AcpError::NotFound("Project not found".to_string()))?;
    let project_key = workspace::project_hash(&project.path);
    Ok((project_key, project.path.clone(), project.name.clone()))
}

// ─── Chat CRUD Handlers ─────────────────────────────────────────────────────

/// List all chats for a task
pub async fn list_chats(
    Path((project_id, task_id)): Path<(String, String)>,
) -> Result<Json<ChatListResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;
    let _ = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    let chats = tasks::load_chat_sessions(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    Ok(Json(ChatListResponse {
        chats: chats
            .iter()
            .map(|c| ChatSessionResponse::build(&project_key, &task_id, c))
            .collect(),
    }))
}

/// Create a new chat for a task
pub async fn create_chat(
    Path((project_id, task_id)): Path<(String, String)>,
    Json(body): Json<CreateChatRequest>,
) -> Result<Json<ChatSessionResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;
    let _ = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    let cfg = config::load_config();
    let agent = body.agent.unwrap_or_else(|| {
        cfg.acp
            .agent_command
            .unwrap_or_else(|| "claude".to_string())
    });
    let now = chrono::Utc::now();
    let title = body
        .title
        .unwrap_or_else(|| format!("New Chat {}", now.format("%Y-%m-%d %H:%M")));

    let chat = tasks::ChatSession {
        id: tasks::generate_chat_id(),
        title,
        agent,
        acp_session_id: None,
        created_at: now,
        duty: None,
    };

    tasks::add_chat_session(&project_key, &task_id, chat.clone())
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    crate::api::handlers::walkie_talkie::broadcast_radio_event(
        crate::api::handlers::walkie_talkie::RadioEvent::ChatListChanged {
            project_id: project_id.clone(),
            task_id: task_id.clone(),
        },
    );

    Ok(Json(ChatSessionResponse::build(
        &project_key,
        &task_id,
        &chat,
    )))
}

/// Update a chat's title
pub async fn update_chat(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
    Json(body): Json<UpdateChatRequest>,
) -> Result<Json<ChatSessionResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;

    tasks::update_chat_title(&project_key, &task_id, &chat_id, &body.title)
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    let chat = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Chat not found".to_string()))?;

    // Notify other surfaces (graph, chat header in another pane, sidebar) that
    // the chat roster changed so they refetch and pick up the new title.
    crate::api::handlers::walkie_talkie::broadcast_radio_event(
        crate::api::handlers::walkie_talkie::RadioEvent::ChatListChanged {
            project_id: project_id.clone(),
            task_id: task_id.clone(),
        },
    );

    Ok(Json(ChatSessionResponse::build(
        &project_key,
        &task_id,
        &chat,
    )))
}

/// Delete a chat (and kill its ACP session if running)
pub async fn delete_chat(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<StatusCode, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;

    // Kill the ACP session for this chat if running
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
    let _ = acp::kill_session(&session_key);

    // Remove chat entry from chats.toml
    tasks::delete_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    // Clean up per-chat data directory (history.jsonl, session.json, etc.)
    let chat_dir = crate::storage::grove_dir()
        .join("projects")
        .join(&project_key)
        .join("tasks")
        .join(&task_id)
        .join("chats")
        .join(&chat_id);
    let _ = std::fs::remove_dir_all(&chat_dir);

    // Clean up socket file
    let _ = std::fs::remove_file(acp::sock_path(&project_key, &task_id, &chat_id));

    crate::api::handlers::walkie_talkie::broadcast_radio_event(
        crate::api::handlers::walkie_talkie::RadioEvent::ChatListChanged {
            project_id: project_id.clone(),
            task_id: task_id.clone(),
        },
    );

    Ok(StatusCode::NO_CONTENT)
}

/// Fork a chat: 调用 ACP `session/fork` 让 agent 派生新会话,然后在 grove 侧
/// 创建一个新的 chat 行(同 task,标题加 " (Fork)"),复制 history.jsonl,
/// 写入 fork 出来的 acp_session_id。新 chat 不立即 spawn 进程 — 用户首次打开
/// 时走标准 reconnect 路径(fresh agent + load_session(forked_id)),与现有
/// resume 机制完全一致。
///
/// 前置条件:被 fork 的 chat 当前必须有 in-memory ACP handle 在跑(必要条件,
/// session/fork 是个 RPC,得有人能发);并且 agent 在 init 阶段声明了 fork
/// capability(`fork_capable=true`),否则 RPC 会被 agent 拒。
pub async fn fork_chat(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<Json<ChatSessionResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;
    let _ = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    // 拿源 chat 元数据(用于继承 agent / title / duty)
    let src_chat = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Source chat not found".to_string()))?;

    // 找到正在跑的 ACP handle — 没跑就没法 fork
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
    let handle = acp::get_session_handle(&session_key)
        .ok_or(AcpError::NotFound("ACP session not running".to_string()))?;

    if !handle
        .fork_capable
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Err(AcpError::Internal(
            "Agent does not support session/fork".to_string(),
        ));
    }

    let cwd = std::path::PathBuf::from(&handle.working_dir);
    let new_acp_session_id = handle
        .fork_session(cwd)
        .await
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    // 创建新 chat 行
    let now = chrono::Utc::now();
    let new_chat = tasks::ChatSession {
        id: tasks::generate_chat_id(),
        title: format!("{} (Fork)", src_chat.title),
        agent: src_chat.agent.clone(),
        acp_session_id: Some(new_acp_session_id),
        created_at: now,
        duty: src_chat.duty.clone(),
    };
    tasks::add_chat_session(&project_key, &task_id, new_chat.clone())
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    // 复制 history.jsonl(失败不致命 — 新 chat 从空历史起步,
    // 用户首次打开仍能通过 load_session 让 agent 端回放)
    if let Err(e) =
        crate::storage::chat_history::copy_history(&project_key, &task_id, &chat_id, &new_chat.id)
    {
        eprintln!("[fork_chat] copy_history failed (non-fatal): {}", e);
    }

    // 同步 copy session.json:usage / mode / model / available_commands 等元数据
    // 让新 chat 首次打开时 ContextUsagePill / mode-picker 直接展示父 chat 的快照,
    // 而不是 fallback 到全空。`pid` 字段清零 — 新 chat 还没 spawn 进程,父进程的
    // pid 不该被任何 owner 检查认成"已上线"。新 agent SessionReady 时会用真 pid
    // 覆盖整个文件。
    if let Some(mut meta) =
        acp::read_session_metadata(&project_key, &task_id, &chat_id)
    {
        meta.pid = 0;
        let dst = acp::session_json_path(&project_key, &task_id, &new_chat.id);
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&meta) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&dst, json) {
                    eprintln!("[fork_chat] write session.json failed (non-fatal): {}", e);
                }
            }
            Err(e) => {
                eprintln!("[fork_chat] serialize session.json failed (non-fatal): {}", e);
            }
        }
    }

    crate::api::handlers::walkie_talkie::broadcast_radio_event(
        crate::api::handlers::walkie_talkie::RadioEvent::ChatListChanged {
            project_id: project_id.clone(),
            task_id: task_id.clone(),
        },
    );

    Ok(Json(ChatSessionResponse::build(
        &project_key,
        &task_id,
        &new_chat,
    )))
}

/// Store a non-image/audio chat attachment on disk and return an ACP resource_link payload.
/// For Studio projects, files are stored in the task's input/ directory instead of chat attachments.
pub async fn upload_chat_attachment(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
    Json(body): Json<UploadAttachmentRequest>,
) -> Result<Json<UploadAttachmentResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;

    let _ = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Chat not found".to_string()))?;

    // Studio projects: store in task input/ directory so agent can access via AGENTS.md rules
    let project = workspace::load_project_by_hash(&project_key).ok().flatten();

    let stored = if let Some(ref proj) = project {
        if proj.project_type == workspace::ProjectType::Studio {
            let input_dir = workspace::studio_project_dir(&proj.path)
                .join("tasks")
                .join(&task_id)
                .join("input");
            chat_attachments::store_attachment_to_dir(
                &input_dir,
                &body.name,
                body.mime_type.as_deref(),
                &body.data,
            )
        } else {
            chat_attachments::store_attachment(
                &project_key,
                &task_id,
                &chat_id,
                &body.name,
                body.mime_type.as_deref(),
                &body.data,
            )
        }
    } else {
        chat_attachments::store_attachment(
            &project_key,
            &task_id,
            &chat_id,
            &body.name,
            body.mime_type.as_deref(),
            &body.data,
        )
    }
    .map_err(|e| AcpError::Internal(e.to_string()))?;

    Ok(Json(UploadAttachmentResponse {
        r#type: "resource_link".to_string(),
        uri: stored.uri,
        name: stored.name,
        mime_type: stored.mime_type,
        size: stored.size,
    }))
}

// ─── Chat WebSocket Handler ─────────────────────────────────────────────────

/// WebSocket upgrade handler for per-chat ACP sessions
pub async fn chat_ws_handler(
    ws: WebSocketUpgrade,
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<Response, AcpError> {
    let (project_key, project_path, project_name) = resolve_project_key(&project_id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(format!("Failed to get task: {}", e)))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    // Find the chat session
    let chat = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Chat not found".to_string()))?;

    // Resolve agent command from the chat's stored agent.
    //
    // Custom Agent (persona) ids resolve to their underlying base_agent here;
    // the persona's system_prompt is then injected once on the **create**
    // session path (not on Resume) inside the ACP session bootstrap.
    let (effective_agent, persona_injection) =
        match crate::storage::custom_agent::try_get_persona(&chat.agent) {
            Ok(Some(persona)) => {
                // Always pass an injection bundle when the agent string is a
                // persona id — even with empty system_prompt, the model/mode/
                // effort still need to be applied on Create.
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
            _ => (chat.agent.clone(), None),
        };
    let resolved = acp::resolve_agent(&effective_agent).ok_or(AcpError::Internal(format!(
        "Unknown agent: {}",
        effective_agent
    )))?;

    let env_vars = build_grove_env(
        &project_key,
        &project_path,
        &project_name,
        &task,
        Some(&chat_id),
    );
    let working_dir = std::path::PathBuf::from(&task.worktree_path);
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);

    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_name: resolved.agent_name,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key,
        task_id,
        chat_id: Some(chat_id),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
        suppress_initial_connecting: false,
        persona_injection,
    };

    Ok(ws.on_upgrade(move |socket| handle_acp_ws(socket, session_key, config)))
}

// ─── History & Take Control Handlers ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub offset: Option<usize>,
}

#[derive(Serialize)]
pub(crate) struct HistoryResponse {
    events: Vec<ServerMessage>,
    total: usize,
    session: Option<acp::SessionMetadata>,
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/chats/{chatId}/history?offset=N
///
/// Returns chat history from the given offset.
pub async fn get_chat_history(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<HistoryResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;

    let history = chat_history::load_history(&project_key, &task_id, &chat_id);
    let total = history.len();
    let offset = params.offset.unwrap_or(0).min(total);
    let events: Vec<ServerMessage> = history[offset..]
        .iter()
        .cloned()
        .map(ServerMessage::from)
        .collect();

    let session = acp::read_session_metadata(&project_key, &task_id, &chat_id);

    Ok(Json(HistoryResponse {
        events,
        total,
        session,
    }))
}

#[derive(Serialize)]
pub struct TakeControlResponse {
    pub success: bool,
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/chats/{chatId}/take-control
///
/// Kill the remote session owner so the Web frontend can take over.
pub async fn take_control(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<Json<TakeControlResponse>, AcpError> {
    let (project_key, _, _) = resolve_project_key(&project_id)?;

    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);

    match acp::discover_session(&project_key, &task_id, &chat_id, &session_key) {
        Some(acp::SessionAccess::Remote { sock_path, .. }) => {
            // Send Kill command to the remote owner
            let kill_cmd = acp::SocketCommand::Kill;
            let _ = acp::send_socket_command(&sock_path, &kill_cmd)
                .await
                .map_err(|e| AcpError::Internal(format!("Failed to kill remote session: {}", e)))?;

            // Brief wait for the socket to become stale
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            Ok(Json(TakeControlResponse { success: true }))
        }
        Some(acp::SessionAccess::Local(_)) | None => {
            // Already local or no session — success
            Ok(Json(TakeControlResponse { success: true }))
        }
    }
}
