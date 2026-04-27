//! ACP (Agent Client Protocol) 核心模块
//!
//! 管理 ACP agent 子进程的生命周期和 JSON-RPC 通信。
//! Grove 作为 ACP Client，启动 agent 子进程并通过 stdio 交互。

#![allow(dead_code)] // Public API — used by CLI now, Web frontend later

pub mod adapter;

// ACP 0.11 migration shim.
//
// 0.11 把消息类型搬进 `agent_client_protocol::schema`,运行时/角色类型
// (Client、Agent、ConnectionTo、ByteStreams、Error、Result)留在 crate 根。
// 这个本地模块把两边重新拍平到单一的 `acp::*` 命名空间,让本文件以及 adapter
// 的大量调用点保持原写法(`acp::SessionNotification` 等)。
#[allow(clippy::module_inception)]
mod acp {
    pub use agent_client_protocol::schema::*;
    pub use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Error, Result};
}
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::sync::{broadcast, mpsc};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// 全局 ACP 会话注册表
/// Keys whose `get_or_start_session` is currently in-flight. Used to serialize
/// concurrent spawn attempts for the same session key (TOCTOU between the
/// initial read of `ACP_SESSIONS` and the spawn thread's write).
static STARTING_SESSIONS: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

static ACP_SESSIONS: once_cell::sync::Lazy<RwLock<HashMap<String, Arc<AcpSessionHandle>>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(HashMap::new()));

/// ACP 会话句柄 — 外部持有，用于查询状态和发送操作
pub struct AcpSessionHandle {
    pub key: String,
    pub update_tx: broadcast::Sender<AcpUpdate>,
    cmd_tx: mpsc::Sender<AcpCommand>,
    /// Agent info stored after initialization: (session_id, name, version)
    pub agent_info: std::sync::RwLock<Option<(String, String, String)>>,
    /// 待处理的权限请求响应 channel + 它的 id（来源是 ACP tool_call.id）。
    /// id 用来在 reconcile 时把这条 live pending 与 history 中的 PermissionRequest
    /// 精确匹配 —— 同 id 的留给前端响应，其它 unresolved 落 Cancelled。
    pending_permission: Mutex<Option<(String, tokio::sync::oneshot::Sender<String>)>>,
    /// 序列化权限请求：同一时刻只能有一个 permission 等待用户响应
    permission_lock: tokio::sync::Mutex<()>,
    /// 项目 key（用于磁盘持久化路径）
    project_key: String,
    /// 任务 ID（用于磁盘持久化路径）
    task_id: String,
    /// Chat ID（磁盘持久化必需）
    chat_id: Option<String>,
    /// load_session 期间抑制 emit（只恢复 agent 内部状态，不转发回放通知）
    suppress_emit: std::sync::atomic::AtomicBool,
    /// 待执行消息队列（agent 完成当前任务后自动发送下一条）
    pending_queue: Mutex<Vec<QueuedMessage>>,
    /// 队列暂停标志（用户正在编辑队列消息时暂停 auto-send）
    queue_paused: std::sync::atomic::AtomicBool,
    /// 当前 agent mode id（用于 PlanFileUpdate 检测）
    current_mode_id: Mutex<Option<String>>,
    /// Task 工作目录（用于用户直接执行 terminal 命令）
    pub working_dir: String,
    /// 用户终端命令的 kill channel（Shell 模式）
    terminal_kill_tx: Mutex<Option<mpsc::Sender<()>>>,
    /// Agent 是否正在处理（busy=true 从 prompt 开始，到 complete 结束）
    pub is_busy: std::sync::atomic::AtomicBool,
    /// 最近一轮 agent 回复的累积文本（用于 Complete 通知摘要）
    last_assistant_text: Mutex<String>,
}

/// 发送给 ACP 后台任务的命令
enum AcpCommand {
    Prompt {
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
    },
    Cancel,
    Kill,
    SetMode {
        mode_id: String,
    },
    SetModel {
        model_id: String,
    },
    /// Change a thought-level / reasoning-effort selector (0.11 SessionConfigOption).
    /// config_id identifies which option (agents choose their own id, e.g. "effort_level");
    /// value_id is the chosen value's id.
    SetThoughtLevel {
        config_id: String,
        value_id: String,
    },
}

/// 从 agent 接收的流式更新
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpUpdate {
    /// Agent 初始化完成
    SessionReady {
        session_id: String,
        agent_name: String,
        agent_version: String,
        available_modes: Vec<(String, String)>,
        current_mode_id: Option<String>,
        available_models: Vec<(String, String)>,
        current_model_id: Option<String>,
        /// Available values for the thought-level / reasoning-effort selector.
        /// Empty vec means the agent does not expose one.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        available_thought_levels: Vec<(String, String)>,
        /// Currently selected thought-level value id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_thought_level_id: Option<String>,
        /// Config option id for the thought-level selector (agent-chosen, e.g. "effort_level").
        /// Frontend must echo this back when calling SetThoughtLevel.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thought_level_config_id: Option<String>,
        prompt_capabilities: PromptCapabilitiesData,
    },
    /// Agent 消息文本片段
    MessageChunk { text: String },
    /// Agent 思考过程片段
    ThoughtChunk { text: String },
    /// 工具调用开始
    ToolCall {
        id: String,
        title: String,
        locations: Vec<(String, Option<u32>)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<DateTime<Utc>>,
    },
    /// 工具调用更新
    ToolCallUpdate {
        id: String,
        status: String,
        content: Option<String>,
        locations: Vec<(String, Option<u32>)>,
    },
    /// 权限请求（带选项，等待用户交互）。`id` 是 ACP tool_call.id，
    /// 用于把后续的 PermissionResponse 精确对应到这条 Request；老历史里的
    /// 事件没有这个字段，反序列化时落到空串，reconcile 视为 legacy orphan。
    PermissionRequest {
        #[serde(default)]
        id: String,
        description: String,
        options: Vec<PermOptionData>,
    },
    /// 用户对权限请求的响应（记录到历史用于回放）
    PermissionResponse {
        #[serde(default)]
        id: String,
        option_id: String,
    },
    /// 本轮处理结束
    Complete { stop_reason: String },
    /// Agent busy 状态变化
    Busy { value: bool },
    /// 错误
    Error { message: String },
    /// 用户消息（load_session 回放时由 agent 发送）
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<ContentBlockData>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sender: Option<String>,
        /// true when the message originated from Shell mode (terminal command)
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        terminal: bool,
    },
    /// Mode 变更通知
    ModeChanged { mode_id: String },
    /// Thought-level selector updated (push from agent via ConfigOptionUpdate,
    /// or echo after a SetThoughtLevel roundtrip). Empty available vec means
    /// the agent dropped the selector.
    ThoughtLevelsUpdate {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        available: Vec<(String, String)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config_id: Option<String>,
    },
    /// Agent Plan 更新（结构化 TODO 列表）
    PlanUpdate { entries: Vec<PlanEntryData> },
    /// 可用 Slash Commands 更新
    AvailableCommands { commands: Vec<CommandInfo> },
    /// 待执行消息队列更新
    QueueUpdate { messages: Vec<QueuedMessage> },
    /// Plan file 路径更新（Write 工具在 plan mode 下写入 .md 文件时触发）
    PlanFileUpdate {
        path: String,
        content: Option<String>,
    },
    /// 会话结束
    SessionEnded,
    /// 用户直接执行终端命令（Shell 模式）
    TerminalExecute { command: String },
    /// 终端输出片段（流式推送）
    TerminalChunk { output: String },
    /// 终端命令执行完成
    TerminalComplete { exit_code: Option<i32> },
}

/// 权限选项数据（从 ACP PermissionOption 提取，用于 WebSocket 传输）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermOptionData {
    pub option_id: String,
    pub name: String,
    pub kind: String, // "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

/// Plan entry 数据（从 ACP Plan 通知提取）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlanEntryData {
    pub content: String,
    pub status: String,
}

/// Slash command 数据（从 ACP AvailableCommandsUpdate 提取）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    pub input_hint: Option<String>,
}

/// Agent 的 Prompt 能力声明（从 ACP InitializeResponse 提取）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PromptCapabilitiesData {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

impl Default for PromptCapabilitiesData {
    fn default() -> Self {
        Self {
            image: true,
            audio: true,
            embedded_context: true,
        }
    }
}

/// 前端→后端的内容块类型（用于多媒体 prompt）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlockData {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Audio {
        data: String,
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    ResourceLink {
        uri: String,
        name: String,
        mime_type: Option<String>,
        size: Option<i64>,
        title: Option<String>,
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Resource {
        uri: String,
        mime_type: Option<String>,
        text: Option<String>,
    },
}

/// 队列中的待发送消息（支持附件）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QueuedMessage {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ContentBlockData>,
    /// 消息发送者标识。`None` = 用户输入；`Some("agent:<chat_id>")` = 另一个 agent
    /// 通过 agent_graph 工具注入的消息。语义对前端用于"身份徽章"渲染，对存储用于
    /// 区分 user / agent-injected 消息。Phase 2 引入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
}

/// Session 元数据（写入 session.json，供其他进程发现）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionMetadata {
    pub pid: u32,
    pub agent_name: String,
    pub agent_version: String,
    pub available_modes: Vec<(String, String)>,
    pub current_mode_id: Option<String>,
    pub available_models: Vec<(String, String)>,
    pub current_model_id: Option<String>,
    #[serde(default)]
    pub available_thought_levels: Vec<(String, String)>,
    #[serde(default)]
    pub current_thought_level_id: Option<String>,
    #[serde(default)]
    pub thought_level_config_id: Option<String>,
    #[serde(default)]
    pub prompt_capabilities: PromptCapabilitiesData,
    #[serde(default)]
    pub available_commands: Vec<CommandInfo>,
}

/// Unix socket 命令（JSONL，每连接一条）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SocketCommand {
    Prompt {
        text: String,
        #[serde(default)]
        attachments: Vec<ContentBlockData>,
        #[serde(default)]
        sender: Option<String>,
    },
    Cancel,
    SetMode {
        mode_id: String,
    },
    SetModel {
        model_id: String,
    },
    SetThoughtLevel {
        config_id: String,
        value_id: String,
    },
    RespondPermission {
        option_id: String,
    },
    Kill,
}

/// Unix socket 响应
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SocketResponse {
    Ok,
    Error { message: String },
}

/// Session 访问方式（本地进程内 vs 远程 socket）
pub enum SessionAccess {
    /// 本进程内的 session handle
    Local(Arc<AcpSessionHandle>),
    /// 另一个进程持有，通过 socket 通信
    Remote {
        sock_path: PathBuf,
        chat_dir: PathBuf,
        project_key: String,
        task_id: String,
        chat_id: String,
    },
}

/// ACP 启动配置
pub struct AcpStartConfig {
    pub agent_command: String,
    /// Agent logical name — used for adapter routing.
    pub agent_name: String,
    pub agent_args: Vec<String>,
    pub working_dir: PathBuf,
    pub env_vars: HashMap<String, String>,
    /// 项目 key（用于持久化 session_id）
    pub project_key: String,
    /// 任务 ID（用于持久化 session_id）
    pub task_id: String,
    /// Chat ID（multi-chat 支持，为空时使用旧的 task 级 session_id）
    pub chat_id: Option<String>,
    /// Agent 类型: "local" | "remote"
    pub agent_type: String,
    /// Remote WebSocket URL
    pub remote_url: Option<String>,
    /// Remote Authorization header
    pub remote_auth: Option<String>,
    /// Skip the automatic `ChatStatus("connecting")` broadcast on session
    /// registration. Set this when the caller has already broadcast it (e.g.
    /// `user_spawn_node` does it before fire-and-forget `get_or_start_session`
    /// to avoid a disconnected→connecting flicker) so the WS doesn't carry a
    /// duplicate event.
    pub suppress_initial_connecting: bool,
}

/// Build Grove's own MCP server config for ACP session setup.
fn grove_mcp_server(env_vars: &HashMap<String, String>) -> crate::error::Result<acp::McpServer> {
    let exe = std::env::current_exe().map_err(|e| {
        crate::error::GroveError::Session(format!(
            "Failed to resolve current executable for Grove MCP injection: {}",
            e
        ))
    })?;
    let command = exe.canonicalize().unwrap_or(exe);
    let env = env_vars
        .iter()
        .map(|(name, value)| acp::EnvVariable::new(name.clone(), value.clone()))
        .collect();

    Ok(acp::McpServer::Stdio(
        acp::McpServerStdio::new("grove", command)
            .args(vec!["mcp".to_string()])
            .env(env),
    ))
}

