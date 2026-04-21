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
use crate::operations::tasks::create_task_session;
use crate::session::SessionType;
use crate::storage::{config, tasks, workspace};

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

    // 3. Check web terminal mode
    let cfg = config::load_config();
    let web_terminal_mode = cfg.web.terminal_mode.as_deref().unwrap_or("multiplexer");
    let working_dir = task.worktree_path.clone();

    if web_terminal_mode == "direct" {
        // Direct mode: spawn a plain shell in the task's worktree (no multiplexer)
        state::watch_task(&project_key, &task.id, &task.worktree_path);

        Ok(ws.on_upgrade(move |socket| handle_shell_terminal(socket, working_dir, cols, rows)))
    } else {
        // Multiplexer mode: use shared create_task_session
        let session_info = create_task_session(&project_key, &task, &project.path)
            .map_err(|e| TaskTerminalError::Internal(format!("Session error: {}", e)))?;

        state::watch_task(&project_key, &task.id, &task.worktree_path);

        Ok(ws.on_upgrade(move |socket| {
            handle_mux_terminal(
                socket,
                MuxTerminalParams {
                    session_name: session_info.session_name,
                    mux: session_info.session_type,
                    new_session: session_info.is_new,
                    working_dir,
                    zellij_layout_path: session_info.layout_path,
                    cols,
                    rows,
                },
            )
        }))
    }
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

/// Pick the default shell for the current platform.
///
/// Priority:
/// 1. `GROVE_SHELL` env var (explicit override, e.g. `wsl.exe`, `pwsh`, `git-bash`)
/// 2. `SHELL` env var (standard on Unix; may be set on Windows with Git Bash/WSL)
/// 3. Platform default: `powershell.exe` on Windows, `/bin/bash` elsewhere
///
/// Returns (shell_path, initial_args) — Windows PowerShell gets UTF-8
/// init args so CJK output doesn't garble.
fn pick_default_shell() -> (String, Vec<String>) {
    if let Ok(shell) = std::env::var("GROVE_SHELL") {
        return (shell, vec![]);
    }
    if let Ok(shell) = std::env::var("SHELL") {
        return (shell, vec![]);
    }

    #[cfg(windows)]
    {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                "chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new()".to_string(),
            ],
        )
    }
    #[cfg(not(windows))]
    {
        ("/bin/bash".to_string(), vec![])
    }
}

/// Ensure the PTY child has a sane base environment.
///
/// When Grove is launched from Finder / Launchpad (packaged `.app` / DMG),
/// the parent process inherits only a minimal env, so `LANG`, `LC_*`, `TERM`
/// and `PATH` are all missing. Without `TERM` zsh's ZLE cannot redraw the
/// prompt — each keystroke gets re-echoed cumulatively (`ls` → `lslssllss…`)
/// — and without a UTF-8 locale zsh prints multibyte bytes as `\M-^…`.
///
/// We set safe defaults only when the variable is absent, so users who do
/// have a terminal-inherited env keep their own values.
fn apply_terminal_env_defaults(cmd: &mut CommandBuilder) {
    let defaults: &[(&str, &str)] = &[
        ("TERM", "xterm-256color"),
        ("LANG", "en_US.UTF-8"),
        ("LC_ALL", "en_US.UTF-8"),
        ("LC_CTYPE", "en_US.UTF-8"),
        ("COLORTERM", "truecolor"),
    ];
    for (k, v) in defaults {
        if std::env::var_os(k).is_none() {
            cmd.env(k, v);
        }
    }

    // PATH can also be empty under a Finder launch — fall back to the
    // standard macOS/Linux default so `ls`, `git`, etc. resolve. We put
    // `/opt/homebrew/bin` first so Apple-Silicon Homebrew installs
    // (`brew`, `node`, `gh`, ...) are reachable.
    if std::env::var_os("PATH").is_none() {
        cmd.env(
            "PATH",
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        );
    }
}

/// Handle the WebSocket connection for a simple shell terminal
async fn handle_shell_terminal(socket: WebSocket, cwd: String, cols: u16, rows: u16) {
    let (shell, args) = pick_default_shell();

    let mut cmd = CommandBuilder::new(&shell);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    apply_terminal_env_defaults(&mut cmd);

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
            apply_terminal_env_defaults(&mut cmd);
            handle_pty_terminal(socket, cmd, cols, rows).await;
        }
        SessionType::Zellij => {
            let mut cmd = CommandBuilder::new("zellij");
            // Remove ZELLIJ env vars to prevent nested session issues
            cmd.env_remove("ZELLIJ");
            cmd.env_remove("ZELLIJ_SESSION_NAME");
            cmd.cwd(&working_dir);
            apply_terminal_env_defaults(&mut cmd);

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
            eprintln!("Warning: ACP task reached terminal handler — this should not happen");
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
    let mut pty_reader_task = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = {
                let mut reader = reader_clone.lock().expect("PTY reader mutex poisoned");
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
    let mut pty_to_ws = tokio::spawn(async move {
        while let Some(data) = pty_rx.recv().await {
            if ws_sender.send(Message::Text(data.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: Write to PTY (blocking)
    let writer_clone = writer.clone();
    let master_clone = master.clone();
    let mut pty_writer_task = tokio::task::spawn_blocking(move || {
        while let Some(data) = ws_rx.blocking_recv() {
            // Check for resize message (JSON format)
            if let Ok(resize) = serde_json::from_slice::<ResizeMessage>(&data) {
                if resize.msg_type == "resize" {
                    let master = master_clone.lock().expect("PTY master mutex poisoned");
                    let _ = master.resize(PtySize {
                        rows: resize.rows,
                        cols: resize.cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                    continue;
                }
            }

            let mut writer = writer_clone.lock().expect("PTY writer mutex poisoned");
            if writer.write_all(&data).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    // Task: Read from WebSocket and send to channel
    let mut ws_to_pty = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(text)) if ws_tx.send(text.as_bytes().to_vec()).await.is_err() => {
                    break;
                }
                Ok(Message::Binary(data)) if ws_tx.send(data.to_vec()).await.is_err() => {
                    break;
                }
                Ok(Message::Text(_) | Message::Binary(_)) => {}
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    });

    // Wait for any task to complete, detect panics
    tokio::select! {
        result = &mut pty_reader_task => {
            if let Err(ref e) = result { if e.is_panic() { eprintln!("[Grove] PTY reader task panicked"); } }
        },
        result = &mut pty_to_ws => {
            if let Err(ref e) = result { if e.is_panic() { eprintln!("[Grove] PTY-to-WS task panicked"); } }
        },
        result = &mut pty_writer_task => {
            if let Err(ref e) = result { if e.is_panic() { eprintln!("[Grove] PTY writer task panicked"); } }
        },
        result = &mut ws_to_pty => {
            if let Err(ref e) = result { if e.is_panic() { eprintln!("[Grove] WS-to-PTY task panicked"); } }
        },
    }

    // One side finished; tear down the rest so the WebSocket actually closes
    // instead of lingering with detached background tasks.
    pty_to_ws.abort();
    ws_to_pty.abort();
    pty_writer_task.abort();

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
