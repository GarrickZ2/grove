use std::time::{Duration, Instant};

use ratatui::widgets::ListState;

use crate::model::{mock, ProjectTab, Worktree};
use crate::theme::{detect_system_theme, get_theme_colors, Theme, ThemeColors};

/// Toast 消息
#[derive(Debug, Clone)]
pub struct Toast {
    pub message: String,
    pub expires_at: Instant,
}

impl Toast {
    pub fn new(message: impl Into<String>, duration: Duration) -> Self {
        Self {
            message: message.into(),
            expires_at: Instant::now() + duration,
        }
    }

    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

/// Project 页面状态
pub struct ProjectState {
    /// 当前选中的 Tab
    pub current_tab: ProjectTab,
    /// 列表选择状态（每个 Tab 独立维护）
    pub list_states: [ListState; 3], // Current, Other, Archived
    /// 各 Tab 的 Worktree 列表
    pub worktrees: [Vec<Worktree>; 3],
    /// 项目路径
    pub project_path: String,
    /// 项目名称
    pub project_name: String,
}

impl ProjectState {
    pub fn new() -> Self {
        let (current, other, archived) = mock::generate_mock_worktrees();

        let mut current_state = ListState::default();
        if !current.is_empty() {
            current_state.select(Some(0));
        }

        let mut other_state = ListState::default();
        if !other.is_empty() {
            other_state.select(Some(0));
        }

        let mut archived_state = ListState::default();
        if !archived.is_empty() {
            archived_state.select(Some(0));
        }

        Self {
            current_tab: ProjectTab::Current,
            list_states: [current_state, other_state, archived_state],
            worktrees: [current, other, archived],
            project_path: "~/code/my-app".to_string(),
            project_name: "my-app".to_string(),
        }
    }

    /// 获取当前 Tab 的 worktree 列表
    pub fn current_worktrees(&self) -> &Vec<Worktree> {
        &self.worktrees[self.current_tab.index()]
    }

    /// 获取当前 Tab 的列表状态（可变）
    pub fn current_list_state_mut(&mut self) -> &mut ListState {
        &mut self.list_states[self.current_tab.index()]
    }

    /// 获取当前 Tab 的列表状态（不可变）
    pub fn current_list_state(&self) -> &ListState {
        &self.list_states[self.current_tab.index()]
    }

    /// 总 worktree 数量
    pub fn total_worktrees(&self) -> usize {
        self.worktrees.iter().map(|w| w.len()).sum()
    }

    /// 切换到下一个 Tab
    pub fn next_tab(&mut self) {
        self.current_tab = self.current_tab.next();
        self.ensure_selection();
    }

    /// 确保当前 Tab 有选中项
    pub fn ensure_selection(&mut self) {
        let list_len = self.current_worktrees().len();
        let state = self.current_list_state_mut();

        if list_len > 0 && state.selected().is_none() {
            state.select(Some(0));
        }
    }

    /// 选中下一项
    pub fn select_next(&mut self) {
        let list_len = self.current_worktrees().len();
        if list_len == 0 {
            return;
        }

        let state = self.current_list_state_mut();
        let current = state.selected().unwrap_or(0);
        let next = (current + 1) % list_len;
        state.select(Some(next));
    }

    /// 选中上一项
    pub fn select_previous(&mut self) {
        let list_len = self.current_worktrees().len();
        if list_len == 0 {
            return;
        }

        let state = self.current_list_state_mut();
        let current = state.selected().unwrap_or(0);
        let prev = if current == 0 {
            list_len - 1
        } else {
            current - 1
        };
        state.select(Some(prev));
    }
}

impl Default for ProjectState {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局应用状态
pub struct App {
    /// 是否应该退出
    pub should_quit: bool,
    /// Project 页面状态
    pub project: ProjectState,
    /// Toast 提示
    pub toast: Option<Toast>,
    /// 当前主题
    pub theme: Theme,
    /// 当前颜色方案
    pub colors: ThemeColors,
    /// 是否显示主题选择器
    pub show_theme_selector: bool,
    /// 主题选择器当前选中索引
    pub theme_selector_index: usize,
    /// 上次检测到的系统主题（用于 Auto 模式检测变化）
    last_system_dark: bool,
}

impl App {
    pub fn new() -> Self {
        let theme = Theme::Auto;
        let last_system_dark = detect_system_theme();
        let colors = get_theme_colors(theme);
        Self {
            should_quit: false,
            project: ProjectState::new(),
            toast: None,
            theme,
            colors,
            show_theme_selector: false,
            theme_selector_index: 0,
            last_system_dark,
        }
    }

    /// 打开主题选择器
    pub fn open_theme_selector(&mut self) {
        // 找到当前主题在列表中的索引
        let themes = Theme::all();
        self.theme_selector_index = themes
            .iter()
            .position(|t| *t == self.theme)
            .unwrap_or(0);
        self.show_theme_selector = true;
    }

    /// 关闭主题选择器
    pub fn close_theme_selector(&mut self) {
        self.show_theme_selector = false;
    }

    /// 主题选择器 - 选择上一个
    pub fn theme_selector_prev(&mut self) {
        let len = Theme::all().len();
        self.theme_selector_index = if self.theme_selector_index == 0 {
            len - 1
        } else {
            self.theme_selector_index - 1
        };
        // 实时预览
        self.apply_theme_at_index(self.theme_selector_index);
    }

    /// 主题选择器 - 选择下一个
    pub fn theme_selector_next(&mut self) {
        let len = Theme::all().len();
        self.theme_selector_index = (self.theme_selector_index + 1) % len;
        // 实时预览
        self.apply_theme_at_index(self.theme_selector_index);
    }

    /// 主题选择器 - 确认选择
    pub fn theme_selector_confirm(&mut self) {
        self.apply_theme_at_index(self.theme_selector_index);
        self.show_theme_selector = false;
        self.show_toast(format!("Theme: {}", self.theme.label()));
    }

    /// 应用指定索引的主题
    fn apply_theme_at_index(&mut self, index: usize) {
        if let Some(theme) = Theme::all().get(index) {
            self.theme = *theme;
            self.colors = get_theme_colors(*theme);
        }
    }

    /// 切换到下一个主题（快捷方式）
    pub fn cycle_theme(&mut self) {
        self.theme = self.theme.next();
        self.colors = get_theme_colors(self.theme);
        self.show_toast(format!("Theme: {}", self.theme.label()));
    }

    /// 显示 Toast 消息
    pub fn show_toast(&mut self, message: impl Into<String>) {
        self.toast = Some(Toast::new(message, Duration::from_secs(2)));
    }

    /// 更新 Toast 状态（清理过期的 Toast）
    pub fn update_toast(&mut self) {
        if let Some(ref toast) = self.toast {
            if toast.is_expired() {
                self.toast = None;
            }
        }
    }

    /// 检查系统主题变化（用于 Auto 模式）
    pub fn check_system_theme(&mut self) {
        // 只在 Auto 模式下检查
        if self.theme != Theme::Auto {
            return;
        }

        let current_dark = detect_system_theme();
        if current_dark != self.last_system_dark {
            self.last_system_dark = current_dark;
            self.colors = get_theme_colors(Theme::Auto);
        }
    }

    /// 退出应用
    pub fn quit(&mut self) {
        self.should_quit = true;
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}
