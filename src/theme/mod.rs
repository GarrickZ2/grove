mod colors;
mod detect;

use ratatui::style::Color;

pub use colors::*;
pub use detect::detect_system_theme;

/// 主题类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Theme {
    #[default]
    Auto,
    Dark,
    Light,
    Dracula,
    Nord,
    Gruvbox,
    TokyoNight,
    Catppuccin,
}

impl Theme {
    /// 主题显示名称
    pub fn label(&self) -> &'static str {
        match self {
            Theme::Auto => "Auto",
            Theme::Dark => "Dark",
            Theme::Light => "Light",
            Theme::Dracula => "Dracula",
            Theme::Nord => "Nord",
            Theme::Gruvbox => "Gruvbox",
            Theme::TokyoNight => "Tokyo Night",
            Theme::Catppuccin => "Catppuccin",
        }
    }

    /// 切换到下一个主题
    pub fn next(&self) -> Self {
        match self {
            Theme::Auto => Theme::Dark,
            Theme::Dark => Theme::Light,
            Theme::Light => Theme::Dracula,
            Theme::Dracula => Theme::Nord,
            Theme::Nord => Theme::Gruvbox,
            Theme::Gruvbox => Theme::TokyoNight,
            Theme::TokyoNight => Theme::Catppuccin,
            Theme::Catppuccin => Theme::Auto,
        }
    }

    /// 所有主题列表
    pub fn all() -> &'static [Theme] {
        &[
            Theme::Auto,
            Theme::Dark,
            Theme::Light,
            Theme::Dracula,
            Theme::Nord,
            Theme::Gruvbox,
            Theme::TokyoNight,
            Theme::Catppuccin,
        ]
    }
}

/// 主题颜色方案
#[derive(Debug, Clone, Copy)]
pub struct ThemeColors {
    /// 主背景色
    pub bg: Color,
    /// 次级背景色（选中行等）
    pub bg_secondary: Color,
    /// Logo 颜色
    pub logo: Color,
    /// 高亮色（选中项、快捷键等）
    pub highlight: Color,
    /// 普通文字
    pub text: Color,
    /// 次要文字（灰色）
    pub muted: Color,
    /// 边框颜色
    pub border: Color,
    /// 状态 - Live
    pub status_live: Color,
    /// 状态 - Idle
    pub status_idle: Color,
    /// 状态 - Merged
    pub status_merged: Color,
    /// 状态 - Conflict
    pub status_conflict: Color,
    /// 状态 - Error
    pub status_error: Color,
    /// Tab 选中前景色
    pub tab_active_fg: Color,
    /// Tab 选中背景色
    pub tab_active_bg: Color,
}

/// 获取指定主题的颜色方案
pub fn get_theme_colors(theme: Theme) -> ThemeColors {
    match theme {
        Theme::Auto => {
            if detect_system_theme() {
                dark_colors()
            } else {
                light_colors()
            }
        }
        Theme::Dark => dark_colors(),
        Theme::Light => light_colors(),
        Theme::Dracula => dracula_colors(),
        Theme::Nord => nord_colors(),
        Theme::Gruvbox => gruvbox_colors(),
        Theme::TokyoNight => tokyo_night_colors(),
        Theme::Catppuccin => catppuccin_colors(),
    }
}