/// Build the `mcp_servers` list for `NewSessionRequest` / `LoadSessionRequest`.
///
/// Always includes the existing stdio `grove mcp` (orchestrator tools). When
/// `agent_graph_token` is `Some` and the in-process MCP HTTP listener is
/// running, **also** appends a second entry — the loopback Streamable HTTP
/// MCP that exposes the 5 agent_graph tools. The two MCP servers run in
/// parallel; their tool sets don't overlap (`grove_*` orchestrator vs
/// `grove_agent_*` graph) so the agent sees them as one combined toolbox.
///
/// The HTTP entry is silently skipped when the listener hasn't booted (e.g.
/// `grove acp` standalone mode, tests). In that case the agent only sees
/// stdio tools — agent_graph features become unavailable but the session
/// still works for normal chat.
fn build_mcp_servers(
    env_vars: &HashMap<String, String>,
    agent_graph_token: Option<&str>,
) -> crate::error::Result<Vec<acp::McpServer>> {
    let mut servers = vec![grove_mcp_server(env_vars)?];
    if let Some(token) = agent_graph_token {
        if let Some(url) = crate::api::handlers::agent_graph_mcp::build_mcp_url(token) {
            servers.push(acp::McpServer::Http(acp::McpServerHttp::new(
                "grove_agent_graph",
                url,
            )));
        }
    }
    Ok(servers)
}

/// RAII guard that unregisters the agent_graph MCP token on Drop. Created in
/// `drive_session` and held for the session's lifetime; dropping it (whether
/// the session exits cleanly, errors out, or panics) frees the token slot.
struct AgentGraphTokenGuard {
    token: String,
}

impl AgentGraphTokenGuard {
    fn new(token: String) -> Self {
        Self { token }
    }
    fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for AgentGraphTokenGuard {
    fn drop(&mut self) {
        let _ = crate::api::handlers::agent_graph_mcp::unregister_token(&self.token);
    }
}

/// 单个 terminal 实例的状态
struct TerminalState {
    /// Send to this channel to request process kill
    kill_tx: mpsc::Sender<()>,
    /// Accumulated stdout+stderr output
    output: Vec<u8>,
    /// Whether output was truncated due to byte limit
    truncated: bool,
    /// Maximum output bytes to retain (truncate from beginning)
    output_byte_limit: Option<u64>,
    /// Exit status once process completes
    exit_status: Option<acp::TerminalExitStatus>,
    /// Notified when process exits
    exit_notify: Arc<tokio::sync::Notify>,
}

/// Grove ACP client 共享状态。
///
/// 在 0.11 SDK 里 handler 不再是 trait 方法,而是注册到 `Client.builder()` 上的
/// 独立闭包。每个 handler 闭包通过 `Arc::clone` 捕获一份这个结构体,所以字段要么
/// 本身就是 `Send + Sync`、要么包在 `Mutex` 里。
struct AcpClientState {
    handle: Arc<AcpSessionHandle>,
    working_dir: PathBuf,
    terminals: Arc<Mutex<HashMap<String, TerminalState>>>,
    project_key: String,
    task_id: String,
    chat_id: Option<String>,
    adapter: Box<dyn adapter::AgentContentAdapter>,
    /// 文件快照缓存：tool_call_id → (abs_path, old_content_or_none)
    /// 用于 Write/Edit 工具调用时生成 diff（agent 不提供 content 时的 fallback）
    file_snapshots: Mutex<HashMap<String, (PathBuf, Option<String>)>>,
    /// Write 工具的 tool_call_id → file_path（用于 PlanFileUpdate 检测）
    write_tool_paths: Mutex<HashMap<String, String>>,
    /// "plan-like" 工具（如 Trae 的 `todo_write` / `update_plan`）的 tool_call_id：
    /// 某些 agent 不会对这些 tool 发 `ToolCallUpdate{status=completed}`，而是
    /// 用紧随其后的 `SessionUpdate::Plan` 事件代表"已应用"。没有人兜底的话，
    /// 前端这条 tool_call 会永远显示 running。我们在收到 Plan 时把它们合成
    /// 为 completed。
    pending_plan_tool_ids: Mutex<Vec<String>>,
}

/// 权限请求 handler。序列化:同一时刻只能有一个 permission 等待用户响应,
/// 后续请求会在 `permission_lock` 上排队。
async fn handle_request_permission(
    state: &AcpClientState,
    args: acp::RequestPermissionRequest,
) -> acp::Result<acp::RequestPermissionResponse> {
    let _guard = state.handle.permission_lock.lock().await;

    let request_id = args.tool_call.tool_call_id.to_string();
    let desc = args.tool_call.fields.title.clone().unwrap_or_default();
    let options: Vec<PermOptionData> = args
        .options
        .iter()
        .map(|o| PermOptionData {
            option_id: o.option_id.to_string(),
            name: o.name.clone(),
            kind: match o.kind {
                acp::PermissionOptionKind::AllowOnce => "allow_once".to_string(),
                acp::PermissionOptionKind::AllowAlways => "allow_always".to_string(),
                acp::PermissionOptionKind::RejectOnce => "reject_once".to_string(),
                acp::PermissionOptionKind::RejectAlways => "reject_always".to_string(),
                _ => format!("{:?}", o.kind).to_lowercase(),
            },
        })
        .collect();

    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .handle
        .pending_permission
        .lock()
        .unwrap()
        .replace((request_id.clone(), tx));

    state.handle.emit(AcpUpdate::PermissionRequest {
        id: request_id,
        description: desc.clone(),
        options,
    });

    notify_acp_event(
        &state.project_key,
        &state.task_id,
        "Permission Required",
        &desc,
        "Purr",
    );

    match rx.await {
        Ok(option_id) => Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(option_id)),
        )),
        Err(_) => Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Cancelled,
        )),
    }
}

