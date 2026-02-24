//! ACP (Agent Client Protocol) 核心模块
//!
//! 管理 ACP agent 子进程的生命周期和 JSON-RPC 通信。
//! Grove 作为 ACP Client，启动 agent 子进程并通过 stdio 交互。

#![allow(dead_code)] // Public API — used by CLI now, Web frontend later

pub mod adapter;

use acp::Agent; // Required for .initialize(), .new_session(), .prompt(), .cancel()
use agent_client_protocol as acp;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::sync::{broadcast, mpsc};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// 全局 ACP 会话注册表
static ACP_SESSIONS: once_cell::sync::Lazy<RwLock<HashMap<String, Arc<AcpSessionHandle>>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(HashMap::new()));

/// ACP 会话句柄 — 外部持有，用于查询状态和发送操作
pub struct AcpSessionHandle {
    pub key: String,
    pub update_tx: broadcast::Sender<AcpUpdate>,
    cmd_tx: mpsc::Sender<AcpCommand>,
    /// Agent info stored after initialization: (session_id, name, version)
    pub agent_info: std::sync::RwLock<Option<(String, String, String)>>,
    /// 历史消息缓冲区（用于 WebSocket 重连时回放）
    history: RwLock<Vec<AcpUpdate>>,
    /// 待处理的权限请求响应 channel
    pending_permission: Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
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
}

/// 发送给 ACP 后台任务的命令
enum AcpCommand {
    Prompt {
        text: String,
        attachments: Vec<ContentBlockData>,
    },
    Cancel,
    Kill,
    SetMode {
        mode_id: String,
    },
    SetModel {
        model_id: String,
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
    },
    /// 工具调用更新
    ToolCallUpdate {
        id: String,
        status: String,
        content: Option<String>,
        locations: Vec<(String, Option<u32>)>,
    },
    /// 权限请求（带选项，等待用户交互）
    PermissionRequest {
        description: String,
        options: Vec<PermOptionData>,
    },
    /// 用户对权限请求的响应（记录到历史用于回放）
    PermissionResponse { option_id: String },
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
    },
    /// Mode 变更通知
    ModeChanged { mode_id: String },
    /// Agent Plan 更新（结构化 TODO 列表）
    PlanUpdate { entries: Vec<PlanEntryData> },
    /// 可用 Slash Commands 更新
    AvailableCommands { commands: Vec<CommandInfo> },
    /// 待执行消息队列更新
    QueueUpdate { messages: Vec<QueuedMessage> },
    /// 会话结束
    SessionEnded,
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
    },
    Audio {
        data: String,
        mime_type: String,
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
}

/// ACP 启动配置
pub struct AcpStartConfig {
    pub agent_command: String,
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

/// Grove 的 ACP Client 实现
struct GroveAcpClient {
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
}

#[async_trait::async_trait(?Send)]
impl acp::Client for GroveAcpClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
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

        // 创建 oneshot channel 等待用户响应
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.handle.pending_permission.lock().unwrap().replace(tx);

        // 发送权限请求给前端
        self.handle.emit(AcpUpdate::PermissionRequest {
            description: desc.clone(),
            options,
        });

        // 发送系统通知（声音 + 横幅 + hooks.toml）
        notify_acp_event(
            &self.project_key,
            &self.task_id,
            "Permission Required",
            &desc,
            "Purr",
        );

