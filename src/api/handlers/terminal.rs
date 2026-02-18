//! Terminal WebSocket handler for Grove Web

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::api::state;
use crate::session::{self, SessionType};
use crate::storage::{config, tasks, workspace};
use crate::tmux;
use crate::tmux::layout::{parse_custom_layout_tree, CustomLayout, TaskLayout};

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    /// Working directory for the terminal
    pub cwd: Option<String>,
    /// Columns (default: 80)
    pub cols: Option<u16>,
    /// Rows (default: 24)
    pub rows: Option<u16>,
}

/// WebSocket upgrade handler for simple terminal (shell)
pub async fn ws_handler(ws: WebSocketUpgrade, Query(query): Query<TerminalQuery>) -> Response {
    let cwd = query
        .cwd
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));
    let cols = query.cols.unwrap_or(80);
    let rows = query.rows.unwrap_or(24);

    ws.on_upgrade(move |socket| handle_shell_terminal(socket, cwd, cols, rows))
}

/// WebSocket upgrade handler for task terminal (tmux session)
pub async fn task_terminal_handler(
    ws: WebSocketUpgrade,
    Path((project_id, task_id)): Path<(String, String)>,
    Query(query): Query<TerminalQuery>,
) -> Result<Response, TaskTerminalError> {
    let cols = query.cols.unwrap_or(80);
    let rows = query.rows.unwrap_or(24);

    // 1. Find project
    let projects = workspace::load_projects()
        .map_err(|e| TaskTerminalError::Internal(format!("Failed to load projects: {}", e)))?;

    let project = projects
        .iter()
        .find(|p| workspace::project_hash(&p.path) == project_id)
        .ok_or(TaskTerminalError::NotFound("Project not found".to_string()))?
        .clone();

    let project_key = workspace::project_hash(&project.path);

    // 2. Find task
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| TaskTerminalError::Internal(format!("Failed to get task: {}", e)))?
        .ok_or(TaskTerminalError::NotFound("Task not found".to_string()))?;

    // 3. Resolve session type and build session name
    // For terminal endpoint: only use terminal multiplexer, never acp
    // If task has enable_terminal=true, use the configured multiplexer (tmux/zellij)
    // If task has enable_terminal=false, this endpoint shouldn't be called, but handle gracefully
    let task_session_type = if task.enable_terminal {
        // Use multiplexer field if it's tmux/zellij, otherwise use default from config
        match task.multiplexer.as_str() {
            "tmux" => SessionType::Tmux,
            "zellij" => SessionType::Zellij,
            _ => {
                // Fallback to config default (handles legacy "acp" multiplexer with enable_terminal=true)
                let cfg = config::load_config();
                match cfg.terminal_multiplexer {
                    config::TerminalMultiplexer::Tmux => SessionType::Tmux,
                    config::TerminalMultiplexer::Zellij => SessionType::Zellij,
                }
            }
        }
    } else {
        // Task doesn't have terminal enabled - shouldn't reach here but handle gracefully
        return Err(TaskTerminalError::Internal(
            "Terminal not enabled for this task".to_string(),
        ));
    };
    let session_name = session::resolve_session_name(&task.session_name, &project_key, &task_id);

    // 4. Ensure session exists (create if needed)
    let session_created = !session::session_exists(&task_session_type, &session_name);
    let mut zellij_layout_path: Option<String> = None;
    if session_created {
        zellij_layout_path =
            ensure_task_session(&project, &project_key, &task, &task_session_type)?;

        // Register FileWatcher for this task's worktree
        state::watch_task(&project_key, &task.id, &task.worktree_path);
    }

    let working_dir = task.worktree_path.clone();

    // 5. Upgrade to WebSocket and handle mux terminal
    Ok(ws.on_upgrade(move |socket| {
        handle_mux_terminal(
            socket,
            MuxTerminalParams {
                session_name,
                mux: task_session_type,
                new_session: session_created,
                working_dir,
                zellij_layout_path,
                cols,
                rows,
            },
        )
    }))
}

/// Error type for task terminal handler
pub enum TaskTerminalError {
    NotFound(String),
    Internal(String),
}