async fn handle_create_terminal(
    state: &AcpClientState,
    args: acp::CreateTerminalRequest,
) -> acp::Result<acp::CreateTerminalResponse> {
    let id = format!(
        "term_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let cwd = args.cwd.unwrap_or_else(|| state.working_dir.clone());

    // Agent 发来的 command 可能是完整 shell 命令字符串(含 &&、|、;、空格参数等)。
    let shell_cmd = if args.args.is_empty() {
        args.command.clone()
    } else {
        format!("{} {}", args.command, args.args.join(" "))
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.arg("-l").arg("-i").arg("-c").arg(&shell_cmd);
    cmd.current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    for env_var in &args.env {
        cmd.env(&env_var.name, &env_var.value);
    }

    let child = cmd.spawn().map_err(|e| {
        acp::Error::internal_error().data(format!("Failed to spawn '{}': {}", shell_cmd, e))
    })?;

    let exit_notify = Arc::new(tokio::sync::Notify::new());
    let (kill_tx, kill_rx) = mpsc::channel(1);

    let term_state = TerminalState {
        kill_tx,
        output: Vec::new(),
        truncated: false,
        output_byte_limit: args.output_byte_limit,
        exit_status: None,
        exit_notify: exit_notify.clone(),
    };

    state
        .terminals
        .lock()
        .unwrap()
        .insert(id.clone(), term_state);

    let terminals = state.terminals.clone();
    let term_id = id.clone();
    // 0.11 handler 要求 Send,但 drive_terminal 的 future 是 Send;用 tokio::spawn
    // 而不是 spawn_local 避免对 LocalSet 的隐式依赖。
    tokio::spawn(async move {
        drive_terminal(terminals, term_id, child, kill_rx, exit_notify).await;
    });

    Ok(acp::CreateTerminalResponse::new(id))
}

async fn handle_terminal_output(
    state: &AcpClientState,
    args: acp::TerminalOutputRequest,
) -> acp::Result<acp::TerminalOutputResponse> {
    let terms = state.terminals.lock().unwrap();
    let tid = &*args.terminal_id.0;
    let term = terms
        .get(tid)
        .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;

    let resp =
        acp::TerminalOutputResponse::new(String::from_utf8_lossy(&term.output), term.truncated);
    Ok(if let Some(ref es) = term.exit_status {
        resp.exit_status(es.clone())
    } else {
        resp
    })
}

async fn handle_release_terminal(
    state: &AcpClientState,
    args: acp::ReleaseTerminalRequest,
) -> acp::Result<acp::ReleaseTerminalResponse> {
    let mut terms = state.terminals.lock().unwrap();
    let tid = &*args.terminal_id.0;
    if let Some(term) = terms.remove(tid) {
        let _ = term.kill_tx.try_send(());
    }
    Ok(acp::ReleaseTerminalResponse::default())
}

async fn handle_wait_for_terminal_exit(
    state: &AcpClientState,
    args: acp::WaitForTerminalExitRequest,
) -> acp::Result<acp::WaitForTerminalExitResponse> {
    let notify = {
        let terms = state.terminals.lock().unwrap();
        let tid = &*args.terminal_id.0;
        let term = terms
            .get(tid)
            .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
        if let Some(ref status) = term.exit_status {
            return Ok(acp::WaitForTerminalExitResponse::new(status.clone()));
        }
        term.exit_notify.clone()
    };
    notify.notified().await;

    let terms = state.terminals.lock().unwrap();
    let tid = &*args.terminal_id.0;
    let term = terms
        .get(tid)
        .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
    Ok(acp::WaitForTerminalExitResponse::new(
        term.exit_status.clone().unwrap_or_default(),
    ))
}

async fn handle_kill_terminal(
    state: &AcpClientState,
    args: acp::KillTerminalRequest,
) -> acp::Result<acp::KillTerminalResponse> {
    let terms = state.terminals.lock().unwrap();
    let tid = &*args.terminal_id.0;
    let term = terms
        .get(tid)
        .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
    let _ = term.kill_tx.try_send(());
    Ok(acp::KillTerminalResponse::default())
}

async fn handle_session_notification(
    state: &AcpClientState,
    args: acp::SessionNotification,
) -> acp::Result<(), acp::Error> {
    match args.update {
        acp::SessionUpdate::AgentMessageChunk(chunk) => {
            let text = content_block_to_text(&chunk.content);
            if let Ok(mut buf) = state.handle.last_assistant_text.lock() {
                buf.push_str(&text);
            }
            state.handle.emit(AcpUpdate::MessageChunk { text });
        }
        acp::SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = content_block_to_text(&chunk.content);
            // Some agents (observed on claude-code-acp) send `text: ""` thought
            // chunks as a "thinking" pulse without actual reasoning content.
            // Skip them so the UI doesn't create an empty Thought bubble.
            if !text.is_empty() {
                state.handle.emit(AcpUpdate::ThoughtChunk { text });
            }
        }
        acp::SessionUpdate::ToolCall(tool_call) => {
            let locations = tool_call
                .locations
                .iter()
                .map(|l| (l.path.display().to_string(), l.line))
                .collect();
            state.handle.emit(AcpUpdate::ToolCall {
                id: tool_call.tool_call_id.to_string(),
                title: tool_call.title.clone(),
                locations,
                timestamp: Some(Utc::now()),
            });

            // 记录 Write 工具的 tool_call_id → file_path(用于 PlanFileUpdate 检测)。
            // 路径可能在第二个 ToolCall 事件才出现,所以每次有 locations 时更新。
            if tool_call.title.starts_with("Write") {
                if let Some(loc) = tool_call.locations.first() {
                    state.write_tool_paths.lock().unwrap().insert(
                        tool_call.tool_call_id.to_string(),
                        loc.path.display().to_string(),
                    );
                } else {
                    state
                        .write_tool_paths
                        .lock()
                        .unwrap()
                        .entry(tool_call.tool_call_id.to_string())
                        .or_default();
                }
            }

            // 追踪 plan-like 工具:Trae 的 `todo_write` / `update_plan` 不走
            // ToolCallUpdate completed,而是用 SessionUpdate::Plan 代表完成。
            let lower_title = tool_call.title.to_lowercase();
            if matches!(
                lower_title.as_str(),
                "todo_write" | "todowrite" | "update_plan"
            ) {
                state
                    .pending_plan_tool_ids
                    .lock()
                    .unwrap()
                    .push(tool_call.tool_call_id.to_string());
            }

            // 缓存 Write/Edit 文件快照(locations 在第二个 ToolCall 事件才有路径)
            let title = &tool_call.title;
            if title.starts_with("Write") || title.starts_with("Edit") {
                if let Some(loc) = tool_call.locations.first() {
                    let id_str = tool_call.tool_call_id.to_string();
                    let mut snapshots = state.file_snapshots.lock().unwrap();
                    snapshots.entry(id_str).or_insert_with(|| {
                        let abs_path = loc.path.clone();
                        let old_content = std::fs::read_to_string(&abs_path).ok();
                        (abs_path, old_content)
                    });
                }
            }
        }
        acp::SessionUpdate::ToolCallUpdate(update) => {
            let mut content = update
                .fields
                .content
                .as_ref()
                .and_then(|blocks| blocks.first())
                .map(|tc| state.adapter.tool_call_content_to_text(tc));
            let status = update
                .fields
                .status
                .as_ref()
                .map(|s| format!("{:?}", s).to_lowercase())
                .unwrap_or_default();
            let locations: Vec<(String, Option<u32>)> = update
                .fields
                .locations
                .as_ref()
                .map(|locs| {
                    locs.iter()
                        .map(|l| (l.path.display().to_string(), l.line))
                        .collect()
                })
                .unwrap_or_default();

            // 如果 ACP 没提供 content 且状态为 completed,从文件快照生成 diff
            let is_completed = update
                .fields
                .status
                .as_ref()
                .is_some_and(|s| matches!(s, acp::ToolCallStatus::Completed));

            if content.is_none() && is_completed {
                let snapshot = state
                    .file_snapshots
                    .lock()
                    .unwrap()
                    .remove(&update.tool_call_id.to_string());
                if let Some((abs_path, old_content)) = snapshot {
                    if let Ok(new_text) = std::fs::read_to_string(&abs_path) {
                        content = Some(adapter::generate_file_diff(
                            &abs_path,
                            old_content.as_deref(),
                            &new_text,
                        ));
                    }
                }
            }

            // ToolCallUpdate 中也可能带 locations(路径可能只在中间的 update 出现),
            // 及时更新 write_tool_paths 以便 completed 时能拿到正确路径
            if !locations.is_empty() {
                let tc_id = update.tool_call_id.to_string();
                let mut paths = state.write_tool_paths.lock().unwrap();
                if let Some(existing) = paths.get_mut(&tc_id) {
                    if existing.is_empty() {
                        if let Some((p, _)) = locations.first() {
                            *existing = p.clone();
                        }
                    }
                }
            }

            // 若这个 tool_id 是 plan-like(之前记过),并且本次 update 是终态,
            // 从 pending 表里移掉,避免 Plan 事件误触重复完成。
            if matches!(
                status.as_str(),
                "completed" | "failed" | "error" | "cancelled"
            ) {
                let tc_id = update.tool_call_id.to_string();
                let mut ids = state.pending_plan_tool_ids.lock().unwrap();
                if let Some(pos) = ids.iter().position(|x| x == &tc_id) {
                    ids.swap_remove(pos);
                }
            }

            state.handle.emit(AcpUpdate::ToolCallUpdate {
                id: update.tool_call_id.to_string(),
                status: status.clone(),
                content,
                locations: locations.clone(),
            });

            // 检测 Plan File:Write 工具 completed 且在 plan mode 下写入 .md 文件
            if is_completed {
                let tc_id = update.tool_call_id.to_string();
                let write_path = state.write_tool_paths.lock().unwrap().remove(&tc_id);
                if let Some(path) = write_path.filter(|p| !p.is_empty()) {
                    if path.ends_with(".md") {
                        let mode = state.handle.current_mode_id.lock().unwrap().clone();
                        if mode
                            .as_ref()
                            .is_some_and(|m| m.to_lowercase().contains("plan"))
                        {
                            // 优先从 ACP ToolCallContent 提取原始内容(Diff.new_text)
                            let plan_content = update
                                .fields
                                .content
                                .as_ref()
                                .and_then(|blocks| blocks.first())
                                .and_then(|tc| match tc {
                                    acp::ToolCallContent::Diff(diff) => Some(diff.new_text.clone()),
                                    acp::ToolCallContent::Content(c) => {
                                        Some(content_block_to_text(&c.content))
                                    }
                                    _ => None,
                                })
                                .or_else(|| std::fs::read_to_string(&path).ok());
                            state.handle.emit(AcpUpdate::PlanFileUpdate {
                                path,
                                content: plan_content,
                            });
                        }
                    }
                }
            }
        }
        acp::SessionUpdate::UserMessageChunk(_) => {
            // Intentionally ignored: Grove already emits UserMessage
            // when AcpCommand::Prompt is received in run_acp_session's loop.
            // Processing this agent echo would duplicate every user message.
        }
        acp::SessionUpdate::CurrentModeUpdate(update) => {
            let mode_id = update.current_mode_id.to_string();
            *state.handle.current_mode_id.lock().unwrap() = Some(mode_id.clone());
            state.handle.emit(AcpUpdate::ModeChanged { mode_id });
        }
        acp::SessionUpdate::Plan(plan) => {
            let entries: Vec<PlanEntryData> = plan
                .entries
                .iter()
                .map(|e| PlanEntryData {
                    content: e.content.clone(),
                    status: format!("{:?}", e.status).to_lowercase(),
                })
                .collect();
            state.handle.emit(AcpUpdate::PlanUpdate { entries });
            // 给所有已观察到但还没收到 completed 的 plan-like tool_call 合成
            // 一条 completed ToolCallUpdate,避免前端上 spinner 永远转。
            let pending_ids: Vec<String> =
                std::mem::take(&mut *state.pending_plan_tool_ids.lock().unwrap());
            for id in pending_ids {
                state.handle.emit(AcpUpdate::ToolCallUpdate {
                    id,
                    status: "completed".to_string(),
                    content: None,
                    locations: Default::default(),
                });
            }
        }
        acp::SessionUpdate::AvailableCommandsUpdate(update) => {
            let commands = update
                .available_commands
                .iter()
                .map(|cmd| CommandInfo {
                    name: cmd.name.clone(),
                    description: cmd.description.clone(),
                    input_hint: cmd.input.as_ref().and_then(|input| match input {
                        acp::AvailableCommandInput::Unstructured(u) => Some(u.hint.clone()),
                        _ => None,
                    }),
                })
                .collect();
            state.handle.emit(AcpUpdate::AvailableCommands { commands });
        }
        acp::SessionUpdate::ConfigOptionUpdate(update) => {
            // Agent pushed a fresh list of SessionConfigOptions. Re-extract
            // the thought-level selector and forward to UI. Unrelated option
            // categories (Mode/Model/Other) are ignored here — Mode/Model have
            // their own CurrentModeUpdate / session-response paths.
            let (available, current, config_id) = extract_thought_level(&update.config_options);
            state.handle.emit(AcpUpdate::ThoughtLevelsUpdate {
                available,
                current,
                config_id,
            });
        }
        _ => {}
    }
    Ok(())
}

/// Emit a synthetic `ThoughtLevelsUpdate` after a successful
/// `SetSessionConfigOption` round-trip, so the new selection persists to
/// `SessionMetadata` even when the agent doesn't auto-echo via
/// `session_update.ConfigOptionUpdate`. Pulls the cached `available` list from
/// the persisted metadata (if any) to keep dropdown options intact; otherwise
/// emits an empty list and relies on the next `SessionReady` / update to refill.
fn emit_thought_level_sync(handle: &AcpSessionHandle, config_id: &str, value_id: &str) {
    let available = handle
        .chat_id
        .as_deref()
        .and_then(|cid| read_session_metadata(&handle.project_key, &handle.task_id, cid))
        .map(|meta| meta.available_thought_levels)
        .unwrap_or_default();
    handle.emit(AcpUpdate::ThoughtLevelsUpdate {
        available,
        current: Some(value_id.to_string()),
        config_id: Some(config_id.to_string()),
    });
}

/// Find the first config option with category == ThoughtLevel, extract its
/// select options + current value + config id. Returns (available, current, config_id).
/// MVP: only Ungrouped Select kind is exposed; Grouped / Boolean are ignored so
/// the UI has a single predictable shape.
fn extract_thought_level(
    config_options: &[acp::SessionConfigOption],
) -> (Vec<(String, String)>, Option<String>, Option<String>) {
    for opt in config_options {
        if !matches!(
            opt.category,
            Some(acp::SessionConfigOptionCategory::ThoughtLevel)
        ) {
            continue;
        }
        let acp::SessionConfigKind::Select(select) = &opt.kind else {
            continue;
        };
        let acp::SessionConfigSelectOptions::Ungrouped(entries) = &select.options else {
            continue;
        };
        let available: Vec<(String, String)> = entries
            .iter()
            .map(|e| (e.value.to_string(), e.name.clone()))
            .collect();
        return (
            available,
            Some(select.current_value.to_string()),
            Some(opt.id.to_string()),
        );
    }
    (vec![], None, None)
}

/// 将 ContentBlock 转换为文本
pub fn content_block_to_text(block: &acp::ContentBlock) -> String {
    match block {
        acp::ContentBlock::Text(t) => t.text.clone(),
        acp::ContentBlock::Image(_) => "<image>".to_string(),
        acp::ContentBlock::Audio(_) => "<audio>".to_string(),
        acp::ContentBlock::ResourceLink(r) => r.uri.clone(),
        acp::ContentBlock::Resource(_) => "<resource>".to_string(),
        _ => "<unknown>".to_string(),
    }
}

/// 将 ContentBlockData 转换为 ACP ContentBlock
fn to_acp_content_block(block: &ContentBlockData) -> acp::ContentBlock {
    match block {
        ContentBlockData::Text { text } => text.clone().into(),
        ContentBlockData::Image {
            data,
            mime_type,
            label,
        } => {
            let mut img = acp::ImageContent::new(data, mime_type);
            if let Some(l) = label {
                img = img.uri(l.clone());
            }
            acp::ContentBlock::Image(img)
        }
        ContentBlockData::Audio {
            data,
            mime_type,
            label,
        } => {
            let mut aud = acp::AudioContent::new(data, mime_type);
            // AudioContent has no uri field; store label in _meta if present
            if let Some(l) = label {
                let mut meta = serde_json::Map::new();
                meta.insert("name".to_string(), serde_json::Value::String(l.clone()));
                aud = aud.meta(meta);
            }
            acp::ContentBlock::Audio(aud)
        }
        ContentBlockData::ResourceLink {
            uri,
            name,
            mime_type,
            size,
            title,
            description,
            label,
        } => {
            let rl = acp::ResourceLink::new(name.clone(), uri.clone())
                .mime_type(mime_type.clone())
                .size(*size)
                .title(title.clone().or_else(|| label.clone()))
                .description(description.clone());
            acp::ContentBlock::ResourceLink(rl)
        }
        ContentBlockData::Resource {
            uri,
            mime_type: _,
            text,
        } => acp::ContentBlock::Resource(acp::EmbeddedResource::new(
            acp::EmbeddedResourceResource::TextResourceContents(acp::TextResourceContents::new(
                text.clone().unwrap_or_default(),
                uri,
            )),
        )),
    }
}

/// 后台任务：读取 terminal 进程的 stdout/stderr 输出，等待退出
async fn drive_terminal(
    terminals: Arc<Mutex<HashMap<String, TerminalState>>>,
    id: String,
    mut child: tokio::process::Child,
    mut kill_rx: mpsc::Receiver<()>,
    exit_notify: Arc<tokio::sync::Notify>,
) {
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let mut stdout_buf = [0u8; 4096];
    let mut stderr_buf = [0u8; 4096];
    let mut stdout_done = false;
    let mut stderr_done = false;

    loop {
        tokio::select! {
            result = stdout.read(&mut stdout_buf), if !stdout_done => {
                match result {
                    Ok(0) | Err(_) => stdout_done = true,
                    Ok(n) => append_terminal_output(&terminals, &id, &stdout_buf[..n]),
                }
            }
            result = stderr.read(&mut stderr_buf), if !stderr_done => {
                match result {
                    Ok(0) | Err(_) => stderr_done = true,
                    Ok(n) => append_terminal_output(&terminals, &id, &stderr_buf[..n]),
                }
            }
            _ = kill_rx.recv() => {
                let _ = child.start_kill();
                // Don't break — continue reading until EOF so output is captured
            }
        }

        if stdout_done && stderr_done {
            break;
        }
    }

    // Wait for child to exit and capture status
    let exit_status = match child.wait().await {
        Ok(status) => {
            let mut es = acp::TerminalExitStatus::new();
            if let Some(code) = status.code() {
                // `status.code()` returns Some only on clean exit, where the
                // code is already non-negative on every supported platform.
                es = es.exit_code(code as u32);
            }
            es
        }
        Err(_) => acp::TerminalExitStatus::default(),
    };

    {
        let mut terms = terminals.lock().unwrap();
        if let Some(state) = terms.get_mut(&id) {
            state.exit_status = Some(exit_status);
        }
    }
    exit_notify.notify_waiters();
}

/// 追加输出到 terminal 缓冲区，应用字节数限制截断
fn append_terminal_output(
    terminals: &Arc<Mutex<HashMap<String, TerminalState>>>,
    id: &str,
    data: &[u8],
) {
    let mut terms = terminals.lock().unwrap();
    if let Some(state) = terms.get_mut(id) {
        state.output.extend_from_slice(data);
        if let Some(limit) = state.output_byte_limit {
            let limit = limit as usize;
            if state.output.len() > limit {
                let excess = state.output.len() - limit;
                state.output.drain(..excess);
                state.truncated = true;
            }
        }
    }
}

/// 获取已存在的 ACP 会话，或启动一个新的
///
/// 如果 session key 已存在，复用现有会话（返回新的 broadcast subscriber）。
/// 否则启动新会话，会话线程由模块自行管理（独立于 WebSocket 连接）。
pub async fn get_or_start_session(
    key: String,
    config: AcpStartConfig,
) -> crate::error::Result<(Arc<AcpSessionHandle>, broadcast::Receiver<AcpUpdate>)> {
    // Serialize concurrent get_or_start for the same key. Without this, two
    // callers can both pass the read check below before either gets a chance
    // to insert, then both spawn full ACP subprocesses; the second insert
    // overwrites the first handle and the first ACP subprocess becomes
    // orphaned (commands sent through the registered handle never reach it).
    //
    // Strategy: check the sessions map; if absent, atomically claim a slot
    // in STARTING_SESSIONS. Other concurrent callers see the claim, sleep
    // briefly, and retry — by then the winner has either finished registering
    // (cache hit on retry) or failed (claim released, retrying caller wins).
    loop {
        if let Ok(sessions) = ACP_SESSIONS.read() {
            if let Some(handle) = sessions.get(&key) {
                let rx = handle.subscribe();
                return Ok((handle.clone(), rx));
            }
        }
        let claimed = {
            let mut starting = STARTING_SESSIONS.lock().unwrap();
            if starting.contains(&key) {
                false
            } else {
                starting.insert(key.clone());
                true
            }
        };
        if claimed {
            break;
        }
        // Another caller is currently spawning this key — yield and retry.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // 创建新会话 — 线程和 LocalSet 由模块管理
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();

    // Move the spawn-claim ownership INTO the std::thread closure. If the
    // guard sat on the calling future, a cancelled caller (tokio::spawn
    // dropped, HTTP client disconnects, await timeout, etc.) would release
    // the claim while the thread races to insert into ACP_SESSIONS — the
    // second concurrent caller would then start a parallel ACP subprocess,
    // exactly the TOCTOU the claim was added to prevent.
    let starting_key_for_thread = key.clone();

    std::thread::spawn(move || {
        // RAII: release the spawn claim at thread exit (covers normal exit
        // AND panic). Concurrent retries between insertion and thread exit
        // are short-circuited by the ACP_SESSIONS.read() check at the top
        // of get_or_start_session.
        struct StartGuard(String);
        impl Drop for StartGuard {
            fn drop(&mut self) {
                if let Ok(mut s) = STARTING_SESSIONS.lock() {
                    s.remove(&self.0);
                }
            }
        }
        let _start_guard = StartGuard(starting_key_for_thread);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create ACP runtime");

            let local = tokio::task::LocalSet::new();
            rt.block_on(local.run_until(async move {
                let key_clone = key.clone();

                let (update_tx, update_rx) = broadcast::channel::<AcpUpdate>(256);
                let (cmd_tx, cmd_rx) = mpsc::channel::<AcpCommand>(32);

                let handle = Arc::new(AcpSessionHandle {
                    key: key.clone(),
                    update_tx: update_tx.clone(),
                    cmd_tx,
                    agent_info: std::sync::RwLock::new(None),
                    pending_permission: Mutex::new(None),
                    permission_lock: tokio::sync::Mutex::new(()),
                    project_key: config.project_key.clone(),
                    task_id: config.task_id.clone(),
                    chat_id: config.chat_id.clone(),
                    suppress_emit: std::sync::atomic::AtomicBool::new(false),
                    pending_queue: Mutex::new(Vec::new()),
                    queue_paused: std::sync::atomic::AtomicBool::new(false),
                    current_mode_id: Mutex::new(None),
                    working_dir: config.working_dir.to_string_lossy().to_string(),
                    terminal_kill_tx: Mutex::new(None),
                    is_busy: std::sync::atomic::AtomicBool::new(false),
                    last_assistant_text: Mutex::new(String::new()),
                });

                // 注册到全局表
                if let Ok(mut sessions) = ACP_SESSIONS.write() {
                    sessions.insert(key.clone(), handle.clone());
                }

                // RAII cleanup: if anything below this point panics, we MUST
                // remove the dead handle from ACP_SESSIONS and broadcast
                // disconnected so the UI doesn't keep a stuck-on-busy node
                // pointing at a handle whose cmd_tx receiver was dropped.
                struct EndGuard {
                    key: String,
                    project_key: String,
                    task_id: String,
                    chat_id: Option<String>,
                    finalized: bool,
                }
                impl Drop for EndGuard {
                    fn drop(&mut self) {
                        if self.finalized {
                            return;
                        }
                        if let Ok(mut sessions) = ACP_SESSIONS.write() {
                            sessions.remove(&self.key);
                        }
                        if let Some(ref cid) = self.chat_id {
                            use crate::api::handlers::walkie_talkie::{
                                broadcast_radio_event, RadioEvent,
                            };
                            broadcast_radio_event(RadioEvent::ChatStatus {
                                project_id: self.project_key.clone(),
                                task_id: self.task_id.clone(),
                                chat_id: cid.clone(),
                                status: "disconnected".to_string(),
                            });
                            cleanup_socket_files(&self.project_key, &self.task_id, cid);
                        }
                    }
                }
                let mut end_guard = EndGuard {
                    key: key_clone.clone(),
                    project_key: config.project_key.clone(),
                    task_id: config.task_id.clone(),
                    chat_id: config.chat_id.clone(),
                    finalized: false,
                };

                // Announce "connecting" the moment the handle is registered,
                // unless the caller already broadcast it (skips a duplicate
                // event on the user_spawn_node fire-and-forget path).
                if !config.suppress_initial_connecting {
                    if let Some(ref chat_id) = config.chat_id {
                        use crate::api::handlers::walkie_talkie::{
                            broadcast_radio_event, RadioEvent,
                        };
                        broadcast_radio_event(RadioEvent::ChatStatus {
                            project_id: config.project_key.clone(),
                            task_id: config.task_id.clone(),
                            chat_id: chat_id.clone(),
                            status: "connecting".to_string(),
                        });
                    }
                }

                // 启动 socket listener（在 LocalSet 内 spawn_local，Unix only）
                #[cfg(unix)]
                if let Some(chat_id) = &config.chat_id {
                    let sp = sock_path(&config.project_key, &config.task_id, chat_id);
                    tokio::task::spawn_local(run_socket_listener(sp, handle.clone()));
                }

                // 发送 handle 给调用方（在启动会话循环之前）
                let _ = result_tx.send(Ok((handle.clone(), update_rx)));

                // 运行会话循环（阻塞直到 Kill 或错误）
                let session_project_key = config.project_key.clone();
                let session_task_id = config.task_id.clone();
                let session_chat_id = config.chat_id.clone();

                if let Err(e) = run_acp_session(handle, config, cmd_rx).await {
                    let _ = update_tx.send(AcpUpdate::Error {
                        message: format!("ACP session error: {}", e),
                    });
                }
                let _ = update_tx.send(AcpUpdate::SessionEnded);

                // Normal-exit cleanup. Mark EndGuard finalized FIRST so any
                // panic during the cleanup ops below doesn't trigger Drop's
                // duplicate disconnected broadcast. EndGuard exists to handle
                // panics inside run_acp_session above; once we've reached
                // this point we own the cleanup explicitly.
                end_guard.finalized = true;
                if let Ok(mut sessions) = ACP_SESSIONS.write() {
                    sessions.remove(&key_clone);
                }
                if let Some(ref cid) = session_chat_id {
                    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
                    broadcast_radio_event(RadioEvent::ChatStatus {
                        project_id: session_project_key.clone(),
                        task_id: session_task_id.clone(),
                        chat_id: cid.clone(),
                        status: "disconnected".to_string(),
                    });
                    cleanup_socket_files(&session_project_key, &session_task_id, cid);
                }
            }));
        }));
        if let Err(e) = result {
            let msg = if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            eprintln!("[Grove] ACP session thread panicked: {}", msg);
        }
    });

    result_rx.await.map_err(|_| {
        crate::error::GroveError::Session("ACP session thread terminated".to_string())
    })?
}

