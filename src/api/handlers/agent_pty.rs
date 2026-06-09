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

    // Currently only claude exposes the `--session-id` / `--resume` UUID
    // contract that makes resume across Grove restarts work. Other agents
    // can be added once they have an equivalent contract.
    //
    // Resolve through the alias map so both `claude` (legacy id stored by
    // the chat-create path) and `claude-acp` (canonical registry id) hit
    // the same branch — without this, swapping write/read sides
    // legacy↔canonical anywhere would produce confusing "not supported"
    // errors. Today writes use legacy and we accept both sides; future
    // canonicalization of chat.agent stays safe.
    let canonical_agent =
        crate::storage::agent_supplement::resolve_agent_id(&chat.agent).into_owned();
    if canonical_agent != "claude-acp" {
        return Err(AgentPtyError::BadRequest(format!(
            "terminal launch_mode is only supported for 'claude' (got {:?})",
            chat.agent
        )));
    }

    // tmux-backed terminal session. The agent CLI runs *inside* a detached
    // tmux session owned by the tmux server, not as a child of this PTY. So
    // when the WebSocket drops (relay reaped an idle socket, phone locked,
    // laptop slept) the agent keeps running and re-attaches cleanly on the
    // next connect — which is the whole point of routing through tmux.
    let session_name = crate::tmux::agent_session_name(&chat_id);

    // Serialise the create-vs-attach decision per chat. Two near-simultaneous
    // first connects (e.g. the same chat pinned into two Blitz slots) could
    // otherwise both observe `session_exists() == false` and both run the
    // one-time setup — generating two acp_session_ids (last write wins, leaving
    // the DB id out of sync with the agent the tmux winner actually launched)
    // and registering two tokens (one orphaned until delete_chat). Holding the
    // chat's lock across the existence check + create closes that window; the
    // loser re-reads `session_exists()` inside the lock and falls through to
    // attach. Released before the WS upgrade — concurrent attaches are safe.
    let create_lock = session_create_lock(&session_name);
    let create_guard = create_lock.lock().await;
    let session_existed = crate::tmux::session_exists(&session_name);

    // Build + launch the agent only when no live tmux session exists. On a
    // reconnect the claude process is still running with its original session
    // id, mcp-config and agent_graph token, so we skip straight to attach and
    // must NOT touch acp_session_id, re-register a token, or rewrite argv.
    if !session_existed {
        // First-launch vs resume:
        //   acp_session_id is None  → generate UUID, run `claude --session-id <uuid>`
        //   acp_session_id is Some  → run `claude --resume <uuid>` (claude replays
        //                              its own persisted conversation history)
        // The resume branch also covers grove having restarted while the tmux
        // session was gone: we recreate claude and let it replay history.
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

        // Per-agent overrides from the marketplace settings sheet (matches the
        // ACP launcher's behavior). Claude is always npx/external in practice
        // — `spawn_for` returns None for External so we fall back to plain
        // `claude` on PATH (terminal mode's only supported binary today). When
        // a future terminal-capable agent ships as Binary, `spawn_for` honors
        // install_path (with disk-existence fallback) automatically.
        let installed_record = crate::storage::installed_agents::get(&canonical_agent)
            .ok()
            .flatten();
        let supplement = crate::storage::agent_supplement::find_supplement(&canonical_agent);
        let extra_args: Vec<String> = installed_record
            .as_ref()
            .map(|r| r.args_override.clone())
            .unwrap_or_default();
        if let Some(ref rec) = installed_record {
            for (k, v) in &rec.env_override {
                grove_env.insert(k.clone(), v.clone());
            }
        }
        let (claude_cmd, prefix_args) = installed_record
            .as_ref()
            .and_then(|r| crate::storage::installed_agents::spawn_for(r, supplement))
            .unwrap_or_else(|| ("claude".to_string(), Vec::new()));

        // agent_graph MCP token: register one for this chat so claude (via
        // `grove mcp-bridge` spawned out of the mcp-config below) can reach
        // the loopback HTTP agent_graph listener. Mirrors what acp::mod.rs
        // does for ACP-mode sessions. The token is now session-scoped (its
        // lifetime tracks the tmux session, not this WebSocket): we register
        // once at create and release it in `delete_chat` when the session is
        // killed. Listener may be absent (`grove acp` standalone, tests) — in
        // that case we skip both registration and env vars, and mcp-bridge
        // surfaces a clear error to the agent.
        //
        // Known limitation: if grove restarts while this tmux session lives
        // on, the in-memory token map is cleared and the agent's grove_agent
        // MCP calls start failing until the chat's claude is restarted. The
        // terminal itself keeps working. Persisting tokens across restart is
        // future work.
        let include_agent_graph =
            if crate::api::handlers::agent_graph_mcp::listener_port().is_some() {
                let token = uuid::Uuid::new_v4().to_string();
                crate::api::handlers::agent_graph_mcp::register_token(&token, &chat_id);
                grove_env.insert("GROVE_MCP_TOKEN".to_string(), token);
                if let Some(port) = crate::api::handlers::agent_graph_mcp::listener_port() {
                    grove_env.insert("GROVE_MCP_PORT".to_string(), port.to_string());
                }
                true
            } else {
                false
            };

        // Write a per-launch mcp-config JSON so claude picks up grove's own MCP
        // server. Claude accepts `--mcp-config <file>` (and `<json-string>`); we
        // use a temp file because:
        //   (a) JSON strings on argv leak in `ps` output (env vars don't),
        //   (b) the env block can get large enough to brush against ARG_MAX.
        // File lives under ~/.grove/agents-tmp/<chat-id>/ — same lifetime as
        // the chat, cleaned up on chat delete (see acp.rs delete_chat).
        let mcp_config_path = build_mcp_config_file(&chat_id, &grove_env, include_agent_graph)
            .map_err(|e| AgentPtyError::Internal(format!("write mcp-config: {}", e)))?;

        // Argv ordering: prefix (e.g. `-y <pkg>@<version>` for npx-launched
        // agents) → session args → mcp config → user extras. Mirrors how claude
        // itself parses flags, with grove-mandatory ones in front. tmux runs
        // this argv directly (no shell), so no quoting is needed.
        let mut argv: Vec<String> = Vec::with_capacity(prefix_args.len() + extra_args.len() + 5);
        argv.push(claude_cmd);
        argv.extend(prefix_args);
        if is_resume {
            argv.push("--resume".to_string());
            argv.push(uuid);
        } else {
            argv.push("--session-id".to_string());
            argv.push(uuid);
        }
        argv.push("--mcp-config".to_string());
        argv.push(mcp_config_path.to_string_lossy().into_owned());
        argv.extend(extra_args);

        // claude runs as a child of the tmux server, so the terminal env we'd
        // normally set on the PTY child must be injected into the session
        // instead. tmux supplies TERM/COLORTERM to in-session processes itself;
        // we add the locale + PATH defaults so the agent has a UTF-8 locale and
        // can resolve `grove`/`node` for the mcp-config servers.
        inject_session_env_defaults(&mut grove_env);

        crate::tmux::create_command_session(&session_name, &task.worktree_path, &grove_env, &argv)
            .map_err(|e| AgentPtyError::Internal(format!("create agent tmux session: {}", e)))?;
    }

    // Session now exists (we created it or it was already live). Concurrent
    // attaches don't race, so release the per-chat lock before upgrading.
    drop(create_guard);

    // Attach the WebSocket PTY to the (now guaranteed-live) tmux session.
    // Detaching this client on WS close leaves the session — and the agent
    // running inside it — alive for the next connect.
    let mut cmd = CommandBuilder::new("tmux");
    cmd.arg("attach-session");
    cmd.arg("-t");
    cmd.arg(&session_name);
    apply_terminal_env_defaults(&mut cmd);

    Ok(ws.on_upgrade(move |socket: WebSocket| async move {
        handle_pty_terminal(socket, cmd, cols, rows).await;
    }))
}

/// Per-chat async locks serialising the create-vs-attach decision in
/// `agent_pty_handler`. The map grows by one `Arc<Mutex<()>>` per chat ever
/// opened in terminal mode — bounded by chat count and negligible in size, so
/// entries are intentionally not reaped.
fn session_create_lock(session_name: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    use tokio::sync::Mutex as AsyncMutex;

    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().expect("agent_pty session lock map poisoned");
    guard
        .entry(session_name.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Inject locale + PATH defaults into the env handed to a tmux-backed agent
/// session. tmux processes inherit TERM/COLORTERM from tmux's own terminal
/// layer, but not a UTF-8 locale or grove's PATH — without the latter the
/// agent can't find `grove` for the mcp-config servers. Only fills keys that
/// aren't already set (per-agent `env_override` wins).
fn inject_session_env_defaults(env: &mut std::collections::HashMap<String, String>) {
    for key in ["LANG", "LC_ALL", "LC_CTYPE"] {
        env.entry(key.to_string())
            .or_insert_with(|| std::env::var(key).unwrap_or_else(|_| "en_US.UTF-8".to_string()));
    }
    if !env.contains_key("PATH") {
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
    }
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
