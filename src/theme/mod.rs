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
    // Light themes first
    Light,
    SolarizedLight,
    GithubLight,
    RosePineDawn,
    CatppuccinLatte,
    // Dark themes
    Dark,
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
            // Light themes
            Theme::Light => "Light",
            Theme::SolarizedLight => "Solarized Light",
            Theme::GithubLight => "GitHub Light",
            Theme::RosePineDawn => "Rosé Pine Dawn",
            Theme::CatppuccinLatte => "Catppuccin Latte",
            // Dark themes
            Theme::Dark => "Dark",
            Theme::Dracula => "Dracula",
            Theme::Nord => "Nord",
            Theme::Gruvbox => "Gruvbox",
            Theme::TokyoNight => "Tokyo Night",
            Theme::Catppuccin => "Catppuccin",
        }
    }

    /// 所有主题列表
    pub fn all() -> &'static [Theme] {
        &[
            Theme::Auto,
            // Light themes first
            Theme::Light,
            Theme::SolarizedLight,
            Theme::GithubLight,
            Theme::RosePineDawn,
            Theme::CatppuccinLatte,
            // Dark themes
            Theme::Dark,
            Theme::Dracula,
            Theme::Nord,
            Theme::Gruvbox,
            Theme::TokyoNight,
            Theme::Catppuccin,
        ]
    }

    /// 从名称创建主题（用于配置加载）
    /// 支持两种格式：label（如 "Dark", "Tokyo Night"）和 id（如 "dark", "tokyo-night"）
    pub fn from_name(name: &str) -> Self {
        match name.to_lowercase().as_str() {
            "auto" => Theme::Auto,
            // Light themes
            "light" => Theme::Light,
            "solarized light" | "solarized-light" | "solarizedlight" => Theme::SolarizedLight,
            "github light" | "github-light" | "githublight" => Theme::GithubLight,
            "rosé pine dawn" | "rose pine dawn" | "rose-pine-dawn" | "rosepinedawn" => {
                Theme::RosePineDawn
            }
            "catppuccin latte" | "catppuccin-latte" | "catppuccinlatte" => Theme::CatppuccinLatte,
            // Dark themes
            "dark" => Theme::Dark,
            "dracula" => Theme::Dracula,
            "nord" => Theme::Nord,
            "gruvbox" => Theme::Gruvbox,
            "tokyo night" | "tokyo-night" | "tokyonight" => Theme::TokyoNight,
            "catppuccin" => Theme::Catppuccin,
            _ => Theme::Auto, // 默认 Auto
        }
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
    /// 信息色 (蓝色) - 用于 notice 通知
    pub info: Color,
    /// 警告色 (黄色) - 用于 warn 通知
    pub warning: Color,
    /// 错误色 (红色) - 用于 critical 通知
    pub error: Color,
    /// 卡片背景色调色板（8 色，用于 examples 等扩展场景）
    #[allow(dead_code)]
    pub card_backgrounds: [Color; 8],
    /// 项目卡片渐变方块调色板（10 色，相邻两色做渐变）
    pub accent_palette: [Color; 10],
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
        // Light themes
        Theme::Light => light_colors(),
        Theme::SolarizedLight => solarized_light_colors(),
        Theme::GithubLight => github_light_colors(),
        Theme::RosePineDawn => rose_pine_dawn_colors(),
        Theme::CatppuccinLatte => catppuccin_latte_colors(),
        // Dark themes
        Theme::Dark => dark_colors(),
        Theme::Dracula => dracula_colors(),
        Theme::Nord => nord_colors(),
        Theme::Gruvbox => gruvbox_colors(),
        Theme::TokyoNight => tokyo_night_colors(),
        Theme::Catppuccin => catppuccin_colors(),
    }
}