/// 运行 ACP 会话的主循环
async fn run_acp_session(
    handle: Arc<AcpSessionHandle>,
    config: AcpStartConfig,
    cmd_rx: mpsc::Receiver<AcpCommand>,
) -> crate::error::Result<()> {
    // 根据 agent_type 分支获取 reader/writer（使用 trait object 统一类型）
    let child: Option<tokio::process::Child>;
    // 0.11 ByteStreams 要求 Send + 'static;grove 的子进程 pipe 和 DuplexStream 都满足。
    let writer: Box<dyn futures::AsyncWrite + Send + Unpin>;
    let reader: Box<dyn futures::AsyncRead + Send + Unpin>;

    if config.agent_type == "remote" {
        // Remote: WebSocket 连接（通过 duplex 管道桥接为 AsyncRead/AsyncWrite）
        child = None;
        let (r, w) = connect_remote_agent(&config).await?;
        reader = Box::new(r);
        writer = Box::new(w);
    } else {
        // Local: 子进程
        // Resolve the program through PATH+PATHEXT before spawning. On Windows
        // `CreateProcessW` doesn't search PATHEXT, so a bare "opencode" fails
        // even when `opencode.cmd` (an npm shim) is on PATH. Pre-resolving to
        // an absolute path makes spawn behave consistently with the shell.
        let resolved = crate::check::resolve_program(&config.agent_command).ok_or_else(|| {
            crate::error::GroveError::Session(format!(
                "Failed to spawn ACP agent '{}': program not found on PATH",
                config.agent_command
            ))
        })?;
        let mut proc = tokio::process::Command::new(&resolved)
            .args(&config.agent_args)
            .current_dir(&config.working_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .envs(&config.env_vars)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                crate::error::GroveError::Session(format!(
                    "Failed to spawn ACP agent '{}' ({}): {}",
                    config.agent_command,
                    resolved.display(),
                    e
                ))
            })?;

        // Redirect agent stderr to log file instead of inheriting parent's stderr
        if let Some(stderr) = proc.stderr.take() {
            let log_path = agent_log_path(
                &config.project_key,
                &config.task_id,
                config.chat_id.as_deref(),
            );
            tokio::task::spawn_local(drain_stderr_to_file(stderr, log_path));
        }

        writer = Box::new(proc.stdin.take().unwrap().compat_write());
        reader = Box::new(proc.stdout.take().unwrap().compat());
        child = Some(proc);
    }

    let adapter = adapter::resolve_adapter(&config.agent_name, &config.agent_command);

    let state = Arc::new(AcpClientState {
        handle: handle.clone(),
        working_dir: config.working_dir.clone(),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        project_key: config.project_key.clone(),
        task_id: config.task_id.clone(),
        chat_id: config.chat_id.clone(),
        adapter,
        file_snapshots: Mutex::new(HashMap::new()),
        write_tool_paths: Mutex::new(HashMap::new()),
        pending_plan_tool_ids: Mutex::new(Vec::new()),
    });

    let transport = acp::ByteStreams::new(writer, reader);

    // 每个 handler 闭包通过 Arc::clone 捕获一份 state。0.11 要求 handler 的 F
    // 本身是 Send,所以 state 必须是 Send + Sync(AcpClientState 已满足)。
    let result = acp::Client
        .builder()
        .on_receive_notification(
            {
                let state = Arc::clone(&state);
                async move |notif: acp::SessionNotification, _cx| {
                    handle_session_notification(&state, notif).await
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::RequestPermissionRequest, responder, _cx| {
                    match handle_request_permission(&state, req).await {
                        Ok(r) => responder.respond(r),
                        Err(e) => responder.respond_with_error(e),
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::CreateTerminalRequest, responder, _cx| {
                    match handle_create_terminal(&state, req).await {
                        Ok(r) => responder.respond(r),
                        Err(e) => responder.respond_with_error(e),
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::TerminalOutputRequest, responder, _cx| {
                    match handle_terminal_output(&state, req).await {
                        Ok(r) => responder.respond(r),
                        Err(e) => responder.respond_with_error(e),
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::ReleaseTerminalRequest, responder, _cx| {
                    match handle_release_terminal(&state, req).await {
                        Ok(r) => responder.respond(r),
                        Err(e) => responder.respond_with_error(e),
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::WaitForTerminalExitRequest, responder, _cx| {
                    match handle_wait_for_terminal_exit(&state, req).await {
                        Ok(r) => responder.respond(r),
                        Err(e) => responder.respond_with_error(e),
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::KillTerminalRequest, responder, _cx| {
                    match handle_kill_terminal(&state, req).await {
                        Ok(r) => responder.respond(r),
                        Err(e) => responder.respond_with_error(e),
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, move |conn: acp::ConnectionTo<acp::Agent>| {
            drive_session(handle, config, cmd_rx, conn)
        })
        .await;

    // kill_on_drop 会清理子进程
    drop(child);

    result.map_err(|e| crate::error::GroveError::Session(format!("ACP session error: {}", e)))
}

/// 在 `connect_with` 的 `main_fn` 里运行 ACP 会话生命周期:initialize → 创建/恢复
/// session → 命令循环。与 handler 不同,这里运行在一个独立的"spawned task"上下文,
/// 可以安全使用 `SentRequest::block_task()`。
async fn drive_session(
    handle: Arc<AcpSessionHandle>,
    config: AcpStartConfig,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
    conn: acp::ConnectionTo<acp::Agent>,
) -> acp::Result<(), acp::Error> {
    fn extract_modes(
        modes: &Option<acp::SessionModeState>,
    ) -> (Vec<(String, String)>, Option<String>) {
        match modes {
            Some(state) => {
                let available: Vec<(String, String)> = state
                    .available_modes
                    .iter()
                    .map(|m| (m.id.to_string(), m.name.clone()))
                    .collect();
                let current = Some(state.current_mode_id.to_string());
                (available, current)
            }
            None => (vec![], None),
        }
    }

    fn extract_models(
        models: &Option<acp::SessionModelState>,
    ) -> (Vec<(String, String)>, Option<String>) {
        match models {
            Some(state) => {
                let available: Vec<(String, String)> = state
                    .available_models
                    .iter()
                    .map(|m| (m.model_id.to_string(), m.name.clone()))
                    .collect();
                let current = Some(state.current_model_id.to_string());
                (available, current)
            }
            None => (vec![], None),
        }
    }

    // Grove 内部错误 → acp::Error
    fn to_acp_err(e: impl std::fmt::Display) -> acp::Error {
        acp::Error::internal_error().data(format!("{}", e))
    }

    // Allocate an agent_graph MCP token if this session has a chat_id (per-chat
    // sessions are the only ones that participate in the graph). The token
    // binds (URL token → caller_chat_id) for the in-process HTTP MCP listener;
    // the guard unregisters on drop, no matter how drive_session exits.
    let _agent_graph_token_guard: Option<AgentGraphTokenGuard> =
        config.chat_id.as_ref().map(|chat_id| {
            let token = uuid::Uuid::new_v4().to_string();
            crate::api::handlers::agent_graph_mcp::register_token(&token, chat_id);
            AgentGraphTokenGuard::new(token)
        });
    let agent_graph_token: Option<&str> = _agent_graph_token_guard.as_ref().map(|g| g.token());

    // 初始化连接
    let init_resp = conn
        .send_request(
            acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                .client_capabilities(acp::ClientCapabilities::default().terminal(true))
                .client_info(
                    acp::Implementation::new("grove", env!("CARGO_PKG_VERSION")).title("Grove"),
                ),
        )
        .block_task()
        .await?;

    let agent_name = init_resp
        .agent_info
        .as_ref()
        .map(|i| i.name.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let agent_version = init_resp
        .agent_info
        .as_ref()
        .map(|i| i.version.clone())
        .unwrap_or_else(|| "0.0.0".to_string());

    // Trae 错误地标识了不支持 load_session 且不返回 agent_info,但实际可以调用
    let is_trae = config.agent_command.contains("trae");
    let supports_load = init_resp.agent_capabilities.load_session || is_trae;

    // 查找保存的 session_id(从 chat session 读取)
    let saved_id = config.chat_id.as_ref().and_then(|cid| {
        crate::storage::tasks::get_chat_session(&config.project_key, &config.task_id, cid)
            .ok()
            .flatten()
            .and_then(|c| c.acp_session_id)
    });

    let persist_session_id = |sid: &str| {
        if let Some(ref cid) = config.chat_id {
            let _ = crate::storage::tasks::update_chat_acp_session_id(
                &config.project_key,
                &config.task_id,
                cid,
                sid,
            );
        }
    };

    let available_modes;
    let current_mode_id;
    let available_models;
    let current_model_id;
    let available_thought_levels;
    let current_thought_level_id;
    let thought_level_config_id;

    macro_rules! create_new_session {
        () => {{
            if let Some(ref cid) = config.chat_id {
                crate::storage::chat_history::clear_history(
                    &config.project_key,
                    &config.task_id,
                    cid,
                );
            }
            let mcp_servers =
                build_mcp_servers(&config.env_vars, agent_graph_token).map_err(to_acp_err)?;
            let resp = conn
                .send_request(
                    acp::NewSessionRequest::new(&config.working_dir).mcp_servers(mcp_servers),
                )
                .block_task()
                .await?;
            let sid = resp.session_id.to_string();
            persist_session_id(&sid);
            (available_modes, current_mode_id) = extract_modes(&resp.modes);
            (available_models, current_model_id) = extract_models(&resp.models);
            (
                available_thought_levels,
                current_thought_level_id,
                thought_level_config_id,
            ) = extract_thought_level(resp.config_options.as_deref().unwrap_or(&[]));
            sid
        }};
    }

    let session_id = if let (true, Some(saved_id)) = (supports_load, saved_id) {
        // 抑制 agent 的回放通知(Grove 统一从磁盘回放)
        handle
            .suppress_emit
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let load_result = {
            let mcp_servers =
                build_mcp_servers(&config.env_vars, agent_graph_token).map_err(to_acp_err)?;
            conn.send_request(
                acp::LoadSessionRequest::new(acp::SessionId::new(&*saved_id), &config.working_dir)
                    .mcp_servers(mcp_servers),
            )
            .block_task()
            .await
        };
        // load_session spec 保证 response 在所有 replay notification 之后,
        // 额外等 300ms 作为安全余量
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        handle
            .suppress_emit
            .store(false, std::sync::atomic::Ordering::Relaxed);

        match load_result {
            Ok(resp) => {
                (available_modes, current_mode_id) = extract_modes(&resp.modes);
                (available_models, current_model_id) = extract_models(&resp.models);
                (
                    available_thought_levels,
                    current_thought_level_id,
                    thought_level_config_id,
                ) = extract_thought_level(resp.config_options.as_deref().unwrap_or(&[]));
                saved_id
            }
            Err(_) => create_new_session!(),
        }
    } else {
        create_new_session!()
    };

    let session_id_arc = acp::SessionId::new(&*session_id);

    let prompt_capabilities = PromptCapabilitiesData {
        image: init_resp.agent_capabilities.prompt_capabilities.image,
        audio: init_resp.agent_capabilities.prompt_capabilities.audio,
        embedded_context: init_resp
            .agent_capabilities
            .prompt_capabilities
            .embedded_context,
    };

    if let Ok(mut info) = handle.agent_info.write() {
        *info = Some((
            session_id.clone(),
            agent_name.clone(),
            agent_version.clone(),
        ));
    }

    *handle.current_mode_id.lock().unwrap() = current_mode_id.clone();

    handle.emit(AcpUpdate::SessionReady {
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
    });

    // 处理命令循环
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::Prompt {
                text,
                attachments,
                sender,
                terminal,
            } => {
                handle.emit(AcpUpdate::UserMessage {
                    text: text.clone(),
                    attachments: attachments.clone(),
                    sender,
                    terminal,
                });
                handle.emit(AcpUpdate::Busy { value: true });
                if let Ok(mut buf) = handle.last_assistant_text.lock() {
                    buf.clear();
                }

                let mut content_blocks: Vec<acp::ContentBlock> = vec![text.into()];
                for block in &attachments {
                    content_blocks.push(to_acp_content_block(block));
                }

                // 用 SentRequest::block_task() 得到可被 select 的 future
                let prompt_fut = conn
                    .send_request(acp::PromptRequest::new(
                        session_id_arc.clone(),
                        content_blocks,
                    ))
                    .block_task();
                tokio::pin!(prompt_fut);

                let cancel_deadline: std::cell::Cell<Option<tokio::time::Instant>> =
                    std::cell::Cell::new(None);
                let mut next_prompt: Option<(String, Vec<ContentBlockData>)> = None;
                let mut got_kill = false;

                let result = loop {
                    let deadline = cancel_deadline.get();
                    tokio::select! {
                        res = &mut prompt_fut => break res,
                        _ = tokio::time::sleep_until(deadline.unwrap_or_else(|| tokio::time::Instant::now() + std::time::Duration::from_secs(86400))), if deadline.is_some() => {
                            eprintln!("[ACP] Cancel timeout — agent unresponsive, forcing exit");
                            break Err(acp::Error::internal_error());
                        }
                        Some(inner_cmd) = cmd_rx.recv() => {
                            match inner_cmd {
                                AcpCommand::Cancel => {
                                    // 0.11: cancel 是 Notification,send_notification 是同步 API
                                    let _ = conn.send_notification(acp::CancelNotification::new(session_id_arc.clone()));
                                    cancel_deadline.set(Some(tokio::time::Instant::now() + std::time::Duration::from_secs(10)));
                                }
                                AcpCommand::SetMode { mode_id } => {
                                    *handle.current_mode_id.lock().unwrap() = Some(mode_id.clone());
                                    handle.emit(AcpUpdate::ModeChanged { mode_id: mode_id.clone() });
                                    let _ = conn.send_request(acp::SetSessionModeRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionModeId::new(mode_id),
                                    )).block_task().await;
                                }
                                AcpCommand::SetModel { model_id } => {
                                    let _ = conn.send_request(acp::SetSessionModelRequest::new(
                                        session_id_arc.clone(),
                                        acp::ModelId::new(model_id),
                                    )).block_task().await;
                                }
                                AcpCommand::SetThoughtLevel { config_id, value_id } => {
                                    let resp = conn.send_request(acp::SetSessionConfigOptionRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionConfigId::new(config_id.clone()),
                                        acp::SessionConfigValueId::new(value_id.clone()),
                                    )).block_task().await;
                                    if resp.is_ok() {
                                        // Optimistically mirror the selection so reconnects
                                        // see it even if the agent doesn't auto-echo via
                                        // session_update. The ThoughtLevelsUpdate handler
                                        // elsewhere in this file persists this to disk.
                                        emit_thought_level_sync(&handle, &config_id, &value_id);
                                    }
                                }
                                AcpCommand::Prompt { text, attachments, .. } => {
                                    let _ = conn.send_notification(acp::CancelNotification::new(session_id_arc.clone()));
                                    cancel_deadline.set(Some(tokio::time::Instant::now() + std::time::Duration::from_secs(10)));
                                    next_prompt = Some((text, attachments));
                                }
                                AcpCommand::Kill => {
                                    got_kill = true;
                                    break Err(acp::Error::internal_error());
                                }
                            }
                        }
                    }
                };

                if got_kill {
                    handle.emit(AcpUpdate::Busy { value: false });
                    handle.emit(AcpUpdate::Error {
                        message: "Session killed".to_string(),
                    });
                    break;
                }

                match result {
                    Ok(resp) => {
                        if next_prompt.is_none() {
                            let summary = handle
                                .last_assistant_text
                                .lock()
                                .ok()
                                .map(|buf| truncate_chars(&buf, 80))
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| "Agent finished responding".to_string());
                            notify_acp_event(
                                &config.project_key,
                                &config.task_id,
                                "Task Complete",
                                &summary,
                                "Glass",
                            );
                            handle.emit(AcpUpdate::Busy { value: false });
                            handle.emit(AcpUpdate::Complete {
                                stop_reason: format!("{:?}", resp.stop_reason),
                            });
                        } else {
                            handle.emit(AcpUpdate::Busy { value: false });
                        }
                    }
                    Err(e) => {
                        handle.emit(AcpUpdate::Busy { value: false });
                        if next_prompt.is_none() {
                            handle.emit(AcpUpdate::Error {
                                message: format!("Prompt error: {}", e),
                            });
                        }
                    }
                }

                if let Some((text, attachments)) = next_prompt {
                    let _ = handle.cmd_tx.try_send(AcpCommand::Prompt {
                        text,
                        attachments,
                        sender: None,
                        terminal: false,
                    });
                } else if !handle
                    .queue_paused
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    if let Some(next_msg) = handle.pop_queue_front() {
                        handle.emit(AcpUpdate::QueueUpdate {
                            messages: handle.get_queue(),
                        });
                        handle.try_enqueue_prompt(
                            next_msg.text,
                            next_msg.attachments,
                            next_msg.sender,
                        );
                    }
                }
            }
            AcpCommand::Cancel => {
                // Agent 空闲时收到 Cancel,忽略
            }
            AcpCommand::SetMode { mode_id } => {
                *handle.current_mode_id.lock().unwrap() = Some(mode_id.clone());
                handle.emit(AcpUpdate::ModeChanged {
                    mode_id: mode_id.clone(),
                });
                let _ = conn
                    .send_request(acp::SetSessionModeRequest::new(
                        session_id_arc.clone(),
                        acp::SessionModeId::new(mode_id),
                    ))
                    .block_task()
                    .await;
            }
            AcpCommand::SetModel { model_id } => {
                let _ = conn
                    .send_request(acp::SetSessionModelRequest::new(
                        session_id_arc.clone(),
                        acp::ModelId::new(model_id),
                    ))
                    .block_task()
                    .await;
            }
            AcpCommand::SetThoughtLevel {
                config_id,
                value_id,
            } => {
                let resp = conn
                    .send_request(acp::SetSessionConfigOptionRequest::new(
                        session_id_arc.clone(),
                        acp::SessionConfigId::new(config_id.clone()),
                        acp::SessionConfigValueId::new(value_id.clone()),
                    ))
                    .block_task()
                    .await;
                if resp.is_ok() {
                    emit_thought_level_sync(&handle, &config_id, &value_id);
                }
            }
            AcpCommand::Kill => {
                break;
            }
        }
    }

    Ok(())
}

/// Remote WebSocket agent: 通过 tokio-tungstenite 连接，桥接为 AsyncRead/AsyncWrite
async fn connect_remote_agent(
    config: &AcpStartConfig,
) -> crate::error::Result<(
    tokio_util::compat::Compat<tokio::io::DuplexStream>,
    tokio_util::compat::Compat<tokio::io::DuplexStream>,
)> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    use tokio_tungstenite::tungstenite;

    let url = config
        .remote_url
        .as_ref()
        .ok_or_else(|| crate::error::GroveError::Session("Remote URL is required".into()))?;

    use tungstenite::client::IntoClientRequest;
    let mut request = url.as_str().into_client_request().map_err(|e| {
        crate::error::GroveError::Session(format!("Failed to build WS request: {}", e))
    })?;

    if let Some(auth) = &config.remote_auth {
        request.headers_mut().insert(
            "Authorization",
            auth.parse().map_err(|e| {
                crate::error::GroveError::Session(format!("Invalid auth header: {}", e))
            })?,
        );
    }

    let (ws_stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| {
            crate::error::GroveError::Session(format!("WebSocket connect failed: {}", e))
        })?;

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // duplex 管道：ACP 侧 <-> WebSocket 侧
    let (agent_read, mut bridge_write) = tokio::io::duplex(64 * 1024);
    let (bridge_read, agent_write) = tokio::io::duplex(64 * 1024);

    // 后台任务: ws_read -> bridge_write (WebSocket text frames -> raw bytes)
    tokio::task::spawn_local(async move {
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(tungstenite::Message::Text(text)) => {
                    let line = format!("{}\n", text);
                    if bridge_write.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Ok(tungstenite::Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });

    // 后台任务: bridge_read -> ws_write (raw bytes newline-delimited -> WebSocket text frames)
    tokio::task::spawn_local(async move {
        use futures::SinkExt;
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(bridge_read);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end().to_string();
                    if ws_write
                        .send(tungstenite::Message::Text(trimmed.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    Ok((agent_read.compat(), agent_write.compat_write()))
}

// === 公开 API ===

impl AcpSessionHandle {
    /// 是否有待处理的权限请求
    pub fn has_pending_permission(&self) -> bool {
        self.pending_permission.lock().unwrap().is_some()
    }

    /// 当前 live pending permission 的 id（来自 ACP tool_call_id）。
    /// reconcile 用它把 history unresolved 的那条与 live tx 精确匹配。
    pub fn pending_permission_id(&self) -> Option<String> {
        self.pending_permission
            .lock()
            .unwrap()
            .as_ref()
            .map(|(id, _)| id.clone())
    }

    /// Derive the current chat-grained node status from in-memory handle
    /// state. Mirrors the status string used on the wire by `RadioEvent::ChatStatus`
    /// and what `GET /graph` computes per node — keep in sync with both.
    pub fn derive_node_status(&self) -> &'static str {
        if self.has_pending_permission() {
            "permission_required"
        } else if self.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
            "busy"
        } else {
            "idle"
        }
    }

    /// 响应待处理的权限请求
    ///
    /// 顺序：先通知 agent（主效果），再落盘（记账）。即使 agent 侧 rx 已被
    /// drop（future 被取消）导致 tx.send 失败，用户的选择已经发生过，
    /// 仍然要记录到 history，保证切回来时前端能正确 resolve 对应 dialog。
    pub fn respond_permission(&self, option_id: String) -> bool {
        let Some((id, tx)) = self.pending_permission.lock().unwrap().take() else {
            return false;
        };
        let _ = tx.send(option_id.clone());
        self.emit(AcpUpdate::PermissionResponse { id, option_id });
        // Permission gone — announce the post-take status so graph nodes can
        // leave the orange "permission_required" state immediately.
        if let Some(ref chat_id) = self.chat_id {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::ChatStatus {
                project_id: self.project_key.clone(),
                task_id: self.task_id.clone(),
                chat_id: chat_id.clone(),
                status: self.derive_node_status().to_string(),
            });
        }
        true
    }

    /// 发送更新并记录到 history buffer（带磁盘持久化）
    pub fn emit(&self, update: AcpUpdate) {
        // load_session 期间抑制大部分 emit；保留 available_commands 以恢复 slash commands
        if self
            .suppress_emit
            .load(std::sync::atomic::Ordering::Relaxed)
            && !matches!(update, AcpUpdate::AvailableCommands { .. })
        {
            return;
        }

        if let Some(ref chat_id) = self.chat_id {
            match &update {
                AcpUpdate::SessionReady {
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
                    ..
                } => {
                    let existing = read_session_metadata(&self.project_key, &self.task_id, chat_id);
                    write_session_metadata(
                        &self.project_key,
                        &self.task_id,
                        chat_id,
                        &SessionMetadata {
                            pid: std::process::id(),
                            agent_name: agent_name.clone(),
                            agent_version: agent_version.clone(),
                            available_modes: available_modes.clone(),
                            current_mode_id: current_mode_id.clone(),
                            available_models: available_models.clone(),
                            current_model_id: current_model_id.clone(),
                            available_thought_levels: available_thought_levels.clone(),
                            current_thought_level_id: current_thought_level_id.clone(),
                            thought_level_config_id: thought_level_config_id.clone(),
                            prompt_capabilities: prompt_capabilities.clone(),
                            available_commands: existing
                                .map(|meta| meta.available_commands)
                                .unwrap_or_default(),
                        },
                    );
                }
                AcpUpdate::ThoughtLevelsUpdate {
                    available,
                    current,
                    config_id,
                } => {
                    if let Some(mut meta) =
                        read_session_metadata(&self.project_key, &self.task_id, chat_id)
                    {
                        meta.available_thought_levels = available.clone();
                        meta.current_thought_level_id = current.clone();
                        meta.thought_level_config_id = config_id.clone();
                        write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                    }
                }
                AcpUpdate::AvailableCommands { commands } => {
                    let mut meta = read_session_metadata(&self.project_key, &self.task_id, chat_id)
                        .unwrap_or_else(|| SessionMetadata {
                            pid: std::process::id(),
                            agent_name: String::new(),
                            agent_version: String::new(),
                            available_modes: Vec::new(),
                            current_mode_id: None,
                            available_models: Vec::new(),
                            current_model_id: None,
                            available_thought_levels: Vec::new(),
                            current_thought_level_id: None,
                            thought_level_config_id: None,
                            prompt_capabilities: PromptCapabilitiesData::default(),
                            available_commands: Vec::new(),
                        });
                    meta.available_commands = commands.clone();
                    write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                }
                _ => {}
            }
        }

        // 实时 append 到磁盘
        if crate::storage::chat_history::should_persist(&update) {
            if let Some(ref chat_id) = self.chat_id {
                crate::storage::chat_history::append_event(
                    &self.project_key,
                    &self.task_id,
                    chat_id,
                    &update,
                );
            }
        }

        // 跟踪 busy 状态，并通知 Radio 客户端
        if let AcpUpdate::Busy { value } = &update {
            self.is_busy
                .store(*value, std::sync::atomic::Ordering::Relaxed);
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::TaskBusy {
                project_id: self.project_key.clone(),
                task_id: self.task_id.clone(),
                busy: *value,
            });
        }

        // Chat-grained status push for the agent graph view. Anchored at the
        // central emit() point so every transition that flows through
        // AcpUpdate gets surfaced exactly once. Permission set is covered by
        // the PermissionRequest variant; permission take is broadcast from
        // respond_permission() because that path never emits an AcpUpdate
        // that would land here for that purpose.
        if let Some(ref chat_id) = self.chat_id {
            let next_status: Option<&'static str> = match &update {
                AcpUpdate::SessionReady { .. } => Some(self.derive_node_status()),
                AcpUpdate::Busy { value: true } => Some("busy"),
                AcpUpdate::Busy { value: false } => Some(self.derive_node_status()),
                AcpUpdate::PermissionRequest { .. } => Some("permission_required"),
                AcpUpdate::SessionEnded => Some("disconnected"),
                _ => None,
            };
            if let Some(status) = next_status {
                use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
                broadcast_radio_event(RadioEvent::ChatStatus {
                    project_id: self.project_key.clone(),
                    task_id: self.task_id.clone(),
                    chat_id: chat_id.clone(),
                    status: status.to_string(),
                });
            }
        }

        // Turn 结束时 compact 磁盘历史
        let should_compact = matches!(&update, AcpUpdate::Complete { .. });

        // broadcast
        let _ = self.update_tx.send(update);

        if should_compact {
            if let Some(ref chat_id) = self.chat_id {
                crate::storage::chat_history::compact_history(
                    &self.project_key,
                    &self.task_id,
                    chat_id,
                );
            }
        }
    }

    /// 获取磁盘持久化所需信息
    pub fn persist_info(&self) -> (String, String, Option<String>) {
        (
            self.project_key.clone(),
            self.task_id.clone(),
            self.chat_id.clone(),
        )
    }

    /// 发送用户提示
    pub async fn send_prompt(
        &self,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
    ) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Prompt {
                text,
                attachments,
                sender,
                terminal,
            })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 切换 Mode
    pub async fn set_mode(&self, mode_id: String) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::SetMode { mode_id })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 切换 Model
    pub async fn set_model(&self, model_id: String) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::SetModel { model_id })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 切换 thought-level / reasoning-effort(0.11 通用 SessionConfigOption)
    pub async fn set_thought_level(
        &self,
        config_id: String,
        value_id: String,
    ) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::SetThoughtLevel {
                config_id,
                value_id,
            })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 取消当前处理
    pub async fn cancel(&self) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Cancel)
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 终止会话
    pub async fn kill(&self) -> crate::error::Result<()> {
        let _ = self.cmd_tx.send(AcpCommand::Kill).await;
        Ok(())
    }

    /// 订阅更新流
    pub fn subscribe(&self) -> broadcast::Receiver<AcpUpdate> {
        self.update_tx.subscribe()
    }

    // ─── Pending queue management ────────────────────────────────────────

    /// 添加消息到待执行队列，返回更新后的队列
    pub fn queue_message(&self, msg: QueuedMessage) -> Vec<QueuedMessage> {
        let mut q = self.pending_queue.lock().unwrap();
        q.push(msg);
        q.clone()
    }

    /// 删除队列中指定位置的消息，返回更新后的队列
    pub fn dequeue_message(&self, index: usize) -> Vec<QueuedMessage> {
        let mut q = self.pending_queue.lock().unwrap();
        if index < q.len() {
            q.remove(index);
        }
        q.clone()
    }

    /// 编辑队列中指定位置的消息文本，返回更新后的队列
    pub fn update_queued_message(&self, index: usize, text: String) -> Vec<QueuedMessage> {
        let mut q = self.pending_queue.lock().unwrap();
        if index < q.len() {
            q[index].text = text;
        }
        q.clone()
    }

    /// 清空待执行队列，返回空队列
    pub fn clear_queue(&self) -> Vec<QueuedMessage> {
        let mut q = self.pending_queue.lock().unwrap();
        q.clear();
        q.clone()
    }

    /// 获取当前队列内容
    pub fn get_queue(&self) -> Vec<QueuedMessage> {
        self.pending_queue.lock().unwrap().clone()
    }

    /// 从队列头部取出一条消息（内部使用，auto-send）
    fn pop_queue_front(&self) -> Option<QueuedMessage> {
        let mut q = self.pending_queue.lock().unwrap();
        if q.is_empty() {
            None
        } else {
            Some(q.remove(0))
        }
    }

    /// 非阻塞发送 prompt 命令（队列 auto-send 使用）
    fn try_enqueue_prompt(
        &self,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
    ) -> bool {
        self.cmd_tx
            .try_send(AcpCommand::Prompt {
                text,
                attachments,
                sender,
                terminal: false,
            })
            .is_ok()
    }

    /// 暂停队列 auto-send（用户正在编辑队列消息）
    pub fn pause_queue(&self) {
        self.queue_paused
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// 恢复队列 auto-send，如果队列非空则立即尝试发送第一条
    pub fn resume_queue(&self) {
        self.queue_paused
            .store(false, std::sync::atomic::Ordering::Relaxed);
        // 尝试发送队列中的第一条消息（如果 agent 空闲会被处理）
        if let Some(next_msg) = self.pop_queue_front() {
            self.emit(AcpUpdate::QueueUpdate {
                messages: self.get_queue(),
            });
            self.try_enqueue_prompt(next_msg.text, next_msg.attachments, next_msg.sender);
        }
    }

    /// 用户直接执行终端命令（Shell 模式，不经过 AI agent）
    pub fn execute_terminal(self: &Arc<Self>, command: String) {
        // 先终止已有的终端命令（如果有）
        self.kill_terminal();
        // 记录到 history
        self.emit(AcpUpdate::TerminalExecute {
            command: command.clone(),
        });

        let handle = self.clone();
        let cwd = self.working_dir.clone();
        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);
        *self.terminal_kill_tx.lock().unwrap() = Some(kill_tx);

        tokio::spawn(async move {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
            let mut cmd = tokio::process::Command::new(&shell);
            cmd.arg("-l").arg("-i").arg("-c").arg(&command);
            cmd.current_dir(&cwd)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    handle.emit(AcpUpdate::TerminalChunk {
                        output: format!("Failed to execute: {}\n", e),
                    });
                    handle.emit(AcpUpdate::TerminalComplete { exit_code: Some(1) });
                    *handle.terminal_kill_tx.lock().unwrap() = None;
                    return;
                }
            };

            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let mut stdout_buf = [0u8; 4096];
            let mut stderr_buf = [0u8; 4096];
            let mut stdout_done = false;
            let mut stderr_done = false;

            loop {
                tokio::select! {
                    result = stdout.read(&mut stdout_buf), if !stdout_done => {
                        match result {
                            Ok(0) | Err(_) => stdout_done = true,
                            Ok(n) => {
                                let text = String::from_utf8_lossy(&stdout_buf[..n]).to_string();
                                handle.emit(AcpUpdate::TerminalChunk { output: text });
                            }
                        }
                    }
                    result = stderr.read(&mut stderr_buf), if !stderr_done => {
                        match result {
                            Ok(0) | Err(_) => stderr_done = true,
                            Ok(n) => {
                                let text = String::from_utf8_lossy(&stderr_buf[..n]).to_string();
                                handle.emit(AcpUpdate::TerminalChunk { output: text });
                            }
                        }
                    }
                    _ = kill_rx.recv() => {
                        let _ = child.start_kill();
                        // Don't break — keep reading until EOF so we don't
                        // truncate output already queued in the pipe.
                    }
                }
                if stdout_done && stderr_done {
                    break;
                }
            }

            let exit_code = child.wait().await.ok().and_then(|s| s.code());
            *handle.terminal_kill_tx.lock().unwrap() = None;
            handle.emit(AcpUpdate::TerminalComplete { exit_code });
        });
    }

    /// 终止用户终端命令
    pub fn kill_terminal(&self) {
        if let Some(tx) = self.terminal_kill_tx.lock().unwrap().take() {
            let _ = tx.try_send(());
        }
    }
}

/// 获取已存在的 ACP 会话句柄（不启动新会话）
pub fn get_session_handle(key: &str) -> Option<Arc<AcpSessionHandle>> {
    ACP_SESSIONS
        .read()
        .ok()
        .and_then(|sessions| sessions.get(key).cloned())
}

/// 检查 ACP 会话是否存在
pub fn session_exists(key: &str) -> bool {
    ACP_SESSIONS
        .read()
        .map(|sessions| sessions.contains_key(key))
        .unwrap_or(false)
}

/// Test helper: build an `AcpSessionHandle` wired to a minimal in-process mock
/// cmd loop so agent_graph integration tests can exercise the real
/// `send_prompt` / `queue_message` paths without spawning an ACP subprocess.
///
/// The mock loop drains `cmd_rx` and:
/// - On `AcpCommand::Prompt`: emits `AcpUpdate::UserMessage` (matching the real
///   cmd loop at `run_acp_session`'s top-level `Prompt` arm) followed by
///   `AcpUpdate::Busy { value: false }`. **Does not** drive any ACP wire.
/// - On `AcpCommand::Kill`: exits the loop.
/// - All other commands are silently dropped.
///
/// Registers the handle in `ACP_SESSIONS` under `key` so
/// `get_session_handle(key)` works during the test. The handle is unregistered
/// when the test drops the returned guard.
#[cfg(test)]
pub fn new_handle_for_test(
    key: &str,
    project_key: &str,
    task_id: &str,
    chat_id: &str,
) -> (
    Arc<AcpSessionHandle>,
    broadcast::Receiver<AcpUpdate>,
    TestSessionGuard,
) {
    let (update_tx, update_rx) = broadcast::channel::<AcpUpdate>(256);
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<AcpCommand>(32);

    let handle = Arc::new(AcpSessionHandle {
        key: key.to_string(),
        update_tx: update_tx.clone(),
        cmd_tx,
        agent_info: std::sync::RwLock::new(Some((
            "session-test".into(),
            "claude".into(),
            "test".into(),
        ))),
        pending_permission: Mutex::new(None),
        permission_lock: tokio::sync::Mutex::new(()),
        project_key: project_key.to_string(),
        task_id: task_id.to_string(),
        chat_id: Some(chat_id.to_string()),
        suppress_emit: std::sync::atomic::AtomicBool::new(false),
        pending_queue: Mutex::new(Vec::new()),
        queue_paused: std::sync::atomic::AtomicBool::new(false),
        current_mode_id: Mutex::new(None),
        working_dir: "/tmp".to_string(),
        terminal_kill_tx: Mutex::new(None),
        is_busy: std::sync::atomic::AtomicBool::new(false),
        last_assistant_text: Mutex::new(String::new()),
    });

    if let Ok(mut sessions) = ACP_SESSIONS.write() {
        sessions.insert(key.to_string(), handle.clone());
    }

    let handle_for_loop = handle.clone();
    tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                AcpCommand::Prompt {
                    text,
                    attachments,
                    sender,
                    terminal,
                } => {
                    handle_for_loop.emit(AcpUpdate::UserMessage {
                        text,
                        attachments,
                        sender,
                        terminal,
                    });
                    handle_for_loop.emit(AcpUpdate::Busy { value: false });
                }
                AcpCommand::Kill => break,
                _ => {}
            }
        }
    });

    let guard = TestSessionGuard {
        key: key.to_string(),
    };
    (handle, update_rx, guard)
}