impl IntoResponse for TaskTerminalError {
    fn into_response(self) -> Response {
        match self {
            TaskTerminalError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            TaskTerminalError::Internal(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

/// Ensure the task's session exists, creating it if needed.
/// Returns the Zellij layout path if one was generated (for use at attach time).
fn ensure_task_session(
    project: &workspace::RegisteredProject,
    project_key: &str,
    task: &tasks::Task,
    session_type: &SessionType,
) -> Result<Option<String>, TaskTerminalError> {
    let session_name = session::resolve_session_name(&task.session_name, project_key, &task.id);

    // Build session environment
    let project_name = std::path::Path::new(&project.path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");

    let session_env = tmux::SessionEnv {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        branch: task.branch.clone(),
        target: task.target.clone(),
        worktree: task.worktree_path.clone(),
        project_name: project_name.to_string(),
        project_path: project.path.clone(),
    };

    // Create session
    session::create_session(
        session_type,
        &session_name,
        &task.worktree_path,
        Some(&session_env),
    )
    .map_err(|e| TaskTerminalError::Internal(format!("Failed to create session: {}", e)))?;

    // Load config and apply layout
    let cfg = config::load_config();
    let layout = TaskLayout::from_name(&cfg.layout.default).unwrap_or(TaskLayout::Single);
    let agent_cmd = cfg.layout.agent_command.clone().unwrap_or_default();

    // Parse custom layout if needed
    let custom_layout = if layout == TaskLayout::Custom {
        cfg.layout.custom.as_ref().and_then(|c| {
            parse_custom_layout_tree(&c.tree, cfg.layout.selected_custom_id.as_deref())
                .map(|root| CustomLayout { root })
        })
    } else {
        None
    };

    // Apply layout
    let mut layout_path: Option<String> = None;
    match session_type {
        SessionType::Acp => {
            // ACP tasks use chat interface, not terminal
            return Ok(None);
        }
        SessionType::Tmux => {
            if layout != TaskLayout::Single {
                if let Err(e) = tmux::layout::apply_layout(
                    &session_name,
                    &task.worktree_path,
                    &layout,
                    &agent_cmd,
                    custom_layout.as_ref(),
                ) {
                    eprintln!("Warning: Failed to apply layout: {}", e);
                }
            }
        }
        SessionType::Zellij => {
            // Zellij: 始终生成 KDL layout 以通过 pane 命令注入环境变量
            let kdl = crate::zellij::layout::generate_kdl(
                &layout,
                &agent_cmd,
                custom_layout.as_ref(),
                &session_env.shell_export_prefix(),
            );
            match crate::zellij::layout::write_session_layout(&session_name, &kdl) {
                Ok(path) => layout_path = Some(path),
                Err(e) => eprintln!("Warning: Failed to write zellij layout: {}", e),
            }
        }
    }

    Ok(layout_path)
}

/// Handle the WebSocket connection for a simple shell terminal
async fn handle_shell_terminal(socket: WebSocket, cwd: String, cols: u16, rows: u16) {
    // Get the user's default shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

    // Create command
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);

    handle_pty_terminal(socket, cmd, cols, rows).await;
}

/// Parameters for multiplexer terminal connection
struct MuxTerminalParams {
    session_name: String,
    mux: SessionType,
    new_session: bool,
    working_dir: String,
    zellij_layout_path: Option<String>,
    cols: u16,
    rows: u16,
}

/// Handle the WebSocket connection for a multiplexer session terminal
async fn handle_mux_terminal(socket: WebSocket, params: MuxTerminalParams) {
    let MuxTerminalParams {
        session_name,
        mux,
        new_session,
        working_dir,
        zellij_layout_path,
        cols,
        rows,
    } = params;
    match mux {
        SessionType::Tmux => {
            let mut cmd = CommandBuilder::new("tmux");
            cmd.arg("attach-session");
            cmd.arg("-t");
            cmd.arg(&session_name);
            handle_pty_terminal(socket, cmd, cols, rows).await;
        }
        SessionType::Zellij => {
            let mut cmd = CommandBuilder::new("zellij");
            // Remove ZELLIJ env vars to prevent nested session issues
            cmd.env_remove("ZELLIJ");
            cmd.env_remove("ZELLIJ_SESSION_NAME");
            cmd.cwd(&working_dir);

            if new_session {
                // New session: use `zellij -s <name>` (mirrors TUI attach_session logic)
                // Clean up any EXITED residual session first
                let _ = std::process::Command::new("zellij")
                    .args(["delete-session", &session_name])
                    .output();

                cmd.arg("-s");
                cmd.arg(&session_name);
                if let Some(lp) = &zellij_layout_path {
                    cmd.arg("-n");
                    cmd.arg(lp);
                }
            } else {
                // Existing session: attach
                cmd.arg("attach");
                cmd.arg(&session_name);
            }

            handle_pty_terminal(socket, cmd, cols, rows).await;
        }
        SessionType::Acp => {
            // ACP tasks use chat interface, not terminal — should not reach here
        }
    }
}

/// Common PTY terminal handler
async fn handle_pty_terminal(socket: WebSocket, cmd: CommandBuilder, cols: u16, rows: u16) {
    // Create PTY in blocking context
    let pty_result = tokio::task::spawn_blocking(move || {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        // Spawn the command
        let child = pair.slave.spawn_command(cmd)?;

        // Get reader from PTY master
        let reader = pair.master.try_clone_reader()?;

        // Get writer from PTY master
        let writer = pair.master.take_writer()?;

        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((pair.master, reader, writer, child))
    })
    .await;

    let (master, reader, writer, child) = match pty_result {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            eprintln!("Failed to setup PTY: {}", e);
            return;
        }
        Err(e) => {
            eprintln!("Task failed: {}", e);
            return;
        }
    };

    // Wrap in Arc for sharing
    let master = Arc::new(std::sync::Mutex::new(master));
    let reader = Arc::new(std::sync::Mutex::new(reader));
    let writer = Arc::new(std::sync::Mutex::new(writer));
    let child = Arc::new(std::sync::Mutex::new(child));

    // Create channels for communication
    let (pty_tx, mut pty_rx) = mpsc::channel::<String>(100);
    let (ws_tx, mut ws_rx) = mpsc::channel::<Vec<u8>>(100);

    // Split WebSocket
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Task: Read from PTY (blocking) and send to channel
    let reader_clone = reader.clone();
    let pty_reader_task = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = {
                let mut reader = reader_clone.lock().unwrap();
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => n,
                    Err(e) => {
                        eprintln!("PTY read error: {}", e);
                        break;
                    }
                }
            };

            let data = String::from_utf8_lossy(&buf[..n]).to_string();
            if pty_tx.blocking_send(data).is_err() {
                break;
            }
        }
    });

    // Task: Send PTY output to WebSocket
    let pty_to_ws = tokio::spawn(async move {
        while let Some(data) = pty_rx.recv().await {
            if ws_sender.send(Message::Text(data.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: Write to PTY (blocking)
    let writer_clone = writer.clone();
    let master_clone = master.clone();
    let pty_writer_task = tokio::task::spawn_blocking(move || {
        while let Some(data) = ws_rx.blocking_recv() {
            // Check for resize message (JSON format)
            if let Ok(resize) = serde_json::from_slice::<ResizeMessage>(&data) {
                if resize.msg_type == "resize" {
                    let master = master_clone.lock().unwrap();
                    let _ = master.resize(PtySize {
                        rows: resize.rows,
                        cols: resize.cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                    continue;
                }
            }

            let mut writer = writer_clone.lock().unwrap();
            if writer.write_all(&data).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    // Task: Read from WebSocket and send to channel
    let ws_to_pty = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if ws_tx.send(text.as_bytes().to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Binary(data)) => {
                    if ws_tx.send(data.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    });

    // Wait for any task to complete
    tokio::select! {
        _ = pty_reader_task => {},
        _ = pty_to_ws => {},
        _ = pty_writer_task => {},
        _ = ws_to_pty => {},
    }

    // Cleanup: kill the child process
    // Note: For tmux attach, killing this process just detaches from the session
    // The tmux session itself continues running
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    };
}

#[derive(Debug, Deserialize)]
struct ResizeMessage {
    #[serde(rename = "type")]
    msg_type: String,
    cols: u16,
    rows: u16,
}
