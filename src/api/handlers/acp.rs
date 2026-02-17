//! ACP WebSocket handler for Grove Web

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::acp::{self, AcpStartConfig, AcpUpdate};
use crate::storage::{config, tasks, workspace};

/// Client-to-server messages
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Prompt {
        text: String,
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
    /// Respond to a permission request
    PermissionResponse {
        option_id: String,
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
        description: String,
        options: Vec<PermOptionMsg>,
    },
    Complete {
        stop_reason: String,
    },
    Busy {
        value: bool,
    },
    Error {
        message: String,
    },
    UserMessage {
        text: String,
    },
    ModeChanged {
        mode_id: String,
    },
    PlanUpdate {
        entries: Vec<PlanEntryMsg>,
    },
    AvailableCommands {
        commands: Vec<CommandMsg>,
    },
    SessionEnded,
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
            },
            AcpUpdate::MessageChunk { text } => ServerMessage::MessageChunk { text },
            AcpUpdate::ThoughtChunk { text } => ServerMessage::ThoughtChunk { text },
            AcpUpdate::ToolCall {
                id,
                title,
                locations,
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
                description,
                options,
            } => ServerMessage::PermissionRequest {
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
            AcpUpdate::Complete { stop_reason } => ServerMessage::Complete { stop_reason },
            AcpUpdate::Busy(value) => ServerMessage::Busy { value },
            AcpUpdate::Error { message } => ServerMessage::Error { message },
            AcpUpdate::UserMessage { text } => ServerMessage::UserMessage { text },
            AcpUpdate::ModeChanged { mode_id } => ServerMessage::ModeChanged { mode_id },
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
            AcpUpdate::SessionEnded => ServerMessage::SessionEnded,
        }
    }
}

/// WebSocket upgrade handler for ACP chat
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path((project_id, task_id)): Path<(String, String)>,
) -> Result<Response, AcpError> {
    // 1. Find project and task
    let projects = workspace::load_projects()
        .map_err(|e| AcpError::Internal(format!("Failed to load projects: {}", e)))?;

    let project = projects
        .iter()
        .find(|p| workspace::project_hash(&p.path) == project_id)
        .ok_or(AcpError::NotFound("Project not found".to_string()))?;

    let project_key = workspace::project_hash(&project.path);

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(format!("Failed to get task: {}", e)))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    // 2. Resolve agent command
    let cfg = config::load_config();
    let agent_name = cfg
        .acp
        .agent_command
        .unwrap_or_else(|| "claude".to_string());
    let resolved = acp::resolve_agent(&agent_name)
        .ok_or(AcpError::Internal(format!("Unknown agent: {}", agent_name)))?;

    let env_vars = HashMap::new();

    let working_dir = std::path::PathBuf::from(&task.worktree_path);
    let session_key = format!("{}:{}", project_key, task_id);

    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key,
        task_id,
        chat_id: None,
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
    };

    Ok(ws.on_upgrade(move |socket| handle_acp_ws(socket, session_key, config)))
}