/// RAII guard that unregisters a test session handle on drop.
#[cfg(test)]
pub struct TestSessionGuard {
    key: String,
}

#[cfg(test)]
impl Drop for TestSessionGuard {
    fn drop(&mut self) {
        if let Ok(mut sessions) = ACP_SESSIONS.write() {
            sessions.remove(&self.key);
        }
    }
}

/// 终止 ACP 会话
pub fn kill_session(key: &str) -> crate::error::Result<()> {
    let handle = {
        ACP_SESSIONS
            .read()
            .map_err(|e| crate::error::GroveError::Session(e.to_string()))?
            .get(key)
            .cloned()
    };
    if let Some(h) = handle {
        let _ = h.cmd_tx.try_send(AcpCommand::Kill);
    }
    Ok(())
}

// ============================================================================
// Unix Socket 跨进程 Session 共享
// ============================================================================

/// 获取 chat 目录路径
fn chat_dir(project_key: &str, task_id: &str, chat_id: &str) -> PathBuf {
    crate::storage::grove_dir()
        .join("projects")
        .join(project_key)
        .join("tasks")
        .join(task_id)
        .join("chats")
        .join(chat_id)
}

/// 获取 Unix socket 路径
///
/// macOS `sun_path` 限制 104 字节，chat 目录路径可能含中文任务名（UTF-8 长），
/// 因此 socket 放在 `/tmp/grove-acp/` 下，用短 hash 命名。
pub fn sock_path(project_key: &str, task_id: &str, chat_id: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    project_key.hash(&mut hasher);
    task_id.hash(&mut hasher);
    chat_id.hash(&mut hasher);
    let hash = hasher.finish();
    // e.g. /tmp/grove-acp/a1b2c3d4e5f6.sock  (~40 bytes, well under 104)
    PathBuf::from(format!("/tmp/grove-acp/{:016x}.sock", hash))
}

