//! Streamable HTTP MCP listener — exposes trusted chat-bound tools to agents.
//!
//! WO-006 part 2 of 4. This module is the HTTP transport layer. Agent-graph
//! logic lives in `crate::agent_graph::tools`; other chat-bound tools delegate
//! to their owning storage/runtime modules.
//!
//! ## Design (方案 A)
//!
//! - Independent **loopback-only** axum listener bound at `127.0.0.1:<dynamic>`.
//!   **Not** mounted on the existing public API router; permissions completely
//!   isolated to avoid leaking the token-bypass surface to mobile / LAN / WAN.
//! - Single rmcp `StreamableHttpService` mounted at `POST /mcp/{token}` (and the
//!   matching `GET` / `DELETE` for SSE resume / session close per the MCP spec).
//! - The URL path token is the `caller_chat_id` binding: when Grove spawns an ACP
//!   session it allocates a fresh token, writes `(token → chat_id)` into the
//!   process-wide [`TokenMap`], and injects
//!   `http://127.0.0.1:<port>/mcp/<token>` into `NewSessionRequest.mcp_servers`.
//!   When that agent calls a tool, the handler reads the token out of
//!   `RequestContext.extensions[Parts]` and looks up the caller — no env var
//!   dependency, no `acp:` URL hacks, no Proxy / Conductor.
//! - Two MCP servers run in parallel for each ACP agent: this HTTP one
//!   (`grove_agent`, for chat-bound runtime tools) and the existing `grove mcp`
//!   stdio server (task/orchestrator utilities).
//!   Tool names don't collide.
//!
//! Commit 3 will start this listener at Grove boot, store the chosen port via
//! [`set_listener_port`], and call [`register_token`] / [`unregister_token`]
//! around each ACP session lifecycle.

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::request::Parts;
use axum::Router;
use once_cell::sync::OnceCell;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{
    handler::server::tool::{Extension, ToolRouter},
    model::*,
    tool, tool_router, ErrorData as McpError, ServerHandler,
};
use std::sync::RwLock;

use rmcp::schemars;
use rmcp::schemars::JsonSchema;
use serde::Deserialize;

use crate::agent_graph::ask_form;
use crate::agent_graph::error::AgentGraphError;
use crate::agent_graph::tools::{
    grove_agent_capability, grove_agent_contacts, grove_agent_reply, grove_agent_send,
    grove_agent_set_title, grove_agent_spawn, CapabilityInput, ContactsInput, ReplyInput,
    SendInput, SetTitleInput, SpawnInput, ToolContext,
};
use crate::error::GroveError;
use crate::storage::{config, memory, tasks};

// ─── Token map (token → caller_chat_id) ───────────────────────────────────────

/// Process-wide token map. Each ACP session gets a fresh token at spawn; the
/// agent connects to `http://127.0.0.1:<port>/mcp/<token>` and the MCP service
/// looks up the caller chat_id by token. Tokens are random uuids; they are not
/// guessable but should still only be exposed to the local agent subprocess.
static TOKEN_MAP: OnceCell<Arc<RwLock<HashMap<String, String>>>> = OnceCell::new();

fn token_map() -> &'static Arc<RwLock<HashMap<String, String>>> {
    TOKEN_MAP.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

/// Register a (token → chat_id) binding. Idempotent on token: re-registering
/// overwrites the prior chat_id. Called by the ACP session spawn path before
/// `NewSessionRequest` is sent.
pub fn register_token(token: impl Into<String>, chat_id: impl Into<String>) {
    let mut map = token_map().write().expect("token map poisoned");
    map.insert(token.into(), chat_id.into());
}

/// Remove a token binding. Called when the ACP session ends. Returns the prior
/// chat_id if present.
pub fn unregister_token(token: &str) -> Option<String> {
    let mut map = token_map().write().expect("token map poisoned");
    map.remove(token)
}

/// Remove every token bound to a chat. Terminal-mode (tmux-backed) chats
/// register a session-scoped token with no WebSocket-drop guard to release it,
/// so teardown happens by chat id when the chat — and its tmux agent session —
/// is deleted (see `acp::delete_chat`).
pub fn unregister_chat(chat_id: &str) {
    let mut map = token_map().write().expect("token map poisoned");
    map.retain(|_, bound_chat| bound_chat != chat_id);
}

fn lookup_token(token: &str) -> Option<String> {
    let map = token_map().read().expect("token map poisoned");
    map.get(token).cloned()
}

// ─── Listener port ────────────────────────────────────────────────────────────

static LISTENER_PORT: OnceCell<u16> = OnceCell::new();

/// Set the chosen MCP listener port. Called once at Grove startup after
/// [`bind_with_fallback`](crate::api::bind_with_fallback) picks a free 127.0.0.1
/// port. Subsequent calls are silently ignored — the port is fixed for the
/// process's lifetime.
///
/// On the first successful set we also write `~/.grove/mcp.port`
/// (`<port> <pid>\n`) so external processes — most importantly
/// `grove mcp-bridge` running as a child of an agent that doesn't accept
/// ACP-injected MCP — can find the listener without reading from the parent's
/// env. We deliberately skip the write on subsequent calls (e.g. from tests
/// that re-call this) to avoid clobbering a previously written port. Multiple
/// concurrent Grove instances last-writer-wins; bridge's pid health check (see
/// [`read_port_file_validated`]) catches stale entries.
///
/// Best-effort write: failure is logged and ignored — the bridge will fall
/// back to env-only discovery when env vars are present.
pub fn set_listener_port(port: u16) {
    if LISTENER_PORT.set(port).is_err() {
        // Already set (idempotent path); don't touch the file.
        return;
    }
    let path = crate::storage::grove_dir().join("mcp.port");
    let payload = format!("{} {}\n", port, std::process::id());
    if let Err(e) = atomic_write(&path, payload.as_bytes()) {
        eprintln!(
            "[agent_graph_mcp] warning: failed to write {}: {}",
            path.display(),
            e
        );
    }
}

/// Atomic write via tmp + rename so concurrent readers never see a half-line.
fn atomic_write(target: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent dir"))?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".mcp.port.{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, target)
}

/// Path to the `mcp.port` file. Used by `grove mcp-bridge` to discover the
/// running Grove server's MCP HTTP listener port.
pub fn port_file_path() -> std::path::PathBuf {
    crate::storage::grove_dir().join("mcp.port")
}

/// Read `mcp.port` and validate the recorded pid is still alive. Returns the
/// port on success. `Err(reason)` covers unreadable file, malformed content,
/// dead pid (stale file from a prior Grove process), and IO errors.
///
/// Used by `grove mcp-bridge` as the env-fallback discovery path.
pub fn read_port_file_validated() -> Result<u16, String> {
    let path = port_file_path();
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let mut tokens = raw.split_whitespace();
    let port_s = tokens.next().ok_or("empty port file")?;
    let port: u16 = port_s
        .parse()
        .map_err(|e| format!("parse port {:?}: {}", port_s, e))?;
    // pid is optional in the spec; if absent, accept the port without health check.
    if let Some(pid_s) = tokens.next() {
        let pid: u32 = pid_s
            .parse()
            .map_err(|e| format!("parse pid {:?}: {}", pid_s, e))?;
        if !pid_alive(pid) {
            return Err(format!(
                "stale {}: pid {} no longer running — start `grove web` / `grove gui` first",
                path.display(),
                pid
            ));
        }
    }
    Ok(port)
}