        // 等待用户选择
        match rx.await {
            Ok(option_id) => Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            )),
            Err(_) => Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Cancelled,
            )),
        }
    }

    async fn write_text_file(
        &self,
        _args: acp::WriteTextFileRequest,
    ) -> acp::Result<acp::WriteTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn read_text_file(
        &self,
        _args: acp::ReadTextFileRequest,
    ) -> acp::Result<acp::ReadTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn create_terminal(
        &self,
        args: acp::CreateTerminalRequest,
    ) -> acp::Result<acp::CreateTerminalResponse> {
        let id = format!(
            "term_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let cwd = args.cwd.unwrap_or_else(|| self.working_dir.clone());

        // Agent 发来的 command 可能是完整 shell 命令字符串（含 &&、|、;、空格参数等），
        // 必须通过 sh -c 执行，否则 Command::new() 会把整个字符串当可执行文件路径。
        let shell_cmd = if args.args.is_empty() {
            args.command.clone()
        } else {
            format!("{} {}", args.command, args.args.join(" "))
        };

        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg(&shell_cmd)
            .current_dir(&cwd)
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

        let state = TerminalState {
            kill_tx,
            output: Vec::new(),
            truncated: false,
            output_byte_limit: args.output_byte_limit,
            exit_status: None,
            exit_notify: exit_notify.clone(),
        };

        self.terminals.lock().unwrap().insert(id.clone(), state);

        let terminals = self.terminals.clone();
        let term_id = id.clone();
        tokio::task::spawn_local(async move {
            drive_terminal(terminals, term_id, child, kill_rx, exit_notify).await;
        });

        Ok(acp::CreateTerminalResponse::new(id))
    }

    async fn terminal_output(
        &self,
        args: acp::TerminalOutputRequest,
    ) -> acp::Result<acp::TerminalOutputResponse> {
        let terms = self.terminals.lock().unwrap();
        let tid = &*args.terminal_id.0;
        let state = terms
            .get(tid)
            .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;

        let resp = acp::TerminalOutputResponse::new(
            String::from_utf8_lossy(&state.output),
            state.truncated,
        );
        Ok(if let Some(ref es) = state.exit_status {
            resp.exit_status(es.clone())
        } else {
            resp
        })
    }

    async fn release_terminal(
        &self,
        args: acp::ReleaseTerminalRequest,
    ) -> acp::Result<acp::ReleaseTerminalResponse> {
        let mut terms = self.terminals.lock().unwrap();
        let tid = &*args.terminal_id.0;
        if let Some(state) = terms.remove(tid) {
            let _ = state.kill_tx.try_send(());
        }
        Ok(acp::ReleaseTerminalResponse::default())
    }

    async fn wait_for_terminal_exit(
        &self,
        args: acp::WaitForTerminalExitRequest,
    ) -> acp::Result<acp::WaitForTerminalExitResponse> {
        let notify = {
            let terms = self.terminals.lock().unwrap();
            let tid = &*args.terminal_id.0;
            let state = terms
                .get(tid)
                .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
            if let Some(ref status) = state.exit_status {
                return Ok(acp::WaitForTerminalExitResponse::new(status.clone()));
            }
            state.exit_notify.clone()
        };
        // Lock dropped before await
        notify.notified().await;

        let terms = self.terminals.lock().unwrap();
        let tid = &*args.terminal_id.0;
        let state = terms
            .get(tid)
            .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
        Ok(acp::WaitForTerminalExitResponse::new(
            state.exit_status.clone().unwrap_or_default(),
        ))
    }

    async fn kill_terminal_command(
        &self,
        args: acp::KillTerminalCommandRequest,
    ) -> acp::Result<acp::KillTerminalCommandResponse> {
        let terms = self.terminals.lock().unwrap();
        let tid = &*args.terminal_id.0;
        let state = terms
            .get(tid)
            .ok_or_else(|| acp::Error::invalid_params().data("Unknown terminal ID"))?;
        let _ = state.kill_tx.try_send(());
        Ok(acp::KillTerminalCommandResponse::default())
    }

    async fn session_notification(
        &self,
        args: acp::SessionNotification,
    ) -> acp::Result<(), acp::Error> {
        match args.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => {
                let text = content_block_to_text(&chunk.content);
                self.handle.emit(AcpUpdate::MessageChunk { text });
            }
            acp::SessionUpdate::AgentThoughtChunk(chunk) => {
                let text = content_block_to_text(&chunk.content);
                self.handle.emit(AcpUpdate::ThoughtChunk { text });
            }
            acp::SessionUpdate::ToolCall(tool_call) => {
                let locations = tool_call
                    .locations
                    .iter()
                    .map(|l| (l.path.display().to_string(), l.line))
                    .collect();
                self.handle.emit(AcpUpdate::ToolCall {
                    id: tool_call.tool_call_id.to_string(),
                    title: tool_call.title.clone(),
                    locations,
                });

                // 缓存 Write/Edit 文件快照（locations 在第二个 ToolCall 事件才有路径）
                let title = &tool_call.title;
                if title.starts_with("Write") || title.starts_with("Edit") {
                    if let Some(loc) = tool_call.locations.first() {
                        let id_str = tool_call.tool_call_id.to_string();
                        let mut snapshots = self.file_snapshots.lock().unwrap();
                        // 只在尚未缓存时缓存（第一个 ToolCall 可能 locations 为空）
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
                    .map(|tc| self.adapter.tool_call_content_to_text(tc));
                let status = update
                    .fields
                    .status
                    .as_ref()
                    .map(|s| format!("{:?}", s).to_lowercase())
                    .unwrap_or_default();
                let locations = update
                    .fields
                    .locations
                    .as_ref()
                    .map(|locs| {
                        locs.iter()
                            .map(|l| (l.path.display().to_string(), l.line))
                            .collect()
                    })
                    .unwrap_or_default();

                // 如果 ACP 没提供 content 且状态为 completed，从文件快照生成 diff
                let is_completed = update
                    .fields
                    .status
                    .as_ref()
                    .is_some_and(|s| matches!(s, acp::ToolCallStatus::Completed));

                if content.is_none() && is_completed {
                    let snapshot = self
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

                self.handle.emit(AcpUpdate::ToolCallUpdate {
                    id: update.tool_call_id.to_string(),
                    status,
                    content,
                    locations,
                });
            }
            acp::SessionUpdate::UserMessageChunk(chunk) => {
                let text = content_block_to_text(&chunk.content);
                self.handle.emit(AcpUpdate::UserMessage {
                    text,
                    attachments: vec![],
                });
            }
            acp::SessionUpdate::CurrentModeUpdate(update) => {
                self.handle.emit(AcpUpdate::ModeChanged {
                    mode_id: update.current_mode_id.to_string(),
                });
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
                self.handle.emit(AcpUpdate::PlanUpdate { entries });
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
                self.handle.emit(AcpUpdate::AvailableCommands { commands });
            }
            _ => {}
        }
        Ok(())
    }

    async fn ext_method(&self, _args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn ext_notification(&self, _args: acp::ExtNotification) -> acp::Result<()> {
        Ok(())
    }
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
        ContentBlockData::Image { data, mime_type } => {
            acp::ContentBlock::Image(acp::ImageContent::new(data, mime_type))
        }
        ContentBlockData::Audio { data, mime_type } => {
            acp::ContentBlock::Audio(acp::AudioContent::new(data, mime_type))
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
    // 复用已存在的会话
    if let Ok(sessions) = ACP_SESSIONS.read() {
        if let Some(handle) = sessions.get(&key) {
            let rx = handle.subscribe();
            return Ok((handle.clone(), rx));
        }
    }

    // 创建新会话 — 线程和 LocalSet 由模块管理
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();

    std::thread::spawn(move || {
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
                history: RwLock::new(Vec::new()),
                pending_permission: Mutex::new(None),
                project_key: config.project_key.clone(),
                task_id: config.task_id.clone(),
                chat_id: config.chat_id.clone(),
                suppress_emit: std::sync::atomic::AtomicBool::new(false),
                pending_queue: Mutex::new(Vec::new()),
                queue_paused: std::sync::atomic::AtomicBool::new(false),
            });

            // 注册到全局表
            if let Ok(mut sessions) = ACP_SESSIONS.write() {
                sessions.insert(key.clone(), handle.clone());
            }

            // 发送 handle 给调用方（在启动会话循环之前）
            let _ = result_tx.send(Ok((handle.clone(), update_rx)));

            // 运行会话循环（阻塞直到 Kill 或错误）
            if let Err(e) = run_acp_session(handle, config, cmd_rx).await {
                let _ = update_tx.send(AcpUpdate::Error {
                    message: format!("ACP session error: {}", e),
                });
            }
            let _ = update_tx.send(AcpUpdate::SessionEnded);

            // 清理：从全局表移除
            if let Ok(mut sessions) = ACP_SESSIONS.write() {
                sessions.remove(&key_clone);
            }
        }));
    });

    result_rx.await.map_err(|_| {
        crate::error::GroveError::Session("ACP session thread terminated".to_string())
    })?
}