/// 获取 session.json 路径
pub fn session_json_path(project_key: &str, task_id: &str, chat_id: &str) -> PathBuf {
    chat_dir(project_key, task_id, chat_id).join("session.json")
}

/// 从磁盘读取 session 元数据
pub fn read_session_metadata(
    project_key: &str,
    task_id: &str,
    chat_id: &str,
) -> Option<SessionMetadata> {
    let path = session_json_path(project_key, task_id, chat_id);
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

/// 原子写 session.json（先写 tmp 再 rename）
fn write_session_metadata(project_key: &str, task_id: &str, chat_id: &str, meta: &SessionMetadata) {
    let path = session_json_path(project_key, task_id, chat_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(data) = serde_json::to_string_pretty(meta) {
        if std::fs::write(&tmp, data).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// 清理 socket 和 session.json 文件
fn cleanup_socket_files(project_key: &str, task_id: &str, chat_id: &str) {
    let _ = std::fs::remove_file(sock_path(project_key, task_id, chat_id));
    let _ = std::fs::remove_file(session_json_path(project_key, task_id, chat_id));
}

/// Socket listener：接受连接，分发命令到 session handle（Unix only）
#[cfg(unix)]
async fn run_socket_listener(path: PathBuf, handle: Arc<AcpSessionHandle>) {
    // 清理可能残留的旧 sock 文件
    let _ = std::fs::remove_file(&path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[ACP] Failed to bind socket {}: {}", path.display(), e);
            return;
        }
    };

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let handle = handle.clone();
                tokio::task::spawn_local(async move {
                    if let Err(e) = handle_socket_connection(stream, &handle).await {
                        // BrokenPipe = client disconnected early, benign
                        if e.kind() != std::io::ErrorKind::BrokenPipe {
                            eprintln!("[ACP] Socket connection error: {}", e);
                        }
                    }
                });
            }
            Err(e) => {
                // Listener closed
                eprintln!("[ACP] Socket accept error: {}", e);
                break;
            }
        }
    }

    // 退出时清理 sock 文件
    let _ = std::fs::remove_file(&path);
}