/// Cross-platform "is this pid running" check. Best-effort.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // signal 0 doesn't deliver, just probes for the process. ESRCH = dead;
    // EPERM = exists but we can't signal it (still alive).
    unsafe {
        libc::kill(pid as libc::pid_t, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION; if it succeeds the
    // pid is at least reserved. Close handle immediately.
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if h.is_null() {
        false
    } else {
        unsafe {
            CloseHandle(h);
        }
        true
    }
}

/// The MCP listener port if the listener has started. `None` before the
/// listener boots or in tests that don't run it.
pub fn listener_port() -> Option<u16> {
    LISTENER_PORT.get().copied()
}

/// Build the `mcp_servers` URL Grove injects into `NewSessionRequest`. Returns
/// `None` if either the listener port or the token has not been registered.
pub fn build_mcp_url(token: &str) -> Option<String> {
    let port = listener_port()?;
    Some(format!("http://127.0.0.1:{port}/mcp/{token}"))
}

// ─── MCP service ──────────────────────────────────────────────────────────────

/// rmcp service that exposes the `agent_graph` tools over Streamable HTTP.
///
/// One instance is constructed per session (rmcp `service_factory`). It carries
/// no per-session state — all caller resolution happens at tool-call time via
/// the URL path token in `Parts.uri.path()`.
#[derive(Clone)]
pub struct AgentGraphMcpService {
    tool_router: ToolRouter<Self>,
}

impl Default for AgentGraphMcpService {
    fn default() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

impl AgentGraphMcpService {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ServerHandler for AgentGraphMcpService {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build());
        info.protocol_version = ProtocolVersion::LATEST;
        info.server_info = {
            let mut impl_info = Implementation::new("grove-agent-graph", env!("CARGO_PKG_VERSION"));
            impl_info.title = Some("Grove Agent Graph MCP".to_string());
            impl_info.website_url = Some("https://github.com/GarrickZ2/grove".to_string());
            impl_info
        };
        info
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let mut tools = self.tool_router.list_all();
        // Hide browser tools when the user has disabled browser control in Settings.
        if !config::load_config().browser_control.enabled {
            tools.retain(|tool| !tool.name.starts_with("browser_"));
        }
        // Memory is project-configured. Keep the advertised tool surface and
        // server-side permission check driven by the same durable flag.
        let memory_enabled = context
            .extensions
            .get::<Parts>()
            .and_then(|parts| caller_session_from_parts(parts).ok())
            .and_then(|(project_id, _, _)| memory::project_memory_enabled(&project_id).ok())
            .unwrap_or(false);
        if !memory_enabled {
            tools.retain(|tool| !WORKING_MEMORY_TOOLS.contains(&tool.name.as_ref()));
        }
        Ok(ListToolsResult {
            tools,
            meta: None,
            next_cursor: None,
        })
    }
}

const WORKING_MEMORY_TOOLS: &[&str] = &[
    "memory_append_log",
    "memory_recall",
    "memory_read",
    "memory_get_related",
    "memory_get_recent_logs",
];

// ─── Tool implementations ─────────────────────────────────────────────────────

#[tool_router]
impl AgentGraphMcpService {
    #[tool(
        name = "memory_append_log",
        description = "Append one immutable short-term Memory Log from the current Grove task/chat. Use it for durable learnings such as decisions, corrections, user preferences, non-obvious project knowledge, or reusable experience. Supply title, tags, and description only; Grove derives the trusted project, task, chat, and agent identity from this MCP connection. Multiple logs may be appended from one task.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<AppendMemoryLogOutput>()
    )]
    async fn grove_memory_append_log_tool(
        &self,
        Parameters(input): Parameters<AppendMemoryLogInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, task_id, chat) = caller_session_from_parts(&parts)?;
        if !memory::project_memory_enabled(&project_id).map_err(memory_mcp_error)? {
            return Err(McpError::invalid_request(
                "Project Memory is not enabled for this project".to_string(),
                None,
            ));
        }
        memory::append_log(&memory::NewMemoryLog {
            project_id: &project_id,
            task_id: &task_id,
            chat_id: Some(&chat.id),
            agent: Some(&chat.agent),
            title: &input.title,
            tags: &input.tags,
            description: &input.description,
        })
        .map_err(memory_mcp_error)?;
        memory_json_success(&AppendMemoryLogOutput { saved: true })
    }

    #[tool(
        name = "memory_recall",
        description = "Find relevant long-term Project Memory summaries by query terms, structured tags, or current score. Query text is split on spaces and common list punctuation; it is not semantic or embedding search. Any term may match title, description, or tags, and results rank by the number of distinct matched terms. This returns metadata only and never changes access counts. Call memory_read before relying on full contents.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<memory::Page<MemoryRecallItem>>()
    )]
    async fn grove_memory_recall_tool(
        &self,
        Parameters(input): Parameters<MemoryRecallInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let project_id = working_memory_project(&parts)?;
        let tags = input
            .tags
            .into_iter()
            .map(|tag| memory::MemoryTagFilter {
                key: tag.key,
                value: tag.value,
            })
            .collect::<Vec<_>>();
        let page = memory::recall_entities(
            &project_id,
            input.query.as_deref(),
            &tags,
            input.cursor.as_deref(),
            memory_bounded_limit(input.limit, 10, 50, "limit")?,
        )
        .map_err(memory_mcp_error)?;
        memory_json_success(&map_memory_page(page, MemoryRecallItem::from))
    }

    #[tool(
        name = "memory_read",
        description = "Read one long-term Memory's full Markdown body. Every successful read increments that Entity's access count. related_limit defaults to 3 and accepts 0 through 10; returned related Memories contain summaries only and are not reinforced. If via_relation_id names a Relation connected to this Entity, that Relation's access count also increments; an invalid or unrelated id is ignored and never blocks the read.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<MemoryReadOutput>()
    )]
    async fn grove_memory_read_tool(
        &self,
        Parameters(input): Parameters<MemoryReadInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let project_id = working_memory_project(&parts)?;
        let result = memory::read_entity(
            &project_id,
            &input.entity_id,
            input.via_relation_id.as_deref(),
            memory_bounded_limit_allow_zero(input.related_limit, 3, 10, "related_limit")?,
        )
        .map_err(memory_mcp_error)?
        .ok_or_else(|| {
            McpError::invalid_request(
                format!("Memory Entity {} was not found", input.entity_id),
                None,
            )
        })?;
        memory_json_success(&MemoryReadOutput::from(result))
    }

    #[tool(
        name = "memory_get_related",
        description = "Page through summary-only Memories related to one Entity, ordered by Relation score. Candidate discovery does not change Entity or Relation access counts; call memory_read with the returned entity_id and Relation id only when following a useful connection. cursor is opaque; limit defaults to 10 and accepts 1 through 50.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<memory::Page<RelatedMemoryItem>>()
    )]
    async fn grove_memory_get_related_tool(
        &self,
        Parameters(input): Parameters<MemoryRelatedInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let project_id = working_memory_project(&parts)?;
        let page = memory::list_related_memories(
            &project_id,
            &input.entity_id,
            input.cursor.as_deref(),
            memory_bounded_limit(input.limit, 10, 50, "limit")?,
        )
        .map_err(memory_mcp_error)?;
        memory_json_success(&map_memory_page(page, RelatedMemoryItem::from))
    }

    #[tool(
        name = "memory_get_recent_logs",
        description = "Page through recent unorganized short-term Memory Logs. Optional query text is split on spaces and common list punctuation; it is not semantic or embedding search. Any term may match title, description, or tags, and results rank by distinct matched terms before recency. Reading results does not change access counts. Treat Logs as recent evidence rather than established long-term Memory. limit defaults to 20 and accepts 1 through 100.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<memory::Page<MemoryLogItem>>()
    )]
    async fn grove_memory_get_recent_logs_tool(
        &self,
        Parameters(input): Parameters<MemoryRecentLogsInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let project_id = working_memory_project(&parts)?;
        let page = memory::list_logs(
            &project_id,
            input.query.as_deref(),
            input.cursor.as_deref(),
            memory_bounded_limit(input.limit, 20, 100, "limit")?,
        )
        .map_err(memory_mcp_error)?;
        memory_json_success(&map_memory_page(page, MemoryLogItem::from))
    }

    #[tool(
        name = "graph_spawn",
        description = "Create a new sibling Session in your task and auto-establish caller→child edge. Blocks until the spawned ACP agent is ready (90s timeout). Returns session_id + capabilities."
    )]
    async fn grove_agent_spawn_tool(
        &self,
        Parameters(input): Parameters<SpawnInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match grove_agent_spawn(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    #[tool(
        name = "graph_send",
        description = "Deliver a message to another Session in your task. Requires a caller→to outgoing edge. The target sees the message as a user prompt wrapped in a `<grove-meta>{...}</grove-meta>` envelope (JSON inside). The envelope's `system-prompt` field carries the human-readable framing (sender name, session id, kind=send, msg_id) and the `message` field carries your raw text. If the target is busy, the message is queued and visible in its pending list; it dequeues automatically when the current turn ends. Single-in-flight: cannot send a second message before the previous one is replied to."
    )]
    async fn grove_agent_send_tool(
        &self,
        Parameters(input): Parameters<SendInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match grove_agent_send(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    #[tool(
        name = "graph_reply",
        description = "Reply to a pending message addressed to you. Consumes the reply ticket. The original sender receives the reply wrapped in a `<grove-meta>{...}</grove-meta>` envelope (JSON), with `system-prompt` describing the reply framing (sender, session id, kind=reply, msg_id) and `message` carrying your raw text. No edge requirement; reply is always permitted on a valid ticket."
    )]
    async fn grove_agent_reply_tool(
        &self,
        Parameters(input): Parameters<ReplyInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match grove_agent_reply(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    #[tool(
        name = "graph_contacts",
        description = "Return your own metadata, who you can contact (outgoing edges), pending replies you owe, pending messages awaiting reply from others, and all spawnable targets (base agents, custom servers, personas) via can_spawn[]."
    )]
    async fn grove_agent_contacts_tool(
        &self,
        Parameters(input): Parameters<ContactsInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match grove_agent_contacts(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    #[tool(
        name = "graph_capability",
        description = "Inspect a session's available models, modes, and thought_levels. The session must be in your task and currently online (its session.json exists). NOTE: this tool does NOT auto-spawn — if you get AgentOffline, send the target a message via graph_send first to wake it, then re-query."
    )]
    async fn grove_agent_capability_tool(
        &self,
        Parameters(input): Parameters<CapabilityInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match grove_agent_capability(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    #[tool(
        name = "set_title",
        description = "Rename the current Session's title. Broadcasts changes to update frontend UI and menu tray."
    )]
    async fn grove_agent_set_title_tool(
        &self,
        Parameters(input): Parameters<SetTitleInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match grove_agent_set_title(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    #[tool(
        name = "ask_form",
        description = "Ask the user to fill out a structured form when you need several decisions at once — much better than asking many questions in plain text. Question types: single_choice, multi_choice, text, textarea, number, rating (fixed 1-5 stars), boolean (fixed Yes/No). Every question is skippable by the user; choice questions automatically include a 'Custom' free-text input — do NOT add a custom option to your `options` list. Returns immediately with status='created' once the form is dispatched to the UI. Your turn ends normally after this call — the user's answers will arrive as a separate user prompt in the next turn (formatted as a numbered markdown list where each line is `N. <question title>: <answer>`), so do not poll, do not call other tools waiting on the response, and do not assume the user has answered before that next prompt arrives."
    )]
    async fn grove_ask_form_tool(
        &self,
        Parameters(input): Parameters<ask_form::AskFormInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cx = caller_context_from_parts(&parts)?;
        match ask_form::grove_ask_form(&cx, input).await {
            Ok(out) => json_success(&out),
            Err(e) => Ok(tool_error(e)),
        }
    }

    // ── Browser tools ────────────────────────────────────────────────────────
    //
    // 寻址模型：grove_browser_open 返回 tab_id；后续 snapshot/interact/extract/
    // screenshot 必须带上该 tab_id，否则报错。group_name 不暴露给 caller —— 后端
    // 用 caller chat_id 反查 task name 自动注入，作为 Chrome Tab Group 标题。
    //
    // 仅当 browser_control.enabled = true 时这些工具可见（参见 list_tools）。

    /// Open a URL in the user's Chrome browser
    #[tool(
        name = "browser_open",
        description = "Open a URL in the user's Chrome browser and return the new tab_id. When browser_control.auto_groups is enabled, the new tab is auto-organized into a Chrome Tab Group named after the current task. Use the returned tab_id with browser_snapshot / _interact / _extract / _screenshot. Requires the Chrome Companion Extension to be connected."
    )]
    async fn grove_browser_open_tool(
        &self,
        Parameters(input): Parameters<BrowserOpenInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = config::load_config();
        if !cfg.browser_control.enabled {
            return Err(McpError::invalid_request(
                "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
                None,
            ));
        }
        let group_name = if cfg.browser_control.auto_groups {
            Some(caller_task_name_from_parts(&parts)?)
        } else {
            None
        };
        crate::api::handlers::extension::browser_open(&input.url, group_name.as_deref())
            .await
            .map_err(|e| McpError::internal_error(e, None))
            .and_then(|mut res| {
                if let Some(obj) = res.as_object_mut() {
                    obj.remove("groupId");
                }
                json_success(&res)
            })
    }

    /// Take an accessibility-tree snapshot of a specific browser tab
    #[tool(
        name = "browser_snapshot",
        description = "Snapshot a specific browser tab (identified by tab_id from browser_open). Returns a simplified Accessibility Tree with interactive elements tagged @e1, @e2, … for use in browser_interact."
    )]
    async fn grove_browser_snapshot_tool(
        &self,
        Parameters(input): Parameters<BrowserSnapshotInput>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = config::load_config();
        if !cfg.browser_control.enabled {
            return Err(McpError::invalid_request(
                "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
                None,
            ));
        }
        crate::api::handlers::extension::browser_snapshot(input.tab_id)
            .await
            .map_err(|e| McpError::internal_error(e, None))
            .and_then(|res| json_success(&res))
    }

    /// Perform a DOM interaction on a specific browser tab
    #[tool(
        name = "browser_interact",
        description = "Perform an interactive DOM gesture on a specific browser tab (identified by tab_id from browser_open). Target elements via @e1/@e2 refs from browser_snapshot, or CSS selectors. Actions: click, dblclick, fill, type, focus, hover, check, uncheck, press."
    )]
    async fn grove_browser_interact_tool(
        &self,
        Parameters(input): Parameters<BrowserInteractInput>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = config::load_config();
        if !cfg.browser_control.enabled {
            return Err(McpError::invalid_request(
                "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
                None,
            ));
        }
        crate::api::handlers::extension::browser_interact(
            input.tab_id,
            &input.action,
            &input.target,
            input.value.as_deref(),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))
        .and_then(|res| json_success(&res))
    }

    /// Extract text or HTML content from a specific browser tab
    #[tool(
        name = "browser_extract",
        description = "Extract structured content from a specific browser tab (identified by tab_id from browser_open). extract_type: text (innerText), html (outerHTML), value (input value), url, title. Optionally target a specific element via @e ref or CSS selector."
    )]
    async fn grove_browser_extract_tool(
        &self,
        Parameters(input): Parameters<BrowserExtractInput>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = config::load_config();
        if !cfg.browser_control.enabled {
            return Err(McpError::invalid_request(
                "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
                None,
            ));
        }
        crate::api::handlers::extension::browser_extract(
            input.tab_id,
            &input.extract_type,
            input.target.as_deref(),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))
        .and_then(|res| json_success(&res))
    }

    /// Capture a screenshot of a specific browser tab
    #[tool(
        name = "browser_screenshot",
        description = "Capture a screenshot of a specific browser tab (identified by tab_id from browser_open). Returns the image as an MCP `image` content (PNG) — the client renders it directly, no base64 in text."
    )]
    async fn grove_browser_screenshot_tool(
        &self,
        Parameters(input): Parameters<BrowserScreenshotInput>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = config::load_config();
        if !cfg.browser_control.enabled {
            return Err(McpError::invalid_request(
                "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
                None,
            ));
        }
        let res = crate::api::handlers::extension::browser_screenshot(input.tab_id)
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        // 扩展返回 { success, screenshot: "data:image/png;base64,...." } 或
        // { success: false, error: "..." }。MCP image content 要求纯 base64 + mime
        // type 分开，不能把 dataUrl 整段塞进 text —— 那样客户端按 token 计字数,
        // 一张 PNG 几十万字符直接顶爆上下文窗口。
        if res.get("success").and_then(|v| v.as_bool()) == Some(false) {
            let err = res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("screenshot failed")
                .to_string();
            return Err(McpError::internal_error(err, None));
        }
        let data_url = res
            .get("screenshot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                McpError::internal_error(
                    "extension returned no `screenshot` field".to_string(),
                    None,
                )
            })?;
        // Strip "data:<mime>;base64," prefix to get raw base64 payload.
        // Refusing malformed data URLs avoids silently shipping a base64
        // string that doesn't actually decode to a valid image — the client
        // would render garbage.
        let (mime, b64) = match data_url.split_once(",") {
            Some((header, body)) if header.starts_with("data:") && header.contains(";base64") => {
                // Extract just the media type (drop any `;param=...` and the
                // `;base64` suffix). `data:;base64,...` is legal — fall
                // back to image/png in that case rather than emitting an
                // empty mime that confuses the MCP client.
                let after_data = header.trim_start_matches("data:");
                let mime = after_data
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let mime = if mime.is_empty() {
                    "image/png".to_string()
                } else {
                    mime
                };
                (mime, body.to_string())
            }
            _ => {
                return Err(McpError::internal_error(
                    "extension returned malformed screenshot payload (expected data:<mime>;base64,<...>)"
                        .to_string(),
                    None,
                ));
            }
        };
        Ok(CallToolResult::success(vec![Content::image(b64, mime)]))
    }
}

