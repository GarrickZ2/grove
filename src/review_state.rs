//! Review 状态管理
//!
//! 管理所有与代码审查（Difit）相关的状态，包括审查任务队列、结果通道、URL 通道等。

use std::collections::HashMap;
use std::sync::mpsc;

use crate::app::BgResult;

/// Review 状态
#[derive(Debug)]
pub struct ReviewState {
    /// 正在审查的 task（task_id → difit_id）
    pub reviewing_tasks: HashMap<String, Option<String>>,
    /// Difit 结果发送端
    pub difit_result_tx: mpsc::Sender<BgResult>,
    /// Difit 结果接收端
    pub difit_result_rx: mpsc::Receiver<BgResult>,
    /// Difit URL 发送端（task_id, difit_id）
    pub difit_url_tx: mpsc::Sender<(String, String)>,
    /// Difit URL 接收端
    pub difit_url_rx: mpsc::Receiver<(String, String)>,
}

impl ReviewState {
    /// 创建新的 Review 状态
    pub fn new() -> Self {
        let (difit_result_tx, difit_result_rx) = mpsc::channel();
        let (difit_url_tx, difit_url_rx) = mpsc::channel();

        Self {
            reviewing_tasks: HashMap::new(),
            difit_result_tx,
            difit_result_rx,
            difit_url_tx,
            difit_url_rx,
        }
    }

    /// 开始审查 task
    #[allow(dead_code)]
    pub fn start_review(&mut self, task_id: impl Into<String>) {
        self.reviewing_tasks.insert(task_id.into(), None);
    }

    /// 设置 difit_id
    #[allow(dead_code)]
    pub fn set_difit_id(&mut self, task_id: &str, difit_id: impl Into<String>) {
        if let Some(entry) = self.reviewing_tasks.get_mut(task_id) {
            *entry = Some(difit_id.into());
        }
    }

    /// 停止审查 task
    #[allow(dead_code)]
    pub fn stop_review(&mut self, task_id: &str) {
        self.reviewing_tasks.remove(task_id);
    }

    /// 获取 difit_id
    #[allow(dead_code)]
    pub fn get_difit_id(&self, task_id: &str) -> Option<&str> {
        self.reviewing_tasks
            .get(task_id)
            .and_then(|opt| opt.as_deref())
    }

    /// 检查是否正在审查
    #[allow(dead_code)]
    pub fn is_reviewing(&self, task_id: &str) -> bool {
        self.reviewing_tasks.contains_key(task_id)
    }

    /// 轮询 URL 通道
    #[allow(dead_code)]
    pub fn poll_url(&mut self) -> Option<(String, String)> {
        self.difit_url_rx.try_recv().ok()
    }

    /// 轮询结果通道
    #[allow(dead_code)]
    pub fn poll_result(&mut self) -> Option<BgResult> {
        self.difit_result_rx.try_recv().ok()
    }

    /// 清空所有审查
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.reviewing_tasks.clear();
    }
}

impl Default for ReviewState {
    fn default() -> Self {
        Self::new()
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
        let state = ReviewState::new();
        assert!(state.reviewing_tasks.is_empty());
    }

    #[test]
    fn test_start_and_stop_review() {
        let mut state = ReviewState::new();
        assert!(!state.is_reviewing("task1"));

        state.start_review("task1");
        assert!(state.is_reviewing("task1"));
        assert_eq!(state.get_difit_id("task1"), None);

        state.stop_review("task1");
        assert!(!state.is_reviewing("task1"));
    }

    #[test]
    fn test_set_difit_id() {
        let mut state = ReviewState::new();
        state.start_review("task1");

        state.set_difit_id("task1", "difit123");
        assert_eq!(state.get_difit_id("task1"), Some("difit123"));
    }

    #[test]
    fn test_clear() {
        let mut state = ReviewState::new();
        state.start_review("task1");
        state.start_review("task2");
        assert_eq!(state.reviewing_tasks.len(), 2);

        state.clear();
        assert!(state.reviewing_tasks.is_empty());
    }

    #[test]
    fn test_poll_url() {
        let mut state = ReviewState::new();
        let tx = state.difit_url_tx.clone();

        tx.send(("task1".to_string(), "difit123".to_string()))
            .unwrap();
        let result = state.poll_url();
        assert_eq!(result, Some(("task1".to_string(), "difit123".to_string())));
    }

    #[test]
    fn test_default_trait() {
        let state = ReviewState::default();
        assert!(state.reviewing_tasks.is_empty());
    }
}
