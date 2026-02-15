//! ACP (Agent Client Protocol) 核心模块
//!
//! 管理 ACP agent 子进程的生命周期和 JSON-RPC 通信。
//! Grove 作为 ACP Client，启动 agent 子进程并通过 stdio 交互。

#![allow(dead_code)] // Public API — used by CLI now, Web frontend later

use acp::Agent; // Required for .initialize(), .new_session(), .prompt(), .cancel()
use agent_client_protocol as acp;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
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
}

/// 发送给 ACP 后台任务的命令
enum AcpCommand {
    Prompt { text: String },
    Cancel,
    Kill,
    SetMode { mode_id: String },
    SetModel { model_id: String },
}

/// 从 agent 接收的流式更新
#[derive(Debug, Clone)]
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
    },
    /// Agent 消息文本片段
    MessageChunk { text: String },
    /// Agent 思考过程片段
    ThoughtChunk { text: String },
    /// 工具调用开始
    ToolCall { id: String, title: String },
    /// 工具调用更新
    ToolCallUpdate {
        id: String,
        status: String,
        content: Option<String>,
    },
    /// 权限请求（CLI 测试阶段自动允许）
    PermissionRequest { description: String },
    /// 本轮处理结束
    Complete { stop_reason: String },
    /// Agent busy 状态变化
    Busy(bool),
    /// 错误
    Error { message: String },
    /// 用户消息（load_session 回放时由 agent 发送）
    UserMessage { text: String },
    /// Mode 变更通知
    ModeChanged { mode_id: String },
    /// Agent Plan 更新（结构化 TODO 列表）
    PlanUpdate { entries: Vec<PlanEntryData> },
    /// 会话结束
    SessionEnded,
}

/// Plan entry 数据（从 ACP Plan 通知提取）
#[derive(Debug, Clone)]
pub struct PlanEntryData {
    pub content: String,
    pub status: String,
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
}

/// Grove 的 ACP Client 实现
struct GroveAcpClient {
    handle: Arc<AcpSessionHandle>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for GroveAcpClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let desc = args.tool_call.fields.title.clone().unwrap_or_default();
        self.handle
            .emit(AcpUpdate::PermissionRequest { description: desc });

