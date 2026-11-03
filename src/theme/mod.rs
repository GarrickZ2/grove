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

    /// 是否为 light 主题(用于 Web ThemeConfig 的 light_theme / dark_theme 槽位选择)。
    /// Auto 既非 light 也非 dark,调用方应单独处理。
    pub fn is_light(&self) -> bool {
        matches!(
            self,
            Theme::Light
                | Theme::SolarizedLight
                | Theme::GithubLight
                | Theme::RosePineDawn
                | Theme::CatppuccinLatte
        )
    }

    /// Web ThemeConfig 中使用的 theme id(kebab-case)。`Auto` 没有对应 id。
    pub fn web_id(&self) -> Option<&'static str> {
        Some(match self {
            Theme::Auto => return None,
            Theme::Light => "light",
            Theme::SolarizedLight => "solarized-light",
            Theme::GithubLight => "github-light",
            Theme::RosePineDawn => "rose-pine-dawn",
            Theme::CatppuccinLatte => "catppuccin-latte",
            Theme::Dark => "dark",
            Theme::Dracula => "dracula",
            Theme::Nord => "nord",
            Theme::Gruvbox => "gruvbox",
            Theme::TokyoNight => "tokyo-night",
            Theme::Catppuccin => "catppuccin",
        })
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
    /// 信息色 (蓝色) - 用于 notice 通知
    pub info: Color,
    /// 警告色 (黄色) - 用于 warn 通知
    pub warning: Color,
    /// 错误色 (红色) - 用于 critical 通知
    pub error: Color,
    /// Card color blocks (adjacent pairs make a gradient).
    pub accent_palette: [Color; 10],
}

/// Save `theme` the way the GUI reads it: `mode` plus the light / dark slot
/// (`Auto` only sets the mode), keeping the other slot and custom themes.
pub fn save_theme(theme: Theme) {
    use crate::storage::config::{load_config, save_config};
    let mut config = load_config();
    config.theme.name = theme.label().to_string();
    match (theme, theme.web_id()) {
        (Theme::Auto, _) | (_, None) => config.theme.mode = "auto".to_string(),
        (t, Some(id)) if t.is_light() => {
            config.theme.mode = "light".to_string();
            config.theme.light_theme = id.to_string();
        }
        (_, Some(id)) => {
            config.theme.mode = "dark".to_string();
            config.theme.dark_theme = id.to_string();
        }
    }
    let _ = save_config(&config);
}

/// 解析配置里的主题：优先按 mode + 对应 slot(Web 端写的就是
/// mode/light_theme/dark_theme,完全不写 name);auto 时用终端 dark/light
/// 偏好选 slot,与 Web 行为对齐;都缺失时退回 legacy name 字段。
pub fn configured_theme(config: &crate::storage::config::ThemeConfig, system_dark: bool) -> Theme {
    match config.mode.as_str() {
        "light" if !config.light_theme.is_empty() => Theme::from_name(&config.light_theme),
        "dark" if !config.dark_theme.is_empty() => Theme::from_name(&config.dark_theme),
        "auto" => {
            let slot = if system_dark {
                &config.dark_theme
            } else {
                &config.light_theme
            };
            if slot.is_empty() {
                Theme::Auto
            } else {
                Theme::from_name(slot)
            }
        }
        _ => Theme::from_name(&config.name),
    }
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
