//! ACP WebSocket handler for Grove Web

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
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
    },
    ToolCallUpdate {
        id: String,
        status: String,
        content: Option<String>,
    },
    PermissionRequest {
        description: String,
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
            AcpUpdate::ToolCall { id, title } => ServerMessage::ToolCall { id, title },
            AcpUpdate::ToolCallUpdate {
                id,
                status,
                content,
            } => ServerMessage::ToolCallUpdate {
                id,
                status,
                content,
            },
            AcpUpdate::PermissionRequest { description } => {
                ServerMessage::PermissionRequest { description }
            }
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
    let (agent_cmd, agent_args) = acp::resolve_agent_command(&agent_name)
        .ok_or(AcpError::Internal(format!("Unknown agent: {}", agent_name)))?;

    let env_vars = HashMap::new();

    let working_dir = std::path::PathBuf::from(&task.worktree_path);
    let session_key = format!("{}:{}", project_key, task_id);

    let config = AcpStartConfig {
        agent_command: agent_cmd,
        agent_args,
        working_dir,
        env_vars,
        project_key,
        task_id,
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