/// 处理单个 socket 连接：读一行命令，执行，写一行响应（Unix only）
#[cfg(unix)]
async fn handle_socket_connection(
    stream: tokio::net::UnixStream,
    handle: &AcpSessionHandle,
) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt};

    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = tokio::io::BufReader::new(reader);
    let mut line = String::new();
    let n = buf_reader.read_line(&mut line).await?;

    // 0 字节 = 探测连接（discover_session 存活检测），直接关闭
    if n == 0 || line.trim().is_empty() {
        return Ok(());
    }

    let response = match serde_json::from_str::<SocketCommand>(line.trim()) {
        Ok(cmd) => dispatch_socket_command(handle, cmd).await,
        Err(e) => SocketResponse::Error {
            message: format!("Invalid command: {}", e),
        },
    };

    let resp_json = serde_json::to_string(&response)
        .unwrap_or_else(|_| r#"{"type":"error","message":"serialize error"}"#.to_string());
    writer.write_all(resp_json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.shutdown().await?;

    Ok(())
}

/// 将 SocketCommand 分发到 session handle 的对应方法
async fn dispatch_socket_command(handle: &AcpSessionHandle, cmd: SocketCommand) -> SocketResponse {
    match cmd {
        SocketCommand::Prompt {
            text,
            attachments,
            sender,
        } => match handle.send_prompt(text, attachments, sender, false).await {
            Ok(()) => SocketResponse::Ok,
            Err(e) => SocketResponse::Error {
                message: e.to_string(),
            },
        },
        SocketCommand::Cancel => match handle.cancel().await {
            Ok(()) => SocketResponse::Ok,
            Err(e) => SocketResponse::Error {
                message: e.to_string(),
            },
        },
        SocketCommand::SetMode { mode_id } => match handle.set_mode(mode_id).await {
            Ok(()) => SocketResponse::Ok,
            Err(e) => SocketResponse::Error {
                message: e.to_string(),
            },
        },
        SocketCommand::SetModel { model_id } => match handle.set_model(model_id).await {
            Ok(()) => SocketResponse::Ok,
            Err(e) => SocketResponse::Error {
                message: e.to_string(),
            },
        },
        SocketCommand::SetThoughtLevel {
            config_id,
            value_id,
        } => match handle.set_thought_level(config_id, value_id).await {
            Ok(()) => SocketResponse::Ok,
            Err(e) => SocketResponse::Error {
                message: e.to_string(),
            },
        },
        SocketCommand::RespondPermission { option_id } => {
            if handle.respond_permission(option_id) {
                SocketResponse::Ok
            } else {
                SocketResponse::Error {
                    message: "No pending permission request".to_string(),
                }
            }
        }
        SocketCommand::Kill => match handle.kill().await {
            Ok(()) => SocketResponse::Ok,
            Err(e) => SocketResponse::Error {
                message: e.to_string(),
            },
        },
    }
}

/// 发现 session：3 步算法
///
/// 1. 查 ACP_SESSIONS（进程内 HashMap）→ Local
/// 2. 查 acp.sock → connect() 成功 → Remote；失败 → stale，删 sock
/// 3. 都没有 → None（调用方可启动新 session）
pub fn discover_session(
    project_key: &str,
    task_id: &str,
    chat_id: &str,
    session_key: &str,
) -> Option<SessionAccess> {
    // Step 1: 进程内 HashMap
    if let Some(handle) = get_session_handle(session_key) {
        return Some(SessionAccess::Local(handle));
    }

    // Step 2: 检查 sock 文件（Unix only）
    #[cfg(unix)]
    {
        let sp = sock_path(project_key, task_id, chat_id);
        if sp.exists() {
            // 尝试同步 connect 探测 socket 是否存活
            match std::os::unix::net::UnixStream::connect(&sp) {
                Ok(_conn) => {
                    // Socket 存活，另一个进程持有
                    drop(_conn);
                    return Some(SessionAccess::Remote {
                        sock_path: sp,
                        chat_dir: chat_dir(project_key, task_id, chat_id),
                        project_key: project_key.to_string(),
                        task_id: task_id.to_string(),
                        chat_id: chat_id.to_string(),
                    });
                }
                Err(_) => {
                    // Stale socket，清理
                    let _ = std::fs::remove_file(&sp);
                    let _ = std::fs::remove_file(session_json_path(project_key, task_id, chat_id));
                }
            }
        }
    }

    // Step 3: 没找到
    None
}

/// 通过 Unix socket 发送命令到远程 session owner
pub async fn send_socket_command(
    sock: &std::path::Path,
    cmd: &SocketCommand,
) -> crate::error::Result<SocketResponse> {
    #[cfg(unix)]
    {
        use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt};

        let stream = tokio::net::UnixStream::connect(sock).await.map_err(|e| {
            crate::error::GroveError::Session(format!("Socket connect failed: {}", e))
        })?;

        let (reader, mut writer) = stream.into_split();

        let cmd_json = serde_json::to_string(cmd).map_err(|e| {
            crate::error::GroveError::Session(format!("Failed to serialize command: {}", e))
        })?;

        writer.write_all(cmd_json.as_bytes()).await.map_err(|e| {
            crate::error::GroveError::Session(format!("Socket write failed: {}", e))
        })?;
        writer.write_all(b"\n").await.map_err(|e| {
            crate::error::GroveError::Session(format!("Socket write failed: {}", e))
        })?;
        writer.shutdown().await.map_err(|e| {
            crate::error::GroveError::Session(format!("Socket shutdown failed: {}", e))
        })?;

        let mut buf_reader = tokio::io::BufReader::new(reader);
        let mut resp_line = String::new();
        buf_reader
            .read_line(&mut resp_line)
            .await
            .map_err(|e| crate::error::GroveError::Session(format!("Socket read failed: {}", e)))?;

        serde_json::from_str(resp_line.trim()).map_err(|e| {
            crate::error::GroveError::Session(format!("Invalid socket response: {}", e))
        })
    }

    #[cfg(not(unix))]
    {
        let _ = (sock, cmd);
        Err(crate::error::GroveError::Session(
            "Cross-process ACP sessions are not supported on Windows".to_string(),
        ))
    }
}

