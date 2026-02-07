//! 配置状态管理
//!
//! 管理全局配置相关的状态，包括 multiplexer、布局、agent 命令等。

use crate::storage::config::Multiplexer;
use crate::tmux::layout::{CustomLayout, TaskLayout};

/// 配置状态
#[derive(Debug)]
pub struct ConfigState {
    /// 当前全局 multiplexer 设置
    pub multiplexer: Multiplexer,
    /// 当前布局预设
    pub task_layout: TaskLayout,
    /// 自定义布局（当 task_layout == Custom 时使用）
    pub custom_layout: Option<CustomLayout>,
    /// Agent 启动命令
    pub agent_command: String,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigState {
    /// 创建新的配置状态
    pub fn new() -> Self {
        Self {
            multiplexer: Multiplexer::Tmux,
            task_layout: TaskLayout::Single,
            custom_layout: None,
            agent_command: String::new(),
        }
    }

    /// 从配置文件加载
    #[allow(dead_code)]
    pub fn from_config(config: &crate::storage::config::Config) -> Self {
        Self {
            multiplexer: config.multiplexer.clone(),
            task_layout: TaskLayout::from_name(&config.layout.default)
                .unwrap_or(TaskLayout::Single),
            custom_layout: None, // TODO: parse from config.layout.custom
            agent_command: config.layout.agent_command.clone().unwrap_or_default(),
        }
    }

    /// 更新 multiplexer 配置
    #[allow(dead_code)]
    pub fn set_multiplexer(&mut self, mux: Multiplexer) {
        self.multiplexer = mux;
    }

    /// 更新布局配置
    #[allow(dead_code)]
    pub fn set_layout(&mut self, layout: TaskLayout, custom: Option<CustomLayout>) {
        self.task_layout = layout;
        self.custom_layout = custom;
    }

    /// 更新 agent 命令
    #[allow(dead_code)]
    pub fn set_agent_command(&mut self, command: String) {
        self.agent_command = command;
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
        let state = ConfigState::new();
        assert!(matches!(state.multiplexer, Multiplexer::Tmux));
        assert!(matches!(state.task_layout, TaskLayout::Single));
        assert!(state.custom_layout.is_none());
        assert!(state.agent_command.is_empty());
    }

    #[test]
    fn test_set_multiplexer() {
        let mut state = ConfigState::new();
        state.set_multiplexer(Multiplexer::Zellij);
        assert!(matches!(state.multiplexer, Multiplexer::Zellij));
    }

    #[test]
    fn test_set_layout() {
        let mut state = ConfigState::new();
        state.set_layout(TaskLayout::AgentShell, None);
        assert!(matches!(state.task_layout, TaskLayout::AgentShell));
        assert!(state.custom_layout.is_none());
    }

    #[test]
    fn test_set_agent_command() {
        let mut state = ConfigState::new();
        state.set_agent_command("claude".to_string());
        assert_eq!(state.agent_command, "claude");
    }

    #[test]
    fn test_default_trait() {
        let state = ConfigState::default();
        assert!(matches!(state.multiplexer, Multiplexer::Tmux));
    }
}
