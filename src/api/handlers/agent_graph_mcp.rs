//! Streamable HTTP MCP listener — exposes the 5 `agent_graph` tools to ACP agents.
//!
//! WO-006 part 2 of 4. This module is the HTTP transport layer; the tool logic
//! lives in `crate::agent_graph::tools` and is transport-agnostic.
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
//! - Two MCP servers run in parallel for each ACP agent: this HTTP one (5 agent
//!   graph tools) and the existing `grove mcp` stdio (orchestrator tools).
//!   Tool names don't collide.
//!
//! Commit 3 will start this listener at Grove boot, store the chosen port via
//! [`set_listener_port`], and call [`register_token`] / [`unregister_token`]
//! around each ACP session lifecycle.

#![allow(dead_code)] // some helpers are exercised only in part 4 integration tests

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

use crate::agent_graph::error::AgentGraphError;
use crate::agent_graph::tools::{
    grove_agent_capability, grove_agent_contacts, grove_agent_reply, grove_agent_send,
    grove_agent_spawn, CapabilityInput, ContactsInput, ReplyInput, SendInput, SpawnInput,
    ToolContext,
};

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
    use std::os::windows::io::RawHandle;
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
        let _ = h as RawHandle;
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

/// rmcp service that exposes the 5 `agent_graph` tools over Streamable HTTP.
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

const MCP_INSTRUCTIONS: &str = r#"
Agent-to-agent communication tools within a Grove task.

Caller identity is derived from the URL token bound at session spawn — you do
not need to pass it. All tools operate within the caller's task only.

- grove_agent_spawn:   create a new sibling session and auto-establish caller→child edge
- grove_agent_send:    deliver a message to a session you have an outgoing edge to
- grove_agent_reply:   reply to a pending message you received
- grove_agent_contacts: list who you can reach, who's awaiting your reply, who you're awaiting
- grove_agent_capability: inspect models / modes / thought_levels of any session in your task

Custom Agents (personas):
- The user can configure "Custom Agents" in Settings — each is a base agent
  (claude / codex / etc) preset with a model, mode, effort, and a system prompt.
- `grove_agent_contacts` returns a `available_custom_agents[]` list. To spawn
  one of them, pass that entry's `id` (e.g. "ca-...") as `grove_agent_spawn.agent`.
- The spawn behaves exactly like a normal base-agent spawn except the new
  session is pre-seeded with the persona's system prompt on Create. Resume
  paths see no extra prompt.
- Personas are user-scoped (per Grove install), not task-scoped. The same
  `available_custom_agents` is visible to every session in every task — by
  design, so a persona created in one task can be reused elsewhere.

Constraints:
- send requires an existing edge (no_edge if missing); single-in-flight per A→B
- duty is locked once set; pass `duty` only when the target has none
- reply consumes the ticket; no edge required
"#;

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
        info.instructions = Some(MCP_INSTRUCTIONS.trim().to_string());
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
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: self.tool_router.list_all(),
            meta: None,
            next_cursor: None,
        })
    }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

#[tool_router]
impl AgentGraphMcpService {
    #[tool(
        name = "grove_agent_spawn",
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
        name = "grove_agent_send",
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
        name = "grove_agent_reply",
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
        name = "grove_agent_contacts",
        description = "Return your own metadata, who you can contact (outgoing edges), pending replies you owe, and pending messages awaiting reply from others."
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
        name = "grove_agent_capability",
        description = "Inspect a session's available models, modes, and thought_levels. The session must be in your task and currently online (its session.json exists). NOTE: this tool does NOT auto-spawn — if you get AgentOffline, send the target a message via grove_agent_send first to wake it, then re-query."
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/// Map an `AgentGraphError` to an MCP CallToolResult with `isError = true`.
/// We use tool-error rather than JSON-RPC error so the calling agent sees the
/// spec §4 error code (`no_edge`, `duty_required`, …) and the human hint as
/// part of normal tool output rather than a transport failure.
fn tool_error(err: AgentGraphError) -> CallToolResult {
    let body = serde_json::json!({
        "error": err.code(),
        "hint": err.hint(),
        "message": err.to_string(),
    });
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
    Router::new()
        .route_service("/mcp/{token}", svc)
        .route_service("/mcp/{token}/", svc_clone)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn list_tools_returns_five() {
        let svc = AgentGraphMcpService::new();
        let names: Vec<String> = svc
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        assert!(names.contains(&"grove_agent_spawn".to_string()));
        assert!(names.contains(&"grove_agent_send".to_string()));
        assert!(names.contains(&"grove_agent_reply".to_string()));
        assert!(names.contains(&"grove_agent_contacts".to_string()));
        assert!(names.contains(&"grove_agent_capability".to_string()));
        assert_eq!(names.len(), 5);
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
            "grove_agent_spawn",
            "grove_agent_send",
            "grove_agent_reply",
            "grove_agent_contacts",
            "grove_agent_capability",
        ] {
            assert!(list_body.contains(tool), "tools/list missing {tool}");
        }

        // ── 3. tools/call grove_agent_contacts ───────────────────────────
        let call_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "grove_agent_contacts",
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
        // Spec §4 ContactsOutput: self.session_id == "chat-A", can_contact has chat-B.
        assert!(call_body.contains("chat-A"), "self chat-A in {call_body}");
        assert!(
            call_body.contains("chat-B"),
            "can_contact chat-B in {call_body}"
        );
        assert!(call_body.contains("dispatcher"), "self.duty in {call_body}");

        unregister_token(token);
        server.abort();
    }
}