/// 解析后的 Agent 信息
pub struct ResolvedAgent {
    pub agent_type: String,
    /// Agent logical name (e.g. "claude", "codex") — used for adapter routing.
    pub agent_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub auth_header: Option<String>,
}

/// Check if a command exists in PATH (cross-platform).
fn command_exists(cmd: &str) -> bool {
    crate::check::command_exists(cmd)
}

/// 解析 agent 名称到完整 agent 信息（支持 built-in + custom）
pub fn resolve_agent(agent_name: &str) -> Option<ResolvedAgent> {
    // 1. Built-in agents
    match agent_name.to_lowercase().as_str() {
        "claude" => {
            let (command, args): (&str, Vec<String>) = if command_exists("claude-agent-acp") {
                ("claude-agent-acp", vec![])
            } else if command_exists("claude-code-acp") {
                ("claude-code-acp", vec![])
            } else if command_exists("npx") {
                (
                    "npx",
                    vec!["-y".into(), "@agentclientprotocol/claude-agent-acp".into()],
                )
            } else {
                return None;
            };
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "claude".into(),
                command: command.into(),
                args,
                url: None,
                auth_header: None,
            });
        }
        "traecli" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "traecli".into(),
                command: "traecli".into(),
                args: vec!["acp".into(), "serve".into()],
                url: None,
                auth_header: None,
            });
        }
        "codex" => {
            let (command, args): (&str, Vec<String>) = if command_exists("codex-acp") {
                ("codex-acp", vec![])
            } else if command_exists("npx") {
                ("npx", vec!["-y".into(), "@zed-industries/codex-acp".into()])
            } else {
                return None;
            };
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "codex".into(),
                command: command.into(),
                args,
                url: None,
                auth_header: None,
            });
        }
        "kimi" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "kimi".into(),
                command: "kimi".into(),
                args: vec!["acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "gemini" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "gemini".into(),
                command: "gemini".into(),
                args: vec!["--experimental-acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "qwen" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "qwen".into(),
                command: "qwen".into(),
                args: vec!["--experimental-acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "opencode" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "opencode".into(),
                command: "opencode".into(),
                args: vec!["acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "copilot" | "gh copilot" | "gh-copilot" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "copilot".into(),
                command: "copilot".into(),
                args: vec!["--acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "junie" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "junie".into(),
                command: "junie".into(),
                args: vec!["--acp".into(), "true".into()],
                url: None,
                auth_header: None,
            });
        }
        "cursor" | "cursor-agent" => {
            let command = if command_exists("cursor-agent") {
                "cursor-agent"
            } else if command_exists("agent") {
                "agent"
            } else {
                return None;
            };
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                agent_name: "cursor".into(),
                command: command.into(),
                args: vec!["acp".into()],
                url: None,
                auth_header: None,
            });
        }
        _ => {}
    }
    // 2. Custom agents from config
    let config = crate::storage::config::load_config();
    config
        .acp
        .custom_agents
        .iter()
        .find(|a| a.id == agent_name)
        .map(|a| ResolvedAgent {
            agent_type: a.agent_type.clone(),
            agent_name: a.id.clone(),
            command: a.command.clone().unwrap_or_default(),
            args: a.args.clone(),
            url: a.url.clone(),
            auth_header: a.auth_header.clone(),
        })
}

/// Priority order for auto-selecting a Chat (ACP) agent when the user hasn't
/// chosen one or the chosen one is not installed. Kept in sync with
/// `agentOptions` in `grove-web/src/components/ui/AgentPicker.tsx`.
const ACP_AGENT_PRIORITY: &[&str] = &[
    "claude", "codex", "cursor", "gemini", "copilot", "junie", "kimi", "opencode", "qwen",
    "traecli",
];

/// Priority order for auto-selecting a Terminal agent. Values are the `id`s
/// used by `layout.agent_command`; the paired `&str` is the binary name to
/// probe on PATH.
const TERMINAL_AGENT_PRIORITY: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("codex", "codex"),
    ("cursor", "cursor-agent"),
    ("gemini", "gemini"),
    ("copilot", "copilot"),
    ("junie", "junie"),
    ("kimi", "kimi"),
    ("opencode", "opencode"),
    ("qwen", "qwen"),
    ("traecli", "traecli"),
];

/// Pick the first ACP agent id whose binary is installed on PATH, preferring
/// user-defined custom agents (which we trust to be runnable).
pub fn pick_first_available_acp_agent() -> Option<String> {
    let config = crate::storage::config::load_config();
    if let Some(custom) = config.acp.custom_agents.first() {
        return Some(custom.id.clone());
    }
    for name in ACP_AGENT_PRIORITY {
        if resolve_agent(name).is_some() {
            return Some((*name).to_string());
        }
    }
    None
}

/// Pick the first Terminal agent id whose launcher binary is on PATH.
pub fn pick_first_available_terminal_agent() -> Option<String> {
    for (id, binary) in TERMINAL_AGENT_PRIORITY {
        if command_exists(binary) {
            return Some((*id).to_string());
        }
    }
    None
}

/// Ensure `config.toml` has sensible `acp.agent_command` / `layout.agent_command`
/// values given the currently-installed CLIs. Runs once at server startup so
/// first-run users don't get "claude" as the default when Claude Code isn't
/// installed. Silent no-op if the configured agents are already valid.
pub fn init_agent_defaults() {
    let mut config = crate::storage::config::load_config();
    let mut changed = false;

    let acp_valid = match &config.acp.agent_command {
        Some(name) if !name.is_empty() => {
            resolve_agent(name).is_some() || config.acp.custom_agents.iter().any(|a| &a.id == name)
        }
        _ => false,
    };
    if !acp_valid {
        if let Some(picked) = pick_first_available_acp_agent() {
            config.acp.agent_command = Some(picked);
            changed = true;
        }
    }

    let terminal_valid = match &config.layout.agent_command {
        Some(name) if !name.is_empty() => TERMINAL_AGENT_PRIORITY
            .iter()
            .find(|(id, _)| id == name)
            .map(|(_, binary)| command_exists(binary))
            .unwrap_or(true),
        _ => false,
    };
    if !terminal_valid {
        if let Some(picked) = pick_first_available_terminal_agent() {
            config.layout.agent_command = Some(picked);
            changed = true;
        }
    }

    if changed {
        if let Err(e) = crate::storage::config::save_config(&config) {
            eprintln!(
                "[warning] Failed to persist auto-selected agent defaults: {}",
                e
            );
        }
    }
}

/// 发送 ACP 事件通知（根据 hooks 配置决定是否播放声音、发送横幅）
fn notify_acp_event(
    project_key: &str,
    task_id: &str,
    title_suffix: &str,
    message: &str,
    default_sound: &str,
) {
    use crate::hooks::{self, NotificationLevel};
    use crate::storage::{config, tasks as task_storage};

    let cfg = config::load_config().hooks;
    if !cfg.enabled {
        return;
    }

    let sound = if cfg.sound_enabled {
        Some(if cfg.sound.is_empty() {
            default_sound
        } else {
            &cfg.sound
        })
    } else {
        None
    };

    if let Some(s) = sound {
        hooks::play_sound(s);
    }

    if cfg.banner {
        let project_name = crate::storage::workspace::load_project_by_hash(project_key)
            .ok()
            .flatten()
            .map(|p| p.name)
            .unwrap_or_else(|| "Grove".to_string());
        let task_name = task_storage::get_task(project_key, task_id)
            .ok()
            .flatten()
            .map(|t| t.name)
            .unwrap_or_else(|| task_id.to_string());

        let title = format!("{} - {}", project_name, title_suffix);
        let banner_msg = format!("{} — {}", task_name, message);
        hooks::send_banner(&title, &banner_msg);
    }

    let level = if title_suffix.contains("Permission") {
        NotificationLevel::Warn
    } else {
        NotificationLevel::Notice
    };
    hooks::update_hook(project_key, task_id, level, Some(message.to_string()));
}

/// Truncate a string to at most `max_chars` Unicode characters, appending "…" if truncated.
/// Collapses newlines to spaces for single-line display.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    let collapsed: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let trimmed = collapsed.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(max_chars).collect();
        format!("{}…", truncated.trim_end())
    }
}

/// Build log file path for agent stderr:
/// `~/.grove/projects/{project}/tasks/{task_id}/chats/{chat_id}/agent.log`
/// Falls back to `~/.grove/projects/{project}/tasks/{task_id}/agent.log` if no chat_id.
fn agent_log_path(project: &str, task_id: &str, chat_id: Option<&str>) -> PathBuf {
    let base = crate::storage::grove_dir()
        .join("projects")
        .join(project)
        .join("tasks")
        .join(task_id);
    match chat_id {
        Some(cid) => base.join("chats").join(cid).join("agent.log"),
        None => base.join("agent.log"),
    }
}

/// Drain agent stderr line-by-line into a log file (append mode).
async fn drain_stderr_to_file(stderr: tokio::process::ChildStderr, path: PathBuf) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(_) => return, // silently give up if we can't open
    };
    let mut writer = std::io::BufWriter::new(file);
    let mut reader = tokio::io::BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                use std::io::Write;
                let _ = writer.write_all(line.as_bytes());
                let _ = writer.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_command_serde_roundtrip() {
        let commands = vec![
            SocketCommand::Prompt {
                text: "hello".into(),
                attachments: vec![],
                sender: None,
            },
            SocketCommand::Cancel,
            SocketCommand::SetMode {
                mode_id: "plan".into(),
            },
            SocketCommand::SetModel {
                model_id: "opus".into(),
            },
            SocketCommand::RespondPermission {
                option_id: "allow_once".into(),
            },
            SocketCommand::Kill,
        ];

        for cmd in &commands {
            let json = serde_json::to_string(cmd).expect("serialize");
            let parsed: SocketCommand = serde_json::from_str(&json).expect("deserialize");
            let json2 = serde_json::to_string(&parsed).expect("re-serialize");
            assert_eq!(json, json2);
        }
    }

    #[test]
    fn socket_command_tagged_format() {
        let cmd = SocketCommand::Prompt {
            text: "do it".into(),
            attachments: vec![],
            sender: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains(r#""action":"prompt""#));

        let cmd = SocketCommand::Cancel;
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains(r#""action":"cancel""#));
    }

    #[test]
    fn socket_response_serde_roundtrip() {
        let ok = SocketResponse::Ok;
        let json = serde_json::to_string(&ok).unwrap();
        assert!(json.contains(r#""type":"ok""#));
        let parsed: SocketResponse = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, SocketResponse::Ok));

        let err = SocketResponse::Error {
            message: "bad thing".into(),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""type":"error""#));
        let parsed: SocketResponse = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, SocketResponse::Error { .. }));
    }

    #[test]
    fn session_metadata_serde_roundtrip() {
        let meta = SessionMetadata {
            pid: 12345,
            agent_name: "claude".into(),
            agent_version: "1.0.0".into(),
            available_modes: vec![
                ("code".into(), "Code".into()),
                ("plan".into(), "Plan".into()),
            ],
            current_mode_id: Some("code".into()),
            available_models: vec![("opus".into(), "Opus".into())],
            current_model_id: Some("opus".into()),
            available_thought_levels: vec![],
            current_thought_level_id: None,
            thought_level_config_id: None,
            prompt_capabilities: PromptCapabilitiesData::default(),
            available_commands: vec![],
        };

        let json = serde_json::to_string_pretty(&meta).expect("serialize");
        let parsed: SessionMetadata = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.pid, 12345);
        assert_eq!(parsed.agent_name, "claude");
        assert_eq!(parsed.available_modes.len(), 2);
    }

    #[test]
    fn discover_session_returns_none_when_no_session() {
        // Using bogus keys that won't match anything
        let result = discover_session(
            "nonexistent_project",
            "nonexistent_task",
            "nonexistent_chat",
            "nonexistent:key",
        );
        assert!(result.is_none());
    }
}
