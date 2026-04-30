//! Spec §4 错误码 — agent_graph 工具共用的 error 类型。

use std::fmt;

/// Spec §4 错误码全集。
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AgentGraphError {
    /// caller→to 没有出边
    NoEdge,
    /// 目标没有 duty 时调用方必传 `duty`
    DutyRequired,
    /// 目标已有 duty 时调用方禁止再传 `duty`
    DutyForbidden,
    /// 目标 session_id 不存在
    TargetNotFound,
    /// 用户连线触发的环检测（spawn / send 不会触发，保留以备 spec §4 完整）
    CycleWouldForm,
    /// 目标 ACP 在线信息缺失（capability 工具读不到 metadata）
    AgentOffline,
    /// spawn 子进程或 ACP handshake 失败
    AgentSpawnFailed,
    /// 目标 session 已被终止
    SessionTerminated,
    /// 等待 ACP ready 超时（spawn 90s）/ 投递超时（send 10s）
    Timeout,
    /// caller→to 已有未回复 pending message
    PreviousMessagePending,
    /// reply 的 msg_id 找不到 / 已被消费
    TicketNotFound,
    /// spawn 的 name 在同 task 内已被占用
    NameTaken,
    /// caller chat_id 不属于已知 session（token 失效 / 数据脏）
    CallerUnknown,
    /// 跨 task 通讯被拒
    SameTaskRequired,
    /// 内部错误（DB / IO / 逻辑分支兜底）。message 给运维看。
    Internal(String),
}

impl AgentGraphError {
    /// 返回 spec §4 列出的错误码字符串（snake_case，稳定 API）
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoEdge => "no_edge",
            Self::DutyRequired => "duty_required",
            Self::DutyForbidden => "duty_forbidden",
            Self::TargetNotFound => "target_not_found",
            Self::CycleWouldForm => "cycle_would_form",
            Self::AgentOffline => "agent_offline",
            Self::AgentSpawnFailed => "agent_spawn_failed",
            Self::SessionTerminated => "session_terminated",
            Self::Timeout => "timeout",
            Self::PreviousMessagePending => "previous_message_pending",
            Self::TicketNotFound => "ticket_not_found",
            Self::NameTaken => "name_taken",
            Self::CallerUnknown => "caller_unknown",
            Self::SameTaskRequired => "same_task_required",
            Self::Internal(_) => "internal_error",
        }
    }

    /// 给 AI 看的 hint，1 句话讲怎么修。
    pub fn hint(&self) -> &'static str {
        match self {
            Self::NoEdge => "caller has no outgoing edge to target; ask the user to connect them in the Graph",
            Self::DutyRequired => "target has no duty yet; pass `duty` describing the target's job",
            Self::DutyForbidden => "target already has a duty (set by user or a previous send); do not pass `duty`",
            Self::TargetNotFound => "target session_id does not exist in caller's task",
            Self::CycleWouldForm => "this edge would create a cycle in the DAG",
            Self::AgentOffline => "target session has not connected its ACP agent; capabilities unavailable",
            Self::AgentSpawnFailed => "spawning the new agent process failed; see Grove logs",
            Self::SessionTerminated => "target session has been killed",
            Self::Timeout => "timed out waiting for ACP session to be ready",
            Self::PreviousMessagePending => "you already have an unanswered send to this target; wait for reply or work on something else",
            Self::TicketNotFound => "no pending message with that msg_id; it may have been answered or expired",
            Self::NameTaken => "another session in this task already uses that name",
            Self::CallerUnknown => "caller chat_id is not registered with Grove",
            Self::SameTaskRequired => "agent_graph is per-task; from and to must be in the same task",
            Self::Internal(_) => "internal error in Grove; check server logs",
        }
    }
}

impl fmt::Display for AgentGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Internal(msg) => write!(f, "{}: {}", self.code(), msg),
            _ => write!(f, "{}: {}", self.code(), self.hint()),
        }
    }
}

impl std::error::Error for AgentGraphError {}

impl From<crate::error::GroveError> for AgentGraphError {
    fn from(e: crate::error::GroveError) -> Self {
        // Storage 层用 GroveError::StorageTagged 抛业务错误码，
        // 这里精确 match tag，不再依赖字符串包含。
        if let Some(tag) = e.storage_tag() {
            return match tag {
                "no_edge" => Self::NoEdge,
                "previous_message_pending" => Self::PreviousMessagePending,
                "same_task_required" => Self::SameTaskRequired,
                "cycle_would_form" => Self::CycleWouldForm,
                "endpoint_not_found" => Self::TargetNotFound,
                "duty_locked" => Self::DutyForbidden,
                "unknown_base_agent" => Self::AgentSpawnFailed,
                "duplicate_edge" | "bidirectional_edge" => Self::Internal(e.to_string()),
                _ => Self::Internal(e.to_string()),
            };
        }
        Self::Internal(e.to_string())
    }
}

impl From<rusqlite::Error> for AgentGraphError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Internal(format!("sqlite: {}", e))
    }
}
