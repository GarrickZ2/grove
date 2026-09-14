//! ACP (Agent Client Protocol) 核心模块
//!
//! 管理 ACP agent 子进程的生命周期和 JSON-RPC 通信。
//! Grove 作为 ACP Client，启动 agent 子进程并通过 stdio 交互。

#![allow(dead_code)] // Public API — used by CLI now, Web frontend later

pub mod adapter;

// SDK 2.0 versions protocol schemas explicitly. Grove currently negotiates ACP v1,
// so keep its schema and runtime types behind one local namespace.
#[allow(clippy::module_inception)]
mod acp {
    pub use agent_client_protocol::schema::v1::*;
    pub use agent_client_protocol::schema::ProtocolVersion;
    pub use agent_client_protocol::{
        Agent, ByteStreams, Client, ConnectionTo, Error, RequestCancellation, Result,
    };
}
use chrono::{DateTime, Utc};
use std::collections::{BTreeMap, HashMap};
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

/// Plugin launch validation runs for every ACP session. Remember diagnostics
/// already shown during this Grove process so one broken plugin does not flood
/// stderr as chats connect and reconnect.
static REPORTED_PLUGIN_MCP_ISSUES: once_cell::sync::Lazy<Mutex<std::collections::HashSet<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

fn report_plugin_mcp_issue_once(key: String, message: impl FnOnce() -> String) {
    let should_report = REPORTED_PLUGIN_MCP_ISSUES
        .lock()
        .map(|mut reported| reported.insert(key))
        .unwrap_or(true);
    if should_report {
        eprintln!("{}", message());
    }
}

const SHORT_MEMORY_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Clone)]
struct ShortToolWatch {
    title: String,
    started_at: std::time::Instant,
    deadline: std::time::Instant,
}

fn is_short_memory_tool(title: &str) -> bool {
    let normalized = title.to_ascii_lowercase();
    normalized.contains("grove_agent") && normalized.contains("memory_")
}

static ACP_SESSIONS: once_cell::sync::Lazy<RwLock<HashMap<String, Arc<AcpSessionHandle>>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(HashMap::new()));

/// ACP 会话句柄 — 外部持有，用于查询状态和发送操作
pub struct AcpSessionHandle {
    pub key: String,
    pub update_tx: broadcast::Sender<AcpUpdate>,
    cmd_tx: mpsc::Sender<AcpCommand>,
    /// Out-of-band shutdown signal for the whole ACP transport/process.
    ///
    /// This must not share the command queue: the command loop can be blocked
    /// awaiting an Agent RPC (notably `session/delete`), in which case a queued
    /// `Kill` cannot be observed until that RPC has already completed.
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    /// Agent info stored after initialization: (session_id, name, version)
    pub agent_info: std::sync::RwLock<Option<(String, String, String)>>,
    /// 待处理的权限请求响应 channel + 它的 id（来源是 ACP tool_call.id）。
    /// id 用来在 reconcile 时把这条 live pending 与 history 中的 PermissionRequest
    /// 精确匹配 —— 同 id 的留给前端响应，其它 unresolved 落 Cancelled。
    pending_permission: Mutex<Option<(String, tokio::sync::oneshot::Sender<String>)>>,
    /// 序列化权限请求：同一时刻只能有一个 permission 等待用户响应
    permission_lock: tokio::sync::Mutex<()>,
    /// ACP elicitations are presented one at a time. Requests that arrive
    /// concurrently wait on this lock before they are exposed to the UI.
    pending_elicitation: Mutex<Option<PendingElicitation>>,
    elicitation_lock: tokio::sync::Mutex<()>,
    /// URL elicitations remain visible after the user consents to open them,
    /// until the Agent sends `elicitation/complete`.
    active_url_elicitations: Mutex<HashMap<String, ElicitationRequestSnapshot>>,
    /// 项目 key（用于磁盘持久化路径）
    project_key: String,
    /// 任务 ID（用于磁盘持久化路径）
    task_id: String,
    /// Chat ID（磁盘持久化必需）
    chat_id: Option<String>,
    /// Non-Task session artifact directory used by Automation consumers.
    artifact_dir: Option<PathBuf>,
    /// Canonical installed-agent id used to refresh its capability snapshot.
    configured_agent_id: String,
    /// load_session 期间抑制 emit（只恢复 agent 内部状态，不转发回放通知）
    suppress_emit: std::sync::atomic::AtomicBool,
    /// Import 的 session/load 回放需要保留 Agent 发回的用户消息。普通会话
    /// 仍忽略该 echo，避免与 Grove 在 Prompt 时写入的 UserMessage 重复。
    replay_user_messages: std::sync::atomic::AtomicBool,
    /// 待执行消息队列（agent 完成当前任务后自动发送下一条）
    pending_queue: Mutex<Vec<QueuedMessage>>,
    /// 队列暂停标志（用户正在编辑队列消息时暂停 auto-send）
    queue_paused: std::sync::atomic::AtomicBool,
    /// Serializes end-of-turn and edit-resume queue drains. Without this,
    /// both paths can observe an idle session and dequeue separate messages.
    queue_drain_lock: Mutex<()>,
    /// 队列合并发送模式（Separate = 逐条发送；Compact = 合并成一条）
    queue_mode: Mutex<QueueMode>,
    /// 当前 agent mode id（用于 PlanFileUpdate 检测和 QueuedConfig 快照）。
    /// 语义：last "intent" — 即上一次成功通过 SetSessionMode 推给 agent 的值。
    /// **不**保证 agent 真的拿这个 mode 处理了任何 prompt（partial apply 失败的
    /// 路径：mode 成功 → model 失败 → prompt 整条跳过，但 current_mode_id 已更新）。
    /// 用于 (a) 决定下次 prompt 是否需要重发 SetSessionMode（O(1) diff），
    /// (b) 写入 token_usage 等统计的 best-effort 归属。
    current_mode_id: Mutex<Option<String>>,
    /// 当前 agent model id — 同 `current_mode_id` 语义（last intent，不是
    /// last-used-for-prompt）。token_usage 写盘读这个字段做 model 归属。
    current_model_id: Mutex<Option<String>>,
    /// 最近一次 ACP `usage_update` 推送的 context window 快照。同步落盘到
    /// `session.json`,attach 时也通过 status 接口下发,前端据此渲染 context pill。
    /// `None` 表示该 chat 还没收到过 usage_update（pill 隐藏）。
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    /// 当前 thought-level value id（用于 QueuedConfig 快照）
    current_thought_level_id: Mutex<Option<String>>,
    /// Config option id for thought-level（agent 自定义，例如 "effort_level"）。
    /// 前端在下一条 `Prompt.config.thought_level_config_id` 里 echo 回来。
    thought_level_config_id: Mutex<Option<String>>,
    /// Config option id for the ACP model selector.
    model_config_id: Mutex<Option<String>>,
    /// Authoritative ACP v1 `configOptions` snapshot. The Agent replaces this
    /// whole list after `session/set_config_option` and in
    /// `config_option_update`; order and option metadata are significant.
    current_config_options: Mutex<Vec<acp::SessionConfigOption>>,
    uses_config_options: std::sync::atomic::AtomicBool,
    /// Task 工作目录（用于用户直接执行 terminal 命令）
    pub working_dir: String,
    /// 用户终端命令的 kill channel（Shell 模式）
    terminal_kill_tx: Mutex<Option<mpsc::Sender<()>>>,
    /// Agent 是否正在处理（busy=true 从 prompt 开始，到 complete 结束）
    pub is_busy: std::sync::atomic::AtomicBool,
    /// 最近一轮 agent 回复的累积文本（用于 Complete 通知摘要 / 菜单栏 Tray 全文）
    last_assistant_text: Mutex<String>,
    /// Grove-owned correlation for the turn currently executed by this
    /// Session. External consumers receive it only through semantic Radio
    /// events; ACP implementation details remain private.
    active_turn_message_ids: Mutex<Vec<String>>,
    /// Text produced after the most recent tool call in the active turn.
    /// This is the canonical final reply carried by Radio on completion.
    last_turn_reply: Mutex<String>,
    /// 当一段 agent 文本之后出现了 tool_call 时置位（前端 ACP Chat 会据此另起
    /// 一个 assistant 气泡）。下一段 AgentMessageChunk 写入 last_assistant_text
    /// 前补一个段落分隔，使累积文本的分段与聊天气泡边界一致，避免被工具调用
    /// 切开的多段文本粘成一坨。
    pending_text_separator: std::sync::atomic::AtomicBool,
    /// Latest user prompt text for this chat. Set when an `AcpCommand::Prompt`
    /// is dispatched; surfaced on the wire via `RadioEvent::ChatStatus.prompt`
    /// when the chat transitions to `busy` so passive listeners (menubar tray)
    /// can show what the agent is currently working on.
    last_user_prompt: Mutex<Option<String>>,
    /// Latest TodoWrite-style plan progress for this chat: `(completed, total)`.
    /// Updated whenever an `AcpUpdate::PlanUpdate` flows through `emit()`.
    /// Surfaced on `RadioEvent::ChatStatus.todo_completed` / `todo_total` so
    /// the menubar tray can render a real progress bar instead of the
    /// generic pulse strip. None for chats whose agent never emits a plan.
    last_plan: Mutex<Option<(u32, u32)>>,
    /// Latest pending permission request details (description + options),
    /// cached at `PermissionRequest` emit time so a one-shot snapshot
    /// (`GET /api/v1/tray/chats`) can render the request — the `pending_permission`
    /// field only holds `(id, tx)`, not the human-readable payload. Cleared in
    /// `respond_permission`. Only meaningful while `has_pending_permission()`
    /// is true; consumers must gate on that to avoid reading stale data.
    last_permission_info: Mutex<Option<crate::radio::PermissionInfo>>,
    /// Tool calls in the current turn that have not reached a terminal status.
    /// Used to apply ACP's preemptive client-side cancellation semantics.
    active_tool_calls: Mutex<std::collections::HashSet<String>>,
    /// Fast local Project Memory calls should finish in milliseconds. Track a
    /// short deadline separately so a wedged MCP transport cannot hold the
    /// entire Agent turn forever.
    short_tool_watches: Mutex<HashMap<String, ShortToolWatch>>,
    /// True from the moment `session/cancel` is sent until the current prompt
    /// resolves. Permission requests arriving in that window are immediately
    /// answered with the protocol-level `cancelled` outcome.
    cancel_requested: std::sync::atomic::AtomicBool,
    /// agent 在 initialize 响应里声明的登录方法。空 = 未声明 / 不需要。
    /// 收到 `AuthRequired (-32000)` 时,client 用这里的第一个 id 走 `authenticate`。
    pub auth_methods: Mutex<Vec<AuthMethodInfo>>,
    /// agent 是否在 initialize 响应里声明了 `auth.logout` 能力。
    /// 前端据此显示 Logout，后端调用前仍会再次校验。
    pub logout_capable: std::sync::atomic::AtomicBool,
    /// 因 `AuthRequired` 错误暂存待重试的 prompt(text, attachments, sender, terminal)。
    /// authenticate 成功后 outer command loop 会把它再丢回 cmd_tx。
    pending_auth_retry: Mutex<Option<PendingPromptRetry>>,
    /// agent 是否在 initialize 响应里声明了 `session.fork` 能力
    /// (`unstable_session_fork`)。前端据此显示/隐藏 Fork 按钮。
    pub fork_capable: std::sync::atomic::AtomicBool,
    pub import_capable: std::sync::atomic::AtomicBool,
    /// agent 是否声明了 `session.delete` 能力。
    /// 用户明确选择 Agent deletion 时，Grove 先等待 `session/delete`
    /// 成功，再删除本地 Chat。
    pub delete_capable: std::sync::atomic::AtomicBool,
    /// agent 是否在 initialize 响应里声明了 `session.close` 能力。
    /// tear down 一个 session 前若为 true,先发 `session/close` 让 agent
    /// 优雅 cancel + 释放资源,再 SIGKILL 兜底。
    pub close_capable: std::sync::atomic::AtomicBool,
    /// session/new 阶段被 -32000 卡住后,记录当前 banner 状态(methods + agent_name)。
    /// 用途:WS 重连时,如果还没登录成功,跳过假的 SessionReady,改发 AuthRequired
    /// 让前端继续显示 banner;避免"刷新后看起来连上了但消息发不出去"。
    /// 进入 retry 时设置,authenticate 成功 → SessionReady 真正发出后清除。
    pub pending_auth: Mutex<Option<PendingAuthState>>,
    /// Session-scoped instruction update waiting to be merged into the next
    /// real user prompt. Revision prevents a newer update being cleared when
    /// an older prompt completes.
    pending_session_instruction: Mutex<Option<(u64, String, String)>>,
    session_instruction_revision: std::sync::atomic::AtomicU64,
}

/// `pending_auth` 内容:重发 AuthRequired 所需的全部字段
#[derive(Debug, Clone)]
pub struct PendingAuthState {
    pub methods: Vec<AuthMethodInfo>,
    pub agent_name: Option<String>,
}

/// 暂存待重发的 prompt 元组(`AuthRequired` 重试用)。
/// 顺序与 `AcpCommand::Prompt` 字段对齐:text, attachments, sender, terminal, config。
type PendingPromptRetry = (
    Vec<String>,
    String,
    Vec<ContentBlockData>,
    Option<String>,
    bool,
    Option<QueuedConfig>,
);

/// 发送给 ACP 后台任务的命令
enum AcpCommand {
    Prompt {
        /// Grove-owned ids for the accepted inputs represented by this turn.
        /// Usually one id; Compact queue mode preserves every merged input id.
        message_ids: Vec<String>,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        /// Per-prompt config snapshot. The cmd_loop applies this (SetSessionMode /
        /// Model / ThoughtLevel ACP requests) BEFORE sending the prompt itself.
        /// `None` means "use whatever the session currently has".
        config: Option<QueuedConfig>,
    },
    Cancel,
    Kill,
    /// 用户点击登录后触发。method_id 来自 initialize 响应 auth_methods[i].id,
    /// 由前端从 `AuthRequired` update 中拿到再原样回传。
    Authenticate {
        method_id: String,
    },
    /// Agent 未声明认证方法时，用户可先在外部 CLI 完成登录，再要求 Grove
    /// 重试被 `auth_required` 拒绝的请求。
    RetryAuthentication,
    /// 调用 ACP v1 `logout`。reply 用于把协议调用结果返回给 WebSocket handler。
    Logout {
        reply: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },
    /// 调用 ACP `session/fork`(`unstable_session_fork`),要求 agent 基于当前
    /// session 派生一个新的会话副本。reply 回传 fork 后的 acp session_id。
    ForkSession {
        cwd: PathBuf,
        reply: tokio::sync::oneshot::Sender<std::result::Result<String, String>>,
    },
    /// 调用 ACP v1 `session/delete`,要求 agent 删掉
    /// 当前 session(handle 自己的 session_id)。reply 回传成功/失败。
    DeleteSession {
        reply: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },
    SetMode {
        mode_id: String,
        reply: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },
    SetConfigOption {
        config_id: String,
        value: ConfigOptionValue,
        reply: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },
    ListSessions {
        cursor: Option<String>,
        reply: tokio::sync::oneshot::Sender<std::result::Result<SessionListPage, String>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum ConfigOptionValue {
    Select(String),
    Boolean(bool),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ListedSession {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionListPage {
    pub sessions: Vec<ListedSession>,
    pub next_cursor: Option<String>,
}

pub type SessionConfigOptionData = acp::SessionConfigOption;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ElicitationRequestSnapshot {
    pub request_id: String,
    pub agent_name: String,
    pub request: acp::CreateElicitationRequest,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub opened: bool,
}

struct PendingElicitation {
    snapshot: ElicitationRequestSnapshot,
    response_tx: tokio::sync::oneshot::Sender<ElicitationResponseData>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ElicitationResponseData {
    Accept {
        #[serde(default)]
        content: Option<BTreeMap<String, ElicitationValueData>>,
    },
    Decline,
    Cancel,
}

pub enum ElicitationResponseResult {
    Accepted,
    Stale,
    Invalid(String),
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub enum ElicitationValueData {
    String(String),
    Integer(i64),
    Number(f64),
    Boolean(bool),
    StringArray(Vec<String>),
}

impl From<ElicitationValueData> for acp::ElicitationContentValue {
    fn from(value: ElicitationValueData) -> Self {
        match value {
            ElicitationValueData::String(value) => Self::String(value),
            ElicitationValueData::Integer(value) => Self::Integer(value),
            ElicitationValueData::Number(value) => Self::Number(value),
            ElicitationValueData::Boolean(value) => Self::Boolean(value),
            ElicitationValueData::StringArray(value) => Self::StringArray(value),
        }
    }
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
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        mode_descriptions: HashMap<String, String>,
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
        /// Frontend echoes this back inside the next `Prompt.config.thought_level_config_id`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thought_level_config_id: Option<String>,
        /// Full ACP v1 config snapshot. Empty means the Agent did not expose
        /// configOptions; legacy mode/model/thought fields above remain for
        /// persisted sessions created by older Grove versions.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        config_options: Vec<acp::SessionConfigOption>,
        #[serde(default)]
        uses_config_options: bool,
        prompt_capabilities: PromptCapabilitiesData,
        /// agent 在 initialize 响应里是否声明了 `session.fork` capability
        /// (`unstable_session_fork`)。老 history.jsonl 没这个字段时反序列化为 false。
        #[serde(default)]
        fork_capable: bool,
        #[serde(default)]
        import_capable: bool,
        #[serde(default)]
        delete_capable: bool,
        /// initialize.authMethods，供 More 菜单按 Agent 声明展示 Login。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        auth_methods: Vec<AuthMethodInfo>,
        /// agentCapabilities.auth.logout，供 More 菜单展示 Logout。
        #[serde(default)]
        logout_capable: bool,
    },
    /// Full replacement snapshot from ACP `config_option_update` or a
    /// successful `session/set_config_option` response.
    ConfigOptionsUpdate {
        config_options: Vec<acp::SessionConfigOption>,
    },
    ConfigOptionError {
        config_id: String,
        message: String,
    },
    /// Grove has started one agent turn for these accepted input messages.
    PromptStarted {
        message_ids: Vec<String>,
    },
    /// The agent turn ended. `stop_reason` distinguishes normal completion
    /// from cancellation or a killed session for lifecycle consumers.
    PromptCompleted {
        message_ids: Vec<String>,
        stop_reason: String,
    },
    /// The accepted input could not complete as an agent turn.
    PromptFailed {
        message_ids: Vec<String>,
        message: String,
    },
    /// Agent 消息文本片段
    MessageChunk {
        text: String,
    },
    /// Agent 消息中的结构化内容片段。Text 继续使用 MessageChunk 兼容旧历史；
    /// Image / Audio / ResourceLink / EmbeddedResource 保留完整 payload。
    MessageContentChunk {
        content: ContentBlockData,
    },
    /// Agent 思考过程片段
    ThoughtChunk {
        text: String,
    },
    /// 工具调用开始
    ToolCall {
        id: String,
        title: String,
        locations: Vec<(String, Option<u32>)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<DateTime<Utc>>,
        /// ACP `tool_call.raw_input` 透传 — agent 实际发起调用时的入参 JSON
        /// (Bash 命令、Grep pattern、MCP 入参等)。老 history.jsonl 无此字段
        /// 反序列化兜底为 None。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_input: Option<serde_json::Value>,
    },
    /// 工具调用更新
    ToolCallUpdate {
        id: String,
        status: String,
        content: Option<String>,
        locations: Vec<(String, Option<u32>)>,
        /// 同 [`AcpUpdate::ToolCall::raw_input`]:一些 agent(Claude Code 等)
        /// 的 `raw_input` 在首个 ToolCall 事件还没出现,要到 ToolCallUpdate
        /// 才透出 — 这里也带上,前端按更新覆盖。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_input: Option<serde_json::Value>,
    },
    /// Complete ACP v1 tool snapshot. Kept separate from legacy Grove events so
    /// old string-delta history remains readable without changing its semantics.
    ToolCallV1 {
        id: String,
        title: String,
        kind: String,
        status: String,
        content: Option<String>,
        #[serde(default)]
        input: Vec<ToolCallInputData>,
        #[serde(default, rename = "raw_input", skip_serializing)]
        legacy_raw_input: Option<serde_json::Value>,
        #[serde(default, rename = "raw_output", skip_serializing)]
        legacy_raw_output: Option<serde_json::Value>,
        #[serde(default, alias = "tool_content")]
        output: Vec<ToolCallContentData>,
        locations: Vec<(String, Option<u32>)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<DateTime<Utc>>,
    },
    /// Partial ACP v1 update. Optional fields preserve omitted-vs-present, and
    /// collection values replace the previous snapshot, including empty clears.
    ToolCallUpdateV1 {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Vec<ToolCallContentData>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        locations: Option<Vec<(String, Option<u32>)>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<Vec<ToolCallInputData>>,
        #[serde(default, rename = "raw_input", skip_serializing)]
        legacy_raw_input: Option<serde_json::Value>,
        #[serde(default, rename = "raw_output", skip_serializing)]
        legacy_raw_output: Option<serde_json::Value>,
        #[serde(default, rename = "content", skip_serializing)]
        legacy_content: Option<serde_json::Value>,
    },
    /// Live snapshot for an ACP v1 terminal embedded in a tool call. Snapshots
    /// are cumulative so reconnect/history replay can restore the latest
    /// visible output without depending on the terminal still being active.
    TerminalOutputUpdate {
        terminal_id: String,
        output: String,
        truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_status: Option<TerminalExitStatusData>,
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
    /// Structured form dispatched to the chat UI by the `ask_form` MCP tool.
    /// Carries the full form definition inline so the frontend can render a
    /// FormPill straight from this event — no rawInput sniffing on tool_call.
    /// Treated as transient UI (excluded from history persistence) so the
    /// form disappears cleanly on refresh; the user's actual answers travel
    /// back as a regular user prompt (which IS persisted as user content).
    AskForm {
        form_id: String,
        definition: crate::agent_graph::ask_form::AskFormInput,
    },
    /// Native ACP `elicitation/create`. Kept transient; the live pending
    /// snapshot is replayed directly when the browser reconnects.
    ElicitationRequest {
        snapshot: ElicitationRequestSnapshot,
    },
    ElicitationResolved {
        request_id: String,
        action: String,
    },
    ElicitationValidationError {
        request_id: String,
        message: String,
    },
    ElicitationComplete {
        elicitation_id: String,
    },
    /// 用户对权限请求的响应（记录到历史用于回放）
    PermissionResponse {
        #[serde(default)]
        id: String,
        option_id: String,
    },
    /// 本轮处理结束。`stop_reason` / `usage` 来自 ACP `PromptResponse`;
    /// `start_ts` / `end_ts`(Unix 秒)是 grove 在 send_request 前后自测的
    /// wall-clock,用于本轮 duration 显示与 token 用量统计入库。
    /// 三个字段都可空,老 history.jsonl 没有这些字段反序列化兜底为 None。
    Complete {
        stop_reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TurnUsage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_ts: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end_ts: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<UsageCost>,
    },
    /// Agent busy 状态变化
    Busy {
        value: bool,
    },
    /// 错误
    Error {
        message: String,
    },
    /// agent 通过 -32000 AuthRequired 通知 client 需要登录。`methods` 来自
    /// initialize 响应里的 auth_methods 全集 — 前端把每个渲染成一个按钮,
    /// 用户点哪个就用哪种登录。空数组表示 agent 没声明任何登录方法,UI 提示
    /// 用户去终端用 agent 自己的 CLI 登录。
    AuthRequired {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        methods: Vec<AuthMethodInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_name: Option<String>,
    },
    /// authenticate 调用成功。发出后 grove 会自动把暂存的原 prompt 重新入队。
    AuthSucceeded,
    /// authenticate 调用失败。前端保留认证面板并恢复按钮，允许用户重试或
    /// 选择其他已声明的方法。
    AuthFailed {
        message: String,
    },
    /// logout RPC 成功。该事件只用于即时 UI 反馈，不写入聊天历史。
    AuthLoggedOut,
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
    ModeChanged {
        mode_id: String,
    },
    /// Model 变更通知（乐观更新，与 ModeChanged 对称）
    ModelChanged {
        model_id: String,
    },
    /// Thought-level selector updated (push from agent via ConfigOptionUpdate,
    /// or echo after applying a Prompt's `config.thought_level`). Empty
    /// available vec means the agent dropped the selector.
    ThoughtLevelsUpdate {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        available: Vec<(String, String)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config_id: Option<String>,
    },
    /// Agent Plan 更新（结构化 TODO 列表）
    PlanUpdate {
        entries: Vec<PlanEntryData>,
    },
    /// 可用 Slash Commands 更新
    AvailableCommands {
        commands: Vec<CommandInfo>,
    },
    /// 待执行消息队列更新
    QueueUpdate {
        messages: Vec<QueuedMessage>,
    },
    /// Notify the frontend that a queued message with the given id is no longer
    /// in the pending queue (already drained / edited away / cleared). Used to
    /// reconcile optimistic edit/delete UI when the client request races the
    /// auto-drain.
    QueueMessageGone {
        id: String,
    },
    /// Plan file 路径更新（Write 工具在 plan mode 下写入 .md 文件时触发）
    PlanFileUpdate {
        path: String,
        content: Option<String>,
    },
    /// 会话结束
    SessionEnded,
    /// 用户直接执行终端命令（Shell 模式）
    TerminalExecute {
        command: String,
    },
    /// 终端输出片段（流式推送）
    TerminalChunk {
        output: String,
    },
    /// 终端命令执行完成
    TerminalComplete {
        exit_code: Option<i32>,
    },
    /// Pre-spawn UI hint for the chat panel. Currently only emitted on the
    /// npx path so the user sees "Downloading agent (~30s)" instead of a
    /// silent 30s "Connecting...". Not persisted, not surfaced on
    /// walkie-talkie / NodeStatus — purely a TaskChat UX signal.
    ///
    /// Phase values: "downloading" (npm fetch in flight), "ready" (pre-warm
    /// done — TaskChat clears the override and falls back to its normal
    /// connecting/connected text driven by `connecting`/`SessionReady`).
    ConnectPhase {
        phase: String,
    },
    /// Context window usage update (ACP v1 `usage_update`).
    /// Agent reports current `used / size` tokens for the session, optionally
    /// with cumulative cost. Pushed every time the agent recomputes — frontend
    /// renders a context-window pill, no debouncing.
    UsageUpdate {
        used: u64,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<UsageCost>,
    },
}

/// Cumulative session cost (from ACP `usage_update.cost`). Optional —
/// only some agents (e.g. opencode) report it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct UsageCost {
    pub amount: f64,
    pub currency: String,
}

/// Per-turn token accounting (from ACP `PromptResponse.usage`). Persisted
/// alongside `Complete` events in chat history so the UI can render a
/// per-message meta row, and inserted into `chat_token_usage` for stats.
/// Per ACP, fields are this prompt turn's usage, not session totals.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_read_tokens: Option<u64>,
}

/// Latest context-window usage snapshot for a chat. Persisted into
/// `session.json` so reopening Grove restores the pill without waiting for
/// the next agent push.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct UsageSnapshot {
    pub used: u64,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<UsageCost>,
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
    /// Missing on Grove history written before ACP plan priorities were
    /// preserved. New protocol events always populate this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(deserialize_with = "deserialize_plan_status")]
    pub status: String,
}

fn deserialize_plan_status<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let status = <String as serde::Deserialize>::deserialize(deserializer)?;
    Ok(normalize_plan_status(&status))
}

/// Slash command 数据（从 ACP AvailableCommandsUpdate 提取）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    pub input_hint: Option<String>,
}

/// 从 ACP InitializeResponse.auth_methods 提取的登录方法描述。
/// 仅捕获 `AuthMethod::Agent` 变体的字段(`unstable_auth_methods` 未开启时
/// EnvVar / Terminal 变体在反序列化阶段会被 `VecSkipError` 自动跳过)。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn is_advertised_auth_method(methods: &[AuthMethodInfo], method_id: &str) -> bool {
    methods.iter().any(|method| method.id == method_id)
}

/// Agent 的 Prompt 能力声明（从 ACP InitializeResponse 提取）
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct PromptCapabilitiesData {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
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
        uri: Option<String>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob: Option<String>,
    },
}

/// Lossless Grove representation of ACP v1 `ToolCallContent`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolCallContentData {
    Content {
        content: ContentBlockData,
    },
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
        /// Adapter-formatted text retained for compact summaries and legacy UI.
        display_text: String,
    },
    Terminal {
        terminal_id: String,
        /// Absent on legacy persisted data that only retained the terminal ID.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_status: Option<TerminalExitStatusData>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct TerminalExitStatusData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

/// User-facing tool input after Grove removes transport metadata and assigns
/// readable labels. ACP's opaque rawInput never leaves the protocol boundary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ToolCallInputData {
    pub label: String,
    pub value: String,
}

fn validate_prompt_content(
    capabilities: &PromptCapabilitiesData,
    attachments: &[ContentBlockData],
) -> Result<(), String> {
    for block in attachments {
        let unsupported = match block {
            ContentBlockData::Image { .. } if !capabilities.image => Some("image"),
            ContentBlockData::Audio { .. } if !capabilities.audio => Some("audio"),
            ContentBlockData::Resource { .. } if !capabilities.embedded_context => {
                Some("embedded resource")
            }
            ContentBlockData::Text { .. } | ContentBlockData::ResourceLink { .. } => None,
            _ => None,
        };
        if let Some(content_type) = unsupported {
            return Err(format!(
                "Prompt not sent — the Agent did not advertise support for {content_type} content"
            ));
        }
    }
    Ok(())
}

/// 队列合并发送模式：Separate = 逐条按原队列顺序发送（默认）；
/// Compact = 自动弹出时把队列中所有消息合并成一条发送。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueMode {
    #[default]
    Separate,
    Compact,
}

/// Model / mode / thought-level 快照，随 QueuedMessage 一起存储，
/// 在出队时重新应用，确保每条消息使用正确的配置。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QueuedConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Thought-level value id（e.g. "high"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_level: Option<String>,
    /// Config option id for thought-level（agent 自定义，e.g. "effort_level"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_level_config_id: Option<String>,
    /// Arbitrary ACP v1 Session Config Options keyed by the agent-advertised
    /// SessionConfigId. String values are Select value ids; booleans are
    /// Boolean config values. Applied in the agent-advertised option order.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub config_options: std::collections::BTreeMap<String, ConfigOptionValue>,
}

/// One select-style session config option (mode / model / effort / …) for
/// external surfaces: the ACP config id to pass to `set_config_option`, a
/// human-readable label, the current value, and the available (value, label)
/// pairs.
#[derive(Debug, Clone)]
pub struct ConfigSelector {
    pub config_id: String,
    pub label: String,
    pub current: Option<String>,
    pub options: Vec<(String, String)>,
}

/// A Grove-owned prompt ticket. Grove allocates the message id before the
/// command enters the ACP loop so an external integration can register its
/// mapping before any turn event is emitted.
pub struct PreparedTextPrompt {
    id: String,
    text: String,
    sender: Option<String>,
}

impl PreparedTextPrompt {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// 队列中的待发送消息（支持附件）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QueuedMessage {
    /// 入队时分配的稳定唯一标识。前端用它做 edit/delete 的目标定位 — 比 index 安全,
    /// 因为 index 会随队首被 drain 而漂移。旧版本持久化数据没有此字段,反序列化时由
    /// `default` 生成新 uuid。
    #[serde(default = "default_queued_message_id")]
    pub id: String,
    /// Accepted Grove input ids carried through queueing and Compact merges.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub message_ids: Vec<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ContentBlockData>,
    /// 消息发送者标识。`None` = 用户输入；`Some("agent:<chat_id>")` = 另一个 agent
    /// 通过 agent_graph 工具注入的消息。语义对前端用于"身份徽章"渲染，对存储用于
    /// 区分 user / agent-injected 消息。Phase 2 引入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    /// 出队时重新应用的 config 快照（model / mode / thought_level）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<QueuedConfig>,
    /// `true` when the original Prompt was issued from Shell-mode (terminal
    /// echo). Drained back into `AcpCommand::Prompt.terminal` so the
    /// downstream `UserMessage` emission preserves the terminal flag. Default
    /// `false` keeps backwards compatibility with persisted history that
    /// pre-dates this field.
    #[serde(default)]
    pub terminal: bool,
}

fn default_queued_message_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl QueuedMessage {
    /// Convenience constructor used by enqueue paths (api/agent_graph/cmd_loop).
    /// 自动分配 uuid 作为 id;调用方拿到返回值后可读 `msg.id` 用于后续 dequeue/edit。
    pub fn new(
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        config: Option<QueuedConfig>,
    ) -> Self {
        let id = default_queued_message_id();
        Self {
            message_ids: vec![id.clone()],
            id,
            text,
            attachments,
            sender,
            config,
            terminal,
        }
    }
}

/// Session 元数据（写入 session.json，供其他进程发现）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionMetadata {
    pub pid: u32,
    pub agent_name: String,
    pub agent_version: String,
    pub available_modes: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub mode_descriptions: HashMap<String, String>,
    pub current_mode_id: Option<String>,
    pub available_models: Vec<(String, String)>,
    pub current_model_id: Option<String>,
    #[serde(default)]
    pub model_config_id: Option<String>,
    #[serde(default)]
    pub available_thought_levels: Vec<(String, String)>,
    #[serde(default)]
    pub current_thought_level_id: Option<String>,
    #[serde(default)]
    pub thought_level_config_id: Option<String>,
    /// Added with complete ACP v1 config-options support. Old session.json
    /// files omit it and continue through the legacy fields above.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_options: Vec<acp::SessionConfigOption>,
    #[serde(default)]
    pub uses_config_options: bool,
    #[serde(default)]
    pub prompt_capabilities: PromptCapabilitiesData,
    #[serde(default)]
    pub available_commands: Vec<CommandInfo>,
    /// Latest context-window usage snapshot (ACP v1 `usage_update`).
    /// Set on every `usage_update` notification; restored from disk on reopen.
    /// `None` when the agent has not reported usage yet — UI hides the pill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_usage: Option<UsageSnapshot>,
}

/// Unix socket 命令（JSONL，每连接一条）。
///
/// **不携带 terminal 字段**：cross-process 路径（MCP CLI、远端 ACP bridge）
/// 不支持 Shell-mode prompt。本进程内 `AcpCommand::Prompt` 有 `terminal: bool`
/// — 那是 WS 直连前端用的。Socket dispatch 在 `dispatch_socket_command` 里
/// 一律以 `terminal=false` 转成 `AcpCommand::Prompt`。若未来要让远端调用方也能
/// 发 Shell prompt，在这里加 `#[serde(default)] terminal: bool` 并把 dispatch
/// 透传即可。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SocketCommand {
    Prompt {
        text: String,
        #[serde(default)]
        attachments: Vec<ContentBlockData>,
        #[serde(default)]
        sender: Option<String>,
        /// Per-prompt config bundle. Applied before the prompt is sent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config: Option<QueuedConfig>,
    },
    Cancel,
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
#[derive(Debug, Clone)]
pub struct LoopbackMcpServer {
    pub name: String,
    pub url: String,
    pub route: String,
    /// Optional usage guidance appended to the first Session instruction when
    /// this explicit server is present for the Run.
    pub session_instruction: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerPolicy {
    /// Grove's normal working-session MCPs plus any explicitly supplied servers.
    WorkingSession,
    /// Only the servers explicitly supplied by the caller.
    ExplicitOnly,
}

const WORKING_GROVE_INSTRUCTION: &str = r#"You are a Working Agent running inside Grove.

The current Project provides durable shared context. The current Task defines the scope of this work. Work toward the user's requested outcome while preserving the meaning of earlier requirements and decisions across follow-up messages.

Before substantive work, use the provided Grove capability to read the current Task notes. Treat those notes as authoritative Task context and reconcile them with the user's current instruction and applicable workspace guidance.

Preserve the user's control over consequential changes. Actions that complete, merge, archive, publish, externally communicate, or otherwise finalize the Task require explicit user direction. When the work reveals a material change to the understood goal, scope, decision, expected behavior, or tradeoff, make that change visible to the user before treating it as the new direction."#;

const WORKING_AGENT_RUNTIME_INSTRUCTION: &str = r#"Keep the Session title aligned with the user's primary intent. Update it when that intent materially changes.

Use Grove collaboration when another Session can contribute relevant existing context or concrete, independently executable work. Understand the available Sessions before coordinating, give delegated work a clear outcome and boundary, and remain responsible for integrating the result into the current Task.

Use a structured form when several related user decisions need to be collected together."#;

const WORKING_CODING_LOCAL_INSTRUCTION: &str = r#"This is a repository Task operating in the Project's primary working tree. Preserve unrelated existing changes, understand the current repository state before editing, and keep your work scoped to the user's request.

When continuing or reviewing an existing change, inspect the available Grove review feedback and distinguish confirmed implementation facts, inferences, and remaining validation needs."#;

const WORKING_CODING_WORKTREE_INSTRUCTION: &str = r#"This is a repository Task operating in its own working tree. Keep changes focused on this Task and preserve the surrounding repository behavior.

When continuing or reviewing an existing change, inspect the available Grove review feedback and distinguish confirmed implementation facts, inferences, and remaining validation needs."#;

const WORKING_STUDIO_INSTRUCTION: &str = r#"This is a Studio Task. Follow the workspace contract in `AGENTS.md` and the Project guidance in `instructions.md` when present. Use visual collaboration capabilities when a visual artifact would communicate or validate the result better than prose alone."#;

const WORKING_BROWSER_INSTRUCTION: &str = r#"Use browser control when the work depends on the user's current browser state, authenticated Session, or visible interaction with a page."#;

const WORKING_MEMORY_INSTRUCTION: &str = r#"Project Memory preserves long-term knowledge about both the Project and its working context.

At the start of every new Working Session, before substantive work, always search Project Memory. Do not decide that Memory is unnecessary without performing this initial retrieval. A search with no relevant result is valid and satisfies this requirement.

Use `memory_recall` with the user's request, current Task scope, and relevant terminology. Also use `memory_get_recent_logs` to find recent decisions, corrections, instructions, and unfinished work that may not yet be organized. For every potentially relevant Entity returned by recall, use `memory_read` before relying on it or proceeding with the work. Reconcile organized long-term Memory and recent unorganized Logs with the current Task notes and the user's latest instruction. If required context is still missing after this search, then ask the user for it rather than guessing.

Repeat Memory retrieval when the user's primary intent materially changes or the work moves to a different subject whose history may matter. Do not repeat an equivalent search when the applicable Memory has already been read in the current Session and remains current.

Apply each Memory according to its recorded scope, conditions, and current validity. Treat organized long-term Memory as established context and recent unorganized Logs as evidence that may still require reconciliation.

When the user or the current work establishes, changes, corrects, rejects, or supersedes durable context, use `memory_append_log` in the same turn as soon as its meaning is clear. Do not defer the Log until Task completion, Session completion, or a later reminder from the user. Preserve the meaning a future Agent will need:

- A decision preserves its context, outcome, rationale, status, and relevant boundaries.
- A rule preserves when it applies, the behavior it requires, and its scope.
- A preference preserves the concrete behavior expected from future Agents.
- A fact preserves the qualifications and time boundaries needed to use it correctly.
- A lesson preserves the situation, insight, and future implication.

Record durable changes in understanding, including corrections and superseded decisions, rather than preserving only the final conclusion."#;

const MEMORY_ORGANIZATION_INSTRUCTION: &str = r#"You are Grove's Project Memory Organizer.

Build and maintain a useful long-term Memory of the Project and the working context around it. The Memory should help future Agents understand what matters, make better decisions, collaborate effectively with the user, and continue work without reconstructing important context from past conversations.

Begin by understanding the existing Memory and the evidence made available for this Run. Identify durable knowledge across the full working context, including the Project's domain, goals, decisions, rationale, constraints, terminology, architecture, operating environment, user preferences, communication patterns, collaboration rules, workflows, recurring problems, lessons, unresolved tensions, and other context that may materially affect future work. These are examples rather than a fixed taxonomy; discover the structure that best fits the evidence.

Organize knowledge according to how it will be used in the future. An Entity should represent a coherent subject, rule, relationship, working pattern, or body of knowledge that is useful to recall together. Preserve distinctions when information has different scopes, audiences, conditions, or consequences. Combine evidence when it contributes to the same durable understanding.

Synthesize rather than transcribe. Preserve the meaning that makes each kind of knowledge actionable:

- Decisions retain their context, outcome, rationale, status, and relevant boundaries.
- Rules retain when they apply, what behavior they require, and their scope.
- Preferences retain the concrete behavior expected from future Agents.
- Facts retain the qualifications, time boundaries, and context needed to use them correctly.
- Lessons retain the situation, insight, and future implication.
- Open questions retain why they remain unresolved and what would resolve them.

Reconcile new evidence with existing Memory and actively choose the maintenance operation that produces the best current structure:

- Keep an Entity whose knowledge, boundary, and metadata remain sound.
- Evolve an Entity when evidence extends or corrects the same knowledge unit.
- Merge Entities that should be recalled and applied as one unit.
- Split an Entity that contains knowledge that should be recalled, applied, or evolve independently.
- Create an Entity for a durable knowledge unit the current structure does not represent.
- Remove an Entity whose useful knowledge has been correctly preserved elsewhere or no longer has long-term value.

Treat Split as a first-class operation. Evaluate a split when an Entity contains different subjects, purposes, scopes, actors, activation conditions, consequences, or lifecycles; when substantial parts are independently useful; when one title, description, and Tag set cannot accurately describe the whole; or when internal conflicts cannot be explained as the evolution of one knowledge unit. Shared origin in one Project, Task, conversation, document, or workflow is not cohesion.

Distinguish evidence provenance from knowledge applicability. Entity boundaries follow where knowledge should apply in the future, not where it was observed. If knowledge would still guide an Agent after replacing its originating subject, separate it from that subject's Business Context and record the actor, conditions, and scope that actually govern its use.

When conflicting evidence describes the evolution of the same knowledge, preserve the current conclusion and the meaningful supersession context together. When the conflict comes from different scopes, actors, conditions, or purposes, split those contexts. When splitting, synthesize and move each coherent cluster, update the original Entity and all affected metadata, avoid duplicate knowledge, and use Relations where the remaining connection has long-term meaning.

Future recall initially discovers Entities through their title, description, and Tags. The Markdown body becomes available only after an Entity has been discovered. Design metadata from likely future queries and useful retrieval facets such as knowledge form, subject, scope, actor, workflow, system, status, and applicability. Keep vocabulary consistent where concepts are shared without forcing every Entity into one template. Metadata makes a coherent Entity discoverable; it does not compensate for a mixed Entity boundary.

Use Relations when a connection between Entities adds useful meaning or improves future discovery.

Before publishing, review the Memory from the perspective of a future Agent. Confirm evidence coverage and correctness, test likely retrieval queries, and review every Entity for internal cohesion and possible split. A no-change result is complete only when the content, Entity operations, boundaries, titles, descriptions, Tags, Relations, scopes, and activation paths already satisfy this standard.

Read only evidence made available through the provided tools. Modify files only within the managed Entity directory, and publish the completed organization through the provided completion tool."#;

fn working_project_kind_instruction(config: &AcpStartConfig) -> Option<&'static str> {
    crate::storage::workspace::load_project_by_hash(&config.project_key)
        .ok()
        .flatten()
        .map(|project| match project.project_type {
            crate::storage::workspace::ProjectType::Studio => WORKING_STUDIO_INSTRUCTION,
            crate::storage::workspace::ProjectType::Repo
                if config.task_id == crate::storage::tasks::LOCAL_TASK_ID =>
            {
                WORKING_CODING_LOCAL_INSTRUCTION
            }
            crate::storage::workspace::ProjectType::Repo => WORKING_CODING_WORKTREE_INSTRUCTION,
        })
}

fn build_working_session_instruction(
    config: &AcpStartConfig,
    agent_runtime_available: bool,
) -> String {
    let mut grove_sections = vec![WORKING_GROVE_INSTRUCTION];
    if let Some(task_kind) = working_project_kind_instruction(config) {
        grove_sections.push(task_kind);
    }
    if agent_runtime_available {
        if crate::storage::memory::project_memory_enabled(&config.project_key).unwrap_or(false) {
            grove_sections.push(WORKING_MEMORY_INSTRUCTION);
        }
        grove_sections.push(WORKING_AGENT_RUNTIME_INSTRUCTION);
        if crate::storage::config::load_config()
            .browser_control
            .enabled
        {
            grove_sections.push(WORKING_BROWSER_INSTRUCTION);
        }
    }

    let mut instruction = format!(
        "<grove-instructions>\n{}\n</grove-instructions>",
        grove_sections.join("\n\n")
    );
    if let Some(persona) = config.persona_injection.as_ref() {
        if !persona.system_prompt.trim().is_empty() {
            instruction.push_str("\n\n");
            instruction.push_str(&crate::agent_graph::inject::build_persona_instruction(
                &persona.persona_name,
                &persona.system_prompt,
            ));
        }
    }
    instruction
}

fn session_bootstrap_instruction(
    config: &AcpStartConfig,
    agent_runtime_available: bool,
) -> Option<(&'static str, String)> {
    if config.mcp_server_policy == McpServerPolicy::WorkingSession && config.chat_id.is_some() {
        return Some((
            "working_session",
            build_working_session_instruction(config, agent_runtime_available),
        ));
    }
    if let Some(memory_server) = config
        .additional_mcp_servers
        .iter()
        .find(|server| server.name == "grove_memory")
    {
        let mut instruction = MEMORY_ORGANIZATION_INSTRUCTION.to_string();
        if let Some(additional) = memory_server.session_instruction.as_deref() {
            if !additional.trim().is_empty() {
                instruction.push_str("\n\n");
                instruction.push_str(additional);
            }
        }
        return Some(("memory_organization", instruction));
    }
    if let Some(persona) = config.persona_injection.as_ref() {
        if !persona.system_prompt.trim().is_empty() {
            return Some((
                "persona",
                crate::agent_graph::inject::build_persona_instruction(
                    &persona.persona_name,
                    &persona.system_prompt,
                ),
            ));
        }
    }
    None
}

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
    /// Optional non-Task artifact directory. Automation consumers use this
    /// for history.jsonl, session.json and agent.log while retaining the same
    /// ACP lifecycle implementation as Task chats.
    pub artifact_dir: Option<PathBuf>,
    /// Additional loopback MCP servers supplied by an Automation consumer.
    pub additional_mcp_servers: Vec<LoopbackMcpServer>,
    /// Controls whether Grove's normal working-session MCPs and plugin MCPs are
    /// included alongside `additional_mcp_servers`.
    pub mcp_server_policy: McpServerPolicy,
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
    /// True only for the WebSocket opened directly by the Import action.
    pub import_session: bool,
    /// Custom Agent (persona) settings and prompt. Settings are applied on the
    /// fresh create path; the prompt is concatenated with Grove's instructions
    /// on the first real user request. Resume / Load paths skip both because
    /// they are already represented by the existing ACP session.
    pub persona_injection: Option<PersonaInjection>,
}

/// Custom Agent (persona) identity, preferred ACP settings, and user-authored
/// instructions applied once per fresh session.
///
/// `agent_config` is the capability-snapshot-backed selection used by new
/// clients. The fixed `model` / `mode` / `effort` fields remain as a fallback
/// for personas created before that schema existed. Configuration is applied
/// BEFORE the system prompt is sent so it is in effect from message #1.
#[derive(Debug, Clone)]
pub struct PersonaInjection {
    pub persona_id: String,
    pub persona_name: String,
    pub base_agent: String,
    pub system_prompt: String,
    pub agent_config: crate::agent_config::AgentConfigSelection,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
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
/// Working sessions include the existing stdio `grove mcp`, the task-scoped
/// `grove_agent` server when available, and installed plugin MCPs. Isolated
/// consumers receive only their explicitly supplied servers.
///
/// The agent_graph entry is silently skipped when the listener hasn't booted (e.g.
/// `grove acp` standalone mode, tests). In that case the agent only sees
/// stdio tools — agent_graph features become unavailable but the session
/// still works for normal chat.
fn build_mcp_servers(
    env_vars: &HashMap<String, String>,
    agent_graph_token: Option<&str>,
    supports_http: bool,
    additional: &[LoopbackMcpServer],
    policy: McpServerPolicy,
) -> crate::error::Result<Vec<acp::McpServer>> {
    let mut servers = Vec::new();
    if policy == McpServerPolicy::WorkingSession {
        servers.push(grove_mcp_server(env_vars)?);
        if let Some(token) = agent_graph_token {
            if let Some(url) = crate::api::handlers::agent_graph_mcp::build_mcp_url(token) {
                if supports_http {
                    servers.push(acp::McpServer::Http(acp::McpServerHttp::new(
                        "grove_agent",
                        url,
                    )));
                } else {
                    // Stdio is mandatory for every ACP Agent. When Streamable HTTP
                    // is unavailable, expose the same agent_graph service through
                    // Grove's stdio-to-HTTP bridge instead.
                    let exe = std::env::current_exe().map_err(|e| {
                        crate::error::GroveError::Session(format!(
                            "Failed to resolve Grove MCP bridge executable: {}",
                            e
                        ))
                    })?;
                    let command = exe.canonicalize().unwrap_or(exe);
                    let env = env_vars
                        .iter()
                        .filter(|(name, _)| {
                            matches!(
                                name.as_str(),
                                "GROVE_MCP_TOKEN"
                                    | "GROVE_MCP_PORT"
                                    | "GROVE_MCP_BRIDGE_TIMEOUT_SECS"
                            )
                        })
                        .map(|(name, value)| acp::EnvVariable::new(name.clone(), value.clone()))
                        .collect();
                    servers.push(acp::McpServer::Stdio(
                        acp::McpServerStdio::new("grove_agent", command)
                            .args(vec![
                                "mcp-bridge".to_string(),
                                "--route".to_string(),
                                "mcp".to_string(),
                            ])
                            .env(env),
                    ));
                }
            }
        }
    }
    for server in additional {
        if supports_http {
            servers.push(acp::McpServer::Http(acp::McpServerHttp::new(
                server.name.clone(),
                server.url.clone(),
            )));
        } else {
            let exe = std::env::current_exe().map_err(|error| {
                crate::error::GroveError::Session(format!(
                    "Failed to resolve Grove MCP bridge executable: {error}"
                ))
            })?;
            let command = exe.canonicalize().unwrap_or(exe);
            let env = env_vars
                .iter()
                .filter(|(name, _)| {
                    matches!(
                        name.as_str(),
                        "GROVE_MCP_TOKEN" | "GROVE_MCP_PORT" | "GROVE_MCP_BRIDGE_TIMEOUT_SECS"
                    )
                })
                .map(|(name, value)| acp::EnvVariable::new(name.clone(), value.clone()))
                .collect();
            servers.push(acp::McpServer::Stdio(
                acp::McpServerStdio::new(server.name.clone(), command)
                    .args(vec![
                        "mcp-bridge".to_string(),
                        "--route".to_string(),
                        server.route.clone(),
                    ])
                    .env(env),
            ));
        }
    }
    if policy == McpServerPolicy::WorkingSession {
        // Inject stdio MCP servers contributed by installed plugins, forwarding the
        // task/project context env (so a plugin's MCP server has the same "current
        // context" the panel gets from host.getInfo).
        servers.extend(load_plugin_mcp_servers(env_vars));
        servers.extend(load_standalone_mcp_servers(env_vars));
    }
    Ok(servers)
}

fn load_standalone_mcp_servers(base_env: &HashMap<String, String>) -> Vec<acp::McpServer> {
    let Some(agent_id) = base_env.get("GROVE_AGENT_ID") else {
        return Vec::new();
    };
    let configs = crate::storage::extensions::resolve_effective_mcp_configs(
        agent_id,
        base_env.get("GROVE_PROJECT").map(String::as_str),
    )
    .unwrap_or_default();
    configs
        .into_iter()
        .filter_map(|config| {
            let name = sanitize_mcp_server_name(&config.name);
            if config.transport == "stdio" {
                let command = config.command?;
                let env = config
                    .env
                    .into_iter()
                    .map(|(key, value)| acp::EnvVariable::new(key, value))
                    .collect();
                Some(acp::McpServer::Stdio(
                    acp::McpServerStdio::new(name, std::path::PathBuf::from(command))
                        .args(config.args)
                        .env(env),
                ))
            } else {
                let url = config.url?;
                let headers = config
                    .headers
                    .into_iter()
                    .map(|(key, value)| acp::HttpHeader::new(key, value))
                    .collect();
                Some(acp::McpServer::Http(
                    acp::McpServerHttp::new(name, url).headers(headers),
                ))
            }
        })
        .collect()
}

fn sanitize_mcp_server_name(raw: &str) -> String {
    let value = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let value = value.trim_matches('-');
    if value.is_empty() {
        "mcp".into()
    } else {
        value.into()
    }
}

/// Resolve Task-level linked Grove Project IDs to the absolute directories
/// sent on ACP session lifecycle requests. New/load/resume resolve this when
/// the connection starts; fork resolves it again when the request is sent so
/// a newly forked session receives the Task's latest linked Project set.
fn resolve_linked_project_paths(
    project_key: &str,
    task_id: &str,
) -> crate::error::Result<Vec<PathBuf>> {
    let ids =
        crate::storage::tasks::load_linked_project_ids(project_key, task_id).map_err(|error| {
            crate::error::GroveError::Session(format!(
                "Failed to load linked Project configuration: {error}"
            ))
        })?;
    let registered = crate::storage::workspace::load_projects().map_err(|error| {
        crate::error::GroveError::Session(format!(
            "Failed to load registered Projects for linked workspace setup: {error}"
        ))
    })?;
    let mut paths = Vec::new();
    for id in ids {
        let Some(project) = registered
            .iter()
            .find(|project| crate::storage::workspace::project_hash(&project.path) == id)
        else {
            eprintln!("[ACP] Linked project {id} is no longer registered; skipping");
            continue;
        };
        let path = crate::storage::workspace::project_directory(project);
        if !path.is_absolute() || !path.is_dir() {
            eprintln!(
                "[ACP] Linked project {} has no accessible absolute directory: {}",
                project.name, project.path
            );
            continue;
        }
        let resolved = path.canonicalize().unwrap_or(path);
        if !paths.contains(&resolved) {
            paths.push(resolved);
        }
    }
    Ok(paths)
}

fn is_executable_file(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    true
}

fn resolve_executable_candidate(
    path: &std::path::Path,
    env: &HashMap<String, String>,
) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let _ = env;
        is_executable_file(path).then(|| path.to_path_buf())
    }

    #[cfg(windows)]
    {
        let extensions: Vec<String> = env
            .get("PATHEXT")
            .cloned()
            .or_else(|| std::env::var("PATHEXT").ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(str::to_string)
            .collect();
        let literal_allowed = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                let extension = format!(".{extension}");
                extensions
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
            });
        if literal_allowed && is_executable_file(path) {
            return Some(path.to_path_buf());
        }
        if path.extension().is_none() {
            for extension in extensions {
                let candidate = PathBuf::from(format!("{}{}", path.display(), extension));
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

/// Resolve a plugin-authored logical command (for example `node`) to the
/// absolute executable path required by ACP. Keep the discovered path itself
/// rather than canonicalizing it so version-manager shims remain effective.
fn resolve_plugin_mcp_command(
    command: &str,
    plugin_dir: &std::path::Path,
    env: &HashMap<String, String>,
) -> Option<String> {
    let command_path = std::path::Path::new(command);

    let plugin_relative = plugin_dir.join(command_path);
    if let Some(plugin_relative) = resolve_executable_candidate(&plugin_relative, env) {
        let absolute = if plugin_relative.is_absolute() {
            plugin_relative
        } else {
            std::env::current_dir().ok()?.join(plugin_relative)
        };
        return Some(absolute.to_string_lossy().into_owned());
    }

    if command_path.is_absolute() {
        return resolve_executable_candidate(command_path, env)
            .map(|path| path.to_string_lossy().into_owned());
    }

    // A relative path containing a directory component is plugin-relative;
    // if it did not resolve above, do not reinterpret it as a PATH command.
    if command_path.components().count() > 1 {
        return None;
    }

    let path = env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"))?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(command_path);
        if let Some(candidate) = resolve_executable_candidate(&candidate, env) {
            let absolute = if candidate.is_absolute() {
                candidate
            } else {
                std::env::current_dir().ok()?.join(candidate)
            };
            return Some(absolute.to_string_lossy().into_owned());
        }
    }
    None
}

/// Build stdio MCP servers contributed by installed plugins. A plugin whose
/// manifest has `contributes.mcp = { command, args?, env? }` gets one stdio
/// server. Relative file paths in command/args are resolved against the plugin
/// folder; `GROVE_PLUGIN_DIR` / `GROVE_PLUGIN_DATA_DIR` plus the allowlisted
/// task/project context (`PLUGIN_MCP_CONTEXT_ENV`, e.g. `GROVE_WORKTREE`) are
/// injected so the server has the same context the panel gets from
/// host.getInfo. Best-effort: a missing / malformed manifest is skipped, never
/// fails the session.
fn load_plugin_mcp_servers(base_env: &HashMap<String, String>) -> Vec<acp::McpServer> {
    let plugins = match crate::storage::plugins::list() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut servers = Vec::new();
    for plugin in plugins {
        let manifest_path = std::path::Path::new(&plugin.local_path).join("plugin.json");
        let manifest: serde_json::Value = match std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(m) => m,
            None => continue,
        };
        let mcp = match manifest.get("contributes").and_then(|c| c.get("mcp")) {
            Some(m) => m,
            None => continue,
        };
        let plugin_dir = std::path::Path::new(&plugin.local_path);
        // Resolve argument values that name files inside the plugin folder.
        // McpServerStdio has no cwd, so a relative entry like `dist/server.js`
        // would otherwise resolve against Grove's cwd. The executable itself
        // is handled separately below because ACP requires an absolute path.
        let resolve = |s: &str| -> String {
            let candidate = plugin_dir.join(s);
            if candidate.is_file() {
                candidate.display().to_string()
            } else {
                s.to_string()
            }
        };
        let command = match mcp.get("command").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => match resolve_plugin_mcp_command(c, plugin_dir, base_env) {
                Some(command) => command,
                None => {
                    report_plugin_mcp_issue_once(
                        format!("{}:missing-executable:{c}", plugin.id),
                        || {
                            format!(
                                "grove: skipping MCP server for plugin '{}': executable '{}' was not found",
                                plugin.name, c
                            )
                        },
                    );
                    continue;
                }
            },
            _ => continue,
        };
        let mut args: Vec<String> = mcp
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(resolve).collect())
            .unwrap_or_default();
        // Declared permissions → Node runtime flags. Scoped permissions use
        // `node --permission`; `exec` intentionally disables that model because
        // it already grants full machine trust and Node otherwise propagates
        // the parent's fs restrictions to external Node/shebang CLIs.
        let perms: std::collections::HashSet<String> = manifest
            .get("permissions")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let storage_root = crate::storage::plugin_data::data_dir(&plugin.id);
        let _ = std::fs::create_dir_all(&storage_root);
        if crate::plugins::runtime::is_node_command(&command) {
            if !crate::plugins::runtime::node_supports_permissions(&command) {
                report_plugin_mcp_issue_once(
                    format!("{}:node-permissions:{command}", plugin.id),
                    || {
                        format!(
                            "grove: skipping MCP server for plugin '{}': node >= {} is required \
                             for enforced permissions (check `node --version`)",
                            plugin.name,
                            crate::plugins::runtime::MIN_NODE_MAJOR
                        )
                    },
                );
                continue;
            }
            let mut flags = crate::plugins::runtime::node_permission_flags(
                &perms,
                &plugin.local_path,
                &storage_root.display().to_string(),
                base_env.get("GROVE_WORKTREE").map(|s| s.as_str()),
            );
            flags.extend(args);
            args = flags;
        }
        let mut env: Vec<acp::EnvVariable> = mcp
            .get("env")
            .and_then(|v| v.as_object())
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| {
                        v.as_str()
                            .map(|s| acp::EnvVariable::new(k.clone(), s.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Hand the server a single structured context blob — the SDK's
        // `getGroveContext()` parses this; plugin authors never read env
        // directly. Secrets (e.g. Grove's MCP token) are never included.
        // The three storage scope dirs the MCP server can use directly (it runs
        // with `--allow-fs-*` on the data root). project/task are present only
        // when the session carries those ids.
        use crate::storage::plugin_data::{scope_dir, Scope};
        let dir_str = |s: Scope| {
            scope_dir(&plugin.id, &s)
                .ok()
                .map(|p| p.display().to_string())
        };
        let pid = base_env.get("GROVE_PROJECT_KEY").cloned();
        let tid = base_env.get("GROVE_TASK_ID").cloned();
        let storage = serde_json::json!({
            "global": dir_str(Scope::Global),
            "project": pid.clone().and_then(|p| dir_str(Scope::Project(p))),
            "task": pid.clone().zip(tid.clone()).and_then(|(p, t)| dir_str(Scope::Task(p, t))),
        });
        // Studio task worktrees live under ~/.grove/studios; everything else is
        // a coding repo. Mirrors the panel's host.getInfo().projectType.
        let project_type = base_env.get("GROVE_WORKTREE").map(|w| {
            if w.contains("studios") {
                "studio"
            } else {
                "repo"
            }
        });
        let context = serde_json::json!({
            "projectDir": base_env.get("GROVE_WORKTREE"),   // current task's working dir
            "projectPath": base_env.get("GROVE_PROJECT"),   // project root
            "projectName": base_env.get("GROVE_PROJECT_NAME"),
            "projectId": base_env.get("GROVE_PROJECT_KEY"),
            "projectType": project_type,
            "taskId": base_env.get("GROVE_TASK_ID"),
            "taskName": base_env.get("GROVE_TASK_NAME"),
            "branch": base_env.get("GROVE_BRANCH"),
            "target": base_env.get("GROVE_TARGET"),
            "chatId": base_env.get("GROVE_CHAT_ID"),
            "pluginDir": plugin.local_path,
            "dataDir": storage_root.display().to_string(),  // data root (all scopes)
            "storage": storage,
        });
        env.push(acp::EnvVariable::new(
            "GROVE_CONTEXT".to_string(),
            context.to_string(),
        ));
        // Event bus: the MCP server's stdio talks to the agent, not Grove, so
        // grove.events.emit posts back over HTTP (loopback) with the token.
        if let Some(url) = crate::plugins::events::events_url(&plugin.id) {
            env.push(acp::EnvVariable::new(
                "GROVE_EVENTS_TRANSPORT".to_string(),
                "http".to_string(),
            ));
            env.push(acp::EnvVariable::new("GROVE_EVENTS_URL".to_string(), url));
            env.push(acp::EnvVariable::new(
                "GROVE_EVENTS_TOKEN".to_string(),
                crate::plugins::events::token().to_string(),
            ));
        }
        servers.push(acp::McpServer::Stdio(
            acp::McpServerStdio::new(
                plugin_mcp_server_name(&plugin),
                std::path::PathBuf::from(command),
            )
            .args(args)
            .env(env),
        ));
    }
    servers
}

/// A readable, tool-safe MCP server name for a plugin — the agent prefixes the
/// plugin's tools with this, so it must not be the opaque `pl-<uuid>`. Uses the
/// plugin's folder name (sanitized to `[A-Za-z0-9_-]`), falling back to the id.
fn plugin_mcp_server_name(plugin: &crate::storage::plugins::Plugin) -> String {
    let raw = std::path::Path::new(&plugin.local_path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&plugin.name);
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        format!("plugin-{}", plugin.id)
    } else {
        slug.to_string()
    }
}

/// 单个 terminal 实例的状态
struct TerminalState {
    /// Send to this channel to request process kill
    kill_tx: mpsc::Sender<()>,
    /// Output state remains owned by the driver after `terminal/release`
    /// removes this ID, allowing trailing output to reach an embedded tool.
    runtime: Arc<Mutex<TerminalRuntime>>,
    /// Race-free, multi-waiter exit state. A new subscriber immediately sees
    /// an exit that happened before it started waiting.
    exit_tx: tokio::sync::watch::Sender<Option<acp::TerminalExitStatus>>,
}

struct TerminalRuntime {
    output: String,
    stdout_pending_utf8: Vec<u8>,
    stderr_pending_utf8: Vec<u8>,
    truncated: bool,
    output_byte_limit: Option<usize>,
    /// Set once an Agent embeds this terminal in ToolCallContent. Before that,
    /// snapshots would have no UI consumer and need not enter chat history.
    linked_to_tool_call: bool,
}

#[derive(Clone, Copy)]
enum TerminalStream {
    Stdout,
    Stderr,
}

/// Grove ACP client 共享状态。
///
/// Protocol handlers are registered as independent closures on `Client.builder()`.
/// 每个 handler 闭包通过 `Arc::clone` 捕获一份这个结构体,所以字段要么
/// 本身就是 `Send + Sync`、要么包在 `Mutex` 里。
struct AcpClientState {
    handle: Arc<AcpSessionHandle>,
    configured_agent_name: String,
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
}

/// Build a richer permission description by extracting the most useful
/// payload field out of the agent's `raw_input` JSON. Bash tools report
/// `{"command": "..."}`; file tools report `{"file_path": "..."}` or
/// similar. Anything else falls back to a short JSON snippet.
fn enrich_permission_description(title: &str, raw_input: &Option<serde_json::Value>) -> String {
    let detail = raw_input.as_ref().and_then(|v| {
        // If the agent passed a bare string for raw_input, surface it
        // directly — `serde_json::to_string` would wrap it in extra
        // quotes ("foo" → "\"foo\"") which looks ugly in the row.
        if let serde_json::Value::String(s) = v {
            return if s.trim().is_empty() {
                None
            } else {
                Some(s.clone())
            };
        }
        // Try common keys first — these are the ones that actually mean
        // something to a user scanning the popover.
        for key in ["command", "file_path", "path", "url", "query", "pattern"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        // Fallback: stringify the whole object, capped to keep the row tidy.
        let s = serde_json::to_string(v).ok()?;
        if s == "null" || s == "{}" || s == "[]" {
            None
        } else {
            Some(s)
        }
    });
    match (title.is_empty(), detail) {
        (true, None) => String::from("(no description)"),
        (true, Some(d)) => truncate_for_row(&d, 240),
        (false, None) => title.to_string(),
        (false, Some(d)) => format!("{} · {}", title, truncate_for_row(&d, 240)),
    }
}

fn truncate_for_row(s: &str, limit: usize) -> String {
    if s.chars().count() <= limit {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(limit).collect();
        out.push('…');
        out
    }
}

/// 权限请求 handler。序列化:同一时刻只能有一个 permission 等待用户响应,
/// 后续请求会在 `permission_lock` 上排队。
async fn handle_request_permission(
    state: &AcpClientState,
    args: acp::RequestPermissionRequest,
    cancellation: acp::RequestCancellation,
) -> acp::Result<acp::RequestPermissionResponse> {
    let _guard = tokio::select! {
        guard = state.handle.permission_lock.lock() => guard,
        _ = cancellation.cancelled() => return Err(acp::Error::request_cancelled()),
    };
    if state
        .handle
        .cancel_requested
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Cancelled,
        ));
    }

    let request_id = args.tool_call.tool_call_id.to_string();
    let title = args.tool_call.fields.title.clone().unwrap_or_default();
    // Enrich the description with the actual command / file path from
    // raw_input so the tray popover shows "bash · ls -la" instead of just
    // "bash". Falls back gracefully if raw_input is missing or not the
    // shape we expect.
    let desc = enrich_permission_description(&title, &args.tool_call.fields.raw_input);
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
        id: request_id.clone(),
        description: desc.clone(),
        options: options.clone(),
    });

    if state.chat_id.is_some() {
        notify_acp_event(
            &state.project_key,
            &state.task_id,
            state.chat_id.as_deref(),
            "Permission Required",
            &desc,
            AcpNotificationEvent::PermissionRequired,
            Some(&options),
        );
    }

    tokio::select! {
        result = rx => match result {
            Ok(option_id) => Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(
                    acp::SelectedPermissionOutcome::new(option_id),
                ),
            )),
            Err(_) => Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Cancelled,
            )),
        },
        _ = cancellation.cancelled() => {
            state.handle.cancel_pending_permission(&request_id);
            Err(acp::Error::request_cancelled())
        }
    }
}

fn elicitation_scope_matches_handle(
    handle: &AcpSessionHandle,
    scope: &acp::ElicitationScope,
) -> bool {
    match scope {
        acp::ElicitationScope::Request(_) => true,
        acp::ElicitationScope::Session(scope) => handle
            .agent_info
            .read()
            .ok()
            .and_then(|info| {
                info.as_ref()
                    .map(|(session_id, _, _)| session_id == &scope.session_id.to_string())
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn convert_elicitation_content(
    schema: &acp::ElicitationSchema,
    content: BTreeMap<String, ElicitationValueData>,
) -> acp::Result<BTreeMap<String, acp::ElicitationContentValue>> {
    for required in schema.required.as_deref().unwrap_or_default() {
        if !content.contains_key(required) {
            return Err(acp::Error::invalid_params()
                .data(format!("Missing required elicitation field '{required}'")));
        }
    }

    let mut converted = BTreeMap::new();
    for (name, value) in content {
        let property = schema.properties.get(&name).ok_or_else(|| {
            acp::Error::invalid_params().data(format!("Unknown elicitation field '{name}'"))
        })?;
        let value = match (property, value) {
            (
                acp::ElicitationPropertySchema::String(property),
                ElicitationValueData::String(value),
            ) => {
                let length = value.chars().count() as u32;
                if property.min_length.is_some_and(|minimum| length < minimum)
                    || property.max_length.is_some_and(|maximum| length > maximum)
                {
                    return Err(acp::Error::invalid_params()
                        .data(format!("Elicitation field '{name}' has an invalid length")));
                }
                if let Some(pattern) = property.pattern.as_deref() {
                    let pattern = regex::Regex::new(pattern).map_err(|_| {
                        acp::Error::invalid_params()
                            .data(format!("Elicitation field '{name}' has an invalid pattern"))
                    })?;
                    if !pattern.is_match(&value) {
                        return Err(acp::Error::invalid_params().data(format!(
                            "Elicitation field '{name}' does not match its pattern"
                        )));
                    }
                }
                let format_valid = match property.format {
                    Some(acp::StringFormat::Email) => {
                        let mut parts = value.split('@');
                        parts.next().is_some_and(|part| !part.is_empty())
                            && parts.next().is_some_and(|part| part.contains('.'))
                            && parts.next().is_none()
                    }
                    Some(acp::StringFormat::Uri) => url::Url::parse(&value).is_ok(),
                    Some(acp::StringFormat::Date) => {
                        chrono::NaiveDate::parse_from_str(&value, "%Y-%m-%d").is_ok()
                    }
                    Some(acp::StringFormat::DateTime) => {
                        chrono::DateTime::parse_from_rfc3339(&value).is_ok()
                    }
                    None => true,
                    _ => true,
                };
                if !format_valid {
                    return Err(acp::Error::invalid_params()
                        .data(format!("Elicitation field '{name}' has an invalid format")));
                }
                let allowed = property
                    .enum_values
                    .as_ref()
                    .map(|values| values.iter().any(|candidate| candidate == &value))
                    .or_else(|| {
                        property
                            .one_of
                            .as_ref()
                            .map(|options| options.iter().any(|option| option.value == value))
                    });
                if allowed == Some(false) {
                    return Err(acp::Error::invalid_params().data(format!(
                        "Elicitation field '{name}' is not an advertised option"
                    )));
                }
                acp::ElicitationContentValue::String(value)
            }
            (
                acp::ElicitationPropertySchema::Integer(property),
                ElicitationValueData::Integer(value),
            ) => {
                if property.minimum.is_some_and(|minimum| value < minimum)
                    || property.maximum.is_some_and(|maximum| value > maximum)
                {
                    return Err(acp::Error::invalid_params()
                        .data(format!("Elicitation field '{name}' is outside its range")));
                }
                acp::ElicitationContentValue::Integer(value)
            }
            (
                acp::ElicitationPropertySchema::Number(property),
                ElicitationValueData::Number(value),
            ) => {
                if !value.is_finite()
                    || property.minimum.is_some_and(|minimum| value < minimum)
                    || property.maximum.is_some_and(|maximum| value > maximum)
                {
                    return Err(acp::Error::invalid_params()
                        .data(format!("Elicitation field '{name}' is outside its range")));
                }
                acp::ElicitationContentValue::Number(value)
            }
            (
                acp::ElicitationPropertySchema::Number(property),
                ElicitationValueData::Integer(value),
            ) => {
                let value = value as f64;
                if property.minimum.is_some_and(|minimum| value < minimum)
                    || property.maximum.is_some_and(|maximum| value > maximum)
                {
                    return Err(acp::Error::invalid_params()
                        .data(format!("Elicitation field '{name}' is outside its range")));
                }
                acp::ElicitationContentValue::Number(value)
            }
            (acp::ElicitationPropertySchema::Boolean(_), ElicitationValueData::Boolean(value)) => {
                acp::ElicitationContentValue::Boolean(value)
            }
            (
                acp::ElicitationPropertySchema::Array(property),
                ElicitationValueData::StringArray(value),
            ) => {
                let count = value.len() as u64;
                if property.min_items.is_some_and(|minimum| count < minimum)
                    || property.max_items.is_some_and(|maximum| count > maximum)
                {
                    return Err(acp::Error::invalid_params().data(format!(
                        "Elicitation field '{name}' has an invalid selection count"
                    )));
                }
                let allowed: Vec<&str> = match &property.items {
                    acp::MultiSelectItems::String(items) => {
                        items.values.iter().map(String::as_str).collect()
                    }
                    acp::MultiSelectItems::Titled(items) => items
                        .options
                        .iter()
                        .map(|option| option.value.as_str())
                        .collect(),
                    acp::MultiSelectItems::Other(_) => {
                        return Err(acp::Error::invalid_params().data(format!(
                            "Elicitation field '{name}' uses an unsupported item type"
                        )));
                    }
                    _ => {
                        return Err(acp::Error::invalid_params().data(format!(
                            "Elicitation field '{name}' uses an unsupported item type"
                        )));
                    }
                };
                if value.iter().any(|item| !allowed.contains(&item.as_str())) {
                    return Err(acp::Error::invalid_params().data(format!(
                        "Elicitation field '{name}' contains an unadvertised option"
                    )));
                }
                acp::ElicitationContentValue::StringArray(value)
            }
            (acp::ElicitationPropertySchema::Other(_), _) => {
                return Err(acp::Error::invalid_params().data(format!(
                    "Elicitation field '{name}' uses an unsupported type"
                )));
            }
            _ => {
                return Err(acp::Error::invalid_params().data(format!(
                    "Elicitation field '{name}' has the wrong value type"
                )));
            }
        };
        converted.insert(name, value);
    }
    Ok(converted)
}

fn build_elicitation_response(
    request: &acp::CreateElicitationRequest,
    response: ElicitationResponseData,
) -> acp::Result<acp::CreateElicitationResponse> {
    let action = match response {
        ElicitationResponseData::Accept { content } => match &request.mode {
            acp::ElicitationMode::Form(form) => {
                let content = convert_elicitation_content(
                    &form.requested_schema,
                    content.unwrap_or_default(),
                )?;
                acp::ElicitationAction::Accept(acp::ElicitationAcceptAction::new().content(content))
            }
            acp::ElicitationMode::Url(_) => {
                acp::ElicitationAction::Accept(acp::ElicitationAcceptAction::new())
            }
            acp::ElicitationMode::Other(_) => {
                return Err(acp::Error::invalid_params().data("Unsupported elicitation mode"));
            }
            _ => {
                return Err(acp::Error::invalid_params().data("Unsupported elicitation mode"));
            }
        },
        ElicitationResponseData::Decline => acp::ElicitationAction::Decline,
        ElicitationResponseData::Cancel => acp::ElicitationAction::Cancel,
    };
    Ok(acp::CreateElicitationResponse::new(action))
}

async fn handle_create_elicitation(
    state: &AcpClientState,
    request: acp::CreateElicitationRequest,
    cancellation: acp::RequestCancellation,
) -> acp::Result<acp::CreateElicitationResponse> {
    match &request.mode {
        acp::ElicitationMode::Other(_) => {
            return Err(acp::Error::invalid_params().data("Unsupported elicitation mode"));
        }
        acp::ElicitationMode::Form(form) => {
            for (name, property) in &form.requested_schema.properties {
                match property {
                    acp::ElicitationPropertySchema::Other(_) => {
                        return Err(acp::Error::invalid_params().data(format!(
                            "Elicitation field '{name}' uses an unsupported type"
                        )));
                    }
                    acp::ElicitationPropertySchema::Array(array)
                        if matches!(array.items, acp::MultiSelectItems::Other(_)) =>
                    {
                        return Err(acp::Error::invalid_params().data(format!(
                            "Elicitation field '{name}' uses an unsupported item type"
                        )));
                    }
                    _ => {}
                }
            }
            if let Some(required) = &form.requested_schema.required {
                if let Some(name) = required
                    .iter()
                    .find(|name| !form.requested_schema.properties.contains_key(*name))
                {
                    return Err(acp::Error::invalid_params().data(format!(
                        "Required elicitation field '{name}' is not defined"
                    )));
                }
            }
        }
        acp::ElicitationMode::Url(_) => {}
        _ => {
            return Err(acp::Error::invalid_params().data("Unsupported elicitation mode"));
        }
    }
    if !elicitation_scope_matches_handle(&state.handle, request.scope()) {
        return Err(
            acp::Error::invalid_params().data("Elicitation scope does not match this connection")
        );
    }
    if let acp::ElicitationMode::Url(url) = &request.mode {
        let parsed = url::Url::parse(&url.url)
            .map_err(|_| acp::Error::invalid_params().data("Invalid elicitation URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(acp::Error::invalid_params()
                .data("Elicitation URL must be an absolute HTTP(S) URL"));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(acp::Error::invalid_params()
                .data("Elicitation URL must not contain embedded credentials"));
        }
    }

    let _guard = tokio::select! {
        guard = state.handle.elicitation_lock.lock() => guard,
        _ = cancellation.cancelled() => return Err(acp::Error::request_cancelled()),
    };
    let request_id = format!("elicitation-{}", uuid::Uuid::new_v4());
    let agent_name = state
        .handle
        .agent_info
        .read()
        .ok()
        .and_then(|info| info.as_ref().map(|(_, name, _)| name.clone()))
        .unwrap_or_else(|| state.configured_agent_name.clone());
    let snapshot = ElicitationRequestSnapshot {
        request_id: request_id.clone(),
        agent_name,
        request: request.clone(),
        opened: false,
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .handle
        .pending_elicitation
        .lock()
        .unwrap()
        .replace(PendingElicitation {
            snapshot: snapshot.clone(),
            response_tx: tx,
        });
    state
        .handle
        .emit(AcpUpdate::ElicitationRequest { snapshot });

    if state.chat_id.is_some() {
        notify_acp_event(
            &state.project_key,
            &state.task_id,
            state.chat_id.as_deref(),
            "Input Required",
            &request.message,
            AcpNotificationEvent::ElicitationRequired,
            None,
        );
    }

    tokio::select! {
        result = rx => match result {
            Ok(response) => build_elicitation_response(&request, response),
            Err(_) => Ok(acp::CreateElicitationResponse::new(acp::ElicitationAction::Cancel)),
        },
        _ = cancellation.cancelled() => {
            state.handle.cancel_pending_elicitation(&request_id);
            Err(acp::Error::request_cancelled())
        }
    }
}

fn handle_complete_elicitation(
    state: &AcpClientState,
    notification: acp::CompleteElicitationNotification,
) -> acp::Result<()> {
    let elicitation_id = notification.elicitation_id.to_string();
    if state
        .handle
        .active_url_elicitations
        .lock()
        .unwrap()
        .remove(&elicitation_id)
        .is_some()
    {
        state
            .handle
            .emit(AcpUpdate::ElicitationComplete { elicitation_id });
    }
    Ok(())
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
    if args.cwd.as_ref().is_some_and(|cwd| !cwd.is_absolute()) {
        return Err(acp::Error::invalid_params().data("Terminal cwd must be an absolute path"));
    }
    let cwd = args.cwd.unwrap_or_else(|| state.working_dir.clone());

    // Keep compatibility with Agents that send a full shell expression in
    // `command` when args is empty. For the protocol's command+args shape,
    // quote every value as one shell word so spaces and metacharacters cannot
    // change argument boundaries.
    let shell_cmd = build_terminal_shell_command(&args.command, &args.args);

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.arg("-c").arg(&shell_cmd);
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

    let (kill_tx, kill_rx) = mpsc::channel(1);
    let (exit_tx, _exit_rx) = tokio::sync::watch::channel(None);
    let runtime = Arc::new(Mutex::new(TerminalRuntime {
        output: String::new(),
        stdout_pending_utf8: Vec::new(),
        stderr_pending_utf8: Vec::new(),
        truncated: false,
        output_byte_limit: args
            .output_byte_limit
            .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX)),
        linked_to_tool_call: false,
    }));

    let term_state = TerminalState {
        kill_tx,
        runtime: Arc::clone(&runtime),
        exit_tx: exit_tx.clone(),
    };

    state
        .terminals
        .lock()
        .unwrap()
        .insert(id.clone(), term_state);

    let term_id = id.clone();
    let handle = Arc::clone(&state.handle);
    // handler 要求 Send,而 drive_terminal 的 future 也是 Send;用 tokio::spawn
    // 而不是 spawn_local 避免对 LocalSet 的隐式依赖。
    tokio::spawn(async move {
        drive_terminal(handle, term_id, runtime, exit_tx, child, kill_rx).await;
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
    let runtime = term.runtime.lock().unwrap();
    let exit_status = term.exit_tx.borrow().clone();
    let resp = acp::TerminalOutputResponse::new(runtime.output.clone(), runtime.truncated);
    Ok(if let Some(es) = exit_status {
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
    cancellation: acp::RequestCancellation,
) -> acp::Result<acp::WaitForTerminalExitResponse> {
    let mut exit_rx = {
        let terms = state.terminals.lock().unwrap();
        let tid = &*args.terminal_id.0;
        let term = terms
            .get(tid)
            .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
        let exit_rx = term.exit_tx.subscribe();
        if let Some(status) = exit_rx.borrow().clone() {
            return Ok(acp::WaitForTerminalExitResponse::new(status.clone()));
        }
        exit_rx
    };
    let status = tokio::select! {
        result = exit_rx.wait_for(|status| status.is_some()) => {
            result
                .map_err(|_| acp::Error::internal_error().data("Terminal exit state closed"))?
                .clone()
                .ok_or_else(|| acp::Error::internal_error().data("Terminal exited without status"))?
        }
        _ = cancellation.cancelled() => return Err(acp::Error::request_cancelled()),
    };
    Ok(acp::WaitForTerminalExitResponse::new(status))
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
    // A single ACP connection may know about more than one Session (for
    // example, after session/fork). Once this handle's active Session ID is
    // known, never apply another Session's updates to its chat state. During
    // session/new or session/load the response may not have supplied the ID
    // yet, so notifications received in that short window remain accepted.
    if !session_notification_targets_handle(&state.handle, &args.session_id) {
        return Ok(());
    }
    match args.update {
        acp::SessionUpdate::AgentMessageChunk(chunk) => {
            if let acp::ContentBlock::Text(text) = &chunk.content {
                if let Ok(mut buf) = state.handle.last_assistant_text.lock() {
                    // 若上一段文本之后夹过 tool_call，则在续写新文本前补段落分隔，
                    // 与前端「tool 边界另起气泡」的行为对齐。连续文本块（无 tool
                    // 间隔）仍直接拼接。
                    if state
                        .handle
                        .pending_text_separator
                        .swap(false, std::sync::atomic::Ordering::Relaxed)
                        && !buf.is_empty()
                    {
                        buf.push_str("\n\n");
                    }
                    buf.push_str(&text.text);
                }
                state.handle.emit(AcpUpdate::MessageChunk {
                    text: text.text.clone(),
                });
            } else if let Some(content) = content_block_to_data(&chunk.content) {
                state
                    .handle
                    .emit(AcpUpdate::MessageContentChunk { content });
            }
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
            let tool_call_id = tool_call.tool_call_id.to_string();
            let terminal = matches!(
                tool_call.status,
                acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed
            );
            {
                let mut active = state.handle.active_tool_calls.lock().unwrap();
                if terminal {
                    active.remove(&tool_call_id);
                } else {
                    active.insert(tool_call_id.clone());
                }
            }
            {
                let mut watches = state.handle.short_tool_watches.lock().unwrap();
                if terminal {
                    watches.remove(&tool_call_id);
                } else if is_short_memory_tool(&tool_call.title) {
                    watches.entry(tool_call_id.clone()).or_insert_with(|| {
                        let started_at = std::time::Instant::now();
                        ShortToolWatch {
                            title: tool_call.title.clone(),
                            started_at,
                            deadline: started_at + SHORT_MEMORY_TOOL_TIMEOUT,
                        }
                    });
                }
            }
            // 标记：此处出现了 tool_call，下一段 agent 文本应另起段落。
            state
                .handle
                .pending_text_separator
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let explicit_locations: Vec<(String, Option<u32>)> = tool_call
                .locations
                .iter()
                .map(|l| (l.path.display().to_string(), l.line))
                .collect();
            // Some ACP adapters (notably @agentclientprotocol/codex-acp 1.1.x)
            // put edited file paths only in ToolCallContent::Diff and leave the
            // top-level locations empty. Preserve those paths before the
            // content-only start event is followed by a status-only update.
            let locations = merge_diff_locations(explicit_locations.clone(), &tool_call.content);
            let output = tool_output_to_data(
                state.adapter.as_ref(),
                &tool_call.content,
                tool_call.raw_output.as_ref(),
                Some(&state.terminals),
            );
            state.handle.emit(AcpUpdate::ToolCallV1 {
                id: tool_call_id.clone(),
                title: tool_call.title.clone(),
                kind: tool_kind_name(&tool_call.kind).to_string(),
                status: tool_status_name(&tool_call.status).to_string(),
                content: tool_output_display_text(&output),
                input: tool_input_to_data(tool_call.raw_input.as_ref()),
                legacy_raw_input: None,
                legacy_raw_output: None,
                output,
                // Keep protocol locations exact. The frontend derives Diff
                // paths from structured output separately, so later output
                // replacement can remove stale Diff paths correctly.
                locations: explicit_locations,
                timestamp: Some(Utc::now()),
            });

            // 记录 Write 工具的 tool_call_id → file_path(用于 PlanFileUpdate 检测)。
            // 路径可能在第二个 ToolCall 事件才出现,所以每次有 locations 时更新。
            if tool_call.title.starts_with("Write") {
                if let Some((path, _)) = locations.first() {
                    state
                        .write_tool_paths
                        .lock()
                        .unwrap()
                        .insert(tool_call.tool_call_id.to_string(), path.clone());
                } else {
                    state
                        .write_tool_paths
                        .lock()
                        .unwrap()
                        .entry(tool_call.tool_call_id.to_string())
                        .or_default();
                }
            }

            // 缓存 Write/Edit 文件快照(locations 在第二个 ToolCall 事件才有路径)
            let title = &tool_call.title;
            if title.starts_with("Write") || title.starts_with("Edit") {
                if let Some((path, _)) = locations.first() {
                    let id_str = tool_call.tool_call_id.to_string();
                    let mut snapshots = state.file_snapshots.lock().unwrap();
                    snapshots.entry(id_str).or_insert_with(|| {
                        let abs_path = PathBuf::from(path);
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
                .as_deref()
                .and_then(|blocks| tool_contents_to_text(state.adapter.as_ref(), blocks));
            let status = update
                .fields
                .status
                .as_ref()
                .map(tool_status_name)
                .map(str::to_owned)
                .unwrap_or_default();
            let tool_call_id = update.tool_call_id.to_string();
            if !status.is_empty() {
                let mut active = state.handle.active_tool_calls.lock().unwrap();
                if matches!(status.as_str(), "completed" | "failed") {
                    active.remove(&tool_call_id);
                    state
                        .handle
                        .short_tool_watches
                        .lock()
                        .unwrap()
                        .remove(&tool_call_id);
                } else {
                    active.insert(tool_call_id.clone());
                }
            }
            let explicit_locations: Vec<(String, Option<u32>)> = update
                .fields
                .locations
                .as_ref()
                .map(|locs| {
                    locs.iter()
                        .map(|l| (l.path.display().to_string(), l.line))
                        .collect()
                })
                .unwrap_or_default();
            let locations = merge_diff_locations(
                explicit_locations,
                update.fields.content.as_deref().unwrap_or_default(),
            );

            // 如果 ACP 没提供 content 且状态为 completed,从文件快照生成 diff
            let is_completed = update
                .fields
                .status
                .as_ref()
                .is_some_and(|s| matches!(s, acp::ToolCallStatus::Completed));

            let snapshot = update
                .fields
                .status
                .as_ref()
                .is_some_and(|value| {
                    matches!(
                        value,
                        acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed
                    )
                })
                .then(|| {
                    state
                        .file_snapshots
                        .lock()
                        .unwrap()
                        .remove(&update.tool_call_id.to_string())
                })
                .flatten();

            let mut fallback_tool_content = None;
            if content.is_none() && is_completed {
                if let Some((abs_path, old_content)) = snapshot {
                    if let Ok(new_text) = std::fs::read_to_string(&abs_path) {
                        let display_text = adapter::generate_file_diff(
                            &abs_path,
                            old_content.as_deref(),
                            &new_text,
                        );
                        fallback_tool_content = Some(vec![ToolCallContentData::Diff {
                            path: abs_path.display().to_string(),
                            old_text: old_content,
                            new_text,
                            display_text: display_text.clone(),
                        }]);
                        content = Some(display_text);
                    }
                }
            }

            let output = if let Some(blocks) = update.fields.content.as_deref() {
                Some(tool_output_to_data(
                    state.adapter.as_ref(),
                    blocks,
                    update.fields.raw_output.as_ref(),
                    Some(&state.terminals),
                ))
            } else if update.fields.raw_output.is_some() {
                Some(tool_output_to_data(
                    state.adapter.as_ref(),
                    &[],
                    update.fields.raw_output.as_ref(),
                    Some(&state.terminals),
                ))
            } else {
                fallback_tool_content
            };

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

            let display_content = match output.as_deref() {
                Some(output) => tool_output_display_text(output),
                None => content,
            };
            state.handle.emit(AcpUpdate::ToolCallUpdateV1 {
                id: tool_call_id,
                title: update.fields.title.clone(),
                kind: update
                    .fields
                    .kind
                    .as_ref()
                    .map(tool_kind_name)
                    .map(str::to_owned),
                status: update
                    .fields
                    .status
                    .as_ref()
                    .map(tool_status_name)
                    .map(str::to_owned),
                output,
                display_content,
                locations: update.fields.locations.as_ref().map(|values| {
                    values
                        .iter()
                        .map(|value| (value.path.display().to_string(), value.line))
                        .collect()
                }),
                input: update
                    .fields
                    .raw_input
                    .as_ref()
                    .map(|value| tool_input_to_data(Some(value))),
                legacy_raw_input: None,
                legacy_raw_output: None,
                legacy_content: None,
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
        acp::SessionUpdate::UserMessageChunk(chunk) => {
            if state
                .handle
                .replay_user_messages
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let (text, attachments) = content_block_to_user_message(&chunk.content);
                state.handle.emit(AcpUpdate::UserMessage {
                    text,
                    attachments,
                    sender: None,
                    terminal: false,
                });
            }
        }
        acp::SessionUpdate::CurrentModeUpdate(update) => {
            // Legacy mode notifications are ignored once the Agent exposes
            // configOptions; ACP requires config-capable clients to use the
            // config snapshot exclusively in that case.
            let uses_config_options = state
                .handle
                .uses_config_options
                .load(std::sync::atomic::Ordering::Relaxed);
            if !uses_config_options {
                let mode_id = update.current_mode_id.to_string();
                *state.handle.current_mode_id.lock().unwrap() = Some(mode_id.clone());
                state.handle.emit(AcpUpdate::ModeChanged { mode_id });
            }
        }
        acp::SessionUpdate::Plan(plan) => {
            let entries: Vec<PlanEntryData> = plan
                .entries
                .iter()
                .map(|e| PlanEntryData {
                    content: e.content.clone(),
                    priority: Some(plan_priority_name(&e.priority).to_string()),
                    status: plan_status_name(&e.status).to_string(),
                })
                .collect();
            state.handle.emit(AcpUpdate::PlanUpdate { entries });
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
            replace_config_snapshot(&state.handle, update.config_options.clone());
        }
        acp::SessionUpdate::UsageUpdate(u) => {
            let cost = u.cost.as_ref().map(|c| UsageCost {
                amount: c.amount,
                currency: c.currency.clone(),
            });
            let snapshot = UsageSnapshot {
                used: u.used,
                size: u.size,
                cost: cost.clone(),
            };
            if let Ok(mut guard) = state.handle.current_usage.lock() {
                *guard = Some(snapshot);
            }
            state.handle.emit(AcpUpdate::UsageUpdate {
                used: u.used,
                size: u.size,
                cost,
            });
        }
        _ => {}
    }
    Ok(())
}

fn session_notification_targets_handle(
    handle: &AcpSessionHandle,
    notification_session_id: &acp::SessionId,
) -> bool {
    let Ok(agent_info) = handle.agent_info.read() else {
        return true;
    };
    agent_info
        .as_ref()
        .is_none_or(|(session_id, _, _)| session_id == &notification_session_id.to_string())
}

fn merge_diff_locations(
    mut locations: Vec<(String, Option<u32>)>,
    content: &[acp::ToolCallContent],
) -> Vec<(String, Option<u32>)> {
    let mut seen: std::collections::HashSet<String> =
        locations.iter().map(|(path, _)| path.clone()).collect();

    for item in content {
        if let acp::ToolCallContent::Diff(diff) = item {
            let path = diff.path.display().to_string();
            if seen.insert(path.clone()) {
                locations.push((path, None));
            }
        }
    }

    locations
}

fn tool_contents_to_text(
    adapter: &dyn adapter::AgentContentAdapter,
    content: &[acp::ToolCallContent],
) -> Option<String> {
    let text = content
        .iter()
        .map(|item| adapter.tool_call_content_to_text(item))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn tool_kind_name(kind: &acp::ToolKind) -> &'static str {
    match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "execute",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        acp::ToolKind::Other => "other",
        _ => "other",
    }
}

fn tool_status_name(status: &acp::ToolCallStatus) -> &'static str {
    match status {
        acp::ToolCallStatus::Pending => "pending",
        acp::ToolCallStatus::InProgress => "in_progress",
        acp::ToolCallStatus::Completed => "completed",
        acp::ToolCallStatus::Failed => "failed",
        _ => "pending",
    }
}

fn plan_priority_name(priority: &acp::PlanEntryPriority) -> &'static str {
    match priority {
        acp::PlanEntryPriority::High => "high",
        acp::PlanEntryPriority::Medium => "medium",
        acp::PlanEntryPriority::Low => "low",
        _ => "medium",
    }
}

fn plan_status_name(status: &acp::PlanEntryStatus) -> &'static str {
    match status {
        acp::PlanEntryStatus::Pending => "pending",
        acp::PlanEntryStatus::InProgress => "in_progress",
        acp::PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
}

fn normalize_plan_status(status: &str) -> String {
    if status == "inprogress" {
        "in_progress".to_string()
    } else {
        status.to_string()
    }
}

fn tool_contents_to_data(
    adapter: &dyn adapter::AgentContentAdapter,
    content: &[acp::ToolCallContent],
    terminals: Option<&Arc<Mutex<HashMap<String, TerminalState>>>>,
) -> Vec<ToolCallContentData> {
    let output: Vec<ToolCallContentData> = content
        .iter()
        .filter_map(|item| match item {
            acp::ToolCallContent::Content(value) => {
                let mut data = content_block_to_data(&value.content)?;
                // Preserve adapter-specific cleanup for textual tool output.
                if let ContentBlockData::Text { text } = &mut data {
                    *text = adapter.tool_call_content_to_text(item);
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                        let looks_internal = value.as_object().is_some_and(|object| {
                            object
                                .keys()
                                .any(|key| TOOL_INPUT_METADATA_KEYS.contains(&key.as_str()))
                        });
                        if looks_internal {
                            *text = protocol_output_text(Some(&value)).unwrap_or_default();
                        }
                    }
                    if text.trim().is_empty() {
                        return None;
                    }
                }
                Some(ToolCallContentData::Content { content: data })
            }
            acp::ToolCallContent::Diff(diff) => Some(ToolCallContentData::Diff {
                path: diff.path.display().to_string(),
                old_text: diff.old_text.clone(),
                new_text: diff.new_text.clone(),
                display_text: adapter.tool_call_content_to_text(item),
            }),
            acp::ToolCallContent::Terminal(terminal) => {
                let terminal_id = terminal.terminal_id.to_string();
                let snapshot = terminals.and_then(|terminals| {
                    let terms = terminals.lock().unwrap();
                    let term = terms.get(&terminal_id)?;
                    let mut runtime = term.runtime.lock().unwrap();
                    runtime.linked_to_tool_call = true;
                    let exit_status = term
                        .exit_tx
                        .borrow()
                        .clone()
                        .as_ref()
                        .map(terminal_exit_status_data);
                    Some((runtime.output.clone(), runtime.truncated, exit_status))
                });
                let (output, truncated, exit_status) = snapshot
                    .map(|(output, truncated, status)| (Some(output), truncated, status))
                    .unwrap_or((None, false, None));
                Some(ToolCallContentData::Terminal {
                    terminal_id,
                    output,
                    truncated,
                    exit_status,
                })
            }
            _ => None,
        })
        .collect();
    expand_embedded_mcp_results(output)
}

/// Some ACP agents expose an MCP CallToolResult as one JSON-encoded text block
/// instead of preserving its typed content blocks. Recover image/audio blocks
/// here so every Grove surface receives real media rather than a wall of base64.
fn expand_embedded_mcp_results(output: Vec<ToolCallContentData>) -> Vec<ToolCallContentData> {
    output
        .into_iter()
        .flat_map(|item| match item {
            ToolCallContentData::Content {
                content: ContentBlockData::Text { ref text },
            } => parse_embedded_mcp_content(text)
                .map(|blocks| {
                    blocks
                        .into_iter()
                        .map(|content| ToolCallContentData::Content { content })
                        .collect()
                })
                .unwrap_or_else(|| vec![item]),
            _ => vec![item],
        })
        .collect()
}

fn parse_embedded_mcp_content(text: &str) -> Option<Vec<ContentBlockData>> {
    let root = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let result = root.get("result").unwrap_or(&root);
    let content = result.get("content")?.as_array()?;

    // Only reinterpret the JSON when it contains actual media. Ordinary tool
    // JSON often has a `content` array too and must remain readable text.
    let contains_media = content.iter().any(|block| {
        matches!(
            block.get("type").and_then(serde_json::Value::as_str),
            Some("image" | "audio")
        )
    });
    if !contains_media {
        return None;
    }

    let blocks: Vec<ContentBlockData> = content
        .iter()
        .filter_map(|block| match block.get("type")?.as_str()? {
            "text" => Some(ContentBlockData::Text {
                text: block.get("text")?.as_str()?.to_string(),
            }),
            "image" => Some(ContentBlockData::Image {
                data: block.get("data")?.as_str()?.to_string(),
                mime_type: block
                    .get("mimeType")
                    .or_else(|| block.get("mime_type"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("image/png")
                    .to_string(),
                uri: None,
                label: None,
            }),
            "audio" => Some(ContentBlockData::Audio {
                data: block.get("data")?.as_str()?.to_string(),
                mime_type: block
                    .get("mimeType")
                    .or_else(|| block.get("mime_type"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("audio/mpeg")
                    .to_string(),
                label: None,
            }),
            _ => None,
        })
        .collect();

    (!blocks.is_empty()).then_some(blocks)
}

fn tool_output_to_data(
    adapter: &dyn adapter::AgentContentAdapter,
    content: &[acp::ToolCallContent],
    protocol_output: Option<&serde_json::Value>,
    terminals: Option<&Arc<Mutex<HashMap<String, TerminalState>>>>,
) -> Vec<ToolCallContentData> {
    let structured = tool_contents_to_data(adapter, content, terminals);
    if !structured.is_empty() {
        return structured;
    }
    protocol_output_text(protocol_output)
        .map(|text| {
            expand_embedded_mcp_results(vec![ToolCallContentData::Content {
                content: ContentBlockData::Text { text },
            }])
        })
        .unwrap_or_default()
}

pub fn legacy_tool_output_to_data(
    content: Option<&serde_json::Value>,
    raw_output: Option<&serde_json::Value>,
) -> Option<Vec<ToolCallContentData>> {
    if let Some(content) = content {
        if let Ok(values) = serde_json::from_value::<Vec<ToolCallContentData>>(content.clone()) {
            if !values.is_empty() || raw_output.is_none() {
                return Some(expand_embedded_mcp_results(values));
            }
        }
    }

    raw_output.and_then(|value| {
        protocol_output_text(Some(value)).map(|text| {
            expand_embedded_mcp_results(vec![ToolCallContentData::Content {
                content: ContentBlockData::Text { text },
            }])
        })
    })
}

fn tool_output_display_text(output: &[ToolCallContentData]) -> Option<String> {
    let text = output
        .iter()
        .map(|item| match item {
            ToolCallContentData::Content {
                content: ContentBlockData::Text { text },
            } => text.clone(),
            ToolCallContentData::Content { content } => match content {
                ContentBlockData::Image { label, .. } => {
                    label.clone().unwrap_or_else(|| "Image".to_string())
                }
                ContentBlockData::Audio { label, .. } => {
                    label.clone().unwrap_or_else(|| "Audio".to_string())
                }
                ContentBlockData::ResourceLink {
                    title, name, uri, ..
                } => title.clone().unwrap_or_else(|| {
                    if name.is_empty() {
                        uri.clone()
                    } else {
                        name.clone()
                    }
                }),
                ContentBlockData::Resource { text, uri, .. } => {
                    text.clone().unwrap_or_else(|| uri.clone())
                }
                ContentBlockData::Text { text } => text.clone(),
            },
            ToolCallContentData::Diff { display_text, .. } => display_text.clone(),
            ToolCallContentData::Terminal { terminal_id, .. } => {
                format!("Terminal {terminal_id}")
            }
        })
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn protocol_output_text(protocol_output: Option<&serde_json::Value>) -> Option<String> {
    let value = protocol_output?;
    if let Some(text) = value.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }

    let object = value.as_object()?;
    for key in ["formatted_output", "output", "content", "text"] {
        if let Some(text) = object.get(key).and_then(serde_json::Value::as_str) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }

    if let Some(content) = object.get("content").and_then(serde_json::Value::as_array) {
        let text = content
            .iter()
            .filter_map(serde_json::Value::as_object)
            .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return Some(text);
        }
    }

    let stdout = object
        .get("stdout")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let stderr = object
        .get("stderr")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let combined = [stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(if stdout.ends_with('\n') { "" } else { "\n" });
    if !combined.is_empty() {
        return Some(combined);
    }

    // Unknown responses may still contain meaningful user-facing fields (for
    // example old_title/new_title). Remove transport metadata, then retain the
    // remaining processed structure rather than treating it as empty.
    const OUTPUT_METADATA_KEYS: &[&str] = &[
        "exit_code",
        "is_error",
        "isError",
        "status",
        "success",
        "command",
        "cmd",
        "cwd",
    ];
    let readable = object
        .iter()
        .filter(|(key, _)| {
            !TOOL_INPUT_METADATA_KEYS.contains(&key.as_str())
                && !OUTPUT_METADATA_KEYS.contains(&key.as_str())
        })
        .filter(|(_, value)| match value {
            serde_json::Value::Null => false,
            serde_json::Value::String(text) => !text.trim().is_empty(),
            serde_json::Value::Array(values) => !values.is_empty(),
            serde_json::Value::Object(object) => !object.is_empty(),
            serde_json::Value::Bool(value) => *value,
            serde_json::Value::Number(_) => true,
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    if readable.is_empty() {
        None
    } else {
        serde_json::to_string_pretty(&serde_json::Value::Object(readable)).ok()
    }
}

const TOOL_INPUT_METADATA_KEYS: &[&str] = &[
    "call_id",
    "process_id",
    "turn_id",
    "session_id",
    "tool_call_id",
    "started_at_ms",
    "completed_at_ms",
    "yield_time_ms",
    "source",
    "parsed_cmd",
];

fn readable_input_label(key: &str) -> String {
    match key {
        "cwd" => "Working directory".to_string(),
        "cmd" | "command" => "Command".to_string(),
        "query" | "pattern" => "Query".to_string(),
        "path" | "file_path" => "Path".to_string(),
        "url" | "uri" => "URL".to_string(),
        "arguments" | "args" => "Parameters".to_string(),
        _ => key
            .split('_')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn input_value_text(key: &str, value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => (!text.trim().is_empty()).then(|| text.clone()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Array(values) if matches!(key, "command" | "cmd") => {
            let parts: Vec<&str> = values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            if parts.len() >= 3 && parts[1] == "-c" {
                Some(parts[2].to_string())
            } else if !parts.is_empty() {
                Some(parts.join(" "))
            } else {
                None
            }
        }
        serde_json::Value::Array(values)
            if values
                .iter()
                .any(|value| value.is_object() || value.is_array()) =>
        {
            serde_json::to_string_pretty(value).ok()
        }
        serde_json::Value::Array(values) => {
            let parts: Vec<String> = values
                .iter()
                .filter_map(|value| input_value_text(key, value))
                .collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        // Direct objects are flattened by `collect_tool_input_fields`. Objects
        // nested inside arrays cannot be flattened without losing item
        // boundaries, so retain them as readable structured values.
        serde_json::Value::Object(_) => serde_json::to_string_pretty(value).ok(),
    }
}

fn collect_tool_input_fields(
    prefix: Option<&str>,
    object: &serde_json::Map<String, serde_json::Value>,
    fields: &mut Vec<ToolCallInputData>,
) {
    const PREFERRED_KEYS: &[&str] = &[
        "query",
        "pattern",
        "path",
        "file_path",
        "command",
        "cmd",
        "cwd",
        "url",
        "uri",
        "server",
        "tool",
        "arguments",
        "args",
    ];
    if prefix.is_none() {
        if let Some(parsed_commands) = object
            .get("parsed_cmd")
            .and_then(serde_json::Value::as_array)
        {
            for parsed in parsed_commands
                .iter()
                .filter_map(serde_json::Value::as_object)
            {
                for key in ["query", "pattern", "path", "file_path", "url", "uri"] {
                    let Some(value) = parsed
                        .get(key)
                        .and_then(|value| input_value_text(key, value))
                    else {
                        continue;
                    };
                    let field = ToolCallInputData {
                        label: readable_input_label(key),
                        value,
                    };
                    if !fields.contains(&field) {
                        fields.push(field);
                    }
                }
            }
        }
    }

    let ordered_keys = PREFERRED_KEYS
        .iter()
        .copied()
        .filter(|key| object.contains_key(*key))
        .chain(
            object
                .keys()
                .map(String::as_str)
                .filter(|key| !PREFERRED_KEYS.contains(key)),
        );

    for key in ordered_keys {
        if TOOL_INPUT_METADATA_KEYS.contains(&key) {
            continue;
        }
        let Some(value) = object.get(key) else {
            continue;
        };
        if let serde_json::Value::Object(nested) = value {
            let nested_prefix = match prefix {
                Some(prefix) => format!("{prefix} · {}", readable_input_label(key)),
                None => readable_input_label(key),
            };
            collect_tool_input_fields(Some(&nested_prefix), nested, fields);
            continue;
        }
        let Some(value) = input_value_text(key, value) else {
            continue;
        };
        let label = match prefix {
            Some(prefix) => format!("{prefix} · {}", readable_input_label(key)),
            None => readable_input_label(key),
        };
        if !fields
            .iter()
            .any(|field| field.label == label && field.value == value)
        {
            fields.push(ToolCallInputData { label, value });
        }
    }
}

pub(crate) fn tool_input_to_data(
    protocol_input: Option<&serde_json::Value>,
) -> Vec<ToolCallInputData> {
    let Some(value) = protocol_input else {
        return Vec::new();
    };
    if let serde_json::Value::Object(object) = value {
        let mut fields = Vec::new();
        collect_tool_input_fields(None, object, &mut fields);
        fields
    } else {
        input_value_text("input", value)
            .map(|value| {
                vec![ToolCallInputData {
                    label: "Input".to_string(),
                    value,
                }]
            })
            .unwrap_or_default()
    }
}

/// Emit a synthetic `ThoughtLevelsUpdate` after a successful
/// `SetSessionConfigOption` round-trip, so the new selection persists to
/// `SessionMetadata` even when the agent doesn't auto-echo via
/// `session_update.ConfigOptionUpdate`. Pulls the cached `available` list from
/// the persisted metadata (if any) to keep dropdown options intact; otherwise
/// emits an empty list and relies on the next `SessionReady` / update to refill.
fn emit_thought_level_sync(handle: &AcpSessionHandle, config_id: &str, value_id: &str) {
    *handle.current_thought_level_id.lock().unwrap() = Some(value_id.to_string());
    *handle.thought_level_config_id.lock().unwrap() = Some(config_id.to_string());
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

fn flatten_select_options(select: &acp::SessionConfigSelect) -> Vec<(String, String)> {
    match &select.options {
        acp::SessionConfigSelectOptions::Ungrouped(entries) => entries
            .iter()
            .map(|entry| (entry.value.to_string(), entry.name.clone()))
            .collect(),
        acp::SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| {
                group
                    .options
                    .iter()
                    .map(|entry| (entry.value.to_string(), entry.name.clone()))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn extract_config_select(
    config_options: &[acp::SessionConfigOption],
    category: acp::SessionConfigOptionCategory,
    aliases: &[&str],
) -> (Vec<(String, String)>, Option<String>, Option<String>) {
    for option in config_options {
        let category_matches = option.category.as_ref().is_some_and(|candidate| {
            candidate == &category
                || matches!(candidate, acp::SessionConfigOptionCategory::Other(value)
                    if aliases.iter().any(|alias| value.eq_ignore_ascii_case(alias)))
        });
        if !category_matches {
            continue;
        }
        let acp::SessionConfigKind::Select(select) = &option.kind else {
            continue;
        };
        return (
            flatten_select_options(select),
            Some(select.current_value.to_string()),
            Some(option.id.to_string()),
        );
    }
    (Vec::new(), None, None)
}

type ExtractedModeState = (
    Vec<(String, String)>,
    Option<String>,
    Option<String>,
    HashMap<String, String>,
);

fn extract_modes(
    modes: &Option<acp::SessionModeState>,
    config_options: &[acp::SessionConfigOption],
    uses_config_options: bool,
) -> ExtractedModeState {
    // ACP v1 requires config-capable clients to use configOptions exclusively
    // whenever the list is present.
    if uses_config_options {
        let (available, current, config_id) = extract_config_select(
            config_options,
            acp::SessionConfigOptionCategory::Mode,
            &["mode"],
        );
        return (available, current, config_id, HashMap::new());
    }
    if let Some(state) = modes.as_ref() {
        return (
            state
                .available_modes
                .iter()
                .map(|mode| (mode.id.to_string(), mode.name.clone()))
                .collect(),
            Some(state.current_mode_id.to_string()),
            None,
            state
                .available_modes
                .iter()
                .filter_map(|mode| {
                    mode.description
                        .as_ref()
                        .map(|description| (mode.id.to_string(), description.clone()))
                })
                .collect(),
        );
    }
    (Vec::new(), None, None, HashMap::new())
}

/// Find the first thought-level selector while preserving grouped values.
fn extract_thought_level(
    config_options: &[acp::SessionConfigOption],
) -> (Vec<(String, String)>, Option<String>, Option<String>) {
    extract_config_select(
        config_options,
        acp::SessionConfigOptionCategory::ThoughtLevel,
        &["effort", "thought_level", "thoughtLevel"],
    )
}

fn store_config_snapshot(handle: &AcpSessionHandle, config_options: &[acp::SessionConfigOption]) {
    handle
        .uses_config_options
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let (_, mode, _) = extract_config_select(
        config_options,
        acp::SessionConfigOptionCategory::Mode,
        &["mode"],
    );
    let (_, model, model_config_id) = extract_config_select(
        config_options,
        acp::SessionConfigOptionCategory::Model,
        &["model"],
    );
    let (_, thought_level, thought_level_config_id) = extract_thought_level(config_options);

    *handle.current_mode_id.lock().unwrap() = mode;
    *handle.current_model_id.lock().unwrap() = model;
    *handle.model_config_id.lock().unwrap() = model_config_id;
    *handle.current_thought_level_id.lock().unwrap() = thought_level;
    *handle.thought_level_config_id.lock().unwrap() = thought_level_config_id;
    *handle.current_config_options.lock().unwrap() = config_options.to_vec();
}

fn config_option_current_value(option: &acp::SessionConfigOption) -> Option<ConfigOptionValue> {
    match &option.kind {
        acp::SessionConfigKind::Boolean(boolean) => {
            Some(ConfigOptionValue::Boolean(boolean.current_value))
        }
        acp::SessionConfigKind::Select(select) => {
            Some(ConfigOptionValue::Select(select.current_value.to_string()))
        }
        _ => None,
    }
}

/// Return persisted values that are still accepted by the newly-started ACP
/// Session and differ from its current values. Iterating in the live Agent's
/// advertised order keeps dependent options deterministic.
fn config_options_to_restore(
    persisted: &[acp::SessionConfigOption],
    advertised: &[acp::SessionConfigOption],
) -> Vec<(String, ConfigOptionValue)> {
    let persisted_values = persisted
        .iter()
        .filter_map(|option| {
            config_option_current_value(option).map(|value| (option.id.to_string(), value))
        })
        .collect::<std::collections::BTreeMap<_, _>>();

    advertised
        .iter()
        .filter_map(|option| {
            let config_id = option.id.to_string();
            let value = persisted_values.get(&config_id)?.clone();
            (crate::agent_config::config_option_accepts(option, &value)
                && !crate::agent_config::config_option_has_current_value(option, &value))
            .then_some((config_id, value))
        })
        .collect()
}

fn legacy_mode_to_restore(
    persisted: Option<&str>,
    current: Option<&str>,
    available: &[(String, String)],
) -> Option<String> {
    let persisted = persisted?;
    (current != Some(persisted) && available.iter().any(|(id, _)| id == persisted))
        .then(|| persisted.to_string())
}

fn replace_config_snapshot(
    handle: &AcpSessionHandle,
    config_options: Vec<acp::SessionConfigOption>,
) {
    store_config_snapshot(handle, &config_options);
    let mut snapshot =
        crate::storage::installed_agents::get_capability_snapshot(&handle.configured_agent_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                serde_json::json!({
                    "agent_id": crate::storage::installed_agents::canonicalize_agent_id(
                        &handle.configured_agent_id
                    )
                })
            });
    if let Some(object) = snapshot.as_object_mut() {
        object.insert(
            "config_options".to_string(),
            serde_json::to_value(&config_options).unwrap_or_else(|_| serde_json::json!([])),
        );
        object.insert("uses_config_options".to_string(), serde_json::json!(true));
        let _ = crate::storage::installed_agents::save_capability_snapshot(
            &handle.configured_agent_id,
            &snapshot,
        );
    }
    handle.emit(AcpUpdate::ConfigOptionsUpdate { config_options });
}

fn validated_config_request_value(
    handle: &AcpSessionHandle,
    config_id: &str,
    value: ConfigOptionValue,
) -> Result<acp::SessionConfigOptionValue, String> {
    let advertised = handle
        .current_config_options
        .lock()
        .map(|options| options.clone())
        .unwrap_or_default();
    config_request_value(&advertised, config_id, value)
}

fn config_request_value(
    advertised: &[acp::SessionConfigOption],
    config_id: &str,
    value: ConfigOptionValue,
) -> Result<acp::SessionConfigOptionValue, String> {
    let advertised = advertised
        .iter()
        .find(|option| option.id.to_string() == config_id);
    match (advertised.as_ref().map(|option| &option.kind), value) {
        (Some(acp::SessionConfigKind::Select(select)), ConfigOptionValue::Select(value))
            if flatten_select_options(select)
                .iter()
                .any(|(candidate, _)| candidate == &value) =>
        {
            Ok(acp::SessionConfigOptionValue::from(
                acp::SessionConfigValueId::new(value),
            ))
        }
        (Some(acp::SessionConfigKind::Boolean(_)), ConfigOptionValue::Boolean(value)) => {
            Ok(acp::SessionConfigOptionValue::from(value))
        }
        (None, _) => Err(format!(
            "Agent did not advertise session config option '{config_id}'"
        )),
        _ => Err(format!(
            "Value is not valid for session config option '{config_id}'"
        )),
    }
}

fn grove_client_capabilities() -> acp::ClientCapabilities {
    acp::ClientCapabilities::default()
        .terminal(true)
        .elicitation(
            acp::ElicitationCapabilities::new()
                .form(acp::ElicitationFormCapabilities::new())
                .url(acp::ElicitationUrlCapabilities::new()),
        )
        .session(
            acp::ClientSessionCapabilities::new().config_options(
                acp::SessionConfigOptionsCapabilities::new()
                    .boolean(acp::BooleanConfigOptionCapabilities::new()),
            ),
        )
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

fn content_block_to_data(block: &acp::ContentBlock) -> Option<ContentBlockData> {
    match block {
        acp::ContentBlock::Text(text) => Some(ContentBlockData::Text {
            text: text.text.clone(),
        }),
        acp::ContentBlock::Image(image) => Some(ContentBlockData::Image {
            data: image.data.clone(),
            mime_type: image.mime_type.clone(),
            uri: image.uri.clone(),
            label: image.uri.clone(),
        }),
        acp::ContentBlock::Audio(audio) => Some(ContentBlockData::Audio {
            data: audio.data.clone(),
            mime_type: audio.mime_type.clone(),
            label: audio
                .meta
                .as_ref()
                .and_then(|meta| meta.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        }),
        acp::ContentBlock::ResourceLink(resource) => Some(ContentBlockData::ResourceLink {
            uri: resource.uri.clone(),
            name: resource.name.clone(),
            mime_type: resource.mime_type.clone(),
            size: resource.size,
            title: resource.title.clone(),
            description: resource.description.clone(),
            label: resource
                .title
                .clone()
                .or_else(|| Some(resource.name.clone())),
        }),
        acp::ContentBlock::Resource(resource) => match &resource.resource {
            acp::EmbeddedResourceResource::TextResourceContents(contents) => {
                Some(ContentBlockData::Resource {
                    uri: contents.uri.clone(),
                    mime_type: contents.mime_type.clone(),
                    text: Some(contents.text.clone()),
                    blob: None,
                })
            }
            acp::EmbeddedResourceResource::BlobResourceContents(contents) => {
                Some(ContentBlockData::Resource {
                    uri: contents.uri.clone(),
                    mime_type: contents.mime_type.clone(),
                    text: None,
                    blob: Some(contents.blob.clone()),
                })
            }
            _ => None,
        },
        _ => None,
    }
}

/// Preserve the original ACP content block when replaying user history from
/// `session/load`. Text remains message text; every non-text block travels as
/// a structured attachment so the frontend can render the same user turn.
fn content_block_to_user_message(block: &acp::ContentBlock) -> (String, Vec<ContentBlockData>) {
    match content_block_to_data(block) {
        Some(ContentBlockData::Text { text }) => (text, Vec::new()),
        Some(attachment) => (String::new(), vec![attachment]),
        None => (String::new(), Vec::new()),
    }
}

/// 将 ContentBlockData 转换为 ACP ContentBlock
fn to_acp_content_block(block: &ContentBlockData) -> acp::ContentBlock {
    match block {
        ContentBlockData::Text { text } => text.clone().into(),
        ContentBlockData::Image {
            data,
            mime_type,
            uri,
            label: _,
        } => {
            let mut img = acp::ImageContent::new(data, mime_type);
            if let Some(uri) = uri {
                img = img.uri(uri.clone());
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
            mime_type,
            text,
            blob,
        } => {
            let resource = if let Some(blob) = blob {
                acp::EmbeddedResourceResource::BlobResourceContents(
                    acp::BlobResourceContents::new(blob, uri).mime_type(mime_type.clone()),
                )
            } else {
                acp::EmbeddedResourceResource::TextResourceContents(
                    acp::TextResourceContents::new(text.clone().unwrap_or_default(), uri)
                        .mime_type(mime_type.clone()),
                )
            };
            acp::ContentBlock::Resource(acp::EmbeddedResource::new(resource))
        }
    }
}

fn shell_quote_word(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn build_terminal_shell_command(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        return command.to_string();
    }
    std::iter::once(shell_quote_word(command))
        .chain(args.iter().map(|arg| shell_quote_word(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn terminal_exit_status_data(status: &acp::TerminalExitStatus) -> TerminalExitStatusData {
    TerminalExitStatusData {
        exit_code: status.exit_code,
        signal: status.signal.clone(),
    }
}

fn terminal_output_update(
    id: &str,
    runtime: &TerminalRuntime,
    exit_status: Option<&acp::TerminalExitStatus>,
) -> Option<AcpUpdate> {
    runtime
        .linked_to_tool_call
        .then(|| AcpUpdate::TerminalOutputUpdate {
            terminal_id: id.to_string(),
            output: runtime.output.clone(),
            truncated: runtime.truncated,
            exit_status: exit_status.map(terminal_exit_status_data),
        })
}

fn decode_terminal_bytes(pending: &mut Vec<u8>, data: &[u8]) -> String {
    pending.extend_from_slice(data);
    let mut decoded = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                decoded.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    decoded.push_str(
                        std::str::from_utf8(&pending[..valid_up_to])
                            .expect("valid_up_to must delimit valid UTF-8"),
                    );
                    pending.drain(..valid_up_to);
                }
                match error.error_len() {
                    Some(error_len) => {
                        decoded.push('\u{fffd}');
                        pending.drain(..error_len);
                    }
                    None => break,
                }
            }
        }
    }
    decoded
}

fn truncate_terminal_output(runtime: &mut TerminalRuntime) {
    let Some(limit) = runtime.output_byte_limit else {
        return;
    };
    if runtime.output.len() <= limit {
        return;
    }
    let mut cut = runtime.output.len() - limit;
    while !runtime.output.is_char_boundary(cut) {
        cut += 1;
    }
    runtime.output.drain(..cut);
    runtime.truncated = true;
}

fn append_terminal_output(
    runtime: &Arc<Mutex<TerminalRuntime>>,
    stream: TerminalStream,
    data: &[u8],
) -> Option<(String, bool)> {
    let mut runtime = runtime.lock().unwrap();
    let decoded = match stream {
        TerminalStream::Stdout => decode_terminal_bytes(&mut runtime.stdout_pending_utf8, data),
        TerminalStream::Stderr => decode_terminal_bytes(&mut runtime.stderr_pending_utf8, data),
    };
    runtime.output.push_str(&decoded);
    truncate_terminal_output(&mut runtime);
    runtime
        .linked_to_tool_call
        .then(|| (runtime.output.clone(), runtime.truncated))
}

fn flush_terminal_decoder(runtime: &mut TerminalRuntime, stream: TerminalStream) {
    let pending = match stream {
        TerminalStream::Stdout => std::mem::take(&mut runtime.stdout_pending_utf8),
        TerminalStream::Stderr => std::mem::take(&mut runtime.stderr_pending_utf8),
    };
    if !pending.is_empty() {
        runtime.output.push_str(&String::from_utf8_lossy(&pending));
        truncate_terminal_output(runtime);
    }
}

#[cfg(unix)]
fn terminal_signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        value => return format!("SIG{value}"),
    }
    .to_string()
}

fn terminal_exit_status(status: std::process::ExitStatus) -> acp::TerminalExitStatus {
    let mut result = acp::TerminalExitStatus::new();
    if let Some(code) = status.code().and_then(|code| u32::try_from(code).ok()) {
        result = result.exit_code(code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            result = result.signal(terminal_signal_name(signal));
        }
    }
    result
}

/// 后台任务：读取 terminal 进程的 stdout/stderr 输出，等待退出
async fn drive_terminal(
    handle: Arc<AcpSessionHandle>,
    id: String,
    runtime: Arc<Mutex<TerminalRuntime>>,
    exit_tx: tokio::sync::watch::Sender<Option<acp::TerminalExitStatus>>,
    mut child: tokio::process::Child,
    mut kill_rx: mpsc::Receiver<()>,
) {
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let mut stdout_buf = [0u8; 4096];
    let mut stderr_buf = [0u8; 4096];
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut kill_requested = false;

    loop {
        tokio::select! {
            result = stdout.read(&mut stdout_buf), if !stdout_done => {
                match result {
                    Ok(0) | Err(_) => stdout_done = true,
                    Ok(n) => {
                        if let Some((output, truncated)) =
                            append_terminal_output(&runtime, TerminalStream::Stdout, &stdout_buf[..n])
                        {
                            handle.emit(AcpUpdate::TerminalOutputUpdate {
                                terminal_id: id.clone(),
                                output,
                                truncated,
                                exit_status: None,
                            });
                        }
                    }
                }
            }
            result = stderr.read(&mut stderr_buf), if !stderr_done => {
                match result {
                    Ok(0) | Err(_) => stderr_done = true,
                    Ok(n) => {
                        if let Some((output, truncated)) =
                            append_terminal_output(&runtime, TerminalStream::Stderr, &stderr_buf[..n])
                        {
                            handle.emit(AcpUpdate::TerminalOutputUpdate {
                                terminal_id: id.clone(),
                                output,
                                truncated,
                                exit_status: None,
                            });
                        }
                    }
                }
            }
            _ = kill_rx.recv(), if !kill_requested => {
                kill_requested = true;
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
        Ok(status) => terminal_exit_status(status),
        Err(_) => acp::TerminalExitStatus::default(),
    };

    let final_update = {
        let mut runtime = runtime.lock().unwrap();
        flush_terminal_decoder(&mut runtime, TerminalStream::Stdout);
        flush_terminal_decoder(&mut runtime, TerminalStream::Stderr);
        terminal_output_update(&id, &runtime, Some(&exit_status))
    };
    exit_tx.send_replace(Some(exit_status));
    if let Some(update) = final_update {
        handle.emit(update);
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
                let (shutdown_tx, _) = tokio::sync::watch::channel(false);

                let handle = Arc::new(AcpSessionHandle {
                    key: key.clone(),
                    update_tx: update_tx.clone(),
                    cmd_tx,
                    shutdown_tx,
                    agent_info: std::sync::RwLock::new(None),
                    pending_permission: Mutex::new(None),
                    permission_lock: tokio::sync::Mutex::new(()),
                    pending_elicitation: Mutex::new(None),
                    elicitation_lock: tokio::sync::Mutex::new(()),
                    active_url_elicitations: Mutex::new(HashMap::new()),
                    project_key: config.project_key.clone(),
                    task_id: config.task_id.clone(),
                    chat_id: config.chat_id.clone(),
                    artifact_dir: config.artifact_dir.clone(),
                    configured_agent_id: config.agent_name.clone(),
                    suppress_emit: std::sync::atomic::AtomicBool::new(false),
                    replay_user_messages: std::sync::atomic::AtomicBool::new(
                        config.import_session,
                    ),
                    pending_queue: Mutex::new(Vec::new()),
                    queue_paused: std::sync::atomic::AtomicBool::new(false),
                    queue_drain_lock: Mutex::new(()),
                    queue_mode: Mutex::new(QueueMode::default()),
                    current_mode_id: Mutex::new(None),
                    current_model_id: Mutex::new(None),
                    current_usage: Mutex::new(None),
                    current_thought_level_id: Mutex::new(None),
                    thought_level_config_id: Mutex::new(None),
                    model_config_id: Mutex::new(None),
                    current_config_options: Mutex::new(Vec::new()),
                    uses_config_options: std::sync::atomic::AtomicBool::new(false),
                    working_dir: config.working_dir.to_string_lossy().to_string(),
                    terminal_kill_tx: Mutex::new(None),
                    is_busy: std::sync::atomic::AtomicBool::new(false),
                    last_assistant_text: Mutex::new(String::new()),
                    active_turn_message_ids: Mutex::new(Vec::new()),
                    last_turn_reply: Mutex::new(String::new()),
                    pending_text_separator: std::sync::atomic::AtomicBool::new(false),
                    last_user_prompt: Mutex::new(None),
                    last_plan: Mutex::new(None),
                    last_permission_info: Mutex::new(None),
                    active_tool_calls: Mutex::new(std::collections::HashSet::new()),
                    short_tool_watches: Mutex::new(HashMap::new()),
                    cancel_requested: std::sync::atomic::AtomicBool::new(false),
                    auth_methods: Mutex::new(Vec::new()),
                    logout_capable: std::sync::atomic::AtomicBool::new(false),
                    pending_auth_retry: Mutex::new(None),
                    pending_auth: Mutex::new(None),
                    pending_session_instruction: Mutex::new(None),
                    session_instruction_revision: std::sync::atomic::AtomicU64::new(0),
                    fork_capable: std::sync::atomic::AtomicBool::new(false),
                    import_capable: std::sync::atomic::AtomicBool::new(false),
                    delete_capable: std::sync::atomic::AtomicBool::new(false),
                    close_capable: std::sync::atomic::AtomicBool::new(false),
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
                        // Guard against double-panic: if we're already
                        // unwinding, catch_unwind prevents abort.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            if let Ok(mut sessions) = ACP_SESSIONS.write() {
                                sessions.remove(&self.key);
                            }
                            if let Some(ref cid) = self.chat_id {
                                use crate::radio::{publish as broadcast_radio_event, RadioEvent};
                                broadcast_radio_event(RadioEvent::ChatStatus {
                                    project_id: self.project_key.clone(),
                                    task_id: self.task_id.clone(),
                                    chat_id: cid.clone(),
                                    status: "disconnected".to_string(),
                                    permission: None,
                                    project_name: None,
                                    task_name: None,
                                    chat_title: None,
                                    agent: None,
                                    prompt: None,
                                    message: None,
                                    todo_completed: None,
                                    todo_total: None,
                                });
                                cleanup_socket_files(&self.project_key, &self.task_id, cid);
                            }
                        }));
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
                        use crate::radio::{publish as broadcast_radio_event, RadioEvent};
                        broadcast_radio_event(RadioEvent::ChatStatus {
                            project_id: config.project_key.clone(),
                            task_id: config.task_id.clone(),
                            chat_id: chat_id.clone(),
                            status: "connecting".to_string(),
                            permission: None,
                            project_name: None,
                            task_name: None,
                            chat_title: None,
                            agent: None,
                            prompt: None,
                            message: None,
                            todo_completed: None,
                            todo_total: None,
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
                if result_tx.send(Ok((handle.clone(), update_rx))).is_err() {
                    eprintln!("[ACP] result_tx send failed — caller dropped before session started (key={})", key_clone);
                }

                // 运行会话循环（阻塞直到 Kill 或错误）
                let session_project_key = config.project_key.clone();
                let session_task_id = config.task_id.clone();
                let session_chat_id = config.chat_id.clone();
                let session_agent_name = config.agent_name.clone();

                let session_result = run_acp_session(handle.clone(), config, cmd_rx).await;
                if let Err(e) = &session_result {
                    eprintln!(
                        "[ACP] session ended with error (key={} agent={} task={} chat={:?}): {}",
                        key_clone, session_agent_name, session_task_id, session_chat_id, e
                    );
                    let message = match e {
                        crate::error::GroveError::Session(message) => message.clone(),
                        other => other.to_string(),
                    };
                    handle.emit(AcpUpdate::Error { message });
                }
                handle.emit(AcpUpdate::SessionEnded);

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
                    use crate::radio::{publish as broadcast_radio_event, RadioEvent};
                    broadcast_radio_event(RadioEvent::ChatStatus {
                        project_id: session_project_key.clone(),
                        task_id: session_task_id.clone(),
                        chat_id: cid.clone(),
                        status: "disconnected".to_string(),
                        permission: None,
                        project_name: None,
                        task_name: None,
                        chat_title: None,
                        agent: None,
                        prompt: None,
                        message: None,
                        todo_completed: None,
                        todo_total: None,
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
    mut config: AcpStartConfig,
    cmd_rx: mpsc::Receiver<AcpCommand>,
) -> crate::error::Result<()> {
    // Cloned up front since `config` is moved into the `connect_with` closure
    // below; used only for the post-mortem exit-status log at the end.
    let agent_name_for_log = config.agent_name.clone();

    // 提前生成 agent_graph MCP token —— 在 spawn 子进程之前注册并塞进 env。
    // 这样 `grove mcp-bridge`（agent 自己孩子的孩子，比如 Trae 不接受 ACP 注入
    // 的 MCP 时由用户在 Trae mcp 配置里指向我们）只要从 env 读 GROVE_MCP_TOKEN
    // / GROVE_MCP_PORT 就能找到 listener，不依赖 ACP NewSessionRequest.
    let agent_graph_token: Option<String> = config.chat_id.as_ref().map(|chat_id| {
        let token = uuid::Uuid::new_v4().to_string();
        crate::api::handlers::agent_graph_mcp::register_token(&token, chat_id);
        token
    });
    if let Some(token) = agent_graph_token.as_deref() {
        config
            .env_vars
            .insert("GROVE_MCP_TOKEN".to_string(), token.to_string());
    }
    if let Some(port) = crate::api::handlers::agent_graph_mcp::listener_port() {
        config
            .env_vars
            .insert("GROVE_MCP_PORT".to_string(), port.to_string());
    }
    // RAII guard for the token — drops on any return path below, mirroring
    // the prior in-`drive_session` lifetime.
    struct EarlyTokenGuard(Option<String>);
    impl Drop for EarlyTokenGuard {
        fn drop(&mut self) {
            if let Some(t) = self.0.take() {
                let _ = crate::api::handlers::agent_graph_mcp::unregister_token(&t);
            }
        }
    }
    let _early_token_guard = EarlyTokenGuard(agent_graph_token.clone());

    // 根据 agent_type 分支获取 reader/writer（使用 trait object 统一类型）
    let mut child: Option<tokio::process::Child>;
    // ByteStreams 要求 Send + 'static;grove 的子进程 pipe 和 DuplexStream 都满足。
    let mut writer: Box<dyn futures::AsyncWrite + Send + Unpin>;
    let mut reader: Box<dyn futures::AsyncRead + Send + Unpin>;

    if config.agent_type == "remote" {
        // Remote: WebSocket 连接（通过 duplex 管道桥接为 AsyncRead/AsyncWrite）
        child = None;
        let (r, w) = connect_remote_agent(&config).await?;
        reader = Box::new(r);
        writer = Box::new(w);
    } else {
        // Pre-warm npm cache for npx-spawned agents. First-run npx fetches
        // can stall for ~30s; without this hint the user stares at
        // "Connecting..." not knowing if the app is dead. Run a dummy
        // `--version` invocation to populate the cache before the real
        // spawn. The "downloading" UI hint is only emitted if the pre-warm
        // is *still running* after 1.5s — hot-cache runs (which finish in
        // <2s) skip the emit entirely so users don't see a confusing flash.
        //
        // Heuristic: assumes built-in npx invocations always look like
        // `npx -y <pkg>`. Custom agents using more exotic forms (e.g.
        // `npx --package=X cli-name`) may pre-warm the wrong identifier;
        // since the result is timeout-wrapped and discarded, the worst case
        // is a no-op that adds a brief delay before the real spawn.
        if config.agent_command == "npx" {
            if let Some(pkg) = config
                .agent_args
                .iter()
                .find(|a| !a.starts_with('-'))
                .cloned()
            {
                let prewarm = tokio::process::Command::new("npx")
                    .args(["-y", &pkg, "--version"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .status();
                let prewarm_with_timeout =
                    tokio::time::timeout(std::time::Duration::from_secs(120), prewarm);
                tokio::pin!(prewarm_with_timeout);
                let mut emitted = false;
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(1500)) => {
                        handle.emit(AcpUpdate::ConnectPhase {
                            phase: "downloading".to_string(),
                        });
                        emitted = true;
                        let _ = (&mut prewarm_with_timeout).await;
                    }
                    _ = &mut prewarm_with_timeout => {
                        // Hot-cache fast path: pre-warm finished before the
                        // 1.5s threshold; never emit the "downloading" hint.
                    }
                }
                if emitted {
                    handle.emit(AcpUpdate::ConnectPhase {
                        phase: "ready".to_string(),
                    });
                }
            }
        }
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
            let log_path = config
                .artifact_dir
                .as_ref()
                .map(|dir| dir.join("agent.log"))
                .unwrap_or_else(|| {
                    agent_log_path(
                        &config.project_key,
                        &config.task_id,
                        config.chat_id.as_deref(),
                    )
                });
            tokio::task::spawn_local(drain_stderr_to_file(stderr, log_path));
        }

        writer = Box::new(proc.stdin.take().unwrap().compat_write());
        reader = Box::new(proc.stdout.take().unwrap().compat());
        child = Some(proc);
    }

    // ACP_DEBUG=1（仅 dev build）：把 stdio 上的所有 NDJSON 流量 tee 到
    // 每个 chat 的 agent.log（与 stderr 合用同一文件），方向用 `>>`(出) /
    // `<<`(入) 标记。release 永远不开。
    if acp_debug_enabled() {
        let log_path = config
            .artifact_dir
            .as_ref()
            .map(|dir| dir.join("agent.log"))
            .unwrap_or_else(|| {
                agent_log_path(
                    &config.project_key,
                    &config.task_id,
                    config.chat_id.as_deref(),
                )
            });
        if let Some(file) = open_acp_log(&log_path) {
            if let Ok(mut f) = file.lock() {
                use std::io::Write;
                let _ = writeln!(
                    f,
                    "[{}] -- ACP session start agent={} task={} chat={:?}",
                    chrono::Utc::now().to_rfc3339(),
                    config.agent_name,
                    config.task_id,
                    config.chat_id,
                );
            }
            writer = Box::new(LoggingAsyncWrite {
                inner: writer,
                tap: AcpLogTap::new(Arc::clone(&file), ">>"),
            });
            reader = Box::new(LoggingAsyncRead {
                inner: reader,
                tap: AcpLogTap::new(file, "<<"),
            });
        }
    }

    let adapter = adapter::resolve_adapter(&config.agent_name, &config.agent_command);

    let state = Arc::new(AcpClientState {
        handle: handle.clone(),
        configured_agent_name: config.agent_name.clone(),
        working_dir: config.working_dir.clone(),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        project_key: config.project_key.clone(),
        task_id: config.task_id.clone(),
        chat_id: config.chat_id.clone(),
        adapter,
        file_snapshots: Mutex::new(HashMap::new()),
        write_tool_paths: Mutex::new(HashMap::new()),
    });

    let transport = acp::ByteStreams::new(writer, reader);

    // 每个 handler 闭包通过 Arc::clone 捕获一份 state。SDK 要求 handler 的 F
    // 本身是 Send,所以 state 必须是 Send + Sync(AcpClientState 已满足)。
    let mut shutdown_rx = handle.shutdown_tx.subscribe();
    let connection = acp::Client
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
        .on_receive_notification(
            {
                let state = Arc::clone(&state);
                async move |notification: acp::CompleteElicitationNotification, _cx| {
                    handle_complete_elicitation(&state, notification)
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::RequestPermissionRequest, responder, cx| {
                    let state = Arc::clone(&state);
                    cx.spawn(async move {
                        let cancellation = responder.cancellation();
                        match handle_request_permission(&state, req, cancellation).await {
                            Ok(r) => responder.respond(r),
                            Err(e) => responder.respond_with_error(e),
                        }
                    })?;
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |request: acp::CreateElicitationRequest, responder, cx| {
                    let state = Arc::clone(&state);
                    cx.spawn(async move {
                        let cancellation = responder.cancellation();
                        match handle_create_elicitation(&state, request, cancellation).await {
                            Ok(response) => responder.respond(response),
                            Err(error) => responder.respond_with_error(error),
                        }
                    })?;
                    Ok(())
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
                async move |req: acp::WaitForTerminalExitRequest, responder, cx| {
                    let state = Arc::clone(&state);
                    cx.spawn(async move {
                        let cancellation = responder.cancellation();
                        match handle_wait_for_terminal_exit(&state, req, cancellation).await {
                            Ok(r) => responder.respond(r),
                            Err(e) => responder.respond_with_error(e),
                        }
                    })?;
                    Ok(())
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
        });
    tokio::pin!(connection);
    let result = tokio::select! {
        result = &mut connection => result,
        _ = shutdown_rx.wait_for(|requested| *requested) => Ok(()),
    };

    // Diagnostics: if the agent subprocess had already exited by the time
    // the ACP I/O loop ended, that's very likely *why* it ended (crash /
    // OOM-kill / unexpected quit) rather than a clean session close. Check
    // with try_wait (non-blocking — returns None if still running) before
    // `drop(child)` triggers kill_on_drop, which would otherwise mask this.
    if let Some(ref mut c) = child {
        match c.try_wait() {
            Ok(Some(status)) => {
                eprintln!(
                    "[ACP] agent process had already exited when session I/O ended: {} (agent={})",
                    status, agent_name_for_log
                );
            }
            Ok(None) => { /* still running — we're the ones tearing it down below */ }
            Err(e) => {
                eprintln!(
                    "[ACP] failed to check agent process status (agent={}): {}",
                    agent_name_for_log, e
                );
            }
        }
    }

    // kill_on_drop 会清理子进程
    drop(child);

    result.map_err(|e| crate::error::GroveError::Session(e.to_string()))
}

/// 在 `connect_with` 的 `main_fn` 里运行 ACP 会话生命周期:initialize → 创建/恢复
/// session → 命令循环。与 handler 不同,这里运行在一个独立的"spawned task"上下文,
/// 可以安全使用 `SentRequest::block_task()`。
fn validate_v1_protocol_version(version: acp::ProtocolVersion) -> acp::Result<()> {
    if version == acp::ProtocolVersion::V1 {
        return Ok(());
    }

    Err(acp::Error::new(
        -32099,
        format!(
            "Unable to connect to this agent. This agent uses ACP protocol version {}, but Grove currently supports version 1 only.",
            version.as_u16()
        ),
    ))
}

async fn drive_session(
    handle: Arc<AcpSessionHandle>,
    config: AcpStartConfig,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
    conn: acp::ConnectionTo<acp::Agent>,
) -> acp::Result<(), acp::Error> {
    /// Lowercase fuzzy-match a free-text query against `(id, name)` pairs.
    /// Used by the Custom Agent (persona) layer to translate the user's
    /// free-text `model` / `mode` / `effort` strings into the live session's
    /// real ids.
    ///
    /// Resolution order:
    ///   1. Exact lowercase id or name → return immediately (deterministic).
    ///   2. Substring match: collect all hits. If exactly one, return it.
    ///      If two or more (e.g. user typed "sonnet" and the agent advertises
    ///      both "claude-sonnet-4-5" and "claude-3-5-sonnet"), return `None`
    ///      — caller falls back to the agent's default rather than rolling
    ///      the dice on an order-sensitive pick. A warn is logged so the
    ///      ambiguity is debuggable from logs.
    fn fuzzy_pick_id(query: &str, options: &[(String, String)]) -> Option<String> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return None;
        }
        for (id, name) in options {
            if id.to_lowercase() == q || name.to_lowercase() == q {
                return Some(id.clone());
            }
        }
        let hits: Vec<&String> = options
            .iter()
            .filter(|(id, name)| id.to_lowercase().contains(&q) || name.to_lowercase().contains(&q))
            .map(|(id, _)| id)
            .collect();
        match hits.len() {
            0 => None,
            1 => Some(hits[0].clone()),
            _ => {
                eprintln!(
                    "[ACP] Persona config: query '{}' matched {} options ambiguously \
                     ({}); leaving agent default.",
                    query,
                    hits.len(),
                    hits.iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                None
            }
        }
    }

    fn extract_models(
        config_options: &[acp::SessionConfigOption],
    ) -> (Vec<(String, String)>, Option<String>, Option<String>) {
        extract_config_select(
            config_options,
            acp::SessionConfigOptionCategory::Model,
            &["model"],
        )
    }

    // Grove 内部错误 → acp::Error
    fn to_acp_err(e: impl std::fmt::Display) -> acp::Error {
        acp::Error::internal_error().data(format!("{}", e))
    }

    fn is_auth_required_error(e: &acp::Error) -> bool {
        i32::from(e.code) == -32000
    }

    // The agent_graph MCP token is generated and registered in `run_acp_session`
    // BEFORE the agent subprocess is spawned, so that the token is present in
    // the agent's environment (`GROVE_MCP_TOKEN`) — needed by `grove mcp-bridge`
    // children. We just read it back from env_vars here. The lifetime/cleanup
    // of the registration is owned by `run_acp_session`'s EarlyTokenGuard.
    // Only Task/Chat sessions receive `grove_agent`. Automation consumers may
    // reuse GROVE_MCP_TOKEN for their own loopback bridge, but have no Chat
    // identity and must not accidentally expose the Task-scoped server.
    let agent_graph_token: Option<&str> = config
        .chat_id
        .as_ref()
        .and_then(|_| config.env_vars.get("GROVE_MCP_TOKEN"))
        .map(String::as_str);

    // 初始化连接
    let init_resp = conn
        .send_request(
            acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                .client_capabilities(grove_client_capabilities())
                .client_info(
                    acp::Implementation::new("grove", env!("CARGO_PKG_VERSION")).title("Grove"),
                ),
        )
        .block_task()
        .await?;

    validate_v1_protocol_version(init_resp.protocol_version)?;

    // 缓存 agent 声明的登录方法 — 后续收到 -32000 AuthRequired 时取第一个走
    // authenticate。`unstable_auth_methods` feature 未启用,所以这里只会拿到
    // `AuthMethod::Agent` 变体(EnvVar / Terminal 在反序列化阶段已被过滤)。
    {
        let methods: Vec<AuthMethodInfo> = init_resp
            .auth_methods
            .iter()
            .map(|m| AuthMethodInfo {
                id: m.id().to_string(),
                name: m.name().to_string(),
                description: m.description().map(|s| s.to_string()),
            })
            .collect();
        if let Ok(mut slot) = handle.auth_methods.lock() {
            *slot = methods;
        }
    }

    let logout_capable = init_resp.agent_capabilities.auth.logout.is_some();
    handle
        .logout_capable
        .store(logout_capable, std::sync::atomic::Ordering::Relaxed);

    let mut agent_name = init_resp
        .agent_info
        .as_ref()
        .map(|i| i.name.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let agent_version = init_resp
        .agent_info
        .as_ref()
        .map(|i| i.version.clone())
        .unwrap_or_else(|| "0.0.0".to_string());

    if agent_name == "unknown" {
        agent_name = config.agent_command.clone();
    }

    // Trae 目前已在新版中正确声明支持 load_session，此处可直接使用其实际能力声明
    let supports_load = init_resp.agent_capabilities.load_session;

    // Resume 能力:agent 在 capabilities 里
    // 声明 resume=Some(_) 表示支持。与 load_session 的本质区别 — resume **不 replay
    // 历史消息**(load 会把全部历史通过 session/update 回放回来)。Grove 的历史本就
    // 自己从磁盘加载,所以 resume 路线天然不需要 suppress_emit + 300ms 那套抛弃 hack。
    let supports_resume = init_resp
        .agent_capabilities
        .session_capabilities
        .resume
        .is_some();
    let additional_directories_capable = init_resp
        .agent_capabilities
        .session_capabilities
        .additional_directories
        .is_some();
    let additional_directories = if additional_directories_capable {
        resolve_linked_project_paths(&config.project_key, &config.task_id).map_err(to_acp_err)?
    } else {
        Vec::new()
    };
    let supports_mcp_http = init_resp.agent_capabilities.mcp_capabilities.http;

    // Fork 能力(`unstable_session_fork`):agent 在 capabilities 里声明 fork=Some(_)
    // 表示支持 `session/fork`。同时 grove 的 fork 实现依赖 load_session — 派生
    // 出的新 chat 用户首次打开时走的是 fresh process + load_session(forked_id),
    // 没有 load_session 就复活不了。两者必须同时具备,Fork 按钮才显示。
    let fork_capable = init_resp
        .agent_capabilities
        .session_capabilities
        .fork
        .is_some()
        && supports_load;
    handle
        .fork_capable
        .store(fork_capable, std::sync::atomic::Ordering::Relaxed);
    let import_capable = init_resp
        .agent_capabilities
        .session_capabilities
        .list
        .is_some()
        && supports_load;
    handle
        .import_capable
        .store(import_capable, std::sync::atomic::Ordering::Relaxed);

    // Agent 声明 session.delete 后才允许发送 session/delete。
    let delete_capable = init_resp
        .agent_capabilities
        .session_capabilities
        .delete
        .is_some();
    handle
        .delete_capable
        .store(delete_capable, std::sync::atomic::Ordering::Relaxed);

    // Close 能力(`session/close`,已 stabilized 无需 feature):agent 声明
    // session.close 即可。tear down 前发 close 让 agent 优雅 cancel + 释放资源。
    let close_capable = init_resp
        .agent_capabilities
        .session_capabilities
        .close
        .is_some();
    handle
        .close_capable
        .store(close_capable, std::sync::atomic::Ordering::Relaxed);

    // 查找保存的 session_id(从 chat session 读取)
    let saved_id = config.chat_id.as_ref().and_then(|cid| {
        crate::storage::tasks::get_chat_session(&config.project_key, &config.task_id, cid)
            .ok()
            .flatten()
            .and_then(|c| c.acp_session_id)
    });
    // Capture the last confirmed runtime settings before SessionReady replaces
    // session.json with the Agent's startup defaults. This snapshot is used
    // below to restore settings after an app/process restart.
    let persisted_session_metadata = config
        .chat_id
        .as_ref()
        .and_then(|cid| read_session_metadata(&config.project_key, &config.task_id, cid));
    let should_restore_persisted_settings = saved_id.is_some();

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

    let mut available_modes;
    let mut mode_descriptions;
    let mut current_mode_id;
    let mut available_models;
    let mut current_model_id;
    let mut model_config_id;
    let mut available_thought_levels;
    let mut current_thought_level_id;
    let mut thought_level_config_id;
    let mut config_options;
    let mut uses_config_options;
    let mut pending_session_bootstrap: Option<(&'static str, String)> = None;

    /// Pause a pre-session request after `auth_required`, drive the advertised
    /// Agent authentication flow, then return so the caller can retry the exact
    /// request that failed. This is shared by new/resume/load.
    macro_rules! await_authentication {
        () => {{
            let methods = handle
                .auth_methods
                .lock()
                .map(|methods| methods.clone())
                .unwrap_or_default();
            if let Ok(mut slot) = handle.pending_auth.lock() {
                *slot = Some(PendingAuthState {
                    methods: methods.clone(),
                    agent_name: Some(agent_name.clone()),
                });
            }
            handle.emit(AcpUpdate::AuthRequired {
                methods: methods.clone(),
                agent_name: Some(agent_name.clone()),
            });

            let mut next_method_id: Option<String> = None;
            'auth_wait: loop {
                let method_id = if let Some(method_id) = next_method_id.take() {
                    method_id
                } else {
                    loop {
                        match cmd_rx.recv().await {
                            None => {
                                if let Ok(mut slot) = handle.pending_auth.lock() {
                                    *slot = None;
                                }
                                return Err(acp::Error::internal_error());
                            }
                            Some(AcpCommand::Authenticate { method_id }) => break method_id,
                            Some(AcpCommand::RetryAuthentication) if methods.is_empty() => {
                                // The user completed login outside ACP. Treat this
                                // as a request to retry, not proof of authentication;
                                // another auth_required response will reopen the panel.
                                handle.emit(AcpUpdate::AuthSucceeded);
                                break 'auth_wait;
                            }
                            Some(AcpCommand::Kill) => {
                                if let Ok(mut slot) = handle.pending_auth.lock() {
                                    *slot = None;
                                }
                                return Ok(());
                            }
                            Some(AcpCommand::Logout { reply }) => {
                                let _ = reply
                                    .send(Err("Cannot log out while authentication is required"
                                        .to_string()));
                            }
                            Some(AcpCommand::Prompt {
                                message_ids,
                                text,
                                attachments,
                                sender,
                                terminal,
                                config,
                            }) => {
                                let mut queued = QueuedMessage::new(
                                        text,
                                        attachments,
                                        sender,
                                        terminal,
                                        config,
                                    );
                                queued.message_ids = message_ids;
                                handle.pending_queue.lock().unwrap().push(queued);
                                handle.emit(AcpUpdate::QueueUpdate {
                                    messages: handle.get_queue(),
                                });
                            }
                            Some(AcpCommand::ForkSession { reply, .. }) => {
                                let _ = reply.send(Err(
                                    "Cannot fork while authentication is required".to_string(),
                                ));
                            }
                            Some(AcpCommand::DeleteSession { reply }) => {
                                let _ = reply.send(Err(
                                    "Cannot delete the Agent session while authentication is required"
                                        .to_string(),
                                ));
                            }
                            Some(AcpCommand::SetMode { reply, .. }
                            | AcpCommand::SetConfigOption { reply, .. }) => {
                                let _ = reply.send(Err(
                                    "Session settings are unavailable while authentication is required"
                                        .to_string(),
                                ));
                            }
                            Some(AcpCommand::Cancel | AcpCommand::RetryAuthentication) => {}
                            Some(AcpCommand::ListSessions { reply, .. }) => {
                                let _ = reply.send(Err("session/list unavailable during authentication".into()));
                            }
                        }
                    }
                };

                let auth_fut = conn
                    .send_request(acp::AuthenticateRequest::new(acp::AuthMethodId::new(
                        method_id,
                    )))
                    .block_task();
                tokio::pin!(auth_fut);
                loop {
                    tokio::select! {
                        res = &mut auth_fut => {
                            match res {
                                Ok(_) => {
                                    handle.emit(AcpUpdate::AuthSucceeded);
                                    break 'auth_wait;
                                }
                                Err(auth_err) => {
                                    handle.emit(AcpUpdate::AuthFailed {
                                        message: format!("Authentication failed: {}", auth_err),
                                    });
                                    continue 'auth_wait;
                                }
                            }
                        }
                        cmd = cmd_rx.recv() => match cmd {
                            None => {
                                if let Ok(mut slot) = handle.pending_auth.lock() {
                                    *slot = None;
                                }
                                return Err(acp::Error::internal_error());
                            }
                            Some(AcpCommand::Authenticate { method_id }) => {
                                // A second choice supersedes an in-flight flow.
                                next_method_id = Some(method_id);
                                continue 'auth_wait;
                            }
                            Some(AcpCommand::Kill) => {
                                if let Ok(mut slot) = handle.pending_auth.lock() {
                                    *slot = None;
                                }
                                return Ok(());
                            }
                            Some(AcpCommand::Logout { reply }) => {
                                let _ = reply.send(Err(
                                    "Cannot log out while authentication is in progress"
                                        .to_string(),
                                ));
                            }
                            Some(AcpCommand::Prompt {
                                message_ids,
                                text,
                                attachments,
                                sender,
                                terminal,
                                config,
                            }) => {
                                let mut queued = QueuedMessage::new(
                                        text,
                                        attachments,
                                        sender,
                                        terminal,
                                        config,
                                    );
                                queued.message_ids = message_ids;
                                handle.pending_queue.lock().unwrap().push(queued);
                                handle.emit(AcpUpdate::QueueUpdate {
                                    messages: handle.get_queue(),
                                });
                            }
                            Some(AcpCommand::ForkSession { reply, .. }) => {
                                let _ = reply.send(Err(
                                    "Cannot fork while authentication is in progress".to_string(),
                                ));
                            }
                            Some(AcpCommand::DeleteSession { reply }) => {
                                let _ = reply.send(Err(
                                    "Cannot delete the Agent session while authentication is in progress"
                                        .to_string(),
                                ));
                            }
                            Some(AcpCommand::SetMode { reply, .. }
                            | AcpCommand::SetConfigOption { reply, .. }) => {
                                let _ = reply.send(Err(
                                    "Session settings are unavailable while authentication is in progress"
                                        .to_string(),
                                ));
                            }
                            Some(AcpCommand::Cancel | AcpCommand::RetryAuthentication) => {}
                            Some(AcpCommand::ListSessions { reply, .. }) => {
                                let _ = reply.send(Err("session/list unavailable during authentication".into()));
                            }
                        }
                    }
                }
            }
        }};
    }

    macro_rules! create_new_session {
        ($preserve_history:expr) => {{
            // 仅在"明确从零起步"时才清 history.jsonl。Resume / Fork 场景下
            // load_session 失败 fall-through 到 fresh session 时,磁盘上的
            // 历史是用户的对话记录,agent 忘了不代表用户也得忘 — 保留。
            if !$preserve_history {
                if let Some(ref cid) = config.chat_id {
                    crate::storage::chat_history::clear_history(
                        &config.project_key,
                        &config.task_id,
                        cid,
                    );
                }
                if let Some(ref artifact_dir) = config.artifact_dir {
                    let _ = std::fs::remove_file(artifact_dir.join("history.jsonl"));
                }
            }
            let mcp_servers =
                build_mcp_servers(
                    &config.env_vars,
                    agent_graph_token,
                    supports_mcp_http,
                    &config.additional_mcp_servers,
                    config.mcp_server_policy,
                )
                .map_err(to_acp_err)?;
            // 重试循环:session/new 在用户没登录时(claude-code-acp / codex 都
            // 这样)会直接抛 -32000 AuthRequired。捕获后 emit AuthRequired banner,
            // 等用户在 chat 里点 Login → 收到 Authenticate cmd → 调 authenticate →
            // 成功后回到 loop 顶端再试一次 session/new。这一段没有进 cmd 主循环,
            // 登录期间到达的 prompt 会进入可见队列，其他 session action 会得到
            // 明确回复，避免共享 command channel 中的命令被静默丢弃。
            let resp = loop {
                match conn
                    .send_request(
                        acp::NewSessionRequest::new(&config.working_dir)
                            .additional_directories(additional_directories.clone())
                            .mcp_servers(mcp_servers.clone()),
                    )
                    .block_task()
                    .await
                {
                    Ok(r) => break r,
                    Err(e) if is_auth_required_error(&e) => {
                        await_authentication!();
                    }
                    Err(e) => return Err(e),
                }
            };
            // session/new 成功 → 清掉 pending_auth,后续 SessionReady 走正常路径
            if let Ok(mut slot) = handle.pending_auth.lock() {
                *slot = None;
            }
            let sid = resp.session_id.to_string();
            persist_session_id(&sid);
            uses_config_options = resp.config_options.is_some();
            config_options = resp.config_options.clone().unwrap_or_default();
            let extracted_modes =
                extract_modes(&resp.modes, &config_options, uses_config_options);
            available_modes = extracted_modes.0;
            current_mode_id = extracted_modes.1;
            let mut persona_mode_config_id = extracted_modes.2;
            mode_descriptions = extracted_modes.3;
            (available_models, current_model_id, model_config_id) =
                extract_models(&config_options);
            (
                available_thought_levels,
                current_thought_level_id,
                thought_level_config_id,
            ) = extract_thought_level(&config_options);

            macro_rules! accept_config_response {
                ($response:expr) => {{
                    config_options = $response.config_options;
                    uses_config_options = true;
                    let extracted_modes = extract_modes(&resp.modes, &config_options, true);
                    available_modes = extracted_modes.0;
                    current_mode_id = extracted_modes.1;
                    mode_descriptions = extracted_modes.3;
                    (available_models, current_model_id, model_config_id) =
                        extract_models(&config_options);
                    (
                        available_thought_levels,
                        current_thought_level_id,
                        thought_level_config_id,
                    ) = extract_thought_level(&config_options);
                }};
            }

            // Custom Agent (persona): apply preferred model/mode/effort before
            // the first real user request. The Persona prompt itself is
            // concatenated with Grove's session instructions below, avoiding a
            // separate acknowledgement turn. Resume skips both paths.
            if let Some(p) = config.persona_injection.as_ref() {
                let sid_arc = acp::SessionId::new(&*sid);

                let uses_capability_config = match &p.agent_config {
                    crate::agent_config::AgentConfigSelection::ConfigOptions { values, .. } => {
                        // Apply exact option ids and values selected from the persisted
                        // capability snapshot. Best-effort keeps a stale snapshot from
                        // blocking Persona startup when an Agent changes capabilities.
                        for option in config_options.clone() {
                            let config_id = option.id.to_string();
                            let Some(value) = values.get(&config_id).cloned() else {
                                continue;
                            };
                            let Ok(request_value) =
                                config_request_value(&config_options, &config_id, value)
                            else {
                                continue;
                            };
                            if let Ok(response) = conn
                                .send_request(acp::SetSessionConfigOptionRequest::new(
                                    sid_arc.clone(),
                                    acp::SessionConfigId::new(config_id),
                                    request_value,
                                ))
                                .block_task()
                                .await
                            {
                                accept_config_response!(response);
                                persona_mode_config_id = extract_config_select(
                                    &config_options,
                                    acp::SessionConfigOptionCategory::Mode,
                                    &["mode"],
                                )
                                .2;
                            }
                        }
                        true
                    }
                    crate::agent_config::AgentConfigSelection::Modes { mode_id, .. } => {
                        if let Some(config_id) = persona_mode_config_id.clone() {
                            if let Ok(response) = conn
                                .send_request(acp::SetSessionConfigOptionRequest::new(
                                    sid_arc.clone(),
                                    acp::SessionConfigId::new(config_id),
                                    acp::SessionConfigValueId::new(mode_id.clone()),
                                ))
                                .block_task()
                                .await
                            {
                                accept_config_response!(response);
                            }
                        } else if conn
                            .send_request(acp::SetSessionModeRequest::new(
                                sid_arc.clone(),
                                acp::SessionModeId::new(mode_id.clone()),
                            ))
                            .block_task()
                            .await
                            .is_ok()
                        {
                            current_mode_id = Some(mode_id.clone());
                        }
                        true
                    }
                    crate::agent_config::AgentConfigSelection::Default { .. } => false,
                };

                // Fuzzy match by lowercase id-or-name: exact first, then
                // substring. This is only the compatibility path for personas
                // created before structured Agent configuration was available.
                if !uses_capability_config {
                if let Some(query) = p.model.as_deref() {
                    if let (Some(id), Some(config_id)) = (
                        fuzzy_pick_id(query, &available_models),
                        model_config_id.as_ref(),
                    ) {
                        if let Ok(response) = conn
                            .send_request(acp::SetSessionConfigOptionRequest::new(
                                sid_arc.clone(),
                                acp::SessionConfigId::new(config_id.clone()),
                                acp::SessionConfigValueId::new(id),
                            ))
                            .block_task()
                            .await
                        {
                            accept_config_response!(response);
                            persona_mode_config_id = extract_config_select(
                                &config_options,
                                acp::SessionConfigOptionCategory::Mode,
                                &["mode"],
                            )
                            .2;
                        }
                    }
                }
                if let Some(query) = p.mode.as_deref() {
                    if let Some(id) = fuzzy_pick_id(query, &available_modes) {
                        if let Some(config_id) = persona_mode_config_id.clone() {
                            if let Ok(response) = conn
                                .send_request(acp::SetSessionConfigOptionRequest::new(
                                    sid_arc.clone(),
                                    acp::SessionConfigId::new(config_id),
                                    acp::SessionConfigValueId::new(id),
                                ))
                                .block_task()
                                .await
                            {
                                accept_config_response!(response);
                            }
                        } else if conn
                            .send_request(acp::SetSessionModeRequest::new(
                                sid_arc.clone(),
                                acp::SessionModeId::new(id.clone()),
                            ))
                            .block_task()
                            .await
                            .is_ok()
                        {
                            current_mode_id = Some(id);
                        }
                    }
                }
                if let Some(query) = p.effort.as_deref() {
                    if let (Some(value_id), Some(cfg_id)) = (
                        fuzzy_pick_id(query, &available_thought_levels),
                        thought_level_config_id.clone(),
                    ) {
                        if let Ok(response) = conn
                            .send_request(acp::SetSessionConfigOptionRequest::new(
                                sid_arc.clone(),
                                acp::SessionConfigId::new(cfg_id),
                                acp::SessionConfigValueId::new(value_id),
                            ))
                            .block_task()
                            .await
                        {
                            accept_config_response!(response);
                        }
                    }
                }
                }
            }
            let agent_runtime_available = agent_graph_token
                .and_then(crate::api::handlers::agent_graph_mcp::build_mcp_url)
                .is_some();
            pending_session_bootstrap =
                session_bootstrap_instruction(&config, agent_runtime_available);
            sid
        }};
    }

    let session_id = match (
        saved_id,
        supports_resume,
        supports_load,
        config.import_session,
    ) {
        // Import is the only path that intentionally exposes session/load replay.
        // It is selected by an ephemeral flag on this WebSocket connection only.
        (Some(saved_id), _, true, true) => {
            let mcp_servers = build_mcp_servers(
                &config.env_vars,
                agent_graph_token,
                supports_mcp_http,
                &config.additional_mcp_servers,
                config.mcp_server_policy,
            )
            .map_err(to_acp_err)?;
            let resp = conn
                .send_request(
                    acp::LoadSessionRequest::new(
                        acp::SessionId::new(&*saved_id),
                        &config.working_dir,
                    )
                    .additional_directories(Vec::<PathBuf>::new())
                    .mcp_servers(mcp_servers),
                )
                .block_task()
                .await
                .map_err(|error| {
                    acp::Error::internal_error().data(format!("Import session failed: {error}"))
                })?;
            uses_config_options = resp.config_options.is_some();
            config_options = resp.config_options.clone().unwrap_or_default();
            (available_modes, current_mode_id, _, mode_descriptions) =
                extract_modes(&resp.modes, &config_options, uses_config_options);
            (available_models, current_model_id, model_config_id) = extract_models(&config_options);
            (
                available_thought_levels,
                current_thought_level_id,
                thought_level_config_id,
            ) = extract_thought_level(&config_options);
            saved_id
        }
        // Prefer resume because it does not replay history. Some agents expose
        // both lifecycle methods but only keep resumable resources in memory;
        // after an agent restart, resume can return Resource not found while
        // session/load can still restore the persisted session. Fall back to
        // load in that case, suppressing its replay because Grove's local
        // history remains the display source of truth.
        (Some(saved_id), true, supports_load, false) => {
            let mcp_servers = build_mcp_servers(
                &config.env_vars,
                agent_graph_token,
                supports_mcp_http,
                &config.additional_mcp_servers,
                config.mcp_server_policy,
            )
            .map_err(to_acp_err)?;
            let mut resume_failure = None;
            let resume_response = loop {
                match conn
                    .send_request(
                        acp::ResumeSessionRequest::new(
                            acp::SessionId::new(&*saved_id),
                            &config.working_dir,
                        )
                        .additional_directories(additional_directories.clone())
                        .mcp_servers(mcp_servers.clone()),
                    )
                    .block_task()
                    .await
                {
                    Ok(resp) => break Some(resp),
                    Err(error) if is_auth_required_error(&error) => {
                        await_authentication!();
                    }
                    Err(error) => {
                        resume_failure = Some(error);
                        break None;
                    }
                }
            };
            if let Ok(mut slot) = handle.pending_auth.lock() {
                *slot = None;
            }
            if let Some(resp) = resume_response {
                uses_config_options = resp.config_options.is_some();
                config_options = resp.config_options.clone().unwrap_or_default();
                (available_modes, current_mode_id, _, mode_descriptions) =
                    extract_modes(&resp.modes, &config_options, uses_config_options);
                (available_models, current_model_id, model_config_id) =
                    extract_models(&config_options);
                (
                    available_thought_levels,
                    current_thought_level_id,
                    thought_level_config_id,
                ) = extract_thought_level(&config_options);
            } else if supports_load {
                handle
                    .suppress_emit
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                let load_response = loop {
                    match conn
                        .send_request(
                            acp::LoadSessionRequest::new(
                                acp::SessionId::new(&*saved_id),
                                &config.working_dir,
                            )
                            .additional_directories(additional_directories.clone())
                            .mcp_servers(mcp_servers.clone()),
                        )
                        .block_task()
                        .await
                    {
                        Ok(resp) => break resp,
                        Err(error) if is_auth_required_error(&error) => {
                            await_authentication!();
                        }
                        Err(load_error) => {
                            return Err(acp::Error::internal_error().data(format!(
                                "Resume session failed: {}; load fallback failed: {}",
                                resume_failure.expect("missing resume failure"),
                                load_error
                            )));
                        }
                    }
                };
                if let Ok(mut slot) = handle.pending_auth.lock() {
                    *slot = None;
                }
                uses_config_options = load_response.config_options.is_some();
                config_options = load_response.config_options.clone().unwrap_or_default();
                (available_modes, current_mode_id, _, mode_descriptions) =
                    extract_modes(&load_response.modes, &config_options, uses_config_options);
                (available_models, current_model_id, model_config_id) =
                    extract_models(&config_options);
                (
                    available_thought_levels,
                    current_thought_level_id,
                    thought_level_config_id,
                ) = extract_thought_level(&config_options);
            } else {
                return Err(acp::Error::internal_error().data(format!(
                    "Resume session failed: {}",
                    resume_failure.expect("missing resume failure")
                )));
            }
            saved_id
        }
        // Load 路线:agent 不支持 resume 但支持 load_session。agent 会 replay 历史
        // (Grove 统一从磁盘回放),所以抑制其回放 emit。关键:很多 agent 的
        // replay 在 LoadSessionResponse **之后**才异步流式发出,固定时间窗口抓不住
        // → suppress 保持 true,直到 cmd loop 收到首个用户 prompt 才解除(见 Prompt
        // arm)。恢复 session 后、用户发新消息前,agent 主动 emit 的只可能是 replay。
        (Some(saved_id), false, true, false) => {
            handle
                .suppress_emit
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let mcp_servers = build_mcp_servers(
                &config.env_vars,
                agent_graph_token,
                supports_mcp_http,
                &config.additional_mcp_servers,
                config.mcp_server_policy,
            )
            .map_err(to_acp_err)?;
            let resp = loop {
                match conn
                    .send_request(
                        acp::LoadSessionRequest::new(
                            acp::SessionId::new(&*saved_id),
                            &config.working_dir,
                        )
                        .additional_directories(additional_directories.clone())
                        .mcp_servers(mcp_servers.clone()),
                    )
                    .block_task()
                    .await
                {
                    Ok(resp) => break resp,
                    Err(error) if is_auth_required_error(&error) => {
                        await_authentication!();
                    }
                    Err(error) => {
                        return Err(acp::Error::internal_error()
                            .data(format!("Load session failed: {}", error)));
                    }
                }
            };
            if let Ok(mut slot) = handle.pending_auth.lock() {
                *slot = None;
            }
            uses_config_options = resp.config_options.is_some();
            config_options = resp.config_options.clone().unwrap_or_default();
            (available_modes, current_mode_id, _, mode_descriptions) =
                extract_modes(&resp.modes, &config_options, uses_config_options);
            (available_models, current_model_id, model_config_id) = extract_models(&config_options);
            (
                available_thought_levels,
                current_thought_level_id,
                thought_level_config_id,
            ) = extract_thought_level(&config_options);
            saved_id
        }
        // Existing Grove history remains the source of truth even when the
        // Agent cannot restore its own session. Start a fresh Agent session,
        // but never erase the user's locally persisted conversation.
        (Some(_), _, false, true) => {
            return Err(acp::Error::internal_error()
                .data("Agent does not support session/load required for import"));
        }
        (Some(_), false, false, false) => create_new_session!(true),
        // A genuinely new chat starts from an empty local history.
        (None, _, _, true) => {
            return Err(acp::Error::internal_error().data("Imported session id is missing"));
        }
        (None, _, _, false) => create_new_session!(false),
    };

    let session_id_arc = acp::SessionId::new(&*session_id);

    // A restarted Agent may successfully resume/load the conversation while
    // still returning default config values. Re-apply the last values Grove
    // confirmed in session.json before publishing SessionReady, so the UI and
    // the actual Agent runtime cannot diverge. Removed or invalid options are
    // deliberately skipped; the new Agent snapshot remains the capability
    // authority.
    if should_restore_persisted_settings {
        if let Some(persisted) = persisted_session_metadata.as_ref() {
            if uses_config_options {
                let restore = config_options_to_restore(&persisted.config_options, &config_options);
                for (config_id, value) in restore {
                    let request_value = match config_request_value(
                        &config_options,
                        &config_id,
                        value,
                    ) {
                        Ok(value) => value,
                        Err(error) => {
                            handle.emit(AcpUpdate::ConfigOptionError {
                                config_id: config_id.clone(),
                                message: format!(
                                    "Could not restore saved session setting '{config_id}'; using the Agent's current value. {error}"
                                ),
                            });
                            continue;
                        }
                    };
                    let result = conn
                        .send_request(acp::SetSessionConfigOptionRequest::new(
                            session_id_arc.clone(),
                            acp::SessionConfigId::new(config_id.clone()),
                            request_value,
                        ))
                        .block_task()
                        .await;
                    match result {
                    Ok(response) => {
                        config_options = response.config_options;
                        (available_modes, current_mode_id, _, mode_descriptions) =
                            extract_modes(&None, &config_options, true);
                        (available_models, current_model_id, model_config_id) =
                            extract_models(&config_options);
                        (
                            available_thought_levels,
                            current_thought_level_id,
                            thought_level_config_id,
                        ) = extract_thought_level(&config_options);
                    }
                    Err(error) => handle.emit(AcpUpdate::ConfigOptionError {
                        config_id: config_id.clone(),
                        message: format!(
                            "Could not restore saved session setting '{config_id}'; using the Agent's current value. {error}"
                        ),
                    }),
                    }
                }
            } else if let Some(saved_mode) = legacy_mode_to_restore(
                persisted.current_mode_id.as_deref(),
                current_mode_id.as_deref(),
                &available_modes,
            ) {
                let result = conn
                    .send_request(acp::SetSessionModeRequest::new(
                        session_id_arc.clone(),
                        acp::SessionModeId::new(saved_mode.clone()),
                    ))
                    .block_task()
                    .await;
                match result {
                    Ok(_) => current_mode_id = Some(saved_mode.clone()),
                    Err(error) => handle.emit(AcpUpdate::ConfigOptionError {
                        config_id: "__legacy_mode".to_string(),
                        message: format!(
                            "Could not restore saved session mode '{saved_mode}'; using the Agent's current mode. {error}"
                        ),
                    }),
                }
            }
        }
    }

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
    *handle.current_model_id.lock().unwrap() = current_model_id.clone();
    *handle.current_thought_level_id.lock().unwrap() = current_thought_level_id.clone();
    *handle.thought_level_config_id.lock().unwrap() = thought_level_config_id.clone();
    *handle.model_config_id.lock().unwrap() = model_config_id.clone();
    *handle.current_config_options.lock().unwrap() = config_options.clone();
    handle
        .uses_config_options
        .store(uses_config_options, std::sync::atomic::Ordering::Relaxed);

    if let Some(ref chat_id) = handle.chat_id {
        if let Some(existing) = read_session_metadata(&handle.project_key, &handle.task_id, chat_id)
        {
            if let Some(usage) = existing.current_usage {
                *handle.current_usage.lock().unwrap() = Some(usage);
            }
        }
    }

    let installed = crate::storage::installed_agents::get(&config.agent_name)
        .ok()
        .flatten();
    let selected = installed
        .as_ref()
        .and_then(|agent| agent.selected_installation());
    let capability_snapshot = serde_json::json!({
        "agent_id": crate::storage::installed_agents::canonicalize_agent_id(&config.agent_name),
        "agent_version": agent_version,
        "install_method": installed.as_ref().map(|agent| agent.selected_install_method.as_str()),
        "install_version": selected.map(|installation| installation.version.as_str()),
        "config_options": config_options,
        "uses_config_options": uses_config_options,
        "modes": {
            "available": available_modes,
            "current": current_mode_id,
        }
    });
    let _ = crate::storage::installed_agents::save_capability_snapshot(
        &config.agent_name,
        &capability_snapshot,
    );

    handle.emit(AcpUpdate::SessionReady {
        session_id,
        agent_name: agent_name.clone(),
        agent_version,
        available_modes,
        mode_descriptions,
        current_mode_id,
        available_models,
        current_model_id,
        available_thought_levels,
        current_thought_level_id,
        thought_level_config_id,
        config_options,
        uses_config_options,
        prompt_capabilities: prompt_capabilities.clone(),
        fork_capable,
        import_capable,
        delete_capable,
        auth_methods: handle
            .auth_methods
            .lock()
            .map(|methods| methods.clone())
            .unwrap_or_default(),
        logout_capable,
    });

    // 处理命令循环
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::Prompt {
                message_ids,
                text,
                attachments,
                sender,
                terminal,
                config: prompt_config,
            } => {
                handle
                    .cancel_requested
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                handle.active_tool_calls.lock().unwrap().clear();
                handle.short_tool_watches.lock().unwrap().clear();
                // Import replay is complete once the user starts a new turn.
                // From here on UserMessageChunk is a normal Agent echo and
                // must be ignored to avoid duplicating Grove's own message.
                handle
                    .replay_user_messages
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                // load 路线:首个用户 prompt 到来即解除 replay 抑制。此前 agent 的
                // 主动 emit 都是 load replay(Grove 已从磁盘显示历史),从这条新消息
                // 起恢复正常。必须在下面第一个 emit(UserMessage) 之前。幂等:
                // resume/fresh 路线本就 suppress=false,store false 无副作用。
                handle
                    .suppress_emit
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                if let Err(message) = validate_prompt_content(&prompt_capabilities, &attachments) {
                    handle.emit(AcpUpdate::PromptFailed {
                        message_ids,
                        message: message.clone(),
                    });
                    handle.emit(AcpUpdate::Error { message });
                    continue;
                }
                // 提前快照,便于 -32000 AuthRequired 时把这条 prompt 暂存起来
                // 等 authenticate 成功后自动重试。sender/attachments 后续会被
                // 移动进 emit / content_blocks,所以必须 clone。
                let retry_snapshot = (
                    message_ids.clone(),
                    text.clone(),
                    attachments.clone(),
                    sender.clone(),
                    terminal,
                    prompt_config.clone(),
                );

                // ── Pre-prompt config application ───────────────────────────
                // Reconcile and apply settings via ACP requests BEFORE emitting
                // Busy=true / UserMessage. Generic configOptions are explicit
                // overrides: stale/invalid values are skipped in favor of the
                // live Agent defaults. Legacy mode/model/thought fields retain
                // their strict failure behavior for old persisted sessions.
                //
                // Failure reporting: applies are sequential (mode → model →
                // thought_level). When request N fails, requests 1..N-1 may
                // have already taken effect on the agent. We don't roll back —
                // ACP has no rollback semantics, and a "best-effort revert"
                // could fail too. Instead the Error message enumerates what
                // landed vs what didn't, so the user/AI can see the real
                // session state and decide whether to retry, manually correct,
                // or proceed.
                if let Some(ref cfg) = prompt_config {
                    let mut applied: Vec<String> = Vec::new();
                    let mut failure: Option<(String, String)> = None;

                    if !cfg.config_options.is_empty() {
                        let advertised = handle
                            .current_config_options
                            .lock()
                            .map(|options| options.clone())
                            .unwrap_or_default();
                        let advertised_ids = advertised
                            .iter()
                            .map(|option| option.id.to_string())
                            .collect::<std::collections::HashSet<_>>();
                        for missing in cfg
                            .config_options
                            .keys()
                            .filter(|id| !advertised_ids.contains(*id))
                        {
                            handle.emit(AcpUpdate::ConfigOptionError {
                                config_id: missing.clone(),
                                message: format!(
                                    "Skipped saved config option '{missing}' because the Agent no longer advertises it; using the Agent's current value."
                                ),
                            });
                        }
                        for option in advertised {
                            let config_id = option.id.to_string();
                            let Some(value) = cfg.config_options.get(&config_id).cloned() else {
                                continue;
                            };
                            if crate::agent_config::config_option_has_current_value(&option, &value)
                            {
                                continue;
                            }
                            let request_value = match validated_config_request_value(
                                &handle, &config_id, value,
                            ) {
                                Ok(value) => value,
                                Err(error) => {
                                    handle.emit(AcpUpdate::ConfigOptionError {
                                        config_id: config_id.clone(),
                                        message: format!(
                                            "Skipped saved config option '{config_id}' because it is not valid for the current Agent session; using the Agent's current value. {error}"
                                        ),
                                    });
                                    continue;
                                }
                            };
                            match conn
                                .send_request(acp::SetSessionConfigOptionRequest::new(
                                    session_id_arc.clone(),
                                    acp::SessionConfigId::new(config_id.clone()),
                                    request_value,
                                ))
                                .block_task()
                                .await
                            {
                                Ok(response) => {
                                    replace_config_snapshot(&handle, response.config_options);
                                    applied.push(config_id);
                                }
                                Err(error) => {
                                    handle.emit(AcpUpdate::ConfigOptionError {
                                        config_id: config_id.clone(),
                                        message: format!(
                                            "Could not apply saved config option '{config_id}'; continuing with the Agent's current value. {error}"
                                        ),
                                    });
                                }
                            }
                        }
                    }

                    if failure.is_none() {
                        if let Some(ref mode_id) = cfg.mode {
                            let current = handle.current_mode_id.lock().unwrap().clone();
                            if current.as_deref() != Some(mode_id.as_str()) {
                                let mode_cfg_id = handle
                                    .current_config_options
                                    .lock()
                                    .ok()
                                    .and_then(|options| {
                                        extract_config_select(
                                            &options,
                                            acp::SessionConfigOptionCategory::Mode,
                                            &["mode"],
                                        )
                                        .2
                                    });
                                let uses_config_options = handle
                                    .uses_config_options
                                    .load(std::sync::atomic::Ordering::Relaxed);
                                let resp: Result<(), String> = if let Some(config_id) = mode_cfg_id
                                {
                                    conn.send_request(acp::SetSessionConfigOptionRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionConfigId::new(config_id),
                                        acp::SessionConfigValueId::new(mode_id.clone()),
                                    ))
                                    .block_task()
                                    .await
                                    .map(|response| {
                                        replace_config_snapshot(&handle, response.config_options)
                                    })
                                    .map_err(|error| error.to_string())
                                } else if uses_config_options {
                                    Err("agent did not advertise a Mode config option".to_string())
                                } else {
                                    conn.send_request(acp::SetSessionModeRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionModeId::new(mode_id.clone()),
                                    ))
                                    .block_task()
                                    .await
                                    .map(|_| {
                                        *handle.current_mode_id.lock().unwrap() =
                                            Some(mode_id.clone());
                                        handle.emit(AcpUpdate::ModeChanged {
                                            mode_id: mode_id.clone(),
                                        });
                                    })
                                    .map_err(|error| error.to_string())
                                };
                                match resp {
                                    Ok(_) => {
                                        applied.push(format!("mode={}", mode_id));
                                    }
                                    Err(e) => {
                                        failure = Some((
                                            "mode".to_string(),
                                            format!("{}: {}", mode_id, e),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    if failure.is_none() {
                        if let Some(ref model_id) = cfg.model {
                            let current = handle.current_model_id.lock().unwrap().clone();
                            if current.as_deref() != Some(model_id.as_str()) {
                                let model_cfg_id = handle.model_config_id.lock().unwrap().clone();
                                let resp: Result<(), String> = if let Some(ref config_id) =
                                    model_cfg_id
                                {
                                    conn.send_request(acp::SetSessionConfigOptionRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionConfigId::new(config_id.clone()),
                                        acp::SessionConfigValueId::new(model_id.clone()),
                                    ))
                                    .block_task()
                                    .await
                                    .map(|response| {
                                        replace_config_snapshot(&handle, response.config_options)
                                    })
                                    .map_err(|e| e.to_string())
                                } else {
                                    Err("agent did not advertise a model config option".to_string())
                                };
                                match resp {
                                    Ok(_) => {
                                        applied.push(format!("model={}", model_id));
                                    }
                                    Err(e) => {
                                        failure = Some((
                                            "model".to_string(),
                                            format!("{}: {}", model_id, e),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    if failure.is_none() {
                        if let (Some(ref value_id), Some(ref config_id)) =
                            (&cfg.thought_level, &cfg.thought_level_config_id)
                        {
                            let current = handle.current_thought_level_id.lock().unwrap().clone();
                            if current.as_deref() != Some(value_id.as_str()) {
                                let resp = conn
                                    .send_request(acp::SetSessionConfigOptionRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionConfigId::new(config_id.clone()),
                                        acp::SessionConfigValueId::new(value_id.clone()),
                                    ))
                                    .block_task()
                                    .await;
                                match resp {
                                    Ok(response) => {
                                        replace_config_snapshot(&handle, response.config_options);
                                        applied.push(format!("thought_level={}", value_id));
                                    }
                                    Err(e) => {
                                        failure = Some((
                                            "thought_level".to_string(),
                                            format!("{}: {}", value_id, e),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    if let Some((field, detail)) = failure {
                        let applied_str = if applied.is_empty() {
                            "none".to_string()
                        } else {
                            applied.join(", ")
                        };
                        // Task Automations claim the session's busy slot
                        // before enqueueing this Prompt. Config failure occurs
                        // before the normal Busy=true/false pair, so release
                        // that claim explicitly or the Chat remains stuck.
                        handle
                            .is_busy
                            .store(false, std::sync::atomic::Ordering::Release);
                        let message = format!(
                                "Prompt not sent — {} rejected by agent ({}). Already applied before failure: {}. Session state reflects the applied settings; retry after fixing the rejected value.",
                                field, detail, applied_str
                            );
                        handle.emit(AcpUpdate::PromptFailed {
                            message_ids: message_ids.clone(),
                            message: message.clone(),
                        });
                        handle.emit(AcpUpdate::Error { message });
                        continue;
                    }
                }

                // Persist and replay the exact text block sent over ACP. The
                // `<grove-meta>` envelope is presentation metadata: the UI
                // decides how to render it, but history.jsonl remains a
                // faithful protocol transcript.
                let pending_dynamic_instruction = handle.pending_session_instruction_snapshot();
                let wire_text = match (
                    pending_session_bootstrap.as_ref(),
                    pending_dynamic_instruction.as_ref(),
                ) {
                    (None, None) => text.clone(),
                    (bootstrap, dynamic) => {
                        let kind = dynamic
                            .map(|(_, kind, _)| kind.as_str())
                            .or_else(|| bootstrap.map(|(kind, _)| *kind))
                            .unwrap_or("session_update");
                        let mut sections = Vec::new();
                        if let Some((_, instruction)) = bootstrap {
                            sections.push(instruction.as_str());
                        }
                        if let Some((_, _, instruction)) = dynamic {
                            sections.push(instruction.as_str());
                        }
                        crate::agent_graph::inject::build_session_instruction_prompt(
                            kind,
                            &sections.join("\n\n"),
                            &text,
                        )
                    }
                };
                handle.emit(AcpUpdate::PromptStarted {
                    message_ids: message_ids.clone(),
                });
                handle.emit(AcpUpdate::UserMessage {
                    text: wire_text.clone(),
                    attachments: attachments.clone(),
                    sender,
                    terminal,
                });
                // Stash the user prompt BEFORE emitting Busy so the
                // ChatStatus broadcast triggered by Busy=true can pick it
                // up. (emit() is synchronous, so the order matters.)
                if let Ok(mut buf) = handle.last_user_prompt.lock() {
                    *buf = Some(text.clone());
                }
                handle.emit(AcpUpdate::Busy { value: true });
                if let Ok(mut buf) = handle.last_assistant_text.lock() {
                    buf.clear();
                }
                handle
                    .pending_text_separator
                    .store(false, std::sync::atomic::Ordering::Relaxed);

                let mut content_blocks: Vec<acp::ContentBlock> = Vec::new();
                if !wire_text.is_empty() {
                    content_blocks.push(wire_text.into());
                }
                for block in &attachments {
                    content_blocks.push(to_acp_content_block(block));
                }

                // Grove-instrumented turn timer. `start_ts` 记录 send_request 这一刻的
                // wall clock,用来算 duration 和写入 chat_token_usage.start_ts。
                // 选取 send_request 而非用户点 send 的时刻,是为了排除 prompt 队列
                // 等待时间,只反映 agent 真正"思考"了多久。
                let turn_start_ts = chrono::Utc::now().timestamp();
                // Resolve Automation ownership at turn start. A product-level
                // completion tool can make the Run terminal before ACP returns
                // this turn's usage; looking it up at `Complete` would then
                // incorrectly charge the `_memory` TaskChat namespace instead.
                // Later turns in the still-usable Chat correctly have no Run
                // owner because the original Run is already terminal.
                let automation_run_id_owned = config.chat_id.as_deref().and_then(|chat_id| {
                    crate::storage::automations::nonterminal_run_id_for_chat(
                        &config.project_key,
                        &config.task_id,
                        chat_id,
                    )
                    .ok()
                    .flatten()
                });

                // 用 SentRequest::block_task() 得到可被 select 的 future
                let prompt_fut = conn
                    .send_request(acp::PromptRequest::new(
                        session_id_arc.clone(),
                        content_blocks,
                    ))
                    .block_task();
                tokio::pin!(prompt_fut);

                let mut got_kill = false;
                let mut short_tool_watchdog =
                    tokio::time::interval(std::time::Duration::from_secs(1));
                short_tool_watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

                // There is no generic turn timeout: agents may legitimately
                // run long tools. Fast local Memory MCP calls are the narrow
                // exception above; their watchdog sends protocol cancellation
                // without dropping `prompt_fut`, so the ACP session can still
                // finish its normal cancel acknowledgement.
                let result = loop {
                    tokio::select! {
                        res = &mut prompt_fut => break res,
                        _ = short_tool_watchdog.tick() => {
                            if let Some((tool_call_id, watch)) = handle.take_expired_short_tool() {
                                eprintln!(
                                    "[ACP] short MCP tool timed out after {:.1}s; cancelling turn (id={}, title={})",
                                    watch.started_at.elapsed().as_secs_f64(),
                                    tool_call_id,
                                    watch.title,
                                );
                                handle.cancel_current_turn_state();
                                let _ = conn.send_notification(acp::CancelNotification::new(session_id_arc.clone()));
                            }
                        }
                        Some(inner_cmd) = cmd_rx.recv() => {
                            match inner_cmd {
                                AcpCommand::Cancel => {
                                    handle.cancel_current_turn_state();
                                    // cancel 是 Notification, send_notification 是同步 API.
                                    // 多次 Cancel 都允许通过 (用户连点 Send Now / 多 WS 同时 cancel),
                                    // agent 侧需要幂等处理多份 CancelNotification — 这是 ACP spec
                                    // 的预期行为, 不在客户端去重。
                                    let _ = conn.send_notification(acp::CancelNotification::new(session_id_arc.clone()));
                                }
                                AcpCommand::Prompt { message_ids, text, attachments, sender, terminal, config: prompt_config } => {
                                    // B3 fix: in-flight Prompt no longer cancels the current
                                    // turn and overwrites a single `next_prompt` slot — that
                                    // dropped N-1 messages on rapid resends. Enqueue to
                                    // pending_queue and let the end-of-turn drain process
                                    // them in order. terminal flag is preserved so the
                                    // drained Prompt still renders as a shell echo if the
                                    // user originally sent it from Shell mode.
                                    let mut qm = QueuedMessage::new(text, attachments, sender, terminal, prompt_config);
                                    qm.message_ids = message_ids;
                                    handle.pending_queue.lock().unwrap().push(qm);
                                    handle.emit(AcpUpdate::QueueUpdate {
                                        messages: handle.get_queue(),
                                    });
                                }
                                AcpCommand::Kill => {
                                    // Intentionally drops `prompt_fut`'s oneshot Receiver
                                    // even though the Cancel arm above carefully avoids that
                                    // pattern. The distinction: Cancel keeps the session
                                    // alive (any late agent response still has somewhere to
                                    // land), Kill tears the whole session down (cmd_loop
                                    // exits, agent subprocess is killed downstream — no
                                    // late response can arrive because the transport is
                                    // gone). Library-level "receiver dropped" log here is
                                    // harmless noise, not protocol corruption.
                                    got_kill = true;
                                    break Err(acp::Error::internal_error());
                                }
                                AcpCommand::Authenticate { .. } => {
                                    // 我们的流程里 Authenticate 只会在 prompt errored
                                    // 之后由用户点登录触发,此时 prompt_fut 不可能
                                    // 在飞 — 但 channel 是共享的,容错性 drop 掉。
                                }
                                AcpCommand::RetryAuthentication => {
                                    // Same defensive handling as Authenticate: an auth
                                    // retry is only meaningful after this prompt resolves
                                    // with auth_required.
                                }
                                AcpCommand::Logout { reply } => {
                                    let _ = reply.send(Err(
                                        "Cannot log out while agent is busy".to_string(),
                                    ));
                                }
                                AcpCommand::ForkSession { reply, .. } => {
                                    // Agent busy 期间 fork 风险较大(spec 未规定 agent
                                    // 必须支持 in-flight fork);拒绝并让前端把按钮 disable
                                    // 直到 turn 结束。reply 是 oneshot,drop 不丢。
                                    let _ = reply.send(Err(
                                        "Cannot fork while agent is busy".to_string(),
                                    ));
                                }
                                AcpCommand::DeleteSession { reply } => {
                                    // 同 fork:busy 期间拒绝。上层收到 Err 后保留
                                    // Grove Chat，不把 Agent deletion 降级成本地删除。
                                    let _ = reply.send(Err(
                                        "Cannot delete while agent is busy".to_string(),
                                    ));
                                }
                                AcpCommand::SetMode { mode_id, reply } => {
                                    let uses_config_options = handle
                                        .uses_config_options
                                        .load(std::sync::atomic::Ordering::Relaxed);
                                    let result = if uses_config_options {
                                        Err("Legacy session/set_mode is unavailable when configOptions are present".to_string())
                                    } else {
                                        conn.send_request(acp::SetSessionModeRequest::new(
                                                session_id_arc.clone(),
                                                acp::SessionModeId::new(mode_id.clone()),
                                            ))
                                            .block_task()
                                            .await
                                            .map(|_| {
                                                *handle.current_mode_id.lock().unwrap() =
                                                    Some(mode_id.clone());
                                                handle.emit(AcpUpdate::ModeChanged { mode_id });
                                            })
                                            .map_err(|error| {
                                                format!("session/set_mode failed: {error}")
                                            })
                                    };
                                    let _ = reply.send(result);
                                }
                                AcpCommand::SetConfigOption {
                                    config_id,
                                    value,
                                    reply,
                                } => {
                                    let result = match validated_config_request_value(
                                        &handle,
                                        &config_id,
                                        value,
                                    ) {
                                        Err(message) => Err(message),
                                        Ok(request_value) => conn
                                            .send_request(acp::SetSessionConfigOptionRequest::new(
                                                session_id_arc.clone(),
                                                acp::SessionConfigId::new(config_id),
                                                request_value,
                                            ))
                                            .block_task()
                                            .await
                                            .map(|response| {
                                                replace_config_snapshot(
                                                    &handle,
                                                    response.config_options,
                                                );
                                            })
                                            .map_err(|error| {
                                                format!("session/set_config_option failed: {error}")
                                            }),
                                    };
                                    let _ = reply.send(result);
                                }
                                AcpCommand::ListSessions { reply, .. } => {
                                    let _ = reply.send(Err("session/list unavailable while busy".into()));
                                }
                            }
                        }
                    }
                };

                if got_kill {
                    handle.emit(AcpUpdate::Busy { value: false });
                    handle.emit(AcpUpdate::PromptCompleted {
                        message_ids: message_ids.clone(),
                        stop_reason: "killed".to_string(),
                    });
                    if config.chat_id.is_some() {
                        notify_acp_event(
                            &config.project_key,
                            &config.task_id,
                            config.chat_id.as_deref(),
                            "Task Stopped",
                            "Agent session was stopped",
                            AcpNotificationEvent::TurnComplete,
                            None,
                        );
                    }
                    break;
                }

                handle
                    .cancel_requested
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                match result {
                    Ok(resp) => {
                        let stop_reason = format!("{:?}", resp.stop_reason);
                        let was_cancelled = stop_reason.to_ascii_lowercase().contains("cancel");
                        pending_session_bootstrap = None;
                        if let Some((revision, _, _)) = pending_dynamic_instruction {
                            handle.clear_pending_session_instruction(revision);
                        }
                        // Prompt 成功 = agent 当前认账户已登录,任何 stale 的
                        // pending_auth(用户在 grove 外部完成登录后回来)清掉,
                        // 否则 WS 重连仍会重发假 banner。pending_auth_retry 同理 —
                        // 已经成功过了不再需要回放。
                        if let Ok(mut slot) = handle.pending_auth.lock() {
                            *slot = None;
                        }
                        if let Ok(mut slot) = handle.pending_auth_retry.lock() {
                            *slot = None;
                        }
                        // After protocol refactor: in-flight Prompt commands are
                        // enqueued to pending_queue instead of cancelling/chaining,
                        // so every turn is "final" at this point. The drain-loop
                        // below picks up the next queued message if any.
                        let summary = handle
                            .last_assistant_text
                            .lock()
                            .ok()
                            .map(|buf| truncate_chars(&buf, 80))
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "Agent finished responding".to_string());
                        if config.chat_id.is_some() {
                            notify_acp_event(
                                &config.project_key,
                                &config.task_id,
                                config.chat_id.as_deref(),
                                if was_cancelled {
                                    "Task Stopped"
                                } else {
                                    "Task Complete"
                                },
                                if was_cancelled {
                                    "Agent turn was cancelled"
                                } else {
                                    &summary
                                },
                                AcpNotificationEvent::TurnComplete,
                                None,
                            );
                        }
                        handle.emit(AcpUpdate::Busy { value: false });
                        let turn_end_ts = chrono::Utc::now().timestamp();
                        let turn_usage = resp.usage.as_ref().map(|usage| TurnUsage {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            total_tokens: usage.total_tokens,
                            cached_read_tokens: usage.cached_read_tokens,
                        });
                        // Layer A: persist per-turn usage to SQLite for stats.
                        // Best-effort — a write error here must not fail the turn.
                        let cost_owned = handle
                            .current_usage
                            .lock()
                            .ok()
                            .and_then(|g| g.as_ref().and_then(|s| s.cost.clone()));
                        if let Some(usage) = &turn_usage {
                            let model_owned =
                                handle.current_model_id.lock().ok().and_then(|g| g.clone());
                            let automation_run_id = automation_run_id_owned.as_deref();
                            let rec = crate::storage::token_usage::TokenUsageRecord {
                                project_key: &config.project_key,
                                task_id: automation_run_id
                                    .is_none()
                                    .then_some(config.task_id.as_str())
                                    .filter(|_| config.chat_id.is_some()),
                                chat_id: automation_run_id
                                    .is_none()
                                    .then_some(config.chat_id.as_deref())
                                    .flatten(),
                                automation_run_id,
                                agent: &config.agent_name,
                                model: model_owned.as_deref(),
                                input_tokens: usage.input_tokens,
                                cached_read_tokens: usage.cached_read_tokens,
                                output_tokens: usage.output_tokens,
                                total_tokens: usage.total_tokens,
                                start_ts: turn_start_ts,
                                end_ts: turn_end_ts,
                                cost_amount: cost_owned.as_ref().map(|c| c.amount),
                                cost_currency: cost_owned.as_ref().map(|c| c.currency.as_str()),
                            };
                            if let Err(e) = crate::storage::token_usage::insert(&rec) {
                                eprintln!("[token_usage] insert failed: {}", e);
                            }
                        }
                        handle.emit(AcpUpdate::Complete {
                            stop_reason: stop_reason.clone(),
                            usage: turn_usage,
                            start_ts: Some(turn_start_ts),
                            end_ts: Some(turn_end_ts),
                            cost: cost_owned,
                        });
                        handle.emit(AcpUpdate::PromptCompleted {
                            message_ids: message_ids.clone(),
                            stop_reason,
                        });
                    }
                    Err(e) => {
                        handle.emit(AcpUpdate::Busy { value: false });
                        // -32000 AuthRequired:转登录流程,不当一般错误报。
                        if is_auth_required_error(&e) {
                            let methods = handle
                                .auth_methods
                                .lock()
                                .map(|m| m.clone())
                                .unwrap_or_default();
                            if let Ok(mut slot) = handle.pending_auth_retry.lock() {
                                *slot = Some(retry_snapshot.clone());
                            }
                            // 同时落到 pending_auth,让刷新后 WS 重连能重发
                            // banner(activeAuthMessage 派生自当下 messages,
                            // history 里没存 auth_required,光靠回放拿不到)。
                            if let Ok(mut slot) = handle.pending_auth.lock() {
                                *slot = Some(PendingAuthState {
                                    methods: methods.clone(),
                                    agent_name: Some(agent_name.clone()),
                                });
                            }
                            handle.emit(AcpUpdate::AuthRequired {
                                methods,
                                agent_name: Some(agent_name.clone()),
                            });
                            // Authentication is a terminal outcome for the
                            // accepted Connect request. Grove may retain its
                            // normal UI retry context, while external callers
                            // receive an immediate result and clear status.
                            handle.emit(AcpUpdate::PromptFailed {
                                message_ids: message_ids.clone(),
                                message: "Authentication required — open Grove to sign in."
                                    .to_string(),
                            });
                        } else {
                            handle.emit(AcpUpdate::PromptFailed {
                                message_ids: message_ids.clone(),
                                message: e.to_string(),
                            });
                            handle.emit(AcpUpdate::Error {
                                // Preserve the Agent/ACP error text as-is. The event type
                                // already provides the prompt-failure context; adding another
                                // label here produced "Prompt error: Internal error: ...".
                                message: e.to_string(),
                            });
                        }
                    }
                }

                handle.drain_queue_if_ready();
            }
            AcpCommand::Cancel => {
                // Agent 空闲时收到 Cancel,忽略
            }
            AcpCommand::SetMode { mode_id, reply } => {
                let outcome = if handle
                    .uses_config_options
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    Err(
                        "Legacy session/set_mode is unavailable when configOptions are present"
                            .to_string(),
                    )
                } else {
                    conn.send_request(acp::SetSessionModeRequest::new(
                        session_id_arc.clone(),
                        acp::SessionModeId::new(mode_id.clone()),
                    ))
                    .block_task()
                    .await
                    .map(|_| {
                        *handle.current_mode_id.lock().unwrap() = Some(mode_id.clone());
                        handle.emit(AcpUpdate::ModeChanged { mode_id });
                    })
                    .map_err(|error| format!("session/set_mode failed: {error}"))
                };
                let _ = reply.send(outcome);
            }
            AcpCommand::SetConfigOption {
                config_id,
                value,
                reply,
            } => {
                let request_value = validated_config_request_value(&handle, &config_id, value);
                let outcome = match request_value {
                    Err(message) => Err(message),
                    Ok(request_value) => conn
                        .send_request(acp::SetSessionConfigOptionRequest::new(
                            session_id_arc.clone(),
                            acp::SessionConfigId::new(config_id),
                            request_value,
                        ))
                        .block_task()
                        .await
                        .map(|response| {
                            replace_config_snapshot(&handle, response.config_options);
                        })
                        .map_err(|error| format!("session/set_config_option failed: {error}")),
                };
                let _ = reply.send(outcome);
            }
            AcpCommand::Authenticate { method_id } => {
                // Long-blocking 请求:agent 典型实现是开浏览器等 OAuth,期间不响应。
                // 用 select 抢占:in-flight 期间继续 poll cmd_rx,新 Authenticate
                // 进来 → drop 旧 future、用新 method_id 重跑;否则用户选了 A 没完成
                // → 刷新 → 点 B 会被排队永不处理。同 session/new 阶段的写法对齐。
                let mut current_method_id = method_id;
                'auth_loop: loop {
                    let auth_fut = conn
                        .send_request(acp::AuthenticateRequest::new(acp::AuthMethodId::new(
                            current_method_id,
                        )))
                        .block_task();
                    tokio::pin!(auth_fut);
                    loop {
                        tokio::select! {
                            res = &mut auth_fut => {
                                match res {
                                    Ok(_) => {
                                        // 登录成功:清 pending_auth,转发 AuthSucceeded,
                                        // 重发暂存的失败 prompt 让用户感觉无缝接上。
                                        if let Ok(mut slot) = handle.pending_auth.lock() {
                                            *slot = None;
                                        }
                                        handle.emit(AcpUpdate::AuthSucceeded);
                                        let pending = handle
                                            .pending_auth_retry
                                            .lock()
                                            .ok()
                                            .and_then(|mut s| s.take());
                                        if let Some((
                                            message_ids,
                                            text,
                                            attachments,
                                            sender,
                                            terminal,
                                            config,
                                        )) = pending
                                        {
                                            handle.retry_prompt_after_auth(
                                                message_ids,
                                                text,
                                                attachments,
                                                sender,
                                                terminal,
                                                config,
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        // 登录失败 — 告诉用户,banner 仍在,可换一种
                                        // 方法再点。pending_auth_retry 保留:用户二次
                                        // 成功时仍要重发原 prompt。pending_auth 也不清,
                                        // 刷新页面仍能看到 banner。
                                        handle.emit(AcpUpdate::AuthFailed {
                                            message: format!("Authentication failed: {}", e),
                                        });
                                    }
                                }
                                break 'auth_loop;
                            }
                            cmd = cmd_rx.recv() => match cmd {
                                None => break 'auth_loop,
                                Some(AcpCommand::Authenticate { method_id: new_id }) => {
                                    current_method_id = new_id;
                                    continue 'auth_loop;
                                }
                                Some(AcpCommand::Kill) => {
                                    if let Ok(mut slot) = handle.pending_auth.lock() {
                                        *slot = None;
                                    }
                                    return Ok(());
                                }
                                Some(AcpCommand::Logout { reply }) => {
                                    let _ = reply.send(Err(
                                        "Cannot log out while authentication is in progress"
                                            .to_string(),
                                    ));
                                }
                                Some(AcpCommand::Prompt {
                                    message_ids,
                                    text,
                                    attachments,
                                    sender,
                                    terminal,
                                    config,
                                }) => {
                                    let mut queued = QueuedMessage::new(
                                            text,
                                            attachments,
                                            sender,
                                            terminal,
                                            config,
                                        );
                                    queued.message_ids = message_ids;
                                    handle.pending_queue.lock().unwrap().push(queued);
                                    handle.emit(AcpUpdate::QueueUpdate {
                                        messages: handle.get_queue(),
                                    });
                                }
                                Some(AcpCommand::ForkSession { reply, .. }) => {
                                    let _ = reply.send(Err(
                                        "Cannot fork while authentication is in progress"
                                            .to_string(),
                                    ));
                                }
                                Some(AcpCommand::DeleteSession { reply }) => {
                                    let _ = reply.send(Err(
                                        "Cannot delete the Agent session while authentication is in progress"
                                            .to_string(),
                                    ));
                                }
                                Some(AcpCommand::SetMode { reply, .. }
                                | AcpCommand::SetConfigOption { reply, .. }) => {
                                    let _ = reply.send(Err(
                                        "Session settings are unavailable while authentication is in progress"
                                            .to_string(),
                                    ));
                                }
                                Some(AcpCommand::Cancel | AcpCommand::RetryAuthentication) => {}
                                Some(AcpCommand::ListSessions { reply, .. }) => {
                                    let _ = reply.send(Err("session/list unavailable during authentication".into()));
                                }
                            }
                        }
                    }
                }
            }
            AcpCommand::RetryAuthentication => {
                // No auth method was advertised, so the user completed login
                // outside ACP. Retry the blocked prompt; another auth_required
                // response will restore the panel if the external login failed.
                if let Ok(mut slot) = handle.pending_auth.lock() {
                    *slot = None;
                }
                handle.emit(AcpUpdate::AuthSucceeded);
                let pending = handle
                    .pending_auth_retry
                    .lock()
                    .ok()
                    .and_then(|mut retry| retry.take());
                if let Some((message_ids, text, attachments, sender, terminal, config)) = pending {
                    handle.retry_prompt_after_auth(
                        message_ids,
                        text,
                        attachments,
                        sender,
                        terminal,
                        config,
                    );
                }
            }
            AcpCommand::Logout { reply } => {
                let result = conn
                    .send_request(acp::LogoutRequest::new())
                    .block_task()
                    .await
                    .map(|_| ())
                    .map_err(|e| format!("Logout failed: {}", e));
                if result.is_ok() {
                    if let Ok(mut slot) = handle.pending_auth.lock() {
                        *slot = None;
                    }
                    if let Ok(mut slot) = handle.pending_auth_retry.lock() {
                        *slot = None;
                    }
                }
                let _ = reply.send(result);
            }
            AcpCommand::ForkSession { cwd, reply } => {
                // Agent 必须声明 fork capability;否则 send_request 会被 agent
                // 直接拒绝。这里不再二次校验,直接发出 — 失败会通过 reply 透传
                // 给上层(API handler 把错误传回前端)。
                let outcome = match if additional_directories_capable {
                    resolve_linked_project_paths(&config.project_key, &config.task_id)
                } else {
                    Ok(Vec::new())
                } {
                    Err(e) => Err(format!("session/fork workspace setup failed: {e}")),
                    Ok(fork_directories) => match build_mcp_servers(
                        &config.env_vars,
                        agent_graph_token,
                        supports_mcp_http,
                        &config.additional_mcp_servers,
                        config.mcp_server_policy,
                    ) {
                        Ok(mcp_servers) => {
                            match conn
                                .send_request(
                                    acp::ForkSessionRequest::new(session_id_arc.clone(), cwd)
                                        .additional_directories(fork_directories)
                                        .mcp_servers(mcp_servers),
                                )
                                .block_task()
                                .await
                            {
                                Ok(resp) => Ok(resp.session_id.to_string()),
                                Err(e) => Err(format!("session/fork failed: {}", e)),
                            }
                        }
                        Err(e) => Err(format!("session/fork MCP setup failed: {}", e)),
                    },
                };
                let _ = reply.send(outcome);
            }
            AcpCommand::DeleteSession { reply } => {
                // Agent 必须声明 delete capability(调用方已校验)。删的是当前
                // session，直接使用 session_id_arc；失败完整透传给上层。
                let res = conn
                    .send_request(acp::DeleteSessionRequest::new(session_id_arc.clone()))
                    .block_task()
                    .await;
                let outcome = match res {
                    Ok(_) => Ok(()),
                    Err(e) => Err(format!("session/delete failed: {}", e)),
                };
                let _ = reply.send(outcome);
            }
            AcpCommand::ListSessions { cursor, reply } => {
                let outcome = conn
                    .send_request(
                        acp::ListSessionsRequest::new()
                            .cwd(config.working_dir.clone())
                            .cursor(cursor),
                    )
                    .block_task()
                    .await
                    .map(|response| SessionListPage {
                        sessions: response
                            .sessions
                            .into_iter()
                            .map(|session| ListedSession {
                                session_id: session.session_id.to_string(),
                                cwd: session.cwd.to_string_lossy().to_string(),
                                title: session.title,
                                updated_at: session.updated_at.map(|value| value.to_string()),
                            })
                            .collect(),
                        next_cursor: response.next_cursor,
                    })
                    .map_err(|error| format!("session/list failed: {error}"));
                let _ = reply.send(outcome);
            }
            AcpCommand::Kill => {
                break;
            }
        }
    }

    // 优雅退出:tear down 前若 agent 支持 session/close,先让它 cancel 进行中
    // 的工作 + 释放资源,再由 run_acp_session 的 drop(child) SIGKILL 兜底。
    // best-effort:失败 / 超时一律忽略,不阻塞 tear down。
    if handle
        .close_capable
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            conn.send_request(acp::CloseSessionRequest::new(session_id_arc.clone()))
                .block_task(),
        )
        .await;
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

fn turn_form(snapshot: &ElicitationRequestSnapshot) -> Option<crate::radio::TurnForm> {
    use crate::radio::{TurnForm, TurnFormField, TurnFormFieldKind};

    let request = serde_json::to_value(&snapshot.request).ok()?;
    let message = request
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("The agent needs more information.")
        .to_owned();
    let schema = request
        .get("requestedSchema")
        .or_else(|| request.get("requested_schema"))?;
    let required: std::collections::HashSet<&str> = schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect();
    let fields = schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, property)| {
            let kind = match property
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("string")
            {
                "integer" => TurnFormFieldKind::Integer,
                "number" => TurnFormFieldKind::Number,
                "boolean" => TurnFormFieldKind::Boolean,
                "array" => TurnFormFieldKind::StringArray,
                _ => TurnFormFieldKind::Text,
            };
            let options = property
                .get("enum")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(|value| (value.to_owned(), value.to_owned()))
                .collect();
            TurnFormField {
                name: name.clone(),
                label: property
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(name)
                    .to_owned(),
                description: property
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                required: required.contains(name.as_str()),
                kind,
                options,
            }
        })
        .collect();
    Some(TurnForm {
        request_id: snapshot.request_id.clone(),
        message,
        fields,
    })
}

fn turn_form_values(
    snapshot: &ElicitationRequestSnapshot,
    fields: &HashMap<String, String>,
) -> Result<BTreeMap<String, ElicitationValueData>, String> {
    let request = serde_json::to_value(&snapshot.request).map_err(|error| error.to_string())?;
    let schema = request
        .get("requestedSchema")
        .or_else(|| request.get("requested_schema"))
        .ok_or_else(|| "The form has no schema.".to_owned())?;
    let properties = schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "The form has no fields.".to_owned())?;
    let required: std::collections::HashSet<&str> = schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect();
    let mut values = BTreeMap::new();
    for (name, property) in properties {
        let raw = fields
            .get(name)
            .map(|value| value.trim())
            .unwrap_or_default();
        if raw.is_empty() {
            if required.contains(name.as_str()) {
                let label = property
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(name);
                return Err(format!("{label} is required."));
            }
            continue;
        }
        let value = match property
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("string")
        {
            "integer" => ElicitationValueData::Integer(
                raw.parse()
                    .map_err(|_| format!("{name} must be an integer."))?,
            ),
            "number" => ElicitationValueData::Number(
                raw.parse()
                    .map_err(|_| format!("{name} must be a number."))?,
            ),
            "boolean" => ElicitationValueData::Boolean(
                raw.parse()
                    .map_err(|_| format!("{name} must be Yes or No."))?,
            ),
            "array" => ElicitationValueData::StringArray(
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
            ),
            _ => ElicitationValueData::String(raw.to_owned()),
        };
        values.insert(name.clone(), value);
    }
    Ok(values)
}

// === 公开 API ===

impl AcpSessionHandle {
    pub fn pending_turn_form(&self, expected_id: &str) -> Option<crate::radio::TurnForm> {
        self.pending_elicitation_snapshot()
            .filter(|snapshot| snapshot.request_id == expected_id)
            .and_then(|snapshot| turn_form(&snapshot))
    }

    pub fn respond_turn_form(
        &self,
        expected_id: &str,
        accept: bool,
        fields: &HashMap<String, String>,
    ) -> Result<(), String> {
        let snapshot = self
            .pending_elicitation_snapshot()
            .filter(|snapshot| snapshot.request_id == expected_id)
            .ok_or_else(|| "This form is no longer active.".to_owned())?;
        let response = if accept {
            ElicitationResponseData::Accept {
                content: Some(turn_form_values(&snapshot, fields)?),
            }
        } else {
            ElicitationResponseData::Decline
        };
        match self.respond_elicitation(expected_id, response) {
            ElicitationResponseResult::Accepted => Ok(()),
            ElicitationResponseResult::Stale => Err("This form is no longer active.".to_owned()),
            ElicitationResponseResult::Invalid(message) => Err(message),
        }
    }

    fn publish_turn_radio_event(&self, update: &AcpUpdate) {
        use crate::radio::{
            publish as broadcast_radio_event, PermissionInfo, PermissionOptionInfo, RadioEvent,
            TurnEvent,
        };

        let Some(chat_id) = self.chat_id.as_ref() else {
            return;
        };
        let (message_ids, event, terminal) = match update {
            AcpUpdate::PromptStarted { message_ids } => {
                *self.active_turn_message_ids.lock().unwrap() = message_ids.clone();
                self.last_turn_reply.lock().unwrap().clear();
                (message_ids.clone(), TurnEvent::Started, false)
            }
            AcpUpdate::MessageChunk { text } => {
                self.last_turn_reply.lock().unwrap().push_str(text);
                return;
            }
            AcpUpdate::ToolCall { .. } | AcpUpdate::ToolCallV1 { .. } => {
                self.last_turn_reply.lock().unwrap().clear();
                return;
            }
            AcpUpdate::PermissionRequest {
                id,
                description,
                options,
            } => {
                let ids = self.active_turn_message_ids.lock().unwrap().clone();
                let permission = PermissionInfo {
                    description: description.clone(),
                    options: options
                        .iter()
                        .map(|option| PermissionOptionInfo {
                            option_id: option.option_id.clone(),
                            name: option.name.clone(),
                            kind: option.kind.clone(),
                        })
                        .collect(),
                };
                (
                    ids,
                    TurnEvent::PermissionRequired {
                        request_id: id.clone(),
                        permission,
                    },
                    false,
                )
            }
            AcpUpdate::ElicitationRequest { snapshot } => {
                let Some(form) = turn_form(snapshot) else {
                    return;
                };
                (
                    self.active_turn_message_ids.lock().unwrap().clone(),
                    TurnEvent::FormRequired { form },
                    false,
                )
            }
            AcpUpdate::PromptCompleted {
                message_ids,
                stop_reason,
            } => (
                message_ids.clone(),
                TurnEvent::Completed {
                    stop_reason: stop_reason.clone(),
                    message: self.last_turn_reply.lock().unwrap().trim().to_owned(),
                },
                true,
            ),
            AcpUpdate::PromptFailed {
                message_ids,
                message,
            } => (
                message_ids.clone(),
                TurnEvent::Failed {
                    message: message.clone(),
                },
                true,
            ),
            AcpUpdate::QueueMessageGone { id } => (vec![id.clone()], TurnEvent::Removed, true),
            AcpUpdate::SessionEnded => (
                self.active_turn_message_ids.lock().unwrap().clone(),
                TurnEvent::SessionEnded,
                true,
            ),
            _ => return,
        };
        broadcast_radio_event(RadioEvent::Turn {
            project_id: self.project_key.clone(),
            task_id: self.task_id.clone(),
            chat_id: chat_id.clone(),
            message_ids,
            event,
        });
        if terminal {
            self.active_turn_message_ids.lock().unwrap().clear();
            self.last_turn_reply.lock().unwrap().clear();
        }
    }

    pub fn set_pending_session_instruction(&self, kind: &str, instruction: String) {
        let revision = self
            .session_instruction_revision
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        if let Ok(mut pending) = self.pending_session_instruction.lock() {
            *pending = Some((revision, kind.to_string(), instruction));
        }
    }

    fn pending_session_instruction_snapshot(&self) -> Option<(u64, String, String)> {
        self.pending_session_instruction
            .lock()
            .ok()
            .and_then(|pending| pending.clone())
    }

    fn clear_pending_session_instruction(&self, revision: u64) {
        if let Ok(mut pending) = self.pending_session_instruction.lock() {
            if pending
                .as_ref()
                .is_some_and(|(current, _, _)| *current == revision)
            {
                *pending = None;
            }
        }
    }

    pub fn pending_elicitation_snapshot(&self) -> Option<ElicitationRequestSnapshot> {
        self.pending_elicitation
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|pending| pending.snapshot.clone()))
    }

    pub fn active_url_elicitation_snapshots(&self) -> Vec<ElicitationRequestSnapshot> {
        self.active_url_elicitations
            .lock()
            .map(|pending| pending.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn respond_elicitation(
        &self,
        expected_id: &str,
        response: ElicitationResponseData,
    ) -> ElicitationResponseResult {
        {
            let slot = self.pending_elicitation.lock().unwrap();
            let Some(pending) = slot
                .as_ref()
                .filter(|pending| pending.snapshot.request_id == expected_id)
            else {
                return ElicitationResponseResult::Stale;
            };
            if let Err(error) =
                build_elicitation_response(&pending.snapshot.request, response.clone())
            {
                let message = error
                    .data
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&error.message)
                    .to_string();
                return ElicitationResponseResult::Invalid(message);
            }
        }
        let pending = {
            let mut slot = self.pending_elicitation.lock().unwrap();
            if slot
                .as_ref()
                .is_some_and(|pending| pending.snapshot.request_id == expected_id)
            {
                slot.take()
            } else {
                None
            }
        };
        let Some(pending) = pending else {
            return ElicitationResponseResult::Stale;
        };
        let action = match &response {
            ElicitationResponseData::Accept { .. } => "accept",
            ElicitationResponseData::Decline => "decline",
            ElicitationResponseData::Cancel => "cancel",
        };
        if action == "accept" {
            if let acp::ElicitationMode::Url(url) = &pending.snapshot.request.mode {
                let mut snapshot = pending.snapshot.clone();
                snapshot.opened = true;
                self.active_url_elicitations
                    .lock()
                    .unwrap()
                    .insert(url.elicitation_id.to_string(), snapshot);
            }
        }
        let _ = pending.response_tx.send(response);
        self.emit(AcpUpdate::ElicitationResolved {
            request_id: expected_id.to_string(),
            action: action.to_string(),
        });
        ElicitationResponseResult::Accepted
    }

    fn cancel_pending_elicitation(&self, expected_id: &str) -> bool {
        let pending = {
            let mut slot = self.pending_elicitation.lock().unwrap();
            if slot
                .as_ref()
                .is_some_and(|pending| pending.snapshot.request_id == expected_id)
            {
                slot.take()
            } else {
                None
            }
        };
        let Some(pending) = pending else {
            return false;
        };
        drop(pending.response_tx);
        self.emit(AcpUpdate::ElicitationResolved {
            request_id: expected_id.to_string(),
            action: "cancel".to_string(),
        });
        true
    }

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

    /// Whether an option belongs to the currently pending permission request.
    /// External surfaces use this before resolving the one-shot request.
    pub fn pending_permission_accepts(&self, expected_id: &str, option_id: &str) -> bool {
        if self.pending_permission_id().as_deref() != Some(expected_id) {
            return false;
        }
        self.last_permission_info
            .lock()
            .ok()
            .and_then(|info| info.clone())
            .is_some_and(|info| {
                info.options
                    .iter()
                    .any(|option| option.option_id == option_id)
            })
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
        // Drop the cached snapshot payload — the request is no longer pending.
        if let Ok(mut slot) = self.last_permission_info.lock() {
            *slot = None;
        }
        let _ = tx.send(option_id.clone());
        self.emit(AcpUpdate::PermissionResponse { id, option_id });
        self.broadcast_permission_cleared_status();
        true
    }

    /// Resolve one specific live permission because the Agent cancelled its
    /// JSON-RPC request. Matching by tool-call ID prevents a late cancellation
    /// from dismissing a newer permission request on the same connection.
    fn cancel_pending_permission(&self, expected_id: &str) -> bool {
        let pending = {
            let mut slot = self.pending_permission.lock().unwrap();
            if slot.as_ref().is_some_and(|(id, _)| id == expected_id) {
                slot.take()
            } else {
                None
            }
        };
        let Some((id, tx)) = pending else {
            return false;
        };
        drop(tx);
        if let Ok(mut slot) = self.last_permission_info.lock() {
            *slot = None;
        }
        self.emit(AcpUpdate::PermissionResponse {
            id,
            option_id: "Cancelled".to_string(),
        });
        self.broadcast_permission_cleared_status();
        true
    }

    fn broadcast_permission_cleared_status(&self) {
        // Permission gone — announce the post-take status so graph nodes can
        // leave the orange "permission_required" state immediately.
        if let Some(ref chat_id) = self.chat_id {
            use crate::radio::{publish as broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::ChatStatus {
                project_id: self.project_key.clone(),
                task_id: self.task_id.clone(),
                chat_id: chat_id.clone(),
                status: self.derive_node_status().to_string(),
                permission: None,
                project_name: None,
                task_name: None,
                chat_title: None,
                agent: None,
                prompt: None,
                message: None,
                todo_completed: self.last_plan.lock().ok().and_then(|p| p.map(|(c, _)| c)),
                todo_total: self.last_plan.lock().ok().and_then(|p| p.map(|(_, t)| t)),
            });
        }
    }

    /// 发送更新并记录到 history buffer（带磁盘持久化）
    pub fn emit(&self, mut update: AcpUpdate) {
        // load_session 期间抑制大部分 emit；保留 available_commands 以恢复 slash
        // commands，保留 session_ready 让前端就绪(suppress 现在保持到首个用户
        // prompt，session_ready 在 cmd loop 之前发，必须放行)。
        if self
            .suppress_emit
            .load(std::sync::atomic::Ordering::Relaxed)
            && !matches!(
                update,
                AcpUpdate::AvailableCommands { .. }
                    | AcpUpdate::SessionReady { .. }
                    | AcpUpdate::ConfigOptionsUpdate { .. }
                    | AcpUpdate::ModeChanged { .. }
                    | AcpUpdate::ModelChanged { .. }
                    | AcpUpdate::ThoughtLevelsUpdate { .. }
                    | AcpUpdate::AuthRequired { .. }
                    | AcpUpdate::AuthSucceeded
                    | AcpUpdate::AuthFailed { .. }
                    | AcpUpdate::AuthLoggedOut
            )
        {
            return;
        }

        if let Some(ref chat_id) = self.chat_id {
            match &mut update {
                AcpUpdate::SessionReady {
                    agent_name,
                    agent_version,
                    available_modes,
                    mode_descriptions,
                    current_mode_id,
                    available_models,
                    current_model_id,
                    available_thought_levels,
                    current_thought_level_id,
                    thought_level_config_id,
                    config_options,
                    uses_config_options,
                    prompt_capabilities,
                    ..
                } => {
                    let existing = read_session_metadata(&self.project_key, &self.task_id, chat_id);
                    let preserved_commands = existing
                        .as_ref()
                        .map(|m| m.available_commands.clone())
                        .unwrap_or_default();
                    let preserved_usage = existing.as_ref().and_then(|m| m.current_usage.clone());

                    // The Agent's setup response is authoritative. Persisted
                    // selections are only a cold-open fallback and must never
                    // silently overwrite the live session state.
                    *self.current_mode_id.lock().unwrap() = current_mode_id.clone();
                    *self.current_model_id.lock().unwrap() = current_model_id.clone();
                    *self.current_thought_level_id.lock().unwrap() =
                        current_thought_level_id.clone();
                    *self.thought_level_config_id.lock().unwrap() = thought_level_config_id.clone();
                    let model_cfg_id = self.model_config_id.lock().unwrap().clone();

                    write_session_metadata(
                        &self.project_key,
                        &self.task_id,
                        chat_id,
                        &SessionMetadata {
                            pid: std::process::id(),
                            agent_name: agent_name.clone(),
                            agent_version: agent_version.clone(),
                            available_modes: available_modes.clone(),
                            mode_descriptions: mode_descriptions.clone(),
                            current_mode_id: current_mode_id.clone(),
                            available_models: available_models.clone(),
                            current_model_id: current_model_id.clone(),
                            model_config_id: model_cfg_id,
                            available_thought_levels: available_thought_levels.clone(),
                            current_thought_level_id: current_thought_level_id.clone(),
                            thought_level_config_id: thought_level_config_id.clone(),
                            config_options: config_options.clone(),
                            uses_config_options: *uses_config_options,
                            prompt_capabilities: prompt_capabilities.clone(),
                            available_commands: preserved_commands,
                            current_usage: preserved_usage,
                        },
                    );
                }
                AcpUpdate::ModelChanged { model_id } => {
                    if let Some(mut meta) =
                        read_session_metadata(&self.project_key, &self.task_id, chat_id)
                    {
                        meta.current_model_id = Some(model_id.clone());
                        write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                    }
                }
                AcpUpdate::ConfigOptionsUpdate { config_options } => {
                    if let Some(mut meta) =
                        read_session_metadata(&self.project_key, &self.task_id, chat_id)
                    {
                        meta.config_options = config_options.clone();
                        meta.uses_config_options = true;
                        let (modes, mode, _) = extract_config_select(
                            config_options,
                            acp::SessionConfigOptionCategory::Mode,
                            &["mode"],
                        );
                        let (models, model, model_config_id) = extract_config_select(
                            config_options,
                            acp::SessionConfigOptionCategory::Model,
                            &["model"],
                        );
                        let (thought_levels, thought_level, thought_config_id) =
                            extract_thought_level(config_options);
                        meta.available_modes = modes;
                        meta.current_mode_id = mode;
                        meta.available_models = models;
                        meta.current_model_id = model;
                        meta.model_config_id = model_config_id;
                        meta.available_thought_levels = thought_levels;
                        meta.current_thought_level_id = thought_level;
                        meta.thought_level_config_id = thought_config_id;
                        write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                    }
                }
                AcpUpdate::ModeChanged { mode_id } => {
                    if let Some(mut meta) =
                        read_session_metadata(&self.project_key, &self.task_id, chat_id)
                    {
                        meta.current_mode_id = Some(mode_id.clone());
                        write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                    }
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
                            mode_descriptions: HashMap::new(),
                            current_mode_id: None,
                            available_models: Vec::new(),
                            current_model_id: None,
                            model_config_id: None,
                            available_thought_levels: Vec::new(),
                            current_thought_level_id: None,
                            thought_level_config_id: None,
                            config_options: Vec::new(),
                            uses_config_options: false,
                            prompt_capabilities: PromptCapabilitiesData::default(),
                            available_commands: Vec::new(),
                            current_usage: None,
                        });
                    meta.available_commands = commands.clone();
                    write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                }
                AcpUpdate::UsageUpdate { used, size, cost } => {
                    // Update only the in-memory snapshot — disk persistence
                    // is deferred to turn Complete to avoid a write storm
                    // when an agent emits many usage updates per turn.
                    // session.json is read on attach/restore from another
                    // process, which only matters across turns; within a
                    // turn the live process serves the snapshot from memory.
                    let snapshot = UsageSnapshot {
                        used: *used,
                        size: *size,
                        cost: cost.clone(),
                    };
                    if let Ok(mut guard) = self.current_usage.lock() {
                        *guard = Some(snapshot);
                    }
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
                if matches!(
                    &update,
                    AcpUpdate::UserMessage { .. } | AcpUpdate::Complete { .. }
                ) && crate::storage::tasks::touch_chat_session(
                    &self.project_key,
                    &self.task_id,
                    chat_id,
                )
                .unwrap_or(false)
                {
                    use crate::radio::{publish as broadcast_radio_event, RadioEvent};
                    broadcast_radio_event(RadioEvent::ChatListChanged {
                        project_id: self.project_key.clone(),
                        task_id: self.task_id.clone(),
                    });
                }
            }
            if let Some(ref artifact_dir) = self.artifact_dir {
                crate::storage::chat_history::append_event_to_path(
                    &artifact_dir.join("history.jsonl"),
                    &update,
                );
            }
        }
        if let (Some(artifact_dir), AcpUpdate::SessionReady { session_id, .. }) =
            (self.artifact_dir.as_ref(), &update)
        {
            let path = artifact_dir.join("session.json");
            let _ = std::fs::create_dir_all(artifact_dir);
            let payload = serde_json::json!({
                "pid": std::process::id(),
                "session_id": session_id,
                "agent": update,
            });
            if let Ok(data) = serde_json::to_vec_pretty(&payload) {
                let tmp = path.with_extension("json.tmp");
                if std::fs::write(&tmp, data).is_ok() {
                    let _ = std::fs::rename(tmp, path);
                }
            }
        }

        // 跟踪 busy 状态，并通知 Radio 客户端
        if let AcpUpdate::Busy { value } = &update {
            self.is_busy
                .store(*value, std::sync::atomic::Ordering::Relaxed);
            if self.chat_id.is_some() {
                use crate::radio::{publish as broadcast_radio_event, RadioEvent};
                // Tag the busy=true edge with a wall-clock timestamp so menubar
                // tray can render an elapsed-time meter without polling. `prompt`
                // stays None at this layer — enrichment will be wired in a later
                // commit when send_prompt() starts caching the latest user text.
                let started_at = if *value {
                    Some(chrono::Utc::now().timestamp_millis())
                } else {
                    None
                };
                broadcast_radio_event(RadioEvent::TaskBusy {
                    project_id: self.project_key.clone(),
                    task_id: self.task_id.clone(),
                    busy: *value,
                    prompt: None,
                    started_at,
                });
            }
        }

        // Chat-grained status push for the agent graph view. Anchored at the
        // central emit() point so every transition that flows through
        // AcpUpdate gets surfaced exactly once. Permission set is covered by
        // the PermissionRequest variant; permission take is broadcast from
        // respond_permission() because that path never emits an AcpUpdate
        // that would land here for that purpose.
        if let Some(ref chat_id) = self.chat_id {
            use crate::radio::PermissionInfo;
            let (next_status, permission): (Option<&'static str>, Option<PermissionInfo>) =
                match &update {
                    AcpUpdate::SessionReady { .. } => (Some(self.derive_node_status()), None),
                    AcpUpdate::Busy { value: true } => (Some("busy"), None),
                    AcpUpdate::Busy { value: false } => (Some(self.derive_node_status()), None),
                    AcpUpdate::PermissionRequest {
                        description,
                        options,
                        ..
                    } => {
                        let info = PermissionInfo {
                            description: description.clone(),
                            options: options
                                .iter()
                                .map(|o| crate::radio::PermissionOptionInfo {
                                    option_id: o.option_id.clone(),
                                    name: o.name.clone(),
                                    kind: o.kind.clone(),
                                })
                                .collect(),
                        };
                        // Cache for the one-shot snapshot endpoint; a freshly
                        // connected phone has no event history to reconstruct
                        // the pending request from.
                        if let Ok(mut slot) = self.last_permission_info.lock() {
                            *slot = Some(info.clone());
                        }
                        (Some("permission_required"), Some(info))
                    }
                    AcpUpdate::SessionEnded => (Some("disconnected"), None),
                    // Plan progress changed — re-emit the chat's current
                    // status so the cached (todo_completed, todo_total) added
                    // below reaches passive listeners (menubar tray) without
                    // waiting for the next busy/idle transition.
                    AcpUpdate::PlanUpdate { entries } => {
                        let total = entries.len() as u32;
                        let completed =
                            entries.iter().filter(|e| e.status == "completed").count() as u32;
                        if let Ok(mut slot) = self.last_plan.lock() {
                            *slot = Some((completed, total));
                        }
                        (Some(self.derive_node_status()), None)
                    }
                    _ => (None, None),
                };
            if let Some(status) = next_status {
                use crate::radio::{publish as broadcast_radio_event, RadioEvent};
                // Resolve display names so consumers (menubar tray, etc.)
                // don't have to round-trip storage. Lookups are cheap and
                // happen only on actual transitions, not on every message.
                let project_name =
                    crate::storage::workspace::load_projects()
                        .ok()
                        .and_then(|projs| {
                            projs
                                .iter()
                                .find(|p| {
                                    crate::storage::workspace::project_hash(&p.path)
                                        == self.project_key
                                })
                                .map(|p| p.name.clone())
                        });
                let task_name = crate::storage::tasks::load_tasks(&self.project_key)
                    .ok()
                    .and_then(|tasks| {
                        tasks
                            .into_iter()
                            .find(|t| t.id == self.task_id)
                            .map(|t| t.name)
                    });
                let (chat_title, agent) =
                    crate::storage::tasks::load_chat_sessions(&self.project_key, &self.task_id)
                        .ok()
                        .and_then(|chats| chats.into_iter().find(|c| &c.id == chat_id))
                        .map(|c| (Some(c.title), Some(c.agent)))
                        .unwrap_or((None, None));
                // Pull cached chat-turn texts for the wire payload. `prompt`
                // is meaningful when the chat is going *into* busy; `message`
                // is meaningful when it leaves a busy phase. Picking them
                // here (rather than at the publishing-status switch) keeps
                // both fields harmless for unrelated transitions —
                // unrelated subscribers ignore them.
                let prompt = if status == "busy" {
                    self.last_user_prompt.lock().ok().and_then(|p| p.clone())
                } else {
                    None
                };
                let message = if status == "idle" {
                    self.last_assistant_text
                        .lock()
                        .ok()
                        .map(|s| s.clone())
                        .filter(|s| !s.is_empty())
                } else {
                    None
                };
                let (todo_completed, todo_total) = self
                    .last_plan
                    .lock()
                    .ok()
                    .and_then(|p| *p)
                    .map(|(c, t)| (Some(c), Some(t)))
                    .unwrap_or((None, None));
                broadcast_radio_event(RadioEvent::ChatStatus {
                    project_id: self.project_key.clone(),
                    task_id: self.task_id.clone(),
                    chat_id: chat_id.clone(),
                    status: status.to_string(),
                    permission,
                    project_name,
                    task_name,
                    chat_title,
                    agent,
                    prompt,
                    message,
                    todo_completed,
                    todo_total,
                });
            }
        }

        // Turn 结束时 compact 磁盘历史
        let should_compact = matches!(&update, AcpUpdate::Complete { .. });

        // Turn 结束时,如果 plan 已经 100% 完成,清掉缓存。
        // 否则下一轮 agent 不再发 TodoWrite,tray 会一直停在 9/9。
        // 部分完成(例如 5/7 中途停)保留,partial 进度本身是有价值信号。
        if should_compact {
            if let Ok(mut slot) = self.last_plan.lock() {
                if let Some((completed, total)) = *slot {
                    if total > 0 && completed >= total {
                        *slot = None;
                    }
                }
            }

            // Flush latest in-memory usage snapshot to session.json. We
            // batch on Complete instead of writing on every UsageUpdate
            // notification so a turn that emits many incremental updates
            // produces exactly one session.json write.
            if let Some(ref chat_id) = self.chat_id {
                let snapshot = self.current_usage.lock().ok().and_then(|g| g.clone());
                if snapshot.is_some() {
                    if let Some(mut meta) =
                        read_session_metadata(&self.project_key, &self.task_id, chat_id)
                    {
                        if let Some(snapshot) = snapshot {
                            meta.current_usage = Some(snapshot);
                        }
                        write_session_metadata(&self.project_key, &self.task_id, chat_id, &meta);
                    }
                }
            }
        }

        // SessionEnded clears the cached plan so a chat that disconnects
        // mid-todo doesn't carry partial progress into its next session.
        if matches!(&update, AcpUpdate::SessionEnded) {
            if let Ok(mut slot) = self.last_plan.lock() {
                *slot = None;
            }
        }

        if let Some(ref chat_id) = self.chat_id {
            crate::storage::automations::sync_run_state_for_chat_event(
                &self.project_key,
                &self.task_id,
                chat_id,
                &update,
            );
        }

        self.publish_turn_radio_event(&update);

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

    /// 发送用户提示。`config` 为 None 表示沿用 session 当前配置;Some 时 cmd_loop 会
    /// 在发 prompt 前按需先发 SetSessionMode/Model/ThoughtLevel ACP 请求。
    pub async fn send_prompt(
        &self,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        config: Option<QueuedConfig>,
    ) -> crate::error::Result<()> {
        self.send_tracked_prompt(text, attachments, sender, terminal, config)
            .await
            .map(|_| ())
    }

    /// Accepts a prompt and returns Grove's own message id. This id is local
    /// to Grove and remains stable through queueing and Compact turns; it is
    /// unrelated to optional ACP output `MessageId`s supplied by agents.
    pub async fn send_tracked_prompt(
        &self,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        config: Option<QueuedConfig>,
    ) -> crate::error::Result<String> {
        let message_id = default_queued_message_id();
        self.send_tracked_prompt_with_id(
            message_id.clone(),
            text,
            attachments,
            sender,
            terminal,
            config,
        )
        .await?;
        Ok(message_id)
    }

    async fn send_tracked_prompt_with_id(
        &self,
        message_id: String,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        config: Option<QueuedConfig>,
    ) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Prompt {
                message_ids: vec![message_id.clone()],
                text,
                attachments,
                sender,
                terminal,
                config,
            })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))?;
        Ok(())
    }

    /// Allocate a Grove prompt id without entering the ACP command loop.
    /// External adapters use this to register their mapping before starting
    /// the prompt, so a very fast Turn event cannot race the mapping insert.
    pub fn prepare_text_prompt(&self, text: String, sender: Option<String>) -> PreparedTextPrompt {
        PreparedTextPrompt {
            id: default_queued_message_id(),
            text,
            sender,
        }
    }

    /// Start a previously prepared prompt and return its Grove message id.
    pub async fn submit_prepared_text_prompt(
        &self,
        prompt: PreparedTextPrompt,
    ) -> crate::error::Result<String> {
        let PreparedTextPrompt { id, text, sender } = prompt;
        let claimed = self
            .is_busy
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok();
        if claimed {
            match self
                .send_tracked_prompt_with_id(id.clone(), text, Vec::new(), sender, false, None)
                .await
            {
                Ok(()) => Ok(id),
                Err(error) => {
                    self.is_busy
                        .store(false, std::sync::atomic::Ordering::Release);
                    Err(error)
                }
            }
        } else {
            let queued = QueuedMessage {
                id: id.clone(),
                message_ids: vec![id.clone()],
                text,
                attachments: Vec::new(),
                sender,
                config: Some(self.snapshot_config()),
                terminal: false,
            };
            let messages = self.queue_message(queued);
            self.emit(AcpUpdate::QueueUpdate { messages });
            Ok(id)
        }
    }

    /// Grove-level text prompt entry used by external surfaces. Session busy
    /// state and queue behavior stay encapsulated here.
    pub async fn submit_text_prompt(
        &self,
        text: String,
        sender: Option<String>,
    ) -> crate::error::Result<String> {
        let prompt = self.prepare_text_prompt(text, sender);
        self.submit_prepared_text_prompt(prompt).await
    }

    pub async fn set_mode(&self, mode_id: String) -> crate::error::Result<()> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(AcpCommand::SetMode {
                mode_id,
                reply: reply_tx,
            })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))?;
        match reply_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(crate::error::GroveError::Session(message)),
            Err(_) => Err(crate::error::GroveError::Session(
                "Mode request was dropped by ACP loop".to_string(),
            )),
        }
    }

    pub async fn set_config_option(
        &self,
        config_id: String,
        value: ConfigOptionValue,
    ) -> crate::error::Result<()> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(AcpCommand::SetConfigOption {
                config_id,
                value,
                reply: reply_tx,
            })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))?;
        match reply_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(crate::error::GroveError::Session(message)),
            Err(_) => Err(crate::error::GroveError::Session(
                "Config option request was dropped by ACP loop".to_string(),
            )),
        }
    }

    /// 触发 ACP `authenticate(method_id)`。协议要求 method_id 必须来自 Agent
    /// 在 initialize 响应中声明的 authMethods。
    pub async fn authenticate(&self, method_id: String) -> crate::error::Result<()> {
        let advertised = self
            .auth_methods
            .lock()
            .map(|methods| is_advertised_auth_method(&methods, &method_id))
            .unwrap_or(false);
        if !advertised {
            return Err(crate::error::GroveError::Session(format!(
                "Agent did not advertise authentication method '{}'",
                method_id
            )));
        }
        self.cmd_tx
            .send(AcpCommand::Authenticate { method_id })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// Agent 未声明认证方法时，允许用户在外部 CLI 登录后重试原请求。
    pub async fn retry_authentication(&self) -> crate::error::Result<()> {
        let can_retry = self
            .pending_auth
            .lock()
            .map(|state| {
                state
                    .as_ref()
                    .is_some_and(|pending| pending.methods.is_empty())
            })
            .unwrap_or(false);
        if !can_retry {
            return Err(crate::error::GroveError::Session(
                "External authentication retry is not available".to_string(),
            ));
        }
        self.cmd_tx
            .send(AcpCommand::RetryAuthentication)
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 调用 ACP v1 `logout`。协议能力未声明时拒绝发送请求。
    pub async fn logout(&self) -> crate::error::Result<()> {
        if !self
            .logout_capable
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Err(crate::error::GroveError::Session(
                "Agent does not support logout".to_string(),
            ));
        }
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(AcpCommand::Logout { reply: reply_tx })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))?;
        match reply_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(crate::error::GroveError::Session(message)),
            Err(_) => Err(crate::error::GroveError::Session(
                "Logout request was dropped by ACP loop".to_string(),
            )),
        }
    }

    /// 取消当前处理
    pub async fn cancel(&self) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Cancel)
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    fn cancel_current_turn_state(&self) {
        self.cancel_requested
            .store(true, std::sync::atomic::Ordering::Relaxed);

        if let Some((id, sender)) = self.pending_permission.lock().unwrap().take() {
            drop(sender);
            if let Ok(mut slot) = self.last_permission_info.lock() {
                *slot = None;
            }
            self.emit(AcpUpdate::PermissionResponse {
                id,
                option_id: "Cancelled".to_string(),
            });
        }

        if let Some(pending) = self.pending_elicitation.lock().unwrap().take() {
            let request_id = pending.snapshot.request_id;
            drop(pending.response_tx);
            self.emit(AcpUpdate::ElicitationResolved {
                request_id,
                action: "cancel".to_string(),
            });
        }

        let active_tool_calls: Vec<String> =
            self.active_tool_calls.lock().unwrap().drain().collect();
        self.short_tool_watches.lock().unwrap().clear();
        for id in active_tool_calls {
            self.emit(AcpUpdate::ToolCallUpdate {
                id,
                status: "cancelled".to_string(),
                content: None,
                locations: Vec::new(),
                raw_input: None,
            });
        }
    }

    fn take_expired_short_tool(&self) -> Option<(String, ShortToolWatch)> {
        let now = std::time::Instant::now();
        let mut watches = self.short_tool_watches.lock().unwrap();
        let id = watches
            .iter()
            .filter(|(_, watch)| watch.deadline <= now)
            .min_by_key(|(_, watch)| watch.deadline)
            .map(|(id, _)| id.clone())?;
        watches.remove(&id).map(|watch| (id, watch))
    }

    /// 终止会话
    pub async fn kill(&self) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Kill)
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))
    }

    /// 通过 ACP `session/fork` 派生新会话(`unstable_session_fork`)。
    /// 成功返回 fork 后的 acp session_id;调用方据此创建新 chat 行,
    /// 用户首次打开新 chat 时走 `load_session(new_id)` 复活。
    pub async fn fork_session(&self, cwd: PathBuf) -> crate::error::Result<String> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(AcpCommand::ForkSession {
                cwd,
                reply: reply_tx,
            })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))?;
        match reply_rx.await {
            Ok(Ok(sid)) => Ok(sid),
            Ok(Err(msg)) => Err(crate::error::GroveError::Session(msg)),
            Err(_) => Err(crate::error::GroveError::Session(
                "Fork request was dropped by ACP loop".to_string(),
            )),
        }
    }

    /// 通过 ACP v1 `session/delete` 删掉当前 session。
    pub async fn delete_session(&self) -> crate::error::Result<()> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(AcpCommand::DeleteSession { reply: reply_tx })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".to_string()))?;
        match reply_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(msg)) => Err(crate::error::GroveError::Session(msg)),
            Err(_) => Err(crate::error::GroveError::Session(
                "Delete request was dropped by ACP loop".to_string(),
            )),
        }
    }

    /// Request immediate teardown of the ACP transport and its backing process.
    ///
    /// Unlike `AcpCommand::Kill`, this remains observable while the command
    /// loop is blocked waiting for an Agent response.
    pub(crate) fn request_shutdown(&self) {
        self.shutdown_tx.send_replace(true);
    }

    #[cfg(test)]
    pub(crate) fn shutdown_requested(&self) -> bool {
        *self.shutdown_tx.borrow()
    }

    pub async fn list_sessions(
        &self,
        cursor: Option<String>,
    ) -> crate::error::Result<SessionListPage> {
        if !self
            .import_capable
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Err(crate::error::GroveError::Session(
                "Agent does not support session import".into(),
            ));
        }
        let (reply, result) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(AcpCommand::ListSessions { cursor, reply })
            .await
            .map_err(|_| crate::error::GroveError::Session("ACP session closed".into()))?;
        result
            .await
            .map_err(|_| {
                crate::error::GroveError::Session("session/list request was dropped".into())
            })?
            .map_err(crate::error::GroveError::Session)
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

    /// Remove every pending message whose `sender` matches the given filter
    /// exactly. Used by the Automation cancel path to drop all queued prompts
    /// tagged `automation:<run_id>` in one call without having to track the
    /// individual `QueuedMessage.id`s. Returns the number of removed entries.
    pub fn dequeue_messages_by_sender(&self, sender: &str) -> usize {
        let mut q = self.pending_queue.lock().unwrap();
        let before = q.len();
        q.retain(|m| m.sender.as_deref() != Some(sender));
        before - q.len()
    }

    /// 删除队列中指定 id 的消息。返回 `(found, snapshot)`:
    /// - `found = false` 时调用方应回报"消息已被发送/已不在队列"以让前端关闭编辑态。
    pub fn dequeue_message_by_id(&self, id: &str) -> (bool, Vec<QueuedMessage>) {
        let mut q = self.pending_queue.lock().unwrap();
        let before = q.len();
        q.retain(|m| m.id != id);
        let found = q.len() != before;
        (found, q.clone())
    }

    /// 编辑队列中指定 id 的消息文本。返回 `(found, snapshot)`。
    pub fn update_queued_message_by_id(
        &self,
        id: &str,
        text: String,
    ) -> (bool, Vec<QueuedMessage>) {
        let mut q = self.pending_queue.lock().unwrap();
        let mut found = false;
        for m in q.iter_mut() {
            if m.id == id {
                m.text = text;
                found = true;
                break;
            }
        }
        (found, q.clone())
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

    /// 结束当前一轮任务后，按 `queue_mode` 取出待发送内容（auto-send 专用）。
    ///
    /// - `Separate`（默认）：取队首一条，行为与之前完全一致。
    /// - `Compact`：把整条队列 drain 出来合并成一条消息 —— sender/config/terminal
    ///   取队首那条的，text 用换行 join，attachments 依次 extend。队列为空或只有
    ///   一条时退化为跟 `Separate` 相同的单条逻辑，不做特殊合并。
    ///
    /// 返回 `(合并/单条消息, 若发送失败需要原样放回队列的原始消息列表)`。
    /// 调用方发送失败时，把第二个元素里的消息按原顺序插回队首。
    fn pop_queue_for_auto_send(&self) -> Option<(QueuedMessage, Vec<QueuedMessage>)> {
        let mode = *self.queue_mode.lock().unwrap();
        match mode {
            QueueMode::Separate => self.pop_queue_front().map(|m| (m.clone(), vec![m])),
            QueueMode::Compact => {
                let drained: Vec<QueuedMessage> = {
                    let mut q = self.pending_queue.lock().unwrap();
                    std::mem::take(&mut *q)
                };
                if drained.is_empty() {
                    return None;
                }
                if drained.len() == 1 {
                    let only = drained[0].clone();
                    return Some((only, drained));
                }
                let first = &drained[0];
                let merged_text = drained
                    .iter()
                    .map(|m| m.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut merged_attachments = Vec::new();
                for m in &drained {
                    merged_attachments.extend(m.attachments.clone());
                }
                let merged = QueuedMessage {
                    id: default_queued_message_id(),
                    message_ids: drained
                        .iter()
                        .flat_map(|message| message.message_ids.clone())
                        .collect(),
                    text: merged_text,
                    attachments: merged_attachments,
                    sender: first.sender.clone(),
                    config: first.config.clone(),
                    terminal: first.terminal,
                };
                Some((merged, drained))
            }
        }
    }

    /// 非阻塞发送 prompt 命令(队列 auto-send 使用)。
    /// config 直接 bundle 在 Prompt 内,cmd_loop 在发 prompt 前按需先发
    /// SetSessionMode/Model/ThoughtLevel ACP 请求。
    fn try_enqueue_prompt(
        &self,
        message_ids: Vec<String>,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        config: Option<QueuedConfig>,
    ) -> bool {
        self.cmd_tx
            .try_send(AcpCommand::Prompt {
                message_ids,
                text,
                attachments,
                sender,
                terminal,
                config,
            })
            .is_ok()
    }

    /// Drain one auto-send unit only when the session is genuinely ready.
    ///
    /// The end-of-turn path and `resume_queue` can race around the Busy(false)
    /// edge. The lock plus the eager busy reservation ensures exactly one of
    /// them dequeues; the next command-loop iteration replaces the reservation
    /// with the authoritative Busy updates from the actual prompt.
    fn drain_queue_if_ready(&self) {
        let Ok(_drain_guard) = self.queue_drain_lock.lock() else {
            return;
        };
        if self.queue_paused.load(std::sync::atomic::Ordering::Relaxed)
            || self.is_busy.load(std::sync::atomic::Ordering::Relaxed)
            || self
                .pending_auth
                .lock()
                .map(|state| state.is_some())
                .unwrap_or(true)
        {
            return;
        }
        let Some((send_msg, original_msgs)) = self.pop_queue_for_auto_send() else {
            return;
        };

        // Reserve the idle slot before enqueueing so a concurrent resume or
        // end-of-turn drain cannot remove the next queued message as well.
        self.is_busy
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if self.try_enqueue_prompt(
            send_msg.message_ids.clone(),
            send_msg.text.clone(),
            send_msg.attachments.clone(),
            send_msg.sender.clone(),
            send_msg.terminal,
            send_msg.config.clone(),
        ) {
            self.emit(AcpUpdate::QueueUpdate {
                messages: self.get_queue(),
            });
        } else {
            self.is_busy
                .store(false, std::sync::atomic::Ordering::Relaxed);
            let mut q = self.pending_queue.lock().unwrap();
            for (i, msg) in original_msgs.into_iter().enumerate() {
                q.insert(i, msg);
            }
        }
    }

    /// Re-dispatch the prompt that failed with `auth_required`. If producers
    /// filled the bounded command channel while authentication was completing,
    /// retain the prompt at the front of the visible queue instead of dropping it.
    fn retry_prompt_after_auth(
        &self,
        message_ids: Vec<String>,
        text: String,
        attachments: Vec<ContentBlockData>,
        sender: Option<String>,
        terminal: bool,
        config: Option<QueuedConfig>,
    ) {
        let command = AcpCommand::Prompt {
            message_ids,
            text,
            attachments,
            sender,
            terminal,
            config,
        };
        if let Err(error) = self.cmd_tx.try_send(command) {
            if let AcpCommand::Prompt {
                message_ids,
                text,
                attachments,
                sender,
                terminal,
                config,
            } = error.into_inner()
            {
                self.pending_queue.lock().unwrap().insert(0, {
                    let mut queued =
                        QueuedMessage::new(text, attachments, sender, terminal, config);
                    queued.message_ids = message_ids;
                    queued
                });
                self.emit(AcpUpdate::QueueUpdate {
                    messages: self.get_queue(),
                });
            }
        }
    }

    /// 返回当前 config 快照（用于 QueuedConfig）。
    ///
    /// **Tearing**: 这里串行 lock 四个独立 Mutex（model / mode / thought_level /
    /// thought_level_config_id），不是一次原子读。如果在这四次 lock 之间外部刚好
    /// 推进了某个字段（agent 主动 emit ConfigOptionUpdate、另一个 WS client 触发
    /// 切换），快照可能"半新半旧"。
    ///
    /// 这是 benign 的：
    /// (1) snapshot_config 只在"前端没传 config 的旧客户端 fallback"路径上调用
    ///     （`ClientMessage::QueueMessage` 兼容老客户端），不在主流程；
    /// (2) `current_*_id` 字段语义本身就是 "last intent"（见 struct 字段注释），
    ///     不是 ground truth；下一次真正 send prompt 时 cmd_loop 会无条件 apply
    ///     最终 config，任何撕裂都会被覆盖。
    ///
    /// 若哪天要求严格一致（多 mutator 同时跑），把四个字段合并到单一 Mutex 包裹
    /// 的 struct 里即可。
    pub fn snapshot_config(&self) -> QueuedConfig {
        QueuedConfig {
            model: self.current_model_id.lock().unwrap().clone(),
            mode: self.current_mode_id.lock().unwrap().clone(),
            thought_level: self.current_thought_level_id.lock().unwrap().clone(),
            thought_level_config_id: self.thought_level_config_id.lock().unwrap().clone(),
            config_options: std::collections::BTreeMap::new(),
        }
    }

    /// All select-style session config options the agent advertises (mode,
    /// model, effort, …), read from the authoritative `configOptions`
    /// snapshot. Non-select kinds (booleans) are not surfaced yet.
    pub fn config_selectors(&self) -> Vec<ConfigSelector> {
        let config_options = self.current_config_options.lock().unwrap().clone();
        config_options
            .iter()
            .filter_map(|option| {
                let acp::SessionConfigKind::Select(select) = &option.kind else {
                    return None;
                };
                Some(ConfigSelector {
                    config_id: option.id.to_string(),
                    label: option.name.clone(),
                    current: Some(select.current_value.to_string()),
                    options: flatten_select_options(select),
                })
            })
            .collect()
    }

    /// 设置队列合并发送模式（Separate / Compact）
    pub fn set_queue_mode(&self, mode: QueueMode) {
        *self.queue_mode.lock().unwrap() = mode;
    }

    pub fn queue_mode_snapshot(&self) -> QueueMode {
        *self.queue_mode.lock().unwrap()
    }

    /// 暂停队列 auto-send（用户正在编辑队列消息）
    pub fn pause_queue(&self) {
        self.queue_paused
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Test-only helper: drain one queued message into the cmd channel,
    /// emulating what the prod cmd_loop does at end-of-turn.
    #[cfg(test)]
    pub fn test_drain_one_queued(&self) -> bool {
        if let Some(next_msg) = self.pop_queue_front() {
            self.try_enqueue_prompt(
                next_msg.message_ids,
                next_msg.text,
                next_msg.attachments,
                next_msg.sender,
                next_msg.terminal,
                next_msg.config,
            )
        } else {
            false
        }
    }

    /// 恢复队列 auto-send。Agent 忙时保持原队列不动，等待 turn-end drain；
    /// Agent 已空闲时补偿编辑期间被跳过的 drain。
    pub fn resume_queue(&self) {
        self.queue_paused
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.drain_queue_if_ready();
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
            let mut stdout_decoder = crate::api::handlers::terminal::Utf8LossyDecoder::new();
            let mut stderr_decoder = crate::api::handlers::terminal::Utf8LossyDecoder::new();

            loop {
                tokio::select! {
                    result = stdout.read(&mut stdout_buf), if !stdout_done => {
                        match result {
                            Ok(0) | Err(_) => stdout_done = true,
                            Ok(n) => {
                                let text = stdout_decoder.feed(&stdout_buf[..n]);
                                if !text.is_empty() {
                                    handle.emit(AcpUpdate::TerminalChunk { output: text });
                                }
                            }
                        }
                    }
                    result = stderr.read(&mut stderr_buf), if !stderr_done => {
                        match result {
                            Ok(0) | Err(_) => stderr_done = true,
                            Ok(n) => {
                                let text = stderr_decoder.feed(&stderr_buf[..n]);
                                if !text.is_empty() {
                                    handle.emit(AcpUpdate::TerminalChunk { output: text });
                                }
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

/// One-shot snapshot of every active chat's status, mirroring the fields a
/// `RadioEvent::ChatStatus` carries. Used by the tray phone page
/// (`GET /api/v1/tray/chats`) so a freshly connected phone sees the current
/// state without waiting for the next live transition.
///
/// `message` / context usage are deliberately omitted — they are only
/// meaningful in the live event stream and the tray panel does not render them.
pub fn snapshot_active_chats() -> Vec<crate::radio::ChatSnapshot> {
    use crate::radio::ChatSnapshot;
    use std::collections::HashMap;

    let handles: Vec<Arc<AcpSessionHandle>> = match ACP_SESSIONS.read() {
        Ok(sessions) => sessions.values().cloned().collect(),
        Err(_) => return Vec::new(),
    };

    // Lazily cache storage lookups so N sessions in the same project/task don't
    // re-read the same tables N times.
    let project_names: HashMap<String, String> = crate::storage::workspace::load_projects()
        .map(|projs| {
            projs
                .into_iter()
                .map(|p| (crate::storage::workspace::project_hash(&p.path), p.name))
                .collect()
        })
        .unwrap_or_default();
    // (project_key, task_id) -> task_name
    let mut task_names: HashMap<(String, String), Option<String>> = HashMap::new();
    // (project_key, task_id, chat_id) -> (title, agent)
    let mut chat_info: HashMap<(String, String, String), (String, String)> = HashMap::new();
    let mut chats_loaded: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();

    let mut out = Vec::new();
    for handle in handles {
        let Some(chat_id) = handle.chat_id.clone() else {
            continue;
        };
        let project_key = handle.project_key.clone();
        let task_id = handle.task_id.clone();

        let task_name = task_names
            .entry((project_key.clone(), task_id.clone()))
            .or_insert_with(|| {
                crate::storage::tasks::load_tasks(&project_key)
                    .ok()
                    .and_then(|tasks| tasks.into_iter().find(|t| t.id == task_id).map(|t| t.name))
            })
            .clone();

        if chats_loaded.insert((project_key.clone(), task_id.clone())) {
            if let Ok(chats) = crate::storage::tasks::load_chat_sessions(&project_key, &task_id) {
                for c in chats {
                    chat_info.insert(
                        (project_key.clone(), task_id.clone(), c.id.clone()),
                        (c.title, c.agent),
                    );
                }
            }
        }
        let (chat_title, agent) = chat_info
            .get(&(project_key.clone(), task_id.clone(), chat_id.clone()))
            .map(|(t, a)| (Some(t.clone()), Some(a.clone())))
            .unwrap_or((None, None));

        let status = handle.derive_node_status();
        let permission = if status == "permission_required" {
            handle
                .last_permission_info
                .lock()
                .ok()
                .and_then(|p| p.clone())
        } else {
            None
        };
        let prompt = if status == "busy" {
            handle.last_user_prompt.lock().ok().and_then(|p| p.clone())
        } else {
            None
        };
        let (todo_completed, todo_total) = handle
            .last_plan
            .lock()
            .ok()
            .and_then(|p| *p)
            .map(|(c, t)| (Some(c), Some(t)))
            .unwrap_or((None, None));

        out.push(ChatSnapshot {
            chat_id,
            project_id: project_key.clone(),
            task_id: task_id.clone(),
            project_name: project_names.get(&project_key).cloned(),
            task_name,
            chat_title,
            agent,
            status: status.to_string(),
            permission,
            prompt,
            todo_completed,
            todo_total,
        });
    }
    out
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
    let (shutdown_tx, _) = tokio::sync::watch::channel(false);

    let handle = Arc::new(AcpSessionHandle {
        key: key.to_string(),
        update_tx: update_tx.clone(),
        cmd_tx,
        shutdown_tx,
        agent_info: std::sync::RwLock::new(Some((
            "session-test".into(),
            "claude".into(),
            "test".into(),
        ))),
        pending_permission: Mutex::new(None),
        permission_lock: tokio::sync::Mutex::new(()),
        pending_elicitation: Mutex::new(None),
        elicitation_lock: tokio::sync::Mutex::new(()),
        active_url_elicitations: Mutex::new(HashMap::new()),
        project_key: project_key.to_string(),
        task_id: task_id.to_string(),
        chat_id: Some(chat_id.to_string()),
        artifact_dir: None,
        configured_agent_id: "test-agent".to_string(),
        suppress_emit: std::sync::atomic::AtomicBool::new(false),
        replay_user_messages: std::sync::atomic::AtomicBool::new(false),
        pending_queue: Mutex::new(Vec::new()),
        queue_paused: std::sync::atomic::AtomicBool::new(false),
        queue_drain_lock: Mutex::new(()),
        queue_mode: Mutex::new(QueueMode::default()),
        current_mode_id: Mutex::new(None),
        current_model_id: Mutex::new(None),
        current_usage: Mutex::new(None),
        current_thought_level_id: Mutex::new(None),
        thought_level_config_id: Mutex::new(None),
        model_config_id: Mutex::new(None),
        current_config_options: Mutex::new(Vec::new()),
        uses_config_options: std::sync::atomic::AtomicBool::new(false),
        working_dir: "/tmp".to_string(),
        terminal_kill_tx: Mutex::new(None),
        is_busy: std::sync::atomic::AtomicBool::new(false),
        last_assistant_text: Mutex::new(String::new()),
        active_turn_message_ids: Mutex::new(Vec::new()),
        last_turn_reply: Mutex::new(String::new()),
        pending_text_separator: std::sync::atomic::AtomicBool::new(false),
        last_user_prompt: Mutex::new(None),
        last_plan: Mutex::new(None),
        last_permission_info: Mutex::new(None),
        active_tool_calls: Mutex::new(std::collections::HashSet::new()),
        short_tool_watches: Mutex::new(HashMap::new()),
        cancel_requested: std::sync::atomic::AtomicBool::new(false),
        auth_methods: Mutex::new(Vec::new()),
        logout_capable: std::sync::atomic::AtomicBool::new(false),
        pending_auth_retry: Mutex::new(None),
        pending_auth: Mutex::new(None),
        pending_session_instruction: Mutex::new(None),
        session_instruction_revision: std::sync::atomic::AtomicU64::new(0),
        fork_capable: std::sync::atomic::AtomicBool::new(false),
        import_capable: std::sync::atomic::AtomicBool::new(false),
        delete_capable: std::sync::atomic::AtomicBool::new(false),
        close_capable: std::sync::atomic::AtomicBool::new(false),
    });

    if let Ok(mut sessions) = ACP_SESSIONS.write() {
        sessions.insert(key.to_string(), handle.clone());
    }

    let handle_for_loop = handle.clone();
    tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                AcpCommand::Prompt {
                    message_ids,
                    text,
                    attachments,
                    sender,
                    terminal,
                    config: _,
                } => {
                    handle_for_loop.emit(AcpUpdate::PromptStarted {
                        message_ids: message_ids.clone(),
                    });
                    handle_for_loop.emit(AcpUpdate::UserMessage {
                        text,
                        attachments,
                        sender,
                        terminal,
                    });
                    // 与 prod cmd loop 对齐：先 emit Busy{true}，再 Busy{false}。
                    // 让 C1 CAS 路径在测试里能真实地与 emit-store 路径交互。
                    handle_for_loop.emit(AcpUpdate::Busy { value: true });
                    handle_for_loop.emit(AcpUpdate::Busy { value: false });
                    handle_for_loop.emit(AcpUpdate::PromptCompleted {
                        message_ids,
                        stop_reason: "end_turn".to_string(),
                    });
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
    let mut meta: SessionMetadata = serde_json::from_str(&data).ok()?;

    // If there is an active local session running, the in-memory usage
    // snapshot is the real source of truth. We merge it in so the frontend
    // gets the real-time context window usage immediately on page load/history fetch
    // without waiting for the next turn to complete and write to disk.
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
    if let Some(handle) = get_session_handle(&session_key) {
        if let Ok(guard) = handle.current_usage.lock() {
            if let Some(ref snapshot) = *guard {
                meta.current_usage = Some(snapshot.clone());
            }
        }
    }

    Some(meta)
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

/// 清理 socket 文件
fn cleanup_socket_files(project_key: &str, task_id: &str, chat_id: &str) {
    let _ = std::fs::remove_file(sock_path(project_key, task_id, chat_id));
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
            config,
        } => match handle
            .send_prompt(text, attachments, sender, false, config)
            .await
        {
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
#[allow(dead_code)]
fn command_exists(cmd: &str) -> bool {
    crate::check::command_exists(cmd)
}

// ============================================================================
// Agent resolution
//
// `installed_agents` is the single source of truth. `resolve_agent` reads a
// row, picks the active installation channel via `selected_install_method`,
// and delegates to `installed_agents::spawn_for` for the spawn argv. Custom
// agents (from `config.acp.custom_agents`) take precedence — they're
// user-defined and may overlap with marketplace ids.
//
// No PATH probing here — `installed_agents` is the single source of truth.
// Rows are kept in sync with PATH presence by
// `installed_agents::auto_scan_path_binaries()`, which runs on every
// marketplace render and uniformly handles every registry agent.
// ============================================================================

/// Resolve an agent id into a runnable `ResolvedAgent`. Returns `None` when
/// nothing matches — the caller surfaces "agent unavailable" in the UI.
///
/// Post-v2.6, every on-disk id (sessions, config, installed_agents) is
/// canonical via the boot-time remap migration, so this function does
/// exact-id matches only. Callers that might still carry a legacy id
/// (e.g. inbound HTTP body) should call
/// `installed_agents::canonicalize_agent_id` first.
///
/// Order:
///   1. Custom agents (`config.acp.custom_agents`) — exact-id match.
///   2. `installed_agents` row → `spawn_for` produces the (cmd, args)
///      using the active installation channel + the registry document
///      for args.
pub fn resolve_agent(agent_name: &str) -> Option<ResolvedAgent> {
    // 1. Custom agents from config.toml. Highest priority — user
    // explicitly defined this id, so it overrides any same-id row in
    // installed_agents.
    let config = crate::storage::config::load_config();
    if let Some(custom) = config.acp.custom_agents.iter().find(|a| a.id == agent_name) {
        return Some(ResolvedAgent {
            agent_type: custom.agent_type.clone(),
            agent_name: custom.id.clone(),
            command: custom.command.clone().unwrap_or_default(),
            args: custom.args.clone(),
            url: custom.url.clone(),
            auth_header: custom.auth_header.clone(),
        });
    }

    // 2. installed_agents row → spawn_for produces the (cmd, args) using
    // the active installation channel + registry distribution args. Post-
    // v2.6, every on-disk id (sessions, config) is canonical, so we look
    // up directly.
    let installed = crate::storage::installed_agents::get(agent_name)
        .ok()
        .flatten()?;
    let registry = crate::storage::agent_registry::get();
    let reg_entry = registry.agents.iter().find(|a| a.id == installed.id);
    let (command, args) = crate::storage::installed_agents::spawn_for(&installed, reg_entry)?;

    Some(ResolvedAgent {
        agent_type: "local".into(),
        agent_name: installed.id.clone(),
        command,
        args,
        url: None,
        auth_header: None,
    })
}

/// Pick the first installed_agents row by `created_at` for default-agent
/// selection. Custom agents (config.toml) take precedence — that's how
/// users override the default. Hidden rows are skipped.
pub fn pick_first_available_acp_agent() -> Option<String> {
    let config = crate::storage::config::load_config();
    if let Some(custom) = config.acp.custom_agents.first() {
        return Some(custom.id.clone());
    }
    crate::storage::installed_agents::list()
        .ok()?
        .into_iter()
        .find(|a| !a.hidden && a.has_installed_channel())
        .map(|a| a.id)
}

/// Pick the first terminal-capable agent that's currently installed.
///
/// Terminal-capability is registry-data-driven: any agent whose
/// `terminal_launch` field is set (via `inject_grove_supplements`) qualifies.
/// Today that's just `claude-acp`, but the function doesn't know or care.
///
/// Ordering: registry document insertion order — upstream CDN order
/// followed by `inject_trae_and_traex_entries` / `inject_grove_supplements`
/// patches. Stable for the same registry document. TODO: once a second
/// terminal-capable agent ships, switch to a deterministic
/// alphabetic-by-id (or supplements-priority) order to avoid silent
/// default flips when CDN order changes.
pub fn pick_first_available_terminal_agent() -> Option<String> {
    let registry = crate::storage::agent_registry::get();
    for reg in &registry.agents {
        if reg.terminal_launch.is_none() {
            continue;
        }
        if let Some(installed) = crate::storage::installed_agents::get(&reg.id)
            .ok()
            .flatten()
        {
            if !installed.hidden && installed.has_installed_channel() {
                return Some(installed.id);
            }
        }
    }
    None
}

/// Ensure `config.toml` has sensible `acp.agent_command` /
/// `layout.agent_command` defaults given the currently-installed agents.
/// Runs once at server startup. Silent no-op if the configured agents
/// are already valid (resolve_agent returns Some for them).
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

    // Terminal-mode validity: the configured id must match a registry
    // entry that declares `terminal_launch`, AND have an installed,
    // non-hidden row. Data-driven via the registry — no agent-specific
    // code here.
    let terminal_valid = match &config.layout.agent_command {
        Some(name) if !name.is_empty() => {
            let registry_supports = crate::storage::agent_registry::get()
                .agents
                .iter()
                .any(|a| a.id == *name && a.terminal_launch.is_some());
            registry_supports
                && crate::storage::installed_agents::get(name)
                    .ok()
                    .flatten()
                    .map(|a| !a.hidden && a.has_installed_channel())
                    .unwrap_or(false)
        }
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

/// ACP 通知事件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcpNotificationEvent {
    /// Chat Turn End（Agent 回应完成）
    TurnComplete,
    /// Agent 权限请求
    PermissionRequired,
    /// Agent requests structured input through ACP Elicitation.
    ElicitationRequired,
}

/// 发送 ACP 事件通知。
/// notification_enabled 是主开关，notification_show_* 是每个事件类型的子开关，
/// 子开关同时控制声音和系统横幅，声音内容仍从 hooks config 读取。
fn notify_acp_event(
    project_key: &str,
    task_id: &str,
    chat_id: Option<&str>,
    title_suffix: &str,
    message: &str,
    event: AcpNotificationEvent,
    options: Option<&[PermOptionData]>,
) {
    use crate::hooks::{self, NotificationLevel};
    use crate::storage::{config, tasks as task_storage};

    let full_cfg = config::load_config();
    let hooks_cfg = full_cfg.hooks;
    let notif_cfg = full_cfg.notifications;

    // 主开关 + 事件子开关决定本次是否触发任何通知
    let event_enabled = notif_cfg.notification_enabled
        && match event {
            AcpNotificationEvent::TurnComplete => notif_cfg.notification_show_done,
            AcpNotificationEvent::PermissionRequired => notif_cfg.notification_show_permission,
            AcpNotificationEvent::ElicitationRequired => notif_cfg.notification_show_elicitation,
        };

    if !event_enabled {
        let level = if title_suffix.contains("Permission") {
            NotificationLevel::Warn
        } else {
            NotificationLevel::Notice
        };
        // External shell hooks always fire regardless of in-app notification settings —
        // they are a separate mechanism from the tray/system-banner notification system.
        hooks::update_hook(
            project_key,
            task_id,
            level,
            Some(message.to_string()),
            chat_id.map(str::to_string),
        );
        return;
    }

    // ── 声音 ──────────────────────────────────────────────────────────────
    let sound = match event {
        AcpNotificationEvent::TurnComplete => {
            if hooks_cfg.response_sound_enabled {
                Some(if hooks_cfg.response_sound.is_empty() {
                    "Glass"
                } else {
                    &hooks_cfg.response_sound
                })
            } else {
                None
            }
        }
        AcpNotificationEvent::PermissionRequired => {
            if hooks_cfg.permission_sound_enabled {
                Some(if hooks_cfg.permission_sound.is_empty() {
                    "Purr"
                } else {
                    &hooks_cfg.permission_sound
                })
            } else {
                None
            }
        }
        AcpNotificationEvent::ElicitationRequired => None,
    };
    if let Some(s) = sound {
        hooks::play_sound(s);
    }

    // ── 系统横幅 ───────────────────────────────────────────────────────────
    {
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
        let is_permission = event == AcpNotificationEvent::PermissionRequired;

        let mut approve_opt = None;
        let mut deny_opt = None;
        if let Some(opts) = options {
            // 只匹配明确的 allow 类型，找不到就不设按钮（不猜测）
            approve_opt = opts
                .iter()
                .find(|o| o.kind == "allow_once")
                .or_else(|| opts.iter().find(|o| o.kind == "allow_always"))
                .or_else(|| opts.iter().find(|o| o.kind.contains("allow")))
                .map(|o| o.option_id.as_str());

            // 只匹配明确的 reject/deny 类型，找不到就不设按钮（不猜测）
            deny_opt = opts
                .iter()
                .find(|o| o.kind == "reject_once")
                .or_else(|| opts.iter().find(|o| o.kind == "reject_always"))
                .or_else(|| {
                    opts.iter()
                        .find(|o| o.kind.contains("reject") || o.kind.contains("deny"))
                })
                .map(|o| o.option_id.as_str());
        }

        hooks::send_banner(
            &title,
            &banner_msg,
            project_key,
            task_id,
            chat_id,
            is_permission,
            approve_opt,
            deny_opt,
        );
    }

    let level = if title_suffix.contains("Permission") {
        NotificationLevel::Warn
    } else {
        NotificationLevel::Notice
    };
    hooks::update_hook(
        project_key,
        task_id,
        level,
        Some(message.to_string()),
        chat_id.map(str::to_string),
    );
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

/// Gating check: dev-only feature, and only when the env opt-in is set.
/// `cfg!(debug_assertions)` is true for `cargo run` / `cargo build` and false
/// for `--release`, so production binaries never honor `ACP_DEBUG`.
fn acp_debug_enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("ACP_DEBUG").as_deref() == Ok("1")
}

fn open_acp_log(path: &std::path::Path) -> Option<Arc<Mutex<std::fs::File>>> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
        .map(|f| Arc::new(Mutex::new(f)))
}

/// Buffers bytes flowing in one direction and flushes per newline-terminated
/// JSON-RPC frame. ACP transport is NDJSON over stdio, so `\n` cleanly
/// delimits message boundaries.
struct AcpLogTap {
    file: Arc<Mutex<std::fs::File>>,
    direction: &'static str,
    buf: Vec<u8>,
}

impl AcpLogTap {
    fn new(file: Arc<Mutex<std::fs::File>>, direction: &'static str) -> Self {
        Self {
            file,
            direction,
            buf: Vec::new(),
        }
    }

    fn record(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.buf.extend_from_slice(bytes);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let mut end = line.len() - 1;
            if end > 0 && line[end - 1] == b'\r' {
                end -= 1;
            }
            let payload = String::from_utf8_lossy(&line[..end]);
            let ts = chrono::Utc::now().to_rfc3339();
            if let Ok(mut f) = self.file.lock() {
                use std::io::Write;
                let _ = writeln!(f, "[{}] {} {}", ts, self.direction, payload);
                let _ = f.flush();
            }
        }
    }
}

struct LoggingAsyncWrite {
    inner: Box<dyn futures::AsyncWrite + Send + Unpin>,
    tap: AcpLogTap,
}

impl futures::AsyncWrite for LoggingAsyncWrite {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = std::pin::Pin::into_inner(self);
        match std::pin::Pin::new(&mut *this.inner).poll_write(cx, buf) {
            std::task::Poll::Ready(Ok(n)) => {
                this.tap.record(&buf[..n]);
                std::task::Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = std::pin::Pin::into_inner(self);
        std::pin::Pin::new(&mut *this.inner).poll_flush(cx)
    }

    fn poll_close(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = std::pin::Pin::into_inner(self);
        std::pin::Pin::new(&mut *this.inner).poll_close(cx)
    }
}

struct LoggingAsyncRead {
    inner: Box<dyn futures::AsyncRead + Send + Unpin>,
    tap: AcpLogTap,
}

impl futures::AsyncRead for LoggingAsyncRead {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut [u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = std::pin::Pin::into_inner(self);
        match std::pin::Pin::new(&mut *this.inner).poll_read(cx, buf) {
            std::task::Poll::Ready(Ok(n)) => {
                this.tap.record(&buf[..n]);
                std::task::Poll::Ready(Ok(n))
            }
            other => other,
        }
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

    #[tokio::test]
    async fn compact_queue_preserves_accepted_message_ids() {
        let key = format!("compact-message-id-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        handle.set_queue_mode(QueueMode::Compact);
        let first = QueuedMessage::new("one".into(), vec![], None, false, None);
        let second = QueuedMessage::new("two".into(), vec![], None, false, None);
        let expected = vec![first.id.clone(), second.id.clone()];
        handle.queue_message(first);
        handle.queue_message(second);

        let (merged, _) = handle.pop_queue_for_auto_send().expect("merged queue");
        assert_eq!(merged.message_ids, expected);
    }

    #[tokio::test]
    async fn tracked_prompt_returns_the_lifecycle_message_id() {
        let key = format!("tracked-message-id-test-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let message_id = handle
            .send_tracked_prompt("hello".into(), vec![], None, false, None)
            .await
            .expect("prompt accepted");

        loop {
            if let AcpUpdate::PromptStarted { message_ids } =
                updates.recv().await.expect("lifecycle update")
            {
                assert_eq!(message_ids, vec![message_id]);
                break;
            }
        }
    }

    #[tokio::test]
    async fn pending_session_instruction_keeps_latest_toggle_until_matching_turn_completes() {
        let key = format!("session-instruction-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");

        handle.set_pending_session_instruction("agent_voice", "enabled".to_string());
        let enabled = handle
            .pending_session_instruction_snapshot()
            .expect("enabled instruction");
        handle.set_pending_session_instruction("agent_voice", "disabled".to_string());

        handle.clear_pending_session_instruction(enabled.0);
        let current = handle
            .pending_session_instruction_snapshot()
            .expect("newer instruction must remain");
        assert_eq!(current.1, "agent_voice");
        assert_eq!(current.2, "disabled");

        handle.clear_pending_session_instruction(current.0);
        assert!(handle.pending_session_instruction_snapshot().is_none());
    }

    #[tokio::test]
    async fn editing_a_queued_message_while_busy_preserves_its_position() {
        let key = format!("queue-edit-order-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let first = QueuedMessage::new("first".to_string(), Vec::new(), None, false, None);
        let first_id = first.id.clone();
        let second = QueuedMessage::new("second".to_string(), Vec::new(), None, false, None);
        let second_id = second.id.clone();
        handle.queue_message(first);
        handle.queue_message(second);
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Relaxed);

        handle.pause_queue();
        let (found, _) = handle.update_queued_message_by_id(&first_id, "first edited".to_string());
        assert!(found);
        handle.resume_queue();

        let queue = handle.get_queue();
        assert_eq!(
            queue
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec![first_id.as_str(), second_id.as_str()]
        );
        assert_eq!(queue[0].text, "first edited");
    }

    #[test]
    fn only_agent_memory_mcp_tools_use_the_short_watchdog() {
        assert!(is_short_memory_tool("mcp.grove_agent.memory_append_log"));
        assert!(is_short_memory_tool(
            "Tool: grove_agent/memory_get_recent_logs"
        ));
        assert!(!is_short_memory_tool("mcp.grove_agent.grove_agent_spawn"));
        assert!(!is_short_memory_tool("memory_append_log"));
    }

    #[test]
    fn working_memory_instruction_requires_initial_retrieval_and_timely_append() {
        for tool in [
            "memory_recall",
            "memory_get_recent_logs",
            "memory_read",
            "memory_append_log",
        ] {
            assert!(WORKING_MEMORY_INSTRUCTION.contains(tool));
        }
        assert!(WORKING_MEMORY_INSTRUCTION.contains(
            "At the start of every new Working Session, before substantive work, always search Project Memory"
        ));
        assert!(WORKING_MEMORY_INSTRUCTION.contains(
            "Do not decide that Memory is unnecessary without performing this initial retrieval"
        ));
        assert!(
            WORKING_MEMORY_INSTRUCTION.contains("before relying on it or proceeding with the work")
        );
        assert!(WORKING_MEMORY_INSTRUCTION
            .contains("Repeat Memory retrieval when the user's primary intent materially changes"));
        assert!(WORKING_MEMORY_INSTRUCTION.contains(
            "Do not repeat an equivalent search when the applicable Memory has already been read"
        ));
        assert!(WORKING_MEMORY_INSTRUCTION
            .contains("If required context is still missing after this search, then ask the user"));
        assert!(
            WORKING_MEMORY_INSTRUCTION.contains("in the same turn as soon as its meaning is clear")
        );
        assert!(WORKING_MEMORY_INSTRUCTION.contains(
            "Do not defer the Log until Task completion, Session completion, or a later reminder"
        ));
    }

    fn client_state_for_test(
        handle: Arc<AcpSessionHandle>,
        terminals: Arc<Mutex<HashMap<String, TerminalState>>>,
    ) -> Arc<AcpClientState> {
        Arc::new(AcpClientState {
            handle,
            configured_agent_name: "test".to_string(),
            working_dir: PathBuf::from("/tmp"),
            terminals,
            project_key: "project".to_string(),
            task_id: "task".to_string(),
            chat_id: Some("chat".to_string()),
            adapter: adapter::resolve_adapter("test", "test"),
            file_snapshots: Mutex::new(HashMap::new()),
            write_tool_paths: Mutex::new(HashMap::new()),
        })
    }

    #[tokio::test]
    async fn session_notifications_are_scoped_to_the_handles_active_session() {
        let key = format!("session-notification-routing-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");

        assert!(session_notification_targets_handle(
            &handle,
            &acp::SessionId::new("session-test")
        ));
        assert!(!session_notification_targets_handle(
            &handle,
            &acp::SessionId::new("another-session")
        ));

        // Before session/new or session/load returns, the active ID is not
        // known yet. Accept early notifications during that window.
        *handle.agent_info.write().unwrap() = None;
        assert!(session_notification_targets_handle(
            &handle,
            &acp::SessionId::new("new-session")
        ));
    }

    #[test]
    fn initialization_rejects_non_v1_protocol_version() {
        assert!(validate_v1_protocol_version(acp::ProtocolVersion::V1).is_ok());

        let v2: acp::ProtocolVersion = serde_json::from_value(serde_json::json!(2)).unwrap();
        let error = validate_v1_protocol_version(v2).unwrap_err();
        assert_eq!(
            error.message,
            "Unable to connect to this agent. This agent uses ACP protocol version 2, but Grove currently supports version 1 only."
        );
    }

    #[test]
    fn initialization_omitted_prompt_capabilities_are_unsupported() {
        let capabilities = PromptCapabilitiesData::default();

        assert!(!capabilities.image);
        assert!(!capabilities.audio);
        assert!(!capabilities.embedded_context);

        let partial: PromptCapabilitiesData =
            serde_json::from_value(serde_json::json!({ "image": true })).unwrap();
        assert!(partial.image);
        assert!(!partial.audio);
        assert!(!partial.embedded_context);
    }

    #[test]
    fn session_delete_capability_requires_an_advertised_object() {
        let omitted: acp::SessionCapabilities =
            serde_json::from_value(serde_json::json!({})).unwrap();
        let null: acp::SessionCapabilities =
            serde_json::from_value(serde_json::json!({ "delete": null })).unwrap();
        let advertised: acp::SessionCapabilities =
            serde_json::from_value(serde_json::json!({ "delete": {} })).unwrap();

        assert!(omitted.delete.is_none());
        assert!(null.delete.is_none());
        assert!(advertised.delete.is_some());
    }

    #[test]
    fn session_delete_request_preserves_the_opaque_session_id() {
        let request = acp::DeleteSessionRequest::new("agent/session:opaque-123");
        let json = serde_json::to_value(request).unwrap();

        assert_eq!(
            json,
            serde_json::json!({ "sessionId": "agent/session:opaque-123" })
        );
    }

    #[test]
    fn session_delete_accepts_an_empty_success_result() {
        let response: acp::DeleteSessionResponse =
            serde_json::from_value(serde_json::json!({})).unwrap();

        assert!(response.meta.is_none());
    }

    #[tokio::test]
    async fn handle_kill_is_reliably_delivered_through_the_command_queue() {
        let key = format!("delete-shutdown-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");

        assert!(!handle.shutdown_requested());
        handle.kill().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !handle.cmd_tx.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!handle.shutdown_requested());
    }

    #[tokio::test]
    async fn cancelling_a_turn_cancels_permission_and_active_tools_locally() {
        let key = format!("turn-cancel-test-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let (permission_tx, permission_rx) = tokio::sync::oneshot::channel();
        handle
            .pending_permission
            .lock()
            .unwrap()
            .replace(("permission-1".to_string(), permission_tx));
        handle
            .active_tool_calls
            .lock()
            .unwrap()
            .insert("tool-1".to_string());

        handle.cancel_current_turn_state();

        assert!(permission_rx.await.is_err());
        assert!(handle
            .cancel_requested
            .load(std::sync::atomic::Ordering::Relaxed));
        assert!(handle.active_tool_calls.lock().unwrap().is_empty());

        let first = updates.recv().await.unwrap();
        let second = updates.recv().await.unwrap();
        assert!(matches!(
            first,
            AcpUpdate::PermissionResponse { id, option_id }
                if id == "permission-1" && option_id == "Cancelled"
        ));
        assert!(matches!(
            second,
            AcpUpdate::ToolCallUpdate { id, status, .. }
                if id == "tool-1" && status == "cancelled"
        ));
    }

    #[tokio::test]
    async fn request_cancellation_only_clears_the_matching_permission() {
        let key = format!("request-cancel-permission-test-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let (permission_tx, permission_rx) = tokio::sync::oneshot::channel();
        handle
            .pending_permission
            .lock()
            .unwrap()
            .replace(("permission-1".to_string(), permission_tx));

        assert!(!handle.cancel_pending_permission("older-permission"));
        assert_eq!(
            handle.pending_permission_id().as_deref(),
            Some("permission-1")
        );

        assert!(handle.cancel_pending_permission("permission-1"));
        assert!(permission_rx.await.is_err());
        assert!(!handle.has_pending_permission());
        assert!(matches!(
            updates.recv().await.unwrap(),
            AcpUpdate::PermissionResponse { id, option_id }
                if id == "permission-1" && option_id == "Cancelled"
        ));
    }

    #[test]
    fn terminal_shell_command_preserves_protocol_argument_boundaries() {
        assert_eq!(
            build_terminal_shell_command(
                "/tmp/tool with spaces",
                &[
                    "hello world".to_string(),
                    "a'b".to_string(),
                    "$HOME; touch nope".to_string(),
                ],
            ),
            "'/tmp/tool with spaces' 'hello world' 'a'\"'\"'b' '$HOME; touch nope'"
        );
        assert_eq!(
            build_terminal_shell_command("printf 'compatibility command'", &[]),
            "printf 'compatibility command'"
        );
    }

    #[test]
    fn terminal_output_limit_keeps_utf8_character_boundaries() {
        let runtime = Arc::new(Mutex::new(TerminalRuntime {
            output: String::new(),
            stdout_pending_utf8: Vec::new(),
            stderr_pending_utf8: Vec::new(),
            truncated: false,
            output_byte_limit: Some(4),
            linked_to_tool_call: true,
        }));
        let bytes = "a世界".as_bytes();

        assert!(append_terminal_output(&runtime, TerminalStream::Stdout, &bytes[..2]).is_some());
        assert!(append_terminal_output(&runtime, TerminalStream::Stdout, &bytes[2..]).is_some());

        let runtime = runtime.lock().unwrap();
        assert_eq!(runtime.output, "界");
        assert!(runtime.truncated);
        assert!(runtime.stdout_pending_utf8.is_empty());
    }

    #[tokio::test]
    async fn terminal_create_rejects_relative_working_directory() {
        let key = format!("terminal-relative-cwd-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let state = client_state_for_test(handle, Arc::clone(&terminals));
        let request = acp::CreateTerminalRequest::new("session-test", "pwd")
            .cwd(PathBuf::from("relative/path"));

        assert!(handle_create_terminal(&state, request).await.is_err());
        assert!(terminals.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn terminal_create_preserves_arguments_and_retains_completed_output() {
        let key = format!("terminal-create-output-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let state = client_state_for_test(handle, Arc::clone(&terminals));
        let request = acp::CreateTerminalRequest::new("session-test", "printf")
            .args(vec!["%s".to_string(), "hello world".to_string()]);

        let created = handle_create_terminal(&state, request).await.unwrap();
        let terminal_id = created.terminal_id.to_string();
        let embedded = tool_contents_to_data(
            &adapter::DefaultAdapter,
            &[acp::ToolCallContent::Terminal(acp::Terminal::new(
                terminal_id.clone(),
            ))],
            Some(&terminals),
        );
        assert!(matches!(
            &embedded[0],
            ToolCallContentData::Terminal {
                terminal_id: id,
                output: Some(_),
                ..
            } if id == &terminal_id
        ));

        // Subscribe after this short command has normally exited. The status
        // must still be retained for late terminal/output and wait callers.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let mut exit_rx = terminals
            .lock()
            .unwrap()
            .get(&terminal_id)
            .unwrap()
            .exit_tx
            .subscribe();

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            exit_rx.wait_for(|status| status.is_some()),
        )
        .await
        .expect("terminal command should exit")
        .expect("terminal exit channel should remain open");

        let output = handle_terminal_output(
            &state,
            acp::TerminalOutputRequest::new("session-test", terminal_id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(output.output, "hello world");
        assert_eq!(
            output.exit_status.and_then(|status| status.exit_code),
            Some(0)
        );

        handle_release_terminal(
            &state,
            acp::ReleaseTerminalRequest::new("session-test", terminal_id.clone()),
        )
        .await
        .unwrap();
        assert!(!terminals.lock().unwrap().contains_key(&terminal_id));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_exit_status_includes_the_terminating_signal() {
        let status = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("kill -TERM $$")
            .status()
            .await
            .unwrap();
        let status = terminal_exit_status(status);

        assert_eq!(status.exit_code, None);
        assert_eq!(status.signal.as_deref(), Some("SIGTERM"));
    }

    #[tokio::test]
    async fn cancel_request_stops_terminal_wait_without_killing_terminal() {
        use tokio::io::AsyncWriteExt;

        let key = format!("request-cancel-terminal-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let (kill_tx, mut kill_rx) = mpsc::channel(1);
        let (exit_tx, _exit_rx) = tokio::sync::watch::channel(None);
        terminals.lock().unwrap().insert(
            "terminal-1".to_string(),
            TerminalState {
                kill_tx,
                runtime: Arc::new(Mutex::new(TerminalRuntime {
                    output: String::new(),
                    stdout_pending_utf8: Vec::new(),
                    stderr_pending_utf8: Vec::new(),
                    truncated: false,
                    output_byte_limit: None,
                    linked_to_tool_call: false,
                })),
                exit_tx,
            },
        );
        let state = client_state_for_test(handle, Arc::clone(&terminals));

        let (client_writer, peer_reader) = tokio::io::duplex(4096);
        let (mut peer_writer, client_reader) = tokio::io::duplex(4096);
        let transport = acp::ByteStreams::new(client_writer.compat_write(), client_reader.compat());
        let client = acp::Client.builder().on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |req: acp::WaitForTerminalExitRequest, responder, cx| {
                    let state = Arc::clone(&state);
                    cx.spawn(async move {
                        let cancellation = responder.cancellation();
                        match handle_wait_for_terminal_exit(&state, req, cancellation).await {
                            Ok(response) => responder.respond(response),
                            Err(error) => responder.respond_with_error(error),
                        }
                    })?;
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        );

        let client_fut = client.connect_with(transport, |_connection| async {
            futures::future::pending::<acp::Result<()>>().await
        });
        let peer_fut = async move {
            peer_writer
                .write_all(
                    concat!(
                        r#"{"jsonrpc":"2.0","id":"wait-1","method":"terminal/wait_for_exit","params":{"sessionId":"session-test","terminalId":"terminal-1"}}"#,
                        "\n",
                        r#"{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"wait-1"}}"#,
                        "\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut reader = tokio::io::BufReader::new(peer_reader);
            let mut line = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                reader.read_line(&mut line),
            )
            .await
            .expect("cancelled wait should receive a response")
            .unwrap();
            drop(peer_writer);
            serde_json::from_str::<serde_json::Value>(line.trim()).unwrap()
        };

        let response = tokio::select! {
            response = peer_fut => response,
            result = client_fut => panic!("client connection ended before cancellation response: {result:?}"),
        };
        assert_eq!(response["id"], "wait-1");
        assert_eq!(response["error"]["code"], -32800);
        assert!(terminals.lock().unwrap().contains_key("terminal-1"));
        assert!(kill_rx.try_recv().is_err());
    }

    #[test]
    fn prompt_content_validation_applies_only_to_optional_content_types() {
        let capabilities = PromptCapabilitiesData::default();
        let baseline = vec![
            ContentBlockData::Text {
                text: "hello".to_string(),
            },
            ContentBlockData::ResourceLink {
                uri: "file:///tmp/context.txt".to_string(),
                name: "context.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                size: None,
                title: None,
                description: None,
                label: None,
            },
        ];
        assert!(validate_prompt_content(&capabilities, &baseline).is_ok());

        let image = vec![ContentBlockData::Image {
            data: "base64".to_string(),
            mime_type: "image/png".to_string(),
            uri: None,
            label: None,
        }];
        let audio = vec![ContentBlockData::Audio {
            data: "base64".to_string(),
            mime_type: "audio/wav".to_string(),
            label: None,
        }];
        let embedded = vec![ContentBlockData::Resource {
            uri: "file:///tmp/context.txt".to_string(),
            mime_type: Some("text/plain".to_string()),
            text: Some("context".to_string()),
            blob: None,
        }];
        assert!(validate_prompt_content(&capabilities, &image).is_err());
        assert!(validate_prompt_content(&capabilities, &audio).is_err());
        assert!(validate_prompt_content(&capabilities, &embedded).is_err());

        let all = PromptCapabilitiesData {
            image: true,
            audio: true,
            embedded_context: true,
        };
        assert!(validate_prompt_content(&all, &image).is_ok());
        assert!(validate_prompt_content(&all, &audio).is_ok());
        assert!(validate_prompt_content(&all, &embedded).is_ok());
    }

    #[test]
    fn structured_content_roundtrip_preserves_protocol_fields() {
        let blocks = [
            ContentBlockData::Image {
                data: "image-data".to_string(),
                mime_type: "image/png".to_string(),
                uri: Some("file:///tmp/image.png".to_string()),
                label: Some("Image #1".to_string()),
            },
            ContentBlockData::Audio {
                data: "audio-data".to_string(),
                mime_type: "audio/wav".to_string(),
                label: Some("recording.wav".to_string()),
            },
            ContentBlockData::ResourceLink {
                uri: "file:///tmp/report.md".to_string(),
                name: "report.md".to_string(),
                mime_type: Some("text/markdown".to_string()),
                size: Some(42),
                title: Some("Report".to_string()),
                description: Some("Generated report".to_string()),
                label: None,
            },
            ContentBlockData::Resource {
                uri: "file:///tmp/context.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                text: Some("context".to_string()),
                blob: None,
            },
            ContentBlockData::Resource {
                uri: "file:///tmp/archive.bin".to_string(),
                mime_type: Some("application/octet-stream".to_string()),
                text: None,
                blob: Some("blob-data".to_string()),
            },
        ];

        let converted: Vec<_> = blocks
            .iter()
            .map(to_acp_content_block)
            .map(|block| content_block_to_data(&block).unwrap())
            .collect();

        assert!(matches!(
            &converted[0],
            ContentBlockData::Image {
                data,
                mime_type,
                uri: Some(uri),
                ..
            } if data == "image-data"
                && mime_type == "image/png"
                && uri == "file:///tmp/image.png"
        ));
        assert!(matches!(
            &converted[1],
            ContentBlockData::Audio {
                data,
                mime_type,
                label: Some(label),
            } if data == "audio-data"
                && mime_type == "audio/wav"
                && label == "recording.wav"
        ));
        assert!(matches!(
            &converted[2],
            ContentBlockData::ResourceLink {
                uri,
                name,
                mime_type: Some(mime_type),
                size: Some(42),
                title: Some(title),
                description: Some(description),
                ..
            } if uri == "file:///tmp/report.md"
                && name == "report.md"
                && mime_type == "text/markdown"
                && title == "Report"
                && description == "Generated report"
        ));
        assert!(matches!(
            &converted[3],
            ContentBlockData::Resource {
                uri,
                mime_type: Some(mime_type),
                text: Some(text),
                blob: None,
            } if uri == "file:///tmp/context.txt"
                && mime_type == "text/plain"
                && text == "context"
        ));
        assert!(matches!(
            &converted[4],
            ContentBlockData::Resource {
                uri,
                mime_type: Some(mime_type),
                text: None,
                blob: Some(blob),
            } if uri == "file:///tmp/archive.bin"
                && mime_type == "application/octet-stream"
                && blob == "blob-data"
        ));
    }

    #[test]
    fn image_display_label_is_never_used_as_protocol_uri() {
        let block = to_acp_content_block(&ContentBlockData::Image {
            data: "image-data".to_string(),
            mime_type: "image/png".to_string(),
            uri: None,
            label: Some("Image #1".to_string()),
        });

        assert!(matches!(
            block,
            acp::ContentBlock::Image(image) if image.uri.is_none()
        ));
    }

    #[test]
    fn image_content_without_uri_remains_history_compatible() {
        let content: ContentBlockData = serde_json::from_value(serde_json::json!({
            "type": "image",
            "data": "image-data",
            "mime_type": "image/png",
            "label": "Image #1"
        }))
        .unwrap();

        assert!(matches!(content, ContentBlockData::Image { uri: None, .. }));
    }

    #[test]
    fn terminal_content_without_snapshot_remains_history_compatible() {
        let content: ToolCallContentData = serde_json::from_value(serde_json::json!({
            "type": "terminal",
            "terminal_id": "legacy-terminal"
        }))
        .unwrap();

        assert!(matches!(
            content,
            ToolCallContentData::Terminal {
                terminal_id,
                output: None,
                truncated: false,
                exit_status: None,
            } if terminal_id == "legacy-terminal"
        ));
    }

    #[test]
    fn plan_enum_names_match_v1_wire_values() {
        assert_eq!(plan_priority_name(&acp::PlanEntryPriority::High), "high");
        assert_eq!(
            plan_priority_name(&acp::PlanEntryPriority::Medium),
            "medium"
        );
        assert_eq!(plan_priority_name(&acp::PlanEntryPriority::Low), "low");
        assert_eq!(plan_status_name(&acp::PlanEntryStatus::Pending), "pending");
        assert_eq!(
            plan_status_name(&acp::PlanEntryStatus::InProgress),
            "in_progress"
        );
        assert_eq!(
            plan_status_name(&acp::PlanEntryStatus::Completed),
            "completed"
        );
    }

    #[test]
    fn legacy_plan_entries_normalize_status_and_allow_missing_priority() {
        let entry: PlanEntryData = serde_json::from_value(serde_json::json!({
            "content": "Implement the change",
            "status": "inprogress"
        }))
        .unwrap();

        assert_eq!(entry.status, "in_progress");
        assert_eq!(entry.priority, None);
    }

    #[test]
    fn authentication_accepts_only_advertised_method_ids() {
        let methods = vec![AuthMethodInfo {
            id: "agent-login".to_string(),
            name: "Agent login".to_string(),
            description: None,
        }];

        assert!(is_advertised_auth_method(&methods, "agent-login"));
        assert!(!is_advertised_auth_method(&methods, "other-login"));
        assert!(!is_advertised_auth_method(&[], "agent-login"));
    }

    #[test]
    fn merge_diff_locations_recovers_paths_from_tool_content() {
        let content = vec![
            acp::ToolCallContent::Diff(acp::Diff::new("/repo/model/config.go", "new config")),
            acp::ToolCallContent::Diff(acp::Diff::new(
                "/repo/dependency/fornax/client.go",
                "new client",
            )),
        ];

        assert_eq!(
            merge_diff_locations(Vec::new(), &content),
            vec![
                ("/repo/model/config.go".to_string(), None),
                ("/repo/dependency/fornax/client.go".to_string(), None),
            ]
        );
    }

    #[test]
    fn merge_diff_locations_preserves_lines_and_deduplicates_paths() {
        let explicit = vec![("/repo/model/config.go".to_string(), Some(88))];
        let content = vec![
            acp::ToolCallContent::Diff(acp::Diff::new("/repo/model/config.go", "new config")),
            acp::ToolCallContent::Content(acp::Content::new(acp::ContentBlock::Text(
                acp::TextContent::new("not a file"),
            ))),
        ];

        assert_eq!(merge_diff_locations(explicit.clone(), &content), explicit);
    }

    #[test]
    fn tool_contents_to_text_preserves_every_content_block() {
        let content = vec![
            acp::ToolCallContent::Content(acp::Content::new(acp::ContentBlock::Text(
                acp::TextContent::new("first"),
            ))),
            acp::ToolCallContent::Content(acp::Content::new(acp::ContentBlock::Text(
                acp::TextContent::new("second"),
            ))),
        ];

        assert_eq!(
            tool_contents_to_text(&adapter::DefaultAdapter, &content).as_deref(),
            Some("first\n\nsecond")
        );
    }

    #[test]
    fn tool_content_data_preserves_protocol_variants() {
        let diff = acp::Diff::new("/repo/model.rs", "new text").old_text("old text");
        let content = vec![
            acp::ToolCallContent::Content(acp::Content::new(acp::ContentBlock::Text(
                acp::TextContent::new("result"),
            ))),
            acp::ToolCallContent::Diff(diff),
            acp::ToolCallContent::Terminal(acp::Terminal::new("terminal-7")),
        ];

        let converted = tool_contents_to_data(&adapter::DefaultAdapter, &content, None);

        assert!(matches!(
            &converted[0],
            ToolCallContentData::Content {
                content: ContentBlockData::Text { text }
            } if text == "result"
        ));
        assert!(matches!(
            &converted[1],
            ToolCallContentData::Diff {
                path,
                old_text: Some(old_text),
                new_text,
                ..
            } if path == "/repo/model.rs" && old_text == "old text" && new_text == "new text"
        ));
        assert!(matches!(
            &converted[2],
            ToolCallContentData::Terminal { terminal_id, .. } if terminal_id == "terminal-7"
        ));
    }

    #[test]
    fn embedded_mcp_image_result_becomes_structured_tool_media() {
        let output = vec![ToolCallContentData::Content {
            content: ContentBlockData::Text {
                text: serde_json::json!({
                    "result": {
                        "content": [
                            { "type": "text", "text": "{\"mode\":\"viewport\"}" },
                            { "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" }
                        ]
                    }
                })
                .to_string(),
            },
        }];

        let expanded = expand_embedded_mcp_results(output);
        assert_eq!(expanded.len(), 2);
        assert!(matches!(
            &expanded[0],
            ToolCallContentData::Content {
                content: ContentBlockData::Text { text }
            } if text == "{\"mode\":\"viewport\"}"
        ));
        assert!(matches!(
            &expanded[1],
            ToolCallContentData::Content {
                content: ContentBlockData::Image { data, mime_type, .. }
            } if data == "aW1hZ2U=" && mime_type == "image/png"
        ));
    }

    #[test]
    fn ordinary_json_content_array_remains_text() {
        let text = r#"{"content":[{"type":"text","text":"plain"}]}"#;
        let output = vec![ToolCallContentData::Content {
            content: ContentBlockData::Text {
                text: text.to_string(),
            },
        }];

        let expanded = expand_embedded_mcp_results(output);
        assert!(matches!(
            &expanded[..],
            [ToolCallContentData::Content {
                content: ContentBlockData::Text { text: preserved }
            }] if preserved == text
        ));
    }

    #[test]
    fn v1_tool_update_serialization_preserves_empty_replacements_and_omissions() {
        let update = AcpUpdate::ToolCallUpdateV1 {
            id: "tool-1".to_string(),
            title: None,
            kind: None,
            status: None,
            output: Some(Vec::new()),
            display_content: None,
            locations: Some(Vec::new()),
            input: None,
            legacy_raw_input: None,
            legacy_raw_output: None,
            legacy_content: None,
        };

        let value = serde_json::to_value(update).unwrap();
        assert_eq!(value["output"], serde_json::json!([]));
        assert_eq!(value["locations"], serde_json::json!([]));
        assert!(value.get("title").is_none());
        assert!(value.get("status").is_none());
    }

    #[test]
    fn tool_kind_and_status_names_match_v1_wire_values() {
        assert_eq!(tool_kind_name(&acp::ToolKind::SwitchMode), "switch_mode");
        assert_eq!(
            tool_status_name(&acp::ToolCallStatus::InProgress),
            "in_progress"
        );
    }

    #[test]
    fn protocol_output_is_normalized_to_readable_text() {
        let raw_output = serde_json::json!({
            "formatted_output": "diff --git a/model/config.go b/model/config.go\n",
            "exit_code": 0
        });

        assert_eq!(
            protocol_output_text(Some(&raw_output)).as_deref(),
            Some("diff --git a/model/config.go b/model/config.go\n")
        );
    }

    #[test]
    fn protocol_output_retains_meaningful_fields_without_transport_metadata() {
        let raw_output = serde_json::json!({
            "session_id": "chat-internal",
            "old_title": "Old title",
            "new_title": "Readable title"
        });

        let text = protocol_output_text(Some(&raw_output)).unwrap();
        assert!(!text.contains("session_id"));
        assert!(text.contains("old_title"));
        assert!(text.contains("Readable title"));
    }

    #[test]
    fn empty_protocol_output_does_not_create_user_output() {
        let raw_output = serde_json::json!({ "formatted_output": "", "exit_code": 0 });

        assert_eq!(protocol_output_text(Some(&raw_output)), None);
    }

    #[test]
    fn tool_input_is_reduced_to_readable_fields() {
        let protocol_input = serde_json::json!({
            "call_id": "internal-call",
            "process_id": "65474",
            "turn_id": "internal-turn",
            "started_at_ms": 1785533000426_u64,
            "command": ["/bin/zsh", "-c", "rg -n 'needle' document.md"],
            "cwd": "/repo",
            "parsed_cmd": [{
                "type": "search",
                "cmd": "rg -n 'needle' document.md",
                "query": "needle",
                "path": "document.md"
            }],
            "source": "unified_exec_startup"
        });

        assert_eq!(
            tool_input_to_data(Some(&protocol_input)),
            vec![
                ToolCallInputData {
                    label: "Query".to_string(),
                    value: "needle".to_string(),
                },
                ToolCallInputData {
                    label: "Path".to_string(),
                    value: "document.md".to_string(),
                },
                ToolCallInputData {
                    label: "Command".to_string(),
                    value: "rg -n 'needle' document.md".to_string(),
                },
                ToolCallInputData {
                    label: "Working directory".to_string(),
                    value: "/repo".to_string(),
                },
            ]
        );
    }

    #[test]
    fn tool_input_retains_objects_nested_in_arrays() {
        let protocol_input = serde_json::json!({
            "steps": [
                { "path": "a.rs", "line": 12 },
                { "path": "b.rs", "line": 24 }
            ]
        });

        let fields = tool_input_to_data(Some(&protocol_input));
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].label, "Steps");
        assert!(fields[0].value.starts_with('['));
        assert!(fields[0].value.ends_with(']'));
        assert!(fields[0].value.contains("a.rs"));
        assert!(fields[0].value.contains("b.rs"));
    }

    #[test]
    fn internal_json_tool_content_is_not_rendered_as_output() {
        let content = vec![acp::ToolCallContent::Content(acp::Content::new(
            acp::ContentBlock::Text(acp::TextContent::new(
                serde_json::json!({
                    "call_id": "internal-call",
                    "process_id": "42",
                    "command": ["/bin/zsh", "-c", "true"],
                    "exit_code": 0
                })
                .to_string(),
            )),
        ))];

        assert!(tool_contents_to_data(&adapter::DefaultAdapter, &content, None).is_empty());
    }

    #[test]
    fn socket_command_serde_roundtrip() {
        let commands = vec![
            SocketCommand::Prompt {
                text: "hello".into(),
                attachments: vec![],
                sender: None,
                config: None,
            },
            SocketCommand::Prompt {
                text: "with config".into(),
                attachments: vec![],
                sender: None,
                config: Some(QueuedConfig {
                    model: Some("opus".into()),
                    mode: Some("plan".into()),
                    thought_level: None,
                    thought_level_config_id: None,
                    config_options: std::collections::BTreeMap::new(),
                }),
            },
            SocketCommand::Cancel,
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
            config: None,
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
            mode_descriptions: HashMap::new(),
            current_mode_id: Some("code".into()),
            available_models: vec![("opus".into(), "Opus".into())],
            current_model_id: Some("opus".into()),
            model_config_id: None,
            available_thought_levels: vec![],
            current_thought_level_id: None,
            thought_level_config_id: None,
            config_options: vec![],
            uses_config_options: false,
            prompt_capabilities: PromptCapabilitiesData::default(),
            available_commands: vec![],
            current_usage: None,
        };

        let json = serde_json::to_string_pretty(&meta).expect("serialize");
        let parsed: SessionMetadata = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.pid, 12345);
        assert_eq!(parsed.agent_name, "claude");
        assert_eq!(parsed.available_modes.len(), 2);
        assert!(parsed.config_options.is_empty());
        assert!(!json.contains("\"config_options\":"));
    }

    #[test]
    fn config_options_take_precedence_over_legacy_modes() {
        let legacy = Some(acp::SessionModeState::new(
            "legacy",
            vec![acp::SessionMode::new("legacy", "Legacy").description("Legacy description")],
        ));
        let config = acp::SessionConfigOption::select(
            "mode_config",
            "Mode",
            "plan",
            vec![
                acp::SessionConfigSelectOption::new("plan", "Plan"),
                acp::SessionConfigSelectOption::new("build", "Build"),
            ],
        )
        .category(acp::SessionConfigOptionCategory::Mode);

        let (available, current, config_id, descriptions) = extract_modes(&legacy, &[config], true);

        assert_eq!(available[0], ("plan".to_string(), "Plan".to_string()));
        assert_eq!(current.as_deref(), Some("plan"));
        assert_eq!(config_id.as_deref(), Some("mode_config"));
        assert!(descriptions.is_empty());

        let (empty, current, config_id, _) = extract_modes(&legacy, &[], true);
        assert!(empty.is_empty());
        assert!(current.is_none());
        assert!(config_id.is_none());

        let (_, _, _, legacy_descriptions) = extract_modes(&legacy, &[], false);
        assert_eq!(
            legacy_descriptions.get("legacy").map(String::as_str),
            Some("Legacy description")
        );
    }

    #[test]
    fn grouped_select_values_are_preserved_in_order() {
        let select = acp::SessionConfigSelect::new(
            "fast",
            vec![
                acp::SessionConfigSelectGroup::new(
                    "recommended",
                    "Recommended",
                    vec![acp::SessionConfigSelectOption::new("fast", "Fast")],
                ),
                acp::SessionConfigSelectGroup::new(
                    "advanced",
                    "Advanced",
                    vec![acp::SessionConfigSelectOption::new("deep", "Deep")],
                ),
            ],
        );

        assert_eq!(
            flatten_select_options(&select),
            vec![
                ("fast".to_string(), "Fast".to_string()),
                ("deep".to_string(), "Deep".to_string()),
            ]
        );
    }

    #[test]
    fn restart_restore_keeps_only_valid_changed_config_values_in_live_order() {
        let persisted = vec![
            acp::SessionConfigOption::boolean("autoApprove", "Auto approve", true),
            acp::SessionConfigOption::select(
                "model",
                "Model",
                "opus",
                vec![
                    acp::SessionConfigSelectOption::new("sonnet", "Sonnet"),
                    acp::SessionConfigSelectOption::new("opus", "Opus"),
                ],
            ),
            acp::SessionConfigOption::select(
                "removed",
                "Removed",
                "old",
                vec![acp::SessionConfigSelectOption::new("old", "Old")],
            ),
        ];
        let advertised = vec![
            acp::SessionConfigOption::select(
                "model",
                "Model",
                "sonnet",
                vec![
                    acp::SessionConfigSelectOption::new("sonnet", "Sonnet"),
                    acp::SessionConfigSelectOption::new("opus", "Opus"),
                ],
            ),
            acp::SessionConfigOption::boolean("autoApprove", "Auto approve", true),
        ];

        assert_eq!(
            config_options_to_restore(&persisted, &advertised),
            vec![(
                "model".to_string(),
                ConfigOptionValue::Select("opus".to_string())
            )]
        );
    }

    #[test]
    fn restart_restore_rejects_saved_values_removed_by_the_agent() {
        let persisted = vec![acp::SessionConfigOption::select(
            "model",
            "Model",
            "opus",
            vec![acp::SessionConfigSelectOption::new("opus", "Opus")],
        )];
        let advertised = vec![acp::SessionConfigOption::select(
            "model",
            "Model",
            "sonnet",
            vec![acp::SessionConfigSelectOption::new("sonnet", "Sonnet")],
        )];

        assert!(config_options_to_restore(&persisted, &advertised).is_empty());
    }

    #[test]
    fn restart_restore_only_reapplies_an_available_changed_legacy_mode() {
        let available = vec![
            ("code".to_string(), "Code".to_string()),
            ("plan".to_string(), "Plan".to_string()),
        ];

        assert_eq!(
            legacy_mode_to_restore(Some("plan"), Some("code"), &available).as_deref(),
            Some("plan")
        );
        assert!(legacy_mode_to_restore(Some("plan"), Some("plan"), &available).is_none());
        assert!(legacy_mode_to_restore(Some("removed"), Some("code"), &available).is_none());
    }

    #[test]
    fn session_metadata_roundtrips_full_boolean_config_snapshot() {
        let json = r#"{
            "pid": 1,
            "agent_name": "agent",
            "agent_version": "1",
            "available_modes": [],
            "current_mode_id": null,
            "available_models": [],
            "current_model_id": null,
            "config_options": [{
                "id": "autoApprove",
                "name": "Auto approve",
                "description": "Approve safe operations",
                "type": "boolean",
                "currentValue": true
            }],
            "prompt_capabilities": {},
            "available_commands": []
        }"#;

        let parsed: SessionMetadata = serde_json::from_str(json).expect("deserialize config");
        assert_eq!(parsed.config_options.len(), 1);
        assert!(matches!(
            parsed.config_options[0].kind,
            acp::SessionConfigKind::Boolean(_)
        ));
    }

    #[test]
    fn client_advertises_terminal_elicitation_and_boolean_config_options() {
        let capabilities =
            serde_json::to_value(grove_client_capabilities()).expect("serialize capabilities");

        assert_eq!(capabilities["terminal"], true);
        assert!(capabilities["session"]["configOptions"]["boolean"].is_object());
        assert!(capabilities["elicitation"]["form"].is_object());
        assert!(capabilities["elicitation"]["url"].is_object());
    }

    #[test]
    fn elicitation_content_is_checked_against_the_requested_schema() {
        let schema = acp::ElicitationSchema::new()
            .property(
                "environment",
                acp::StringPropertySchema::new()
                    .enum_values(vec!["staging".to_string(), "production".to_string()]),
                true,
            )
            .integer("replicas", 1, 10, true);
        let content = BTreeMap::from([
            (
                "environment".to_string(),
                ElicitationValueData::String("production".to_string()),
            ),
            ("replicas".to_string(), ElicitationValueData::Integer(3)),
        ]);

        let converted = convert_elicitation_content(&schema, content).expect("valid content");
        assert_eq!(
            converted.get("environment"),
            Some(&acp::ElicitationContentValue::String(
                "production".to_string()
            ))
        );
        assert_eq!(
            converted.get("replicas"),
            Some(&acp::ElicitationContentValue::Integer(3))
        );

        let invalid = BTreeMap::from([
            (
                "environment".to_string(),
                ElicitationValueData::String("unknown".to_string()),
            ),
            ("replicas".to_string(), ElicitationValueData::Integer(3)),
        ]);
        assert!(convert_elicitation_content(&schema, invalid).is_err());
    }

    #[tokio::test]
    async fn invalid_elicitation_response_keeps_the_form_pending() {
        let key = format!("elicitation-response-test-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let request = acp::CreateElicitationRequest::new(
            acp::ElicitationFormMode::new(
                acp::ElicitationSessionScope::new("session-test"),
                acp::ElicitationSchema::new().string("name", true),
            ),
            "Your name",
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        handle
            .pending_elicitation
            .lock()
            .unwrap()
            .replace(PendingElicitation {
                snapshot: ElicitationRequestSnapshot {
                    request_id: "request-1".to_string(),
                    agent_name: "Test Agent".to_string(),
                    request,
                    opened: false,
                },
                response_tx: tx,
            });

        let result = handle.respond_elicitation(
            "request-1",
            ElicitationResponseData::Accept {
                content: Some(BTreeMap::new()),
            },
        );
        assert!(matches!(result, ElicitationResponseResult::Invalid(_)));
        assert!(handle.pending_elicitation_snapshot().is_some());

        let result = handle.respond_elicitation(
            "request-1",
            ElicitationResponseData::Accept {
                content: Some(BTreeMap::from([(
                    "name".to_string(),
                    ElicitationValueData::String("Ada".to_string()),
                )])),
            },
        );
        assert!(matches!(result, ElicitationResponseResult::Accepted));
        assert!(matches!(
            rx.await.expect("response delivered"),
            ElicitationResponseData::Accept { .. }
        ));
        assert!(handle.pending_elicitation_snapshot().is_none());
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
