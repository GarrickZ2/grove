//! 配置状态管理
//!
//! 管理全局配置相关的状态，包括 session 类型、布局、agent 命令等。

use crate::storage::config::TerminalMultiplexer;
use crate::tmux::layout::{CustomLayout, TaskLayout};

/// 配置状态
#[derive(Debug)]
pub struct ConfigState {
    /// Terminal 模式使用的复用器
    pub terminal_multiplexer: TerminalMultiplexer,
    /// 是否启用 Terminal 模式
    pub enable_terminal: bool,
    /// 是否启用 Chat 模式
    pub enable_chat: bool,
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
            terminal_multiplexer: TerminalMultiplexer::Tmux,
            enable_terminal: true,
            enable_chat: false,
            task_layout: TaskLayout::Single,
            custom_layout: None,
            agent_command: String::new(),
        }
    }

    /// 从配置文件加载
    #[allow(dead_code)]
    pub fn from_config(config: &crate::storage::config::Config) -> Self {
        Self {
            terminal_multiplexer: config.terminal_multiplexer.clone(),
            enable_terminal: config.enable_terminal,
            enable_chat: config.enable_chat,
            task_layout: TaskLayout::from_name(&config.layout.default)
                .unwrap_or(TaskLayout::Single),
            custom_layout: None, // TODO: parse from config.layout.custom
            agent_command: config.layout.agent_command.clone().unwrap_or_default(),
        }
    }

    /// 获取默认的 session 类型字符串（用于新建 Task）
    pub fn default_session_type(&self) -> String {
        // 当 Terminal + Chat 同时启用时，使用 terminal multiplexer
        // 这样 Terminal 可以连接 tmux/zellij，Chat 通过独立 ACP API 连接
        if self.enable_chat && !self.enable_terminal {
            "acp".to_string()
        } else {
            self.terminal_multiplexer.to_string()
        }
    }

    /// 更新 terminal multiplexer 配置
    #[allow(dead_code)]
    pub fn set_terminal_multiplexer(&mut self, mux: TerminalMultiplexer) {
        self.terminal_multiplexer = mux;
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
        assert!(matches!(
            state.terminal_multiplexer,
            TerminalMultiplexer::Tmux
        ));
        assert!(state.enable_terminal);
        assert!(!state.enable_chat);
        assert!(matches!(state.task_layout, TaskLayout::Single));
        assert!(state.custom_layout.is_none());
        assert!(state.agent_command.is_empty());
    }

    #[test]
    fn test_set_terminal_multiplexer() {
        let mut state = ConfigState::new();
        state.set_terminal_multiplexer(TerminalMultiplexer::Zellij);
        assert!(matches!(
            state.terminal_multiplexer,
            TerminalMultiplexer::Zellij
        ));
    }

    #[test]
    fn test_default_session_type() {
        let mut state = ConfigState::new();
        assert_eq!(state.default_session_type(), "tmux");

        // Only Chat enabled → acp
        state.enable_chat = true;
        state.enable_terminal = false;
        assert_eq!(state.default_session_type(), "acp");

        // Zellij multiplexer
        state.terminal_multiplexer = TerminalMultiplexer::Zellij;
        state.enable_chat = false;
        state.enable_terminal = true;
        assert_eq!(state.default_session_type(), "zellij");
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
        assert!(matches!(
            state.terminal_multiplexer,
            TerminalMultiplexer::Tmux
        ));
    }
}