// ─── Tool parameter types ─────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, JsonSchema)]
struct AppendMemoryLogOutput {
    /// True when Grove persisted the Log.
    saved: bool,
}

#[derive(Debug, serde::Serialize, JsonSchema)]
struct MemoryRecallItem {
    /// Stable id to pass to memory_read or memory_get_related.
    entity_id: String,
    /// Concise Memory title.
    title: String,
    /// Summary for deciding whether the full Memory is relevant.
    description: String,
}

impl From<memory::MemoryEntity> for MemoryRecallItem {
    fn from(entity: memory::MemoryEntity) -> Self {
        Self {
            entity_id: entity.entity_id,
            title: entity.title,
            description: entity.description,
        }
    }
}

#[derive(Debug, serde::Serialize, JsonSchema)]
struct MemoryLogItem {
    /// Concise short-term observation title.
    title: String,
    /// Flat topic labels supplied with the Log.
    tags: Vec<String>,
    /// Short-term observation details.
    description: String,
}

impl From<memory::MemoryLog> for MemoryLogItem {
    fn from(log: memory::MemoryLog) -> Self {
        Self {
            title: log.title,
            tags: log.tags,
            description: log.description,
        }
    }
}

#[derive(Debug, serde::Serialize, JsonSchema)]
struct RelatedMemoryItem {
    /// Stable id to pass to memory_read.
    entity_id: String,
    /// Relation id to pass as via_relation_id when following this connection.
    relation_id: String,
    /// Concise related Memory title.
    title: String,
    /// Summary for deciding whether to read the full related Memory.
    description: String,
}

