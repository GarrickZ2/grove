//! 异步操作状态管理
//!
//! 管理所有与异步操作相关的状态，包括待执行操作、后台任务、Loading 消息等。

use std::sync::mpsc;

use crate::app::{BgResult, PendingAction, PendingAttach};

/// 异步操作状态
#[derive(Debug)]
pub struct AsyncOpsState {
    /// 待 attach 的 session (暂停 TUI 后执行，完成后恢复 TUI)
    pub pending_attach: Option<PendingAttach>,
    /// 待执行的操作（确认后执行）
    pub pending_action: Option<PendingAction>,
    /// 后台操作结果通道
    pub bg_result_rx: Option<mpsc::Receiver<BgResult>>,
    /// Loading 消息（后台操作进行中时显示）
    pub loading_message: Option<String>,
    /// 当前目标分支 (用于显示 "from {branch}")
    pub target_branch: String,
}

impl Default for AsyncOpsState {
    fn default() -> Self {
        Self::new()
    }
}

impl AsyncOpsState {
    /// 创建新的异步操作状态
    pub fn new() -> Self {
        Self {
            pending_attach: None,
            pending_action: None,
            bg_result_rx: None,
            loading_message: None,
            target_branch: String::from("main"),
        }
    }

    /// 创建带目标分支的状态
    pub fn with_target_branch(target_branch: String) -> Self {
        Self {
            pending_attach: None,
            pending_action: None,
            bg_result_rx: None,
            loading_message: None,
            target_branch,
        }
    }

    /// 设置 pending attach
    #[allow(dead_code)]
    pub fn set_pending_attach(&mut self, attach: PendingAttach) {
        self.pending_attach = Some(attach);
    }

    /// 取出 pending attach（消费所有权）
    #[allow(dead_code)]
    pub fn take_pending_attach(&mut self) -> Option<PendingAttach> {
        self.pending_attach.take()
    }

    /// 设置 pending action
    #[allow(dead_code)]
    pub fn set_pending_action(&mut self, action: PendingAction) {
        self.pending_action = Some(action);
    }

    /// 取出 pending action（消费所有权）
    #[allow(dead_code)]
    pub fn take_pending_action(&mut self) -> Option<PendingAction> {
        self.pending_action.take()
    }

    /// 设置后台结果通道
    #[allow(dead_code)]
    pub fn set_bg_result_rx(&mut self, rx: mpsc::Receiver<BgResult>) {
        self.bg_result_rx = Some(rx);
    }

    /// 取出后台结果通道（消费所有权）
    #[allow(dead_code)]
    pub fn take_bg_result_rx(&mut self) -> Option<mpsc::Receiver<BgResult>> {
        self.bg_result_rx.take()
    }

    /// 显示 Loading 消息
    #[allow(dead_code)]
    pub fn show_loading(&mut self, message: impl Into<String>) {
        self.loading_message = Some(message.into());
    }

    /// 清除 Loading 消息
    #[allow(dead_code)]
    pub fn clear_loading(&mut self) {
        self.loading_message = None;
    }

    /// 检查是否有活跃的异步操作
    #[allow(dead_code)]
    pub fn has_active_operation(&self) -> bool {
        self.pending_attach.is_some()
            || self.pending_action.is_some()
            || self.loading_message.is_some()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_creates_default_state() {
        let state = AsyncOpsState::new();
        assert!(state.pending_attach.is_none());
        assert!(state.pending_action.is_none());
        assert!(state.bg_result_rx.is_none());
        assert!(state.loading_message.is_none());
        assert_eq!(state.target_branch, "main");
    }

    #[test]
    fn test_with_target_branch() {
        let state = AsyncOpsState::with_target_branch("develop".to_string());
        assert_eq!(state.target_branch, "develop");
        assert!(state.pending_attach.is_none());
    }

    #[test]
    fn test_show_and_clear_loading() {
        let mut state = AsyncOpsState::new();
        assert!(state.loading_message.is_none());

        state.show_loading("Processing...");
        assert_eq!(state.loading_message.as_ref().unwrap(), "Processing...");

        state.clear_loading();
        assert!(state.loading_message.is_none());
    }

    #[test]
    fn test_has_active_operation() {
        let mut state = AsyncOpsState::new();
        assert!(!state.has_active_operation());

        state.show_loading("Loading...");
        assert!(state.has_active_operation());

        state.clear_loading();
        assert!(!state.has_active_operation());
    }

    #[test]
    fn test_default_trait() {
        let state = AsyncOpsState::default();
        assert_eq!(state.target_branch, "main");
    }
}
