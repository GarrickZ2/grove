//! Notification 状态管理
//!
//! 管理所有与 Hook 通知相关的状态，包括当前项目通知和 Workspace 级别通知。

use std::collections::HashMap;

use crate::hooks::HookEntry;

/// Notification 状态
#[derive(Debug)]
pub struct NotificationState {
    /// Hook 通知数据 (task_id -> HookEntry) - 当前项目
    pub notifications: HashMap<String, HookEntry>,
    /// Workspace 级别的通知数据 (project_name -> task_id -> HookEntry)
    pub workspace_notifications: HashMap<String, HashMap<String, HookEntry>>,
}

impl NotificationState {
    /// 创建新的 Notification 状态
    pub fn new() -> Self {
        Self {
            notifications: HashMap::new(),
            workspace_notifications: HashMap::new(),
        }
    }

    /// 创建带初始通知的状态
    pub fn with_notifications(
        notifications: HashMap<String, HookEntry>,
        workspace_notifications: HashMap<String, HashMap<String, HookEntry>>,
    ) -> Self {
        Self {
            notifications,
            workspace_notifications,
        }
    }

    /// 添加当前项目的通知
    #[allow(dead_code)]
    pub fn add_notification(&mut self, task_id: impl Into<String>, entry: HookEntry) {
        self.notifications.insert(task_id.into(), entry);
    }

    /// 移除当前项目的通知
    #[allow(dead_code)]
    pub fn remove_notification(&mut self, task_id: &str) -> Option<HookEntry> {
        self.notifications.remove(task_id)
    }

    /// 获取当前项目的通知
    #[allow(dead_code)]
    pub fn get_notification(&self, task_id: &str) -> Option<&HookEntry> {
        self.notifications.get(task_id)
    }

    /// 清除当前项目的所有通知
    #[allow(dead_code)]
    pub fn clear_notifications(&mut self) {
        self.notifications.clear();
    }

    /// 添加 Workspace 级别的通知
    #[allow(dead_code)]
    pub fn add_workspace_notification(
        &mut self,
        project_name: impl Into<String>,
        task_id: impl Into<String>,
        entry: HookEntry,
    ) {
        self.workspace_notifications
            .entry(project_name.into())
            .or_default()
            .insert(task_id.into(), entry);
    }

    /// 移除 Workspace 级别的通知
    #[allow(dead_code)]
    pub fn remove_workspace_notification(&mut self, project_name: &str, task_id: &str) {
        if let Some(project_map) = self.workspace_notifications.get_mut(project_name) {
            project_map.remove(task_id);
        }
    }

    /// 获取 Workspace 级别的通知
    #[allow(dead_code)]
    pub fn get_workspace_notification(
        &self,
        project_name: &str,
        task_id: &str,
    ) -> Option<&HookEntry> {
        self.workspace_notifications
            .get(project_name)
            .and_then(|m| m.get(task_id))
    }

    /// 清除指定项目的所有通知
    #[allow(dead_code)]
    pub fn clear_project_notifications(&mut self, project_name: &str) {
        self.workspace_notifications.remove(project_name);
    }

    /// 清除所有 Workspace 通知
    #[allow(dead_code)]
    pub fn clear_workspace_notifications(&mut self) {
        self.workspace_notifications.clear();
    }

    /// 获取当前项目的通知数量
    #[allow(dead_code)]
    pub fn notification_count(&self) -> usize {
        self.notifications.len()
    }

    /// 获取 Workspace 级别的通知总数
    #[allow(dead_code)]
    pub fn workspace_notification_count(&self) -> usize {
        self.workspace_notifications.values().map(|m| m.len()).sum()
    }
}

impl Default for NotificationState {
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
    use crate::hooks::NotificationLevel;
    use chrono::Utc;

    fn create_test_entry() -> HookEntry {
        HookEntry {
            level: NotificationLevel::Notice,
            message: Some("Test message".to_string()),
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn test_new_creates_default_state() {
        let state = NotificationState::new();
        assert!(state.notifications.is_empty());
        assert!(state.workspace_notifications.is_empty());
    }

    #[test]
    fn test_add_and_remove_notification() {
        let mut state = NotificationState::new();
        let entry = create_test_entry();

        state.add_notification("task1", entry.clone());
        assert_eq!(state.notification_count(), 1);
        assert!(state.get_notification("task1").is_some());

        let removed = state.remove_notification("task1");
        assert!(removed.is_some());
        assert_eq!(state.notification_count(), 0);
    }

    #[test]
    fn test_clear_notifications() {
        let mut state = NotificationState::new();
        state.add_notification("task1", create_test_entry());
        state.add_notification("task2", create_test_entry());
        assert_eq!(state.notification_count(), 2);

        state.clear_notifications();
        assert_eq!(state.notification_count(), 0);
    }

    #[test]
    fn test_add_and_remove_workspace_notification() {
        let mut state = NotificationState::new();
        let entry = create_test_entry();

        state.add_workspace_notification("project1", "task1", entry.clone());
        assert_eq!(state.workspace_notification_count(), 1);
        assert!(state
            .get_workspace_notification("project1", "task1")
            .is_some());

        state.remove_workspace_notification("project1", "task1");
        assert_eq!(state.workspace_notification_count(), 0);
    }

    #[test]
    fn test_clear_project_notifications() {
        let mut state = NotificationState::new();
        state.add_workspace_notification("project1", "task1", create_test_entry());
        state.add_workspace_notification("project1", "task2", create_test_entry());
        state.add_workspace_notification("project2", "task1", create_test_entry());
        assert_eq!(state.workspace_notification_count(), 3);

        state.clear_project_notifications("project1");
        assert_eq!(state.workspace_notification_count(), 1);
    }

    #[test]
    fn test_clear_workspace_notifications() {
        let mut state = NotificationState::new();
        state.add_workspace_notification("project1", "task1", create_test_entry());
        state.add_workspace_notification("project2", "task1", create_test_entry());
        assert_eq!(state.workspace_notification_count(), 2);

        state.clear_workspace_notifications();
        assert_eq!(state.workspace_notification_count(), 0);
    }

    #[test]
    fn test_with_notifications() {
        let mut notifications = HashMap::new();
        notifications.insert("task1".to_string(), create_test_entry());

        let mut workspace_notifications = HashMap::new();
        let mut project_map = HashMap::new();
        project_map.insert("task2".to_string(), create_test_entry());
        workspace_notifications.insert("project1".to_string(), project_map);

        let state = NotificationState::with_notifications(notifications, workspace_notifications);
        assert_eq!(state.notification_count(), 1);
        assert_eq!(state.workspace_notification_count(), 1);
    }

    #[test]
    fn test_default_trait() {
        let state = NotificationState::default();
        assert!(state.notifications.is_empty());
        assert!(state.workspace_notifications.is_empty());
    }
}