impl From<memory::RelatedMemory> for RelatedMemoryItem {
    fn from(related: memory::RelatedMemory) -> Self {
        Self {
            entity_id: related.entity.entity_id,
            relation_id: related.relation.id,
            title: related.entity.title,
            description: related.entity.description,
        }
    }
}

#[derive(Debug, serde::Serialize, JsonSchema)]
struct MemoryReadOutput {
    /// Memory title.
    title: String,
    /// Full Markdown body without frontmatter.
    content: String,
    /// Highest-ranked related Memory summaries. Read one with its entity_id and relation_id.
    related_memories: Vec<RelatedMemoryItem>,
}

impl From<memory::MemoryReadResult> for MemoryReadOutput {
    fn from(result: memory::MemoryReadResult) -> Self {
        Self {
            title: result.entity.entity.title,
            content: result.entity.body,
            related_memories: result
                .related
                .into_iter()
                .map(RelatedMemoryItem::from)
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AppendMemoryLogInput {
    /// Concise title for the learned fact, decision, preference, or experience.
    #[schemars(length(min = 1))]
    pub title: String,
    /// Initial topic labels. Grove trims empty values and removes duplicates.
    pub tags: Vec<String>,
    /// What happened or was learned, with enough context for later consolidation.
    #[schemars(length(min = 1))]
    pub description: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryTagFilterInput {
    /// Structured tag category, matched case-insensitively and exactly.
    #[schemars(length(min = 1))]
    pub key: String,
    /// Optional structured tag value, matched case-insensitively and exactly.
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRecallInput {
    /// Optional concepts matched independently against title, description, and tags.
    /// Separate concepts with spaces or common list punctuation.
    pub query: Option<String>,
    /// Optional structured tag filters. Every supplied filter must match.
    #[serde(default)]
    pub tags: Vec<MemoryTagFilterInput>,
    /// Opaque cursor returned by the previous call.
    pub cursor: Option<String>,
    /// Number of summaries to return. Defaults to 10 and is capped at 50.
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryReadInput {
    /// Entity id returned by memory_recall or memory_get_related.
    #[schemars(length(min = 1))]
    pub entity_id: String,
    /// Relation followed to reach this Entity. Invalid or unrelated ids are ignored.
    pub via_relation_id: Option<String>,
    /// Related summaries to include. Defaults to 3 and is capped at 10; use 0 to omit.
    #[schemars(range(min = 0, max = 10))]
    pub related_limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRelatedInput {
    /// Entity whose Relation neighborhood should be explored.
    #[schemars(length(min = 1))]
    pub entity_id: String,
    /// Opaque cursor returned by the previous call.
    pub cursor: Option<String>,
    /// Number of related summaries to return. Defaults to 10 and is capped at 50.
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRecentLogsInput {
    /// Optional concepts matched independently against title, description, and tags.
    /// Separate concepts with spaces or common list punctuation.
    pub query: Option<String>,
    /// Opaque cursor returned by the previous call.
    pub cursor: Option<String>,
    /// Number of Logs to return. Defaults to 20 and is capped at 100.
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserOpenInput {
    /// The URL to open in the user's Chrome browser
    pub url: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserSnapshotInput {
    /// Chrome tab id returned by grove_browser_open
    pub tab_id: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserInteractInput {
    /// Chrome tab id returned by grove_browser_open
    pub tab_id: u32,
    /// DOM action to perform: click, dblclick, fill, type, focus, hover, check, uncheck, press
    pub action: String,
    /// Target element — @e1/@e2 reference from grove_browser_snapshot, or a CSS selector
    pub target: String,
    /// Text to fill/type or key name to press (required for fill, type, press)
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserExtractInput {
    /// Chrome tab id returned by grove_browser_open
    pub tab_id: u32,
    /// What to extract: text (innerText), html (outerHTML), value (input value), url, title
    pub extract_type: String,
    /// Optional element reference (@e1) or CSS selector; omit to target the whole tab
    pub target: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserScreenshotInput {
    /// Chrome tab id returned by grove_browser_open
    pub tab_id: u32,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Resolve the token-bound caller to its trusted project/task/chat identity.
fn caller_session_from_parts(
    parts: &Parts,
) -> Result<(String, String, tasks::ChatSession), McpError> {
    let cx = caller_context_from_parts(parts)?;
    tasks::find_chat_session(&cx.caller_chat_id)
        .map_err(|e| McpError::internal_error(format!("caller lookup failed: {e}"), None))?
        .ok_or_else(|| {
            McpError::invalid_request(
                format!(
                    "caller_unknown: chat_id {} is not bound to any task",
                    cx.caller_chat_id
                ),
                None,
            )
        })
}

fn working_memory_project(parts: &Parts) -> Result<String, McpError> {
    let (project_id, _, _) = caller_session_from_parts(parts)?;
    if !memory::project_memory_enabled(&project_id).map_err(memory_mcp_error)? {
        return Err(McpError::invalid_request(
            "Project Memory is not enabled for this project".to_string(),
            None,
        ));
    }
    Ok(project_id)
}

fn memory_mcp_error(error: GroveError) -> McpError {
    match error {
        GroveError::InvalidData(message) => McpError::invalid_params(message, None),
        GroveError::NotFound(message) => McpError::invalid_request(message, None),
        other => McpError::internal_error(other.to_string(), None),
    }
}

fn memory_bounded_limit(
    value: Option<usize>,
    default: usize,
    max: usize,
    field: &str,
) -> Result<usize, McpError> {
    let value = value.unwrap_or(default);
    if !(1..=max).contains(&value) {
        return Err(McpError::invalid_params(
            format!("{field} must be an integer from 1 through {max} inclusive"),
            None,
        ));
    }
    Ok(value)
}

fn memory_bounded_limit_allow_zero(
    value: Option<usize>,
    default: usize,
    max: usize,
    field: &str,
) -> Result<usize, McpError> {
    let value = value.unwrap_or(default);
    if value > max {
        return Err(McpError::invalid_params(
            format!("{field} must be an integer from 0 through {max} inclusive"),
            None,
        ));
    }
    Ok(value)
}

/// 从 caller chat_id 反查 task name（用作 Chrome Tab Group 标题）。
///
/// 反查失败一律报错（caller_unknown / task_not_found），不静默 fallback —— 多
/// agent 并发场景下静默 fallback 会把 tab 堆到错误的 group 里，调试代价远高于
/// 直接报错。
fn caller_task_name_from_parts(parts: &Parts) -> Result<String, McpError> {
    let cx = caller_context_from_parts(parts)?;
    let chat_id = cx.caller_chat_id.clone();
    let lookup = crate::storage::tasks::session_to_task(&chat_id).map_err(|e| {
        McpError::internal_error(format!("session_to_task lookup failed: {e}"), None)
    })?;
    let (_project, _task_id, task_name) = lookup.ok_or_else(|| {
        McpError::invalid_request(
            format!("caller_unknown: chat_id {chat_id} is not bound to any task"),
            None,
        )
    })?;
    Ok(task_name)
}

/// Extract caller_chat_id from the request URL path token. Returns
/// `caller_unknown` McpError if the path doesn't match `/mcp/{token}` or the
/// token isn't registered.
fn caller_context_from_parts(parts: &Parts) -> Result<ToolContext, McpError> {
    let path = parts.uri.path();
    let token = path
        .trim_start_matches('/')
        .strip_prefix("mcp/")
        .and_then(|rest| rest.split('/').next())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            McpError::invalid_request(
                "agent_graph MCP path must be /mcp/<token>".to_string(),
                None,
            )
        })?;
    let chat_id = lookup_token(token).ok_or_else(|| {
        McpError::invalid_request(
            "caller_unknown: token not registered or expired".to_string(),
            None,
        )
    })?;
    Ok(ToolContext::new(chat_id))
}

fn json_success<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![Content::text(json)]))
}

/// Memory tools advertise output schemas, so return the same JSON as both
/// human-readable text and MCP structured content.
fn memory_json_success<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::structured(value))
}

fn map_memory_page<T, U>(page: memory::Page<T>, map: impl FnMut(T) -> U) -> memory::Page<U> {
    memory::Page {
        items: page.items.into_iter().map(map).collect(),
        next_cursor: page.next_cursor,
    }
}

/// Map an `AgentGraphError` to an MCP CallToolResult with `isError = true`.
/// We use tool-error rather than JSON-RPC error so the calling agent sees the
/// spec §4 error code (`no_edge`, `duty_required`, …) and the human hint as
/// part of normal tool output rather than a transport failure.
fn tool_error(err: AgentGraphError) -> CallToolResult {
    let mut body = serde_json::json!({
        "error": err.code(),
        "hint": err.hint(),
        "message": err.to_string(),
    });
    // For InvalidConfig surface the structured allowed-list so the calling AI
    // can pick a real value without parsing the human message.
    if let AgentGraphError::InvalidConfig {
        field,
        value,
        allowed,
    } = &err
    {
        body["field"] = serde_json::json!(field);
        body["value"] = serde_json::json!(value);
        body["allowed"] = serde_json::json!(allowed);
    }
    let text = serde_json::to_string_pretty(&body)
        .unwrap_or_else(|_| format!("{{\"error\":\"{}\"}}", err.code()));
    CallToolResult::error(vec![Content::text(text)])
}

// ─── Listener bootstrap ───────────────────────────────────────────────────────

/// Default base port. The listener tries this first then increments via
/// [`crate::api::bind_with_fallback`]. Chosen to be far from the public web UI
/// port (3000–3100) and the macOS dynamic-port range (49152+) to make the
/// agent-side MCP URL visible in `lsof` / `netstat` distinct from Grove's
/// frontend.
pub const DEFAULT_BASE_PORT: u16 = 17900;

/// Default attempts to find a free port (`base_port` … `base_port + 99`).
pub const DEFAULT_MAX_ATTEMPTS: u16 = 100;

/// Start the loopback-only agent_graph MCP listener.
///
/// **Idempotent**: subsequent calls after the first successful boot are no-ops
/// and return the previously chosen port. Concurrent first calls are safe — the
/// `OnceCell` ensures only one listener is spawned.
///
/// Binds `127.0.0.1:<port>` via [`crate::api::bind_with_fallback`] and spawns
/// `axum::serve` in a background task that runs for the process's lifetime.
/// The chosen port is published via [`set_listener_port`]; subsequent ACP
/// session spawns read it via [`build_mcp_url`] when constructing
/// `NewSessionRequest.mcp_servers`.
///
/// On bind failure the function returns the std::io::Error and **does not** set
/// the port — callers may retry with a different base. Grove's main start-up
/// path treats bind failure as non-fatal: log a warning and continue without
/// agent_graph (the rest of the API server still works; the in-process tools
/// just become unavailable).
pub async fn start_listener(base_port: u16, max_attempts: u16) -> std::io::Result<u16> {
    if let Some(existing) = listener_port() {
        return Ok(existing);
    }
    let (listener, actual_port) =
        crate::api::bind_with_fallback("127.0.0.1", base_port, max_attempts).await?;
    set_listener_port(actual_port);
    let app = build_router();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[agent_graph_mcp] listener error: {}", e);
        }
    });
    Ok(actual_port)
}

// ─── Router builder ───────────────────────────────────────────────────────────

/// Test-only variant of [`build_router`] that runs the server in **stateless +
/// JSON-response** mode so test clients can issue one-shot tool calls and read
/// plain JSON without managing `Mcp-Session-Id` headers or parsing SSE frames.
/// rmcp 1.3 only honors `json_response` in stateless mode (stateful POSTs are
/// always streamed as SSE per the MCP spec). Real ACP agents in production
/// connect to the stateful router built by [`build_router`].
#[cfg(test)]
fn build_router_json_for_test() -> Router {
    let session_manager = Arc::new(LocalSessionManager::default());
    let config = StreamableHttpServerConfig::default()
        .with_stateful_mode(false)
        .with_json_response(true);
    let svc: StreamableHttpService<AgentGraphMcpService, LocalSessionManager> =
        StreamableHttpService::new(|| Ok(AgentGraphMcpService::new()), session_manager, config);
    let svc_clone = svc.clone();
    Router::new()
        .route_service("/mcp/{token}", svc)
        .route_service("/mcp/{token}/", svc_clone)
}

/// Build the loopback-only axum router serving the agent_graph MCP listener.
///
/// Mount `POST /mcp/{token}` (plus `GET` / `DELETE` for the Streamable HTTP
/// session lifecycle) on the rmcp `StreamableHttpService`. The `{token}` path
/// segment is preserved through to tool handlers via the request URI; this
/// function does no token validation itself — that happens inside each tool.
///
/// The returned router is intended to be served on a fresh
/// `127.0.0.1:<port>` listener (separate from Grove's main public axum
/// router). Do **not** mount on `0.0.0.0` and do **not** add this router to
/// the public `create_api_router` graph; it bypasses `ServerAuth` and relies
/// solely on the unguessable token.
pub fn build_router() -> Router {
    let session_manager = Arc::new(LocalSessionManager::default());
    // In stateful mode rmcp issues an Mcp-Session-Id per `initialize` request and
    // agents echo it on subsequent calls (MCP-spec default; all real agents
    // implement it). Caller identity is separate from the MCP session — we
    // derive it from the URL path token at tool-call time.
    let config = StreamableHttpServerConfig::default()
        .with_stateful_mode(true)
        .with_json_response(false);
    let svc: StreamableHttpService<AgentGraphMcpService, LocalSessionManager> =
        StreamableHttpService::new(|| Ok(AgentGraphMcpService::new()), session_manager, config);

    // Mount under `/mcp/{token}` and the trailing-slash variant. rmcp's service
    // doesn't read the URL path itself; we read it inside the tool handlers.
    let svc_clone = svc.clone();
    let memory_svc = super::memory_mcp::streamable_service();
    let memory_svc_clone = memory_svc.clone();
    Router::new()
        .route_service("/mcp/{token}", svc)
        .route_service("/mcp/{token}/", svc_clone)
        .route_service("/memory-mcp/{token}", memory_svc)
        .route_service("/memory-mcp/{token}/", memory_svc_clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema_fields(
        schema: &serde_json::Map<String, serde_json::Value>,
    ) -> std::collections::HashSet<String> {
        fn collect(value: &serde_json::Value, fields: &mut std::collections::HashSet<String>) {
            match value {
                serde_json::Value::Object(object) => {
                    if let Some(properties) =
                        object.get("properties").and_then(|value| value.as_object())
                    {
                        fields.extend(properties.keys().cloned());
                    }
                    for value in object.values() {
                        collect(value, fields);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        collect(value, fields);
                    }
                }
                _ => {}
            }
        }

        let mut fields = std::collections::HashSet::new();
        collect(&serde_json::Value::Object(schema.clone()), &mut fields);
        fields
    }

    #[test]
    fn working_memory_tools_expose_complete_contracts() {
        let service = AgentGraphMcpService::new();
        let tools = service.tool_router.list_all();
        for name in WORKING_MEMORY_TOOLS {
            let tool = tools
                .iter()
                .find(|tool| tool.name == *name)
                .unwrap_or_else(|| panic!("missing tool {name}"));
            assert!(
                tool.description
                    .as_deref()
                    .is_some_and(|description| !description.trim().is_empty()),
                "{name} must have a description"
            );
            assert!(
                tool.output_schema.is_some(),
                "{name} must expose output_schema"
            );
        }

        let read = tools
            .iter()
            .find(|tool| tool.name == "memory_read")
            .expect("read tool");
        let input_schema = serde_json::to_string(read.input_schema.as_ref()).expect("schema");
        assert!(input_schema.contains("\"minimum\":0"), "{input_schema}");
        assert!(input_schema.contains("\"maximum\":10"), "{input_schema}");

        let append = tools
            .iter()
            .find(|tool| tool.name == "memory_append_log")
            .expect("append tool");
        let append_output =
            serde_json::to_string(append.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let append_fields = schema_fields(append.output_schema.as_deref().expect("output schema"));
        assert!(append_fields.contains("saved"), "{append_output}");
        for hidden in ["project_id", "task_id", "chat_id", "agent", "created_at"] {
            assert!(!append_fields.contains(hidden), "{append_output}");
        }

        let recall = tools
            .iter()
            .find(|tool| tool.name == "memory_recall")
            .expect("recall tool");
        let recall_output =
            serde_json::to_string(recall.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let recall_fields = schema_fields(recall.output_schema.as_deref().expect("output schema"));
        for visible in ["entity_id", "title", "description"] {
            assert!(recall_fields.contains(visible), "{recall_output}");
        }
        for hidden in [
            "project_id",
            "file_path",
            "tags",
            "base_score",
            "access_count",
            "score",
            "created_at",
            "updated_at",
        ] {
            assert!(!recall_fields.contains(hidden), "{recall_output}");
        }

        let read_output =
            serde_json::to_string(read.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let read_fields = schema_fields(read.output_schema.as_deref().expect("output schema"));
        for visible in [
            "title",
            "content",
            "related_memories",
            "entity_id",
            "relation_id",
            "description",
        ] {
            assert!(read_fields.contains(visible), "{read_output}");
        }
        for hidden in [
            "project_id",
            "file_path",
            "tags",
            "base_score",
            "access_count",
            "score",
            "created_at",
            "updated_at",
            "relation_access_recorded",
        ] {
            assert!(!read_fields.contains(hidden), "{read_output}");
        }

        let related = tools
            .iter()
            .find(|tool| tool.name == "memory_get_related")
            .expect("related tool");
        let related_output =
            serde_json::to_string(related.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let related_fields =
            schema_fields(related.output_schema.as_deref().expect("output schema"));
        for visible in ["entity_id", "relation_id", "title", "description"] {
            assert!(related_fields.contains(visible), "{related_output}");
        }
        for hidden in [
            "relation_type",
            "project_id",
            "file_path",
            "tags",
            "base_score",
            "access_count",
            "score",
            "created_at",
            "updated_at",
        ] {
            assert!(!related_fields.contains(hidden), "{related_output}");
        }

        let logs = tools
            .iter()
            .find(|tool| tool.name == "memory_get_recent_logs")
            .expect("logs tool");
        let logs_output =
            serde_json::to_string(logs.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let logs_fields = schema_fields(logs.output_schema.as_deref().expect("output schema"));
        for visible in ["title", "tags", "description"] {
            assert!(logs_fields.contains(visible), "{logs_output}");
        }
        for hidden in [
            "id",
            "project_id",
            "task_id",
            "chat_id",
            "agent",
            "created_at",
        ] {
            assert!(!logs_fields.contains(hidden), "{logs_output}");
        }
    }

    #[test]
    fn token_map_register_and_lookup() {
        register_token("tok-1", "chat-aaa");
        assert_eq!(lookup_token("tok-1").as_deref(), Some("chat-aaa"));
        assert_eq!(unregister_token("tok-1").as_deref(), Some("chat-aaa"));
        assert!(lookup_token("tok-1").is_none());
    }

    #[test]
    fn token_map_unknown_returns_none() {
        assert!(lookup_token("nonexistent-xyz").is_none());
    }

    #[test]
    fn build_mcp_url_requires_port() {
        // listener_port() may or may not be set globally depending on test order;
        // we only assert that with a fresh token, the format is correct *if* the
        // port is set, and otherwise None.
        if let Some(port) = listener_port() {
            let url = build_mcp_url("tok-x").expect("url");
            assert_eq!(url, format!("http://127.0.0.1:{port}/mcp/tok-x"));
        } else {
            assert!(build_mcp_url("tok-x").is_none());
        }
    }

    #[test]
    fn caller_context_extracts_token_from_path() {
        register_token("tok-extract", "chat-extract");
        let req = axum::http::Request::builder()
            .uri("http://127.0.0.1:1234/mcp/tok-extract")
            .body(())
            .unwrap();
        let (parts, _) = req.into_parts();
        let cx = caller_context_from_parts(&parts).expect("ok");
        assert_eq!(cx.caller_chat_id, "chat-extract");
        unregister_token("tok-extract");
    }

    #[test]
    fn caller_context_rejects_unknown_token() {
        let req = axum::http::Request::builder()
            .uri("http://127.0.0.1:1234/mcp/never-registered-token")
            .body(())
            .unwrap();
        let (parts, _) = req.into_parts();
        assert!(caller_context_from_parts(&parts).is_err());
    }

    #[test]
    fn caller_context_rejects_malformed_path() {
        let req = axum::http::Request::builder()
            .uri("http://127.0.0.1:1234/some/other/path")
            .body(())
            .unwrap();
        let (parts, _) = req.into_parts();
        assert!(caller_context_from_parts(&parts).is_err());
    }

    #[test]
    fn caller_context_handles_trailing_slash() {
        register_token("tok-slash", "chat-slash");
        let req = axum::http::Request::builder()
            .uri("http://127.0.0.1:1234/mcp/tok-slash/")
            .body(())
            .unwrap();
        let (parts, _) = req.into_parts();
        let cx = caller_context_from_parts(&parts).expect("ok");
        assert_eq!(cx.caller_chat_id, "chat-slash");
        unregister_token("tok-slash");
    }

    #[test]
    fn router_compiles() {
        // Just smoke-check that we can build the router without panicking.
        let _ = build_router();
    }

    #[tokio::test]
    async fn start_listener_binds_loopback_and_publishes_port() {
        // Use a high base port unlikely to collide; start_listener is idempotent
        // so re-runs of the test suite won't double-bind.
        let port = start_listener(28900, 50).await.expect("listener");
        assert!(port >= 28900);
        assert_eq!(listener_port(), Some(port));
        let url = build_mcp_url("any-token").expect("url");
        assert_eq!(url, format!("http://127.0.0.1:{port}/mcp/any-token"));

        // Second call must return the existing port (idempotent).
        let port2 = start_listener(28999, 1).await.expect("idempotent");
        assert_eq!(port2, port);

        // Sanity: connect to the listener with a TCP probe; the bind should be live.
        let addr = format!("127.0.0.1:{port}");
        let _stream = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("loopback reachable");
    }

    #[test]
    fn list_tools_returns_agent_tools() {
        let svc = AgentGraphMcpService::new();
        let names: Vec<String> = svc
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        for tool in WORKING_MEMORY_TOOLS {
            assert!(names.contains(&tool.to_string()), "missing {tool}");
        }
        assert!(names.contains(&"graph_spawn".to_string()));
        assert!(names.contains(&"graph_send".to_string()));
        assert!(names.contains(&"graph_reply".to_string()));
        assert!(names.contains(&"graph_contacts".to_string()));
        assert!(names.contains(&"graph_capability".to_string()));
        assert!(names.contains(&"browser_open".to_string()));
        assert!(names.contains(&"browser_snapshot".to_string()));
        assert!(names.contains(&"browser_interact".to_string()));
        assert!(names.contains(&"browser_extract".to_string()));
        assert!(names.contains(&"browser_screenshot".to_string()));
        assert!(names.contains(&"set_title".to_string()));
        assert!(names.contains(&"ask_form".to_string()));
        assert_eq!(names.len(), 17);
    }

    /// End-to-end test of the HTTP transport: real axum listener bound on a
    /// 127.0.0.1 port, real MCP `initialize` → `tools/list` → `tools/call
    /// grove_agent_contacts` over HTTP via `reqwest`. Exercises the full
    /// caller-resolution path (URL token → chat_id → ToolContext → SQLite).
    #[tokio::test]
    async fn http_e2e_initialize_and_contacts() {
        use crate::storage::database::test_lock;
        use chrono::Utc;

        let _l = test_lock().lock().await;

        // Sandbox HOME so SQLite writes to a temp dir.
        let tmp = tempfile::tempdir().expect("tmpdir");
        let prev_home = std::env::var_os("HOME");
        // SAFETY: serialized via test_lock; restored on Drop.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        struct HomeGuard {
            prev: Option<std::ffi::OsString>,
        }
        impl Drop for HomeGuard {
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
        let _hg = HomeGuard { prev: prev_home };

        // Seed two chats + an A→B edge so contacts has data to return.
        {
            let conn = crate::storage::database::connection();
            conn.execute(
                "INSERT OR REPLACE INTO session
                 (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
                rusqlite::params![
                    "chat-A",
                    "p",
                    "t",
                    "Alice",
                    "claude",
                    Some("dispatcher"),
                    Utc::now().to_rfc3339(),
                ],
            )
            .expect("seed A");
            conn.execute(
                "INSERT OR REPLACE INTO session
                 (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
                rusqlite::params![
                    "chat-B",
                    "p",
                    "t",
                    "Bob",
                    "claude",
                    Some("worker"),
                    Utc::now().to_rfc3339(),
                ],
            )
            .expect("seed B");
            crate::storage::agent_graph::add_edge(&conn, "p", "t", "chat-A", "chat-B", None)
                .expect("edge");
            conn.execute(
                "INSERT OR REPLACE INTO custom_agent
                 (id, name, base_agent, model, mode, effort, duty, system_prompt, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5, ?6, ?6)",
                rusqlite::params![
                    "ca-reviewer",
                    "Reviewer",
                    "traecli",
                    Some("review implementation and tests"),
                    "do not expose this prompt",
                    Utc::now().to_rfc3339(),
                ],
            )
            .expect("seed persona");
            // Post-v2.6, `can_spawn` requires the persona's base_agent to
            // resolve in `installed_agents`. Seed traecli so the persona is
            // surfaced AND so the assertion below ("any installed agent
            // appears with kind=base") finds at least one row.
            drop(conn);
            let now = Utc::now();
            let row = crate::storage::installed_agents::InstalledAgent {
                id: "traecli".to_string(),
                installations: vec![crate::storage::installed_agents::Installation {
                    method: crate::storage::installed_agents::InstallMethod::External,
                    version: String::new(),
                    install_path: Some("/usr/local/bin/traecli".to_string()),
                    status: crate::storage::installed_agents::InstallStatus::Installed,
                    failure_reason: None,
                    installed_at: now,
                }],
                selected_install_method: crate::storage::installed_agents::InstallMethod::External,
                args_override: Vec::new(),
                env_override: std::collections::HashMap::new(),
                hidden: false,
                created_at: now,
                updated_at: now,
            };
            crate::storage::installed_agents::upsert(&row).expect("seed traecli");
        }

        // Spin up a local axum listener with the agent_graph router (independent
        // of `start_listener`'s OnceCell port to avoid clashing with other tests).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let app = build_router_json_for_test();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        // Bind a fresh token to chat-A.
        let token = "test-tok-e2e";
        register_token(token, "chat-A");
        let url = format!("http://127.0.0.1:{port}/mcp/{token}");

        let client = reqwest::Client::new();

        // ── 1. initialize ────────────────────────────────────────────────
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "grove-test-client", "version": "0.0.0" }
            }
        });
        let init_resp = client
            .post(&url)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&init_req)
            .send()
            .await
            .expect("initialize POST");
        assert!(
            init_resp.status().is_success(),
            "initialize: {:?}",
            init_resp.status()
        );
        // In stateless test mode there is no session header; ignore it.
        let _ = init_resp.text().await;

        // ── 2. tools/list ────────────────────────────────────────────────
        let list_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });
        let list_resp = client
            .post(&url)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&list_req)
            .send()
            .await
            .expect("tools/list POST");
        assert!(list_resp.status().is_success());
        let list_body: String = list_resp.text().await.expect("body");
        // Body may be JSON or SSE-framed. Inspect for tool names.
        for tool in [
            "graph_spawn",
            "graph_send",
            "graph_reply",
            "graph_contacts",
            "graph_capability",
        ] {
            assert!(list_body.contains(tool), "tools/list missing {tool}");
        }
        for tool in WORKING_MEMORY_TOOLS {
            assert!(
                !list_body.contains(tool),
                "disabled Project Memory must not advertise {tool} in {list_body}"
            );
        }

        // ── 3. tools/call grove_agent_contacts ───────────────────────────
        let call_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "graph_contacts",
                "arguments": {}
            }
        });
        let call_resp = client
            .post(&url)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&call_req)
            .send()
            .await
            .expect("tools/call POST");
        assert!(call_resp.status().is_success());
        let call_body: String = call_resp.text().await.expect("body");
        // Spec §4 ContactsOutput: self.session_id == "chat-A", can_contact has chat-B,
        // can_spawn includes available base agents and seeded persona.
        assert!(call_body.contains("chat-A"), "self chat-A in {call_body}");
        assert!(
            call_body.contains("chat-B"),
            "can_contact chat-B in {call_body}"
        );
        assert!(call_body.contains("dispatcher"), "self.duty in {call_body}");
        // can_spawn: persona seeded in setup must appear with duty but without system prompt.
        assert!(
            call_body.contains("ca-reviewer"),
            "can_spawn persona id in {call_body}"
        );
        assert!(
            call_body.contains("review implementation and tests"),
            "can_spawn persona duty in {call_body}"
        );
        assert!(
            !call_body.contains("do not expose this prompt"),
            "persona system prompt leaked in {call_body}"
        );
        // can_spawn: any installed agent must appear with kind=base.
        if let Some(base) = crate::storage::installed_agents::list().ok().and_then(|v| {
            v.into_iter()
                .find(|a| !a.hidden && a.has_installed_channel())
        }) {
            assert!(
                call_body.contains(base.id.as_str()),
                "can_spawn base agent {} missing from {call_body}",
                base.id
            );
        }

        unregister_token(token);
        server.abort();
    }
}