/// 运行 ACP 会话的主循环
async fn run_acp_session(
    handle: Arc<AcpSessionHandle>,
    config: AcpStartConfig,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
) -> crate::error::Result<()> {
    // 根据 agent_type 分支获取 reader/writer（使用 trait object 统一类型）
    let child: Option<tokio::process::Child>;
    let writer: Box<dyn futures::AsyncWrite + Unpin>;
    let reader: Box<dyn futures::AsyncRead + Unpin>;

    if config.agent_type == "remote" {
        // Remote: WebSocket 连接（通过 duplex 管道桥接为 AsyncRead/AsyncWrite）
        child = None;
        let (r, w) = connect_remote_agent(&config).await?;
        reader = Box::new(r);
        writer = Box::new(w);
    } else {
        // Local: 子进程
        let mut proc = tokio::process::Command::new(&config.agent_command)
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
                    "Failed to spawn ACP agent '{}': {}",
                    config.agent_command, e
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

    let adapter = adapter::resolve_adapter(&config.agent_command);

    let client = GroveAcpClient {
        handle: handle.clone(),
        working_dir: config.working_dir.clone(),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        project_key: config.project_key.clone(),
        task_id: config.task_id.clone(),
        chat_id: config.chat_id.clone(),
        adapter,
        file_snapshots: Mutex::new(HashMap::new()),
    };

    // 创建 ACP 连接
    let (conn, handle_io) = acp::ClientSideConnection::new(client, writer, reader, |fut| {
        tokio::task::spawn_local(fut);
    });

    // 后台处理 I/O
    tokio::task::spawn_local(handle_io);

    // 初始化连接
    let init_resp = conn
        .initialize(
            acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                .client_capabilities(acp::ClientCapabilities::default().terminal(true))
                .client_info(
                    acp::Implementation::new("grove", env!("CARGO_PKG_VERSION")).title("Grove"),
                ),
        )
        .await
        .map_err(|e| crate::error::GroveError::Session(format!("ACP initialize failed: {}", e)))?;

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

    // 检查 agent 是否支持 load_session
    // Trae 错误地标识了不支持 load_session 且不返回 agent_info，但实际可以调用
    let is_trae = config.agent_command.contains("trae");
    let supports_load = init_resp.agent_capabilities.load_session || is_trae;
    // Helper: extract modes/models from session response
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

    // 查找保存的 session_id（从 chat session 读取）
    let saved_id = config.chat_id.as_ref().and_then(|cid| {
        crate::storage::tasks::get_chat_session(&config.project_key, &config.task_id, cid)
            .ok()
            .flatten()
            .and_then(|c| c.acp_session_id)
    });

    // Helper: persist session_id to chat storage
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

    // Track modes/models from session response
    let available_modes;
    let current_mode_id;
    let available_models;
    let current_model_id;

    // Helper macro: new_session + persist + extract modes/models
    macro_rules! create_new_session {
        () => {{
            // 清除旧的磁盘历史
            if let Some(ref cid) = config.chat_id {
                crate::storage::chat_history::clear_history(
                    &config.project_key,
                    &config.task_id,
                    cid,
                );
            }
            let resp = conn
                .new_session(acp::NewSessionRequest::new(&config.working_dir))
                .await
                .map_err(|e| {
                    crate::error::GroveError::Session(format!("ACP new_session failed: {}", e))
                })?;
            let sid = resp.session_id.to_string();
            persist_session_id(&sid);
            (available_modes, current_mode_id) = extract_modes(&resp.modes);
            (available_models, current_model_id) = extract_models(&resp.models);
            sid
        }};
    }

    let session_id = if let (true, Some(saved_id)) = (supports_load, saved_id) {
        // 抑制 agent 的回放通知（Grove 统一从磁盘回放）
        handle
            .suppress_emit
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let load_result = conn
            .load_session(acp::LoadSessionRequest::new(
                acp::SessionId::new(&*saved_id),
                &config.working_dir,
            ))
            .await;
        handle
            .suppress_emit
            .store(false, std::sync::atomic::Ordering::Relaxed);

        match load_result {
            Ok(resp) => {
                (available_modes, current_mode_id) = extract_modes(&resp.modes);
                (available_models, current_model_id) = extract_models(&resp.models);
                // 填充内存历史（供 WS 重连回放），不 broadcast（WS handler 已先行发送）
                if let Some(ref cid) = config.chat_id {
                    let disk_history = crate::storage::chat_history::load_history(
                        &config.project_key,
                        &config.task_id,
                        cid,
                    );
                    for update in disk_history {
                        handle.push_to_history(update);
                    }
                }
                saved_id
            }
            Err(_) => {
                create_new_session!()
            }
        }
    } else {
        create_new_session!()
    };

    let session_id_arc = acp::SessionId::new(&*session_id);

    // 提取 prompt capabilities
    let prompt_capabilities = PromptCapabilitiesData {
        image: init_resp.agent_capabilities.prompt_capabilities.image,
        audio: init_resp.agent_capabilities.prompt_capabilities.audio,
        embedded_context: init_resp
            .agent_capabilities
            .prompt_capabilities
            .embedded_context,
    };

    // 存储 agent info（用于重连时回放历史）
    if let Ok(mut info) = handle.agent_info.write() {
        *info = Some((
            session_id.clone(),
            agent_name.clone(),
            agent_version.clone(),
        ));
    }

    // 通知会话就绪
    handle.emit(AcpUpdate::SessionReady {
        session_id,
        agent_name,
        agent_version,
        available_modes,
        current_mode_id,
        available_models,
        current_model_id,
        prompt_capabilities,
    });

    // 处理命令循环
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::Prompt { text, attachments } => {
                // 记录用户消息到 history（重连时回放）
                handle.emit(AcpUpdate::UserMessage {
                    text: text.clone(),
                    attachments: attachments.clone(),
                });
                handle.emit(AcpUpdate::Busy { value: true });

                // 构建 content blocks
                let mut content_blocks: Vec<acp::ContentBlock> = vec![text.into()];
                for block in &attachments {
                    content_blocks.push(to_acp_content_block(block));
                }

                // 使用 select! 让 Cancel 等命令在 prompt 运行期间也能被处理
                let prompt_fut = conn.prompt(acp::PromptRequest::new(
                    session_id_arc.clone(),
                    content_blocks,
                ));
                tokio::pin!(prompt_fut);

                // Cancel 超时：发送 cancel 后若 agent 无响应，超时强制退出
                let cancel_deadline: std::cell::Cell<Option<tokio::time::Instant>> =
                    std::cell::Cell::new(None);
                // 新 prompt 到达时暂存，等当前 prompt 结束后立即处理
                let mut next_prompt: Option<(String, Vec<ContentBlockData>)> = None;
                let mut got_kill = false;

                let result = loop {
                    // 计算超时 future
                    let deadline = cancel_deadline.get();
                    tokio::select! {
                        res = &mut prompt_fut => break res,
                        _ = tokio::time::sleep_until(deadline.unwrap_or_else(|| tokio::time::Instant::now() + std::time::Duration::from_secs(86400))), if deadline.is_some() => {
                            // Cancel 超时：agent 无响应，强制退出
                            eprintln!("[ACP] Cancel timeout — agent unresponsive, forcing exit");
                            break Err(acp::Error::internal_error());
                        }
                        Some(inner_cmd) = cmd_rx.recv() => {
                            match inner_cmd {
                                AcpCommand::Cancel => {
                                    let _ = conn.cancel(acp::CancelNotification::new(session_id_arc.clone())).await;
                                    // 10 秒超时：如果 agent 不响应 cancel，强制退出内循环
                                    cancel_deadline.set(Some(tokio::time::Instant::now() + std::time::Duration::from_secs(10)));
                                }
                                AcpCommand::SetMode { mode_id } => {
                                    let _ = conn.set_session_mode(acp::SetSessionModeRequest::new(
                                        session_id_arc.clone(),
                                        acp::SessionModeId::new(mode_id),
                                    )).await;
                                }
                                AcpCommand::SetModel { model_id } => {
                                    let _ = conn.set_session_model(acp::SetSessionModelRequest::new(
                                        session_id_arc.clone(),
                                        acp::ModelId::new(model_id),
                                    )).await;
                                }
                                AcpCommand::Prompt { text, attachments } => {
                                    // 新 prompt 到达：cancel 当前，保存新 prompt 待处理
                                    let _ = conn.cancel(acp::CancelNotification::new(session_id_arc.clone())).await;
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

                handle.emit(AcpUpdate::Busy { value: false });

                // Kill 命令：跳出外层循环
                if got_kill {
                    handle.emit(AcpUpdate::Error {
                        message: "Session killed".to_string(),
                    });
                    break;
                }

                match result {
                    Ok(resp) => {
                        // 有 next_prompt 时不发 Complete 通知（即将开始新 prompt）
                        if next_prompt.is_none() {
                            handle.emit(AcpUpdate::Complete {
                                stop_reason: format!("{:?}", resp.stop_reason),
                            });
                            notify_acp_event(
                                &config.project_key,
                                &config.task_id,
                                "Task Complete",
                                "Agent finished responding",
                                "Glass",
                            );
                        }
                    }
                    Err(e) => {
                        if next_prompt.is_none() {
                            handle.emit(AcpUpdate::Error {
                                message: format!("Prompt error: {}", e),
                            });
                        }
                    }
                }

                // 有暂存的新 prompt → 回注到命令 channel 优先处理
                if let Some((text, attachments)) = next_prompt {
                    let _ = handle
                        .cmd_tx
                        .try_send(AcpCommand::Prompt { text, attachments });
                } else {
                    // Auto-send next queued message (if any), unless queue is paused
                    if !handle
                        .queue_paused
                        .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        if let Some(next_msg) = handle.pop_queue_front() {
                            handle.emit(AcpUpdate::QueueUpdate {
                                messages: handle.get_queue(),
                            });
                            handle.try_enqueue_prompt(next_msg.text, next_msg.attachments);
                        }
                    }
                }
            }
            AcpCommand::Cancel => {
                // Agent 空闲时收到 Cancel，忽略
            }
            AcpCommand::SetMode { mode_id } => {
                let _ = conn
                    .set_session_mode(acp::SetSessionModeRequest::new(
                        session_id_arc.clone(),
                        acp::SessionModeId::new(mode_id),
                    ))
                    .await;
            }
            AcpCommand::SetModel { model_id } => {
                let _ = conn
                    .set_session_model(acp::SetSessionModelRequest::new(
                        session_id_arc.clone(),
                        acp::ModelId::new(model_id),
                    ))
                    .await;
            }
            AcpCommand::Kill => {
                break;
            }
        }
    }

    // 清理子进程（如有）
    drop(child);

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
    /// 响应待处理的权限请求
    pub fn respond_permission(&self, option_id: String) {
        if let Some(tx) = self.pending_permission.lock().unwrap().take() {
            let _ = tx.send(option_id.clone());
        }
        // 记录到历史（磁盘 + 内存），回放时前端可标记为已解决
        self.emit(AcpUpdate::PermissionResponse { option_id });
    }

    /// 发送更新并记录到 history buffer（带磁盘持久化）
    pub fn emit(&self, update: AcpUpdate) {
        // load_session 期间抑制所有 emit（agent 回放的通知不转发）
        if self
            .suppress_emit
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return;
        }

        // 实时 append 到磁盘（替代 turn_buffer 缓存）
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

        // Turn 结束时 compact 磁盘历史（合并 chunk 碎片）
        let should_compact = matches!(&update, AcpUpdate::Complete { .. });

        // 内存 history + broadcast
        if let Ok(mut h) = self.history.write() {
            h.push(update.clone());
        }
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

    /// 仅写入内存 history（不 broadcast），用于预填充历史供重连回放
    pub fn push_to_history(&self, update: AcpUpdate) {
        if let Ok(mut h) = self.history.write() {
            h.push(update);
        }
    }

    /// 获取完整的历史消息
    pub fn get_history(&self) -> Vec<AcpUpdate> {
        self.history.read().map(|h| h.clone()).unwrap_or_default()
    }

    /// 发送用户提示
    pub async fn send_prompt(
        &self,
        text: String,
        attachments: Vec<ContentBlockData>,
    ) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Prompt { text, attachments })
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
    fn try_enqueue_prompt(&self, text: String, attachments: Vec<ContentBlockData>) -> bool {
        self.cmd_tx
            .try_send(AcpCommand::Prompt { text, attachments })
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
            self.try_enqueue_prompt(next_msg.text, next_msg.attachments);
        }
    }
}

/// 检查 ACP 会话是否存在
pub fn session_exists(key: &str) -> bool {
    ACP_SESSIONS
        .read()
        .map(|sessions| sessions.contains_key(key))
        .unwrap_or(false)
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

/// 解析后的 Agent 信息
pub struct ResolvedAgent {
    pub agent_type: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub auth_header: Option<String>,
}

/// 解析 agent 名称到完整 agent 信息（支持 built-in + custom）
pub fn resolve_agent(agent_name: &str) -> Option<ResolvedAgent> {
    // 1. Built-in agents
    match agent_name.to_lowercase().as_str() {
        "claude" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "claude-code-acp".into(),
                args: vec![],
                url: None,
                auth_header: None,
            });
        }
        "traecli" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "traecli".into(),
                args: vec!["acp".into(), "serve".into()],
                url: None,
                auth_header: None,
            });
        }
        "codex" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "codex-acp".into(),
                args: vec![],
                url: None,
                auth_header: None,
            });
        }
        "kimi" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "kimi".into(),
                args: vec!["acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "gemini" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "gemini".into(),
                args: vec!["--experimental-acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "qwen" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "qwen".into(),
                args: vec!["--experimental-acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "opencode" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "opencode".into(),
                args: vec!["acp".into()],
                url: None,
                auth_header: None,
            });
        }
        "copilot" | "gh copilot" | "gh-copilot" => {
            return Some(ResolvedAgent {
                agent_type: "local".into(),
                command: "copilot".into(),
                args: vec!["--acp".into()],
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
            command: a.command.clone().unwrap_or_default(),
            args: a.args.clone(),
            url: a.url.clone(),
            auth_header: a.auth_header.clone(),
        })
}

/// 发送 ACP 事件通知（声音 + 横幅 + hooks.toml）
fn notify_acp_event(
    project_key: &str,
    task_id: &str,
    title_suffix: &str,
    message: &str,
    sound: &str,
) {
    use crate::hooks::{self, NotificationLevel};
    use crate::storage::tasks as task_storage;

    // 播放声音
    hooks::play_sound(sound);

    // 查询 task 名称用于横幅
    let task_name = task_storage::get_task(project_key, task_id)
        .ok()
        .flatten()
        .map(|t| t.name)
        .unwrap_or_else(|| task_id.to_string());

    // 发送系统横幅
    let title = format!("Grove - {}", title_suffix);
    let banner_msg = format!("{} — {}", task_name, message);
    hooks::send_banner(&title, &banner_msg);

    // 更新 hooks.toml（web 前端轮询会展示）
    let level = if title_suffix.contains("Permission") {
        NotificationLevel::Warn
    } else {
        NotificationLevel::Notice
    };
    let mut hooks_file = hooks::load_hooks(project_key);
    hooks_file.update(task_id, level, Some(message.to_string()));
    let _ = hooks::save_hooks(project_key, &hooks_file);
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