/// Handle the ACP WebSocket connection
async fn handle_acp_ws(socket: WebSocket, session_key: String, config: AcpStartConfig) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Check if we're reattaching to an existing session
    let is_existing = acp::session_exists(&session_key);

    // Get or start ACP session (thread managed by acp module)
    let (handle, mut update_rx) = match acp::get_or_start_session(session_key, config).await {
        Ok(r) => r,
        Err(e) => {
            let msg = ServerMessage::Error {
                message: format!("Failed to start ACP session: {}", e),
            };
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    // For existing sessions, replay full history so frontend rebuilds UI
    if is_existing {
        for update in handle.get_history() {
            let msg: ServerMessage = update.into();
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
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
                    let json = serde_json::to_string(&msg).unwrap();
                    if ws_sender.send(Message::Text(json.into())).await.is_err() {
                        break;
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
                            ClientMessage::Prompt { text } => {
                                if let Err(e) = handle_for_input.send_prompt(text).await {
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
                            ClientMessage::PermissionResponse { option_id } => {
                                handle_for_input.respond_permission(option_id);
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

    // Wait for either task to finish
    tokio::select! {
        _ = updates_to_ws => {},
        _ = ws_to_acp => {},
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

impl From<&tasks::ChatSession> for ChatSessionResponse {
    fn from(chat: &tasks::ChatSession) -> Self {
        Self {
            id: chat.id.clone(),
            title: chat.title.clone(),
            agent: chat.agent.clone(),
            created_at: chat.created_at.to_rfc3339(),
        }
    }
}

/// Helper: resolve project key from project_id path param
fn resolve_project_key(project_id: &str) -> Result<(String, String), AcpError> {
    let projects = workspace::load_projects()
        .map_err(|e| AcpError::Internal(format!("Failed to load projects: {}", e)))?;
    let project = projects
        .iter()
        .find(|p| workspace::project_hash(&p.path) == project_id)
        .ok_or(AcpError::NotFound("Project not found".to_string()))?;
    let project_key = workspace::project_hash(&project.path);
    Ok((project_key, project.path.clone()))
}

// ─── Chat CRUD Handlers ─────────────────────────────────────────────────────

/// List all chats for a task
pub async fn list_chats(
    Path((project_id, task_id)): Path<(String, String)>,
) -> Result<Json<ChatListResponse>, AcpError> {
    let (project_key, _) = resolve_project_key(&project_id)?;
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    // Migration: if task has acp_session_id but no chats, create one
    let chats = if task.acp_session_id.is_some() && task.chats.is_empty() {
        let cfg = config::load_config();
        let agent = cfg
            .acp
            .agent_command
            .unwrap_or_else(|| "claude".to_string());
        let chat = tasks::ChatSession {
            id: tasks::generate_chat_id(),
            title: format!("Chat {}", task.created_at.format("%Y-%m-%d %H:%M")),
            agent,
            acp_session_id: task.acp_session_id.clone(),
            created_at: task.created_at,
        };
        let _ = tasks::add_chat_session(&project_key, &task_id, chat.clone());
        vec![chat]
    } else {
        task.chats
    };

    Ok(Json(ChatListResponse {
        chats: chats.iter().map(ChatSessionResponse::from).collect(),
    }))
}

/// Create a new chat for a task
pub async fn create_chat(
    Path((project_id, task_id)): Path<(String, String)>,
    Json(body): Json<CreateChatRequest>,
) -> Result<Json<ChatSessionResponse>, AcpError> {
    let (project_key, _) = resolve_project_key(&project_id)?;
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
    };

    tasks::add_chat_session(&project_key, &task_id, chat.clone())
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    Ok(Json(ChatSessionResponse::from(&chat)))
}

/// Update a chat's title
pub async fn update_chat(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
    Json(body): Json<UpdateChatRequest>,
) -> Result<Json<ChatSessionResponse>, AcpError> {
    let (project_key, _) = resolve_project_key(&project_id)?;

    tasks::update_chat_title(&project_key, &task_id, &chat_id, &body.title)
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    let chat = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?
        .ok_or(AcpError::NotFound("Chat not found".to_string()))?;

    Ok(Json(ChatSessionResponse::from(&chat)))
}

/// Delete a chat (and kill its ACP session if running)
pub async fn delete_chat(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<StatusCode, AcpError> {
    let (project_key, _) = resolve_project_key(&project_id)?;

    // Kill the ACP session for this chat if running
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
    let _ = acp::kill_session(&session_key);

    tasks::delete_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AcpError::Internal(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

// ─── Chat WebSocket Handler ─────────────────────────────────────────────────

/// WebSocket upgrade handler for per-chat ACP sessions
pub async fn chat_ws_handler(
    ws: WebSocketUpgrade,
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<Response, AcpError> {
    let (project_key, _) = resolve_project_key(&project_id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AcpError::Internal(format!("Failed to get task: {}", e)))?
        .ok_or(AcpError::NotFound("Task not found".to_string()))?;

    // Find the chat session
    let chat = task
        .chats
        .iter()
        .find(|c| c.id == chat_id)
        .ok_or(AcpError::NotFound("Chat not found".to_string()))?;

    // Resolve agent command from the chat's stored agent
    let resolved = acp::resolve_agent(&chat.agent)
        .ok_or(AcpError::Internal(format!("Unknown agent: {}", chat.agent)))?;

    let env_vars = HashMap::new();
    let working_dir = std::path::PathBuf::from(&task.worktree_path);
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);

    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key,
        task_id,
        chat_id: Some(chat_id),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
    };

    Ok(ws.on_upgrade(move |socket| handle_acp_ws(socket, session_key, config)))
}