        // CLI 测试阶段：自动选择第一个 AllowOnce 或 AllowAlways 选项
        let option_id = args
            .options
            .iter()
            .find(|o| {
                matches!(
                    o.kind,
                    acp::PermissionOptionKind::AllowOnce | acp::PermissionOptionKind::AllowAlways
                )
            })
            .map(|o| o.option_id.clone())
            .unwrap_or_else(|| args.options[0].option_id.clone());

        Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(option_id)),
        ))
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
        _args: acp::CreateTerminalRequest,
    ) -> acp::Result<acp::CreateTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn terminal_output(
        &self,
        _args: acp::TerminalOutputRequest,
    ) -> acp::Result<acp::TerminalOutputResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn release_terminal(
        &self,
        _args: acp::ReleaseTerminalRequest,
    ) -> acp::Result<acp::ReleaseTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn wait_for_terminal_exit(
        &self,
        _args: acp::WaitForTerminalExitRequest,
    ) -> acp::Result<acp::WaitForTerminalExitResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn kill_terminal_command(
        &self,
        _args: acp::KillTerminalCommandRequest,
    ) -> acp::Result<acp::KillTerminalCommandResponse> {
        Err(acp::Error::method_not_found())
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
                self.handle.emit(AcpUpdate::ToolCall {
                    id: tool_call.tool_call_id.to_string(),
                    title: tool_call.title.clone(),
                });
            }
            acp::SessionUpdate::ToolCallUpdate(update) => {
                let content = update
                    .fields
                    .content
                    .as_ref()
                    .and_then(|blocks| blocks.first())
                    .map(tool_call_content_to_text);
                let status = update
                    .fields
                    .status
                    .as_ref()
                    .map(|s| format!("{:?}", s).to_lowercase())
                    .unwrap_or_default();
                self.handle.emit(AcpUpdate::ToolCallUpdate {
                    id: update.tool_call_id.to_string(),
                    status,
                    content,
                });
            }
            acp::SessionUpdate::UserMessageChunk(chunk) => {
                let text = content_block_to_text(&chunk.content);
                self.handle.emit(AcpUpdate::UserMessage { text });
            }
            acp::SessionUpdate::CurrentModeUpdate(update) => {
                self.handle.emit(AcpUpdate::ModeChanged {
                    mode_id: update.current_mode_id.to_string(),
                });
            }
            acp::SessionUpdate::Plan(plan) => {
                let entries = plan
                    .entries
                    .iter()
                    .map(|e| PlanEntryData {
                        content: e.content.clone(),
                        status: format!("{:?}", e.status).to_lowercase(),
                    })
                    .collect();
                self.handle.emit(AcpUpdate::PlanUpdate { entries });
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
fn content_block_to_text(block: &acp::ContentBlock) -> String {
    match block {
        acp::ContentBlock::Text(t) => t.text.clone(),
        acp::ContentBlock::Image(_) => "<image>".to_string(),
        acp::ContentBlock::Audio(_) => "<audio>".to_string(),
        acp::ContentBlock::ResourceLink(r) => r.uri.clone(),
        acp::ContentBlock::Resource(_) => "<resource>".to_string(),
        _ => "<unknown>".to_string(),
    }
}

/// 将 ToolCallContent 转换为文本
fn tool_call_content_to_text(tc: &acp::ToolCallContent) -> String {
    match tc {
        acp::ToolCallContent::Content(content) => content_block_to_text(&content.content),
        acp::ToolCallContent::Diff(diff) => {
            format!("diff: {}", diff.path.display())
        }
        _ => "<unknown>".to_string(),
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
    // 启动 agent 子进程
    let mut child = tokio::process::Command::new(&config.agent_command)
        .args(&config.agent_args)
        .current_dir(&config.working_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .envs(&config.env_vars)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            crate::error::GroveError::Session(format!(
                "Failed to spawn ACP agent '{}': {}",
                config.agent_command, e
            ))
        })?;

    let stdin = child.stdin.take().unwrap().compat_write();
    let stdout = child.stdout.take().unwrap().compat();

    let client = GroveAcpClient {
        handle: handle.clone(),
    };

    // 创建 ACP 连接
    let (conn, handle_io) = acp::ClientSideConnection::new(client, stdin, stdout, |fut| {
        tokio::task::spawn_local(fut);
    });

    // 后台处理 I/O
    tokio::task::spawn_local(handle_io);

    // 初始化连接
    let init_resp = conn
        .initialize(
            acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                .client_capabilities(acp::ClientCapabilities::default())
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
    let supports_load = init_resp.agent_capabilities.load_session;

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

    // 查找保存的 session_id，尝试 load_session 或创建新会话
    let saved_id = crate::storage::tasks::get_task(&config.project_key, &config.task_id)
        .ok()
        .flatten()
        .and_then(|t| t.acp_session_id);

    // Track modes/models from session response
    let available_modes;
    let current_mode_id;
    let available_models;
    let current_model_id;

    let session_id = if supports_load {
        if let Some(saved_id) = saved_id {
            match conn
                .load_session(acp::LoadSessionRequest::new(
                    acp::SessionId::new(&*saved_id),
                    &config.working_dir,
                ))
                .await
            {
                Ok(resp) => {
                    (available_modes, current_mode_id) = extract_modes(&resp.modes);
                    (available_models, current_model_id) = extract_models(&resp.models);
                    saved_id
                }
                Err(_) => {
                    // fallback: 创建新会话
                    let resp = conn
                        .new_session(acp::NewSessionRequest::new(&config.working_dir))
                        .await
                        .map_err(|e| {
                            crate::error::GroveError::Session(format!(
                                "ACP new_session failed: {}",
                                e
                            ))
                        })?;
                    let sid = resp.session_id.to_string();
                    let _ = crate::storage::tasks::update_acp_session_id(
                        &config.project_key,
                        &config.task_id,
                        &sid,
                    );
                    (available_modes, current_mode_id) = extract_modes(&resp.modes);
                    (available_models, current_model_id) = extract_models(&resp.models);
                    sid
                }
            }
        } else {
            let resp = conn
                .new_session(acp::NewSessionRequest::new(&config.working_dir))
                .await
                .map_err(|e| {
                    crate::error::GroveError::Session(format!("ACP new_session failed: {}", e))
                })?;
            let sid = resp.session_id.to_string();
            let _ = crate::storage::tasks::update_acp_session_id(
                &config.project_key,
                &config.task_id,
                &sid,
            );
            (available_modes, current_mode_id) = extract_modes(&resp.modes);
            (available_models, current_model_id) = extract_models(&resp.models);
            sid
        }
    } else {
        let resp = conn
            .new_session(acp::NewSessionRequest::new(&config.working_dir))
            .await
            .map_err(|e| {
                crate::error::GroveError::Session(format!("ACP new_session failed: {}", e))
            })?;
        let sid = resp.session_id.to_string();
        let _ = crate::storage::tasks::update_acp_session_id(
            &config.project_key,
            &config.task_id,
            &sid,
        );
        (available_modes, current_mode_id) = extract_modes(&resp.modes);
        (available_models, current_model_id) = extract_models(&resp.models);
        sid
    };

    let session_id_arc = acp::SessionId::new(&*session_id);

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
    });

    // 处理命令循环
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::Prompt { text } => {
                // 记录用户消息到 history（重连时回放）
                handle.emit(AcpUpdate::UserMessage { text: text.clone() });
                handle.emit(AcpUpdate::Busy(true));
                let result = conn
                    .prompt(acp::PromptRequest::new(
                        session_id_arc.clone(),
                        vec![text.into()],
                    ))
                    .await;
                handle.emit(AcpUpdate::Busy(false));

                match result {
                    Ok(resp) => {
                        handle.emit(AcpUpdate::Complete {
                            stop_reason: format!("{:?}", resp.stop_reason),
                        });
                    }
                    Err(e) => {
                        handle.emit(AcpUpdate::Error {
                            message: format!("Prompt error: {}", e),
                        });
                    }
                }
            }
            AcpCommand::Cancel => {
                let _ = conn
                    .cancel(acp::CancelNotification::new(session_id_arc.clone()))
                    .await;
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

    // 清理子进程
    drop(child);

    Ok(())
}

// === 公开 API ===

impl AcpSessionHandle {
    /// 发送更新并记录到 history buffer
    pub fn emit(&self, update: AcpUpdate) {
        if let Ok(mut h) = self.history.write() {
            h.push(update.clone());
        }
        let _ = self.update_tx.send(update);
    }

    /// 获取完整的历史消息
    pub fn get_history(&self) -> Vec<AcpUpdate> {
        self.history.read().map(|h| h.clone()).unwrap_or_default()
    }

    /// 发送用户提示
    pub async fn send_prompt(&self, text: String) -> crate::error::Result<()> {
        self.cmd_tx
            .send(AcpCommand::Prompt { text })
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

/// 解析 agent 名称到命令和参数
pub fn resolve_agent_command(agent_name: &str) -> Option<(String, Vec<String>)> {
    match agent_name.to_lowercase().as_str() {
        "claude" => Some(("claude-code-acp".to_string(), vec![])),
        _ => None,
    }
}
