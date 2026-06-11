//! Agent PTY WebSocket handler — terminal-mode chat sessions.
//!
//! For chats whose `launch_mode == "terminal"`, Grove spawns the agent CLI
//! (currently only `claude`) under a PTY and bridges stdin/stdout over a
//! WebSocket. No ACP protocol, no structured events — the frontend renders
//! the raw PTY stream in xterm.js and `--session-id` / `--resume <uuid>`
//! lets `claude` persist its own conversation across reconnects.

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use portable_pty::CommandBuilder;
use serde::Deserialize;

use crate::storage::{tasks, workspace};

use super::terminal::{apply_terminal_env_defaults, handle_pty_terminal};

#[derive(Debug, Deserialize)]
pub struct AgentPtyQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub enum AgentPtyError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl IntoResponse for AgentPtyError {
    fn into_response(self) -> Response {
        match self {
            AgentPtyError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            AgentPtyError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            AgentPtyError::Internal(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

/// WebSocket upgrade for a terminal-mode chat. Path:
/// `/api/v1/projects/{id}/tasks/{taskId}/chats/{chatId}/agent-pty`
pub async fn agent_pty_handler(
    ws: WebSocketUpgrade,
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
    Query(query): Query<AgentPtyQuery>,
) -> Result<Response, AgentPtyError> {
    let cols = query.cols.unwrap_or(80).clamp(20, 500);
    let rows = query.rows.unwrap_or(24).clamp(5, 200);

    // Resolve project hash
    let projects = workspace::load_projects()
        .map_err(|e| AgentPtyError::Internal(format!("load_projects: {}", e)))?;
    let project = projects
        .iter()
        .find(|p| workspace::project_hash(&p.path) == project_id)
        .ok_or_else(|| AgentPtyError::NotFound("Project not found".to_string()))?
        .clone();
    let project_key = workspace::project_hash(&project.path);

    // Resolve task (worktree path = cwd for agent)
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| AgentPtyError::Internal(format!("get_task: {}", e)))?
        .ok_or_else(|| AgentPtyError::NotFound("Task not found".to_string()))?;

    // Resolve chat and validate launch_mode
    let chat = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| AgentPtyError::Internal(format!("get_chat_session: {}", e)))?
        .ok_or_else(|| AgentPtyError::NotFound("Chat not found".to_string()))?;

    if chat.launch_mode != "terminal" {
        return Err(AgentPtyError::BadRequest(format!(
            "chat launch_mode is {:?}, expected 'terminal'",
            chat.launch_mode
        )));
    }

    // Look up the agent's `terminal_launch` config from the registry. This
    // is the ONE place that says "this agent supports PTY launch and here
    // are the argv flags". Set by `inject_grove_supplements` for claude-acp;
    // any future PTY agent gets a row in the same supplement.
    //
    // Canonicalize first — chat.agent could still be a legacy id on
    // sessions written before the v2.6 remap migration.
    let canonical_agent = crate::storage::installed_agents::canonicalize_agent_id(&chat.agent);
    let registry = crate::storage::agent_registry::get();
    let terminal_launch = registry
        .agents
        .iter()
        .find(|a| a.id == canonical_agent)
        .and_then(|a| a.terminal_launch.clone())
        .ok_or_else(|| {
            AgentPtyError::BadRequest(format!(
                "agent {:?} does not have a terminal_launch config — \
                 PTY mode requires the agent's registry entry to declare \
                 the launch contract",
                canonical_agent
            ))
        })?;

    // First-launch vs resume:
    //   acp_session_id is None  → generate UUID, run `claude --session-id <uuid>`
    //   acp_session_id is Some  → run `claude --resume <uuid>` (claude replays
    //                              its own persisted conversation history)
    let (uuid, is_resume) = match chat.acp_session_id.clone() {
        Some(existing) => (existing, true),
        None => {
            let new_uuid = uuid::Uuid::new_v4().to_string();
            tasks::update_chat_acp_session_id(&project_key, &task_id, &chat_id, &new_uuid)
                .map_err(|e| {
                    AgentPtyError::Internal(format!("update_chat_acp_session_id: {}", e))
                })?;
            (new_uuid, false)
        }
    };

    // GROVE_* env vars give the agent everything ACP mode sees: task / chat
    // / project identity. Used by `grove mcp` (orchestrator tools) and any
    // user-side hooks that key off those vars.
    let mut grove_env = crate::api::handlers::acp::build_grove_env(
        &project_key,
        &project.path,
        &project.name,
        &task,
        Some(&chat_id),
    );

    // Terminal mode launches the bare CLI under a PTY using the contract
    // declared in registry.terminal_launch:
    //   - cmd: which binary to spawn (resolved via External installation's
    //     install_path; falls back to bare cmd for PATH lookup).
    //   - session_id_arg / resume_arg: how to pass the session UUID.
    //   - mcp_config_arg: how to point the agent at grove's MCP config.
    let installed_record = crate::storage::installed_agents::get(&canonical_agent)
        .ok()
        .flatten();
    let extra_args: Vec<String> = installed_record
        .as_ref()
        .map(|r| r.args_override.clone())
        .unwrap_or_default();
    if let Some(ref rec) = installed_record {
        for (k, v) in &rec.env_override {
            grove_env.insert(k.clone(), v.clone());
        }
    }
    // Prefer the resolved absolute path from the External installation
    // (`auto_scan_path_binaries` records it on PATH detection). Falls back
    // to the bare cmd name for PATH lookup at spawn time if no record.
    let claude_cmd = installed_record
        .as_ref()
        .and_then(|r| {
            r.installations
                .iter()
                .find(|i| {
                    matches!(
                        i.method,
                        crate::storage::installed_agents::InstallMethod::External
                    )
                })
                .and_then(|i| i.install_path.clone())
        })
        .unwrap_or_else(|| terminal_launch.cmd.clone());

    // Pre-flight check: refuse the WebSocket upgrade with a clear 400
    // when the binary isn't actually launchable. Without this, the WS
    // upgrades, claude is spawned, fails immediately because the binary
    // isn't on PATH, and the user sees a silent "Disconnected" with no
    // hint of why. This is the most common upgrade-day failure mode:
    // user had a terminal-mode chat in v2.5 but the `claude` CLI isn't
    // on this machine's PATH right now.
    let bin_ok = if std::path::Path::new(&claude_cmd).is_absolute() {
        std::path::Path::new(&claude_cmd).exists()
    } else {
        crate::check::command_exists(&claude_cmd)
    };
    if !bin_ok {
        return Err(AgentPtyError::BadRequest(format!(
            "Terminal-mode chats require the `{}` binary on PATH. \
             Install it (e.g. `npm install -g @anthropic-ai/claude-code` for Claude) \
             or switch this chat to ACP mode in the agent selector.",
            terminal_launch.cmd,
        )));
    }
    let prefix_args: Vec<String> = Vec::new();

    // agent_graph MCP token: register one for this chat so claude (via
    // `grove mcp-bridge` spawned out of the mcp-config below) can reach
    // the loopback HTTP agent_graph listener. Mirrors what acp::mod.rs
    // does for ACP-mode sessions, including the unregister-on-drop guard
    // hooked up via TokenGuard further down. Listener may be absent
    // (`grove acp` standalone, tests) — in that case we skip both the
    // token registration and the env vars, and mcp-bridge will surface
    // a clear error to the agent.
    let agent_graph_token = if crate::api::handlers::agent_graph_mcp::listener_port().is_some() {
        let token = uuid::Uuid::new_v4().to_string();
        crate::api::handlers::agent_graph_mcp::register_token(&token, &chat_id);
        grove_env.insert("GROVE_MCP_TOKEN".to_string(), token.clone());
        if let Some(port) = crate::api::handlers::agent_graph_mcp::listener_port() {
            grove_env.insert("GROVE_MCP_PORT".to_string(), port.to_string());
        }
        Some(token)
    } else {
        None
    };

    // Write a per-launch mcp-config JSON so claude picks up grove's own MCP
    // server. Claude accepts `--mcp-config <file>` (and `<json-string>`); we
    // use a temp file because:
    //   (a) JSON strings on argv leak in `ps` output (env vars don't),
    //   (b) the env block can get large enough to brush against ARG_MAX.
    // File lives under ~/.grove/agents-tmp/<chat-id>/ — same lifetime as
    // the chat, cleaned up on chat delete (see acp.rs delete_chat).
    let include_agent_graph = agent_graph_token.is_some();
    let mcp_config_path = build_mcp_config_file(&chat_id, &grove_env, include_agent_graph)
        .map_err(|e| AgentPtyError::Internal(format!("write mcp-config: {}", e)))?;

    let mut cmd = CommandBuilder::new(&claude_cmd);
    // Args ordering: prefix (e.g. `-y <pkg>@<version>` for npx-launched
    // agents) → session args → mcp config → user extras. This mirrors how
    // claude itself parses flags, with grove-mandatory ones in front.
    for arg in &prefix_args {
        cmd.arg(arg);
    }
    if is_resume {
        cmd.arg(&terminal_launch.resume_arg);
        cmd.arg(&uuid);
    } else {
        cmd.arg(&terminal_launch.session_id_arg);
        cmd.arg(&uuid);
    }
    cmd.arg(&terminal_launch.mcp_config_arg);
    cmd.arg(mcp_config_path.to_string_lossy().into_owned());
    for arg in &extra_args {
        cmd.arg(arg);
    }
    cmd.cwd(&task.worktree_path);
    apply_terminal_env_defaults(&mut cmd);
    for (k, v) in &grove_env {
        cmd.env(k, v);
    }

    Ok(ws.on_upgrade(move |socket: WebSocket| async move {
        // RAII guard: release the agent_graph MCP token when the PTY
        // session ends (WS close / agent exit / panic). Without this the
        // in-memory token map grows on every chat launch.
        struct TokenGuard(Option<String>);
        impl Drop for TokenGuard {
            fn drop(&mut self) {
                if let Some(t) = self.0.take() {
                    let _ = crate::api::handlers::agent_graph_mcp::unregister_token(&t);
                }
            }
        }
        let _token_guard = TokenGuard(agent_graph_token);

        handle_pty_terminal(socket, cmd, cols, rows).await;
    }))
}

/// Write the per-chat MCP config that gets passed to `claude --mcp-config`.
/// Mirrors what ACP mode injects via the protocol — same two grove stdio
/// servers (`grove mcp` for orchestrator tools, `grove mcp-bridge` for
/// agent_graph) so terminal-mode claude sees identical grove tools without
/// us reinventing a parallel surface.
///
/// `include_agent_graph=false` skips the second entry — used when the
/// in-process agent_graph HTTP listener isn't running (standalone `grove acp`
/// or tests), since `mcp-bridge` without GROVE_MCP_TOKEN/PORT would just
/// error out and clutter claude's UI.
///
/// File location: `<grove_dir>/agents-tmp/<chat_id>/mcp.json`. Per-chat keeps
/// cleanup simple (delete the dir when the chat is deleted) and avoids env
/// snapshots from one chat leaking into another's claude process. Overwritten
/// on every launch so the latest env values always win.
fn build_mcp_config_file(
    chat_id: &str,
    grove_env: &std::collections::HashMap<String, String>,
    include_agent_graph: bool,
) -> std::io::Result<std::path::PathBuf> {
    use serde_json::json;

    // `grove` resolved via PATH — relies on the user having grove installed
    // where their PATH can find it. Same contract ACP mode uses (claude
    // spawns its own grove subprocess for `grove mcp` the same way).
    let mut servers = serde_json::Map::new();
    servers.insert(
        "grove".into(),
        json!({
            "command": "grove",
            "args": ["mcp"],
            "env": grove_env,
        }),
    );
    if include_agent_graph {
        // Bridge reads GROVE_MCP_TOKEN / GROVE_MCP_PORT from its inherited
        // env (set on the parent claude process by the launcher above) and
        // proxies stdio JSON-RPC to the HTTP listener.
        servers.insert(
            "grove_agent".into(),
            json!({
                "command": "grove",
                "args": ["mcp-bridge"],
            }),
        );
    }
    let config = json!({ "mcpServers": servers });

    let dir = crate::storage::grove_dir().join("agents-tmp").join(chat_id);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("mcp.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
    Ok(path)
}
