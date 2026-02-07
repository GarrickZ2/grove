//! UI 状态管理
//!
//! 管理所有与 UI 显示相关的状态，包括主题、颜色、Toast、点击区域等。

use std::time::{Duration, Instant};

use crate::theme::{Theme, ThemeColors};
use crate::ui::click_areas::ClickAreas;

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

/// UI 状态
#[derive(Debug)]
pub struct UiState {
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
    pub last_system_dark: bool,
    /// 可点击区域缓存（每帧渲染时填充）
    pub click_areas: ClickAreas,
    /// 上次点击时间（双击检测）
    pub last_click_time: Instant,
    /// 上次点击位置（双击检测）
    pub last_click_pos: (u16, u16),
}

impl UiState {
    /// 创建新的 UI 状态
    pub fn new(theme: Theme, colors: ThemeColors, last_system_dark: bool) -> Self {
        Self {
            toast: None,
            theme,
            colors,
            show_theme_selector: false,
            theme_selector_index: 0,
            last_system_dark,
            click_areas: ClickAreas::default(),
            last_click_time: Instant::now() - Duration::from_secs(10),
            last_click_pos: (0, 0),
        }
    }

    /// 显示 Toast 消息
    #[allow(dead_code)]
    pub fn show_toast(&mut self, message: impl Into<String>, duration: Duration) {
        self.toast = Some(Toast::new(message, duration));
    }

    /// 清除过期的 Toast
    #[allow(dead_code)]
    pub fn clear_expired_toast(&mut self) {
        if let Some(ref toast) = self.toast {
            if toast.is_expired() {
                self.toast = None;
            }
        }
    }

    /// 切换主题选择器显示状态
    #[allow(dead_code)]
    pub fn toggle_theme_selector(&mut self) {
        self.show_theme_selector = !self.show_theme_selector;
        if self.show_theme_selector {
            // 找到当前主题的索引
            let themes = Theme::all();
            self.theme_selector_index = themes.iter().position(|t| t == &self.theme).unwrap_or(0);
        }
    }

    /// 更新主题
    #[allow(dead_code)]
    pub fn set_theme(&mut self, theme: Theme, colors: ThemeColors) {
        self.theme = theme;
        self.colors = colors;
    }

    /// 记录点击事件
    #[allow(dead_code)]
    pub fn record_click(&mut self, pos: (u16, u16)) {
        self.last_click_time = Instant::now();
        self.last_click_pos = pos;
    }

    /// 检查是否为双击（300ms 内，位置相同）
    #[allow(dead_code)]
    pub fn is_double_click(&self, pos: (u16, u16)) -> bool {
        let time_diff = Instant::now().duration_since(self.last_click_time);
        time_diff < Duration::from_millis(300) && self.last_click_pos == pos
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::get_theme_colors;

    #[test]
    fn test_new_creates_default_state() {
        let theme = Theme::Catppuccin;
        let colors = get_theme_colors(theme);
        let state = UiState::new(theme, colors, false);

        assert!(state.toast.is_none());
        assert_eq!(state.theme, Theme::Catppuccin);
        assert!(!state.show_theme_selector);
        assert_eq!(state.theme_selector_index, 0);
        assert!(!state.last_system_dark);
    }

    #[test]
    fn test_show_toast() {
        let theme = Theme::Catppuccin;
        let colors = get_theme_colors(theme);
        let mut state = UiState::new(theme, colors, false);

        state.show_toast("Test message", Duration::from_secs(3));
        assert!(state.toast.is_some());
        assert_eq!(state.toast.as_ref().unwrap().message, "Test message");
    }

    #[test]
    fn test_toast_expiry() {
        let toast = Toast::new("Test", Duration::from_millis(1));
        assert!(!toast.is_expired());
        std::thread::sleep(Duration::from_millis(2));
        assert!(toast.is_expired());
    }

    #[test]
    fn test_clear_expired_toast() {
        let theme = Theme::Catppuccin;
        let colors = get_theme_colors(theme);
        let mut state = UiState::new(theme, colors, false);

        state.show_toast("Test", Duration::from_millis(1));
        assert!(state.toast.is_some());

        std::thread::sleep(Duration::from_millis(2));
        state.clear_expired_toast();
        assert!(state.toast.is_none());
    }

    #[test]
    fn test_toggle_theme_selector() {
        let theme = Theme::Catppuccin;
        let colors = get_theme_colors(theme);
        let mut state = UiState::new(theme, colors, false);

        assert!(!state.show_theme_selector);
        state.toggle_theme_selector();
        assert!(state.show_theme_selector);
        state.toggle_theme_selector();
        assert!(!state.show_theme_selector);
    }

    #[test]
    fn test_set_theme() {
        let theme = Theme::Catppuccin;
        let colors = get_theme_colors(theme);
        let mut state = UiState::new(theme, colors, false);

        let new_theme = Theme::TokyoNight;
        let new_colors = get_theme_colors(new_theme);
        state.set_theme(new_theme, new_colors);

        assert_eq!(state.theme, Theme::TokyoNight);
    }

    #[test]
    fn test_double_click_detection() {
        let theme = Theme::Catppuccin;
        let colors = get_theme_colors(theme);
        let mut state = UiState::new(theme, colors, false);

        state.record_click((10, 20));
        assert!(state.is_double_click((10, 20)));
        assert!(!state.is_double_click((11, 20))); // 位置不同

        std::thread::sleep(Duration::from_millis(301));
        assert!(!state.is_double_click((10, 20))); // 超时
    }
}
