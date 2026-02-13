//! 应用配置持久化

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use super::grove_dir;
use crate::error::Result;

/// Terminal multiplexer 选择
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Multiplexer {
    #[default]
    Tmux,
    Zellij,
}

impl fmt::Display for Multiplexer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Multiplexer::Tmux => write!(f, "tmux"),
            Multiplexer::Zellij => write!(f, "zellij"),
        }
    }
}

impl FromStr for Multiplexer {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "tmux" => Ok(Multiplexer::Tmux),
            "zellij" => Ok(Multiplexer::Zellij),
            _ => Err(format!("unknown multiplexer: {}", s)),
        }
    }
}

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub theme: ThemeConfig,
    #[serde(default)]
    pub update: UpdateConfig,
    #[serde(default)]
    pub layout: LayoutConfig,
    #[serde(default)]
    pub mcp: McpConfig,
    #[serde(default)]
    pub web: WebConfig,
    #[serde(default)]
    pub multiplexer: Multiplexer,
    #[serde(default)]
    pub auto_link: AutoLinkConfig,
}

/// MCP Server 配置（预留扩展）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfig {
    // 预留字段，目前仅用于显示配置说明
}

/// Web 专用配置（TUI 会忽略未知字段）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WebConfig {
    /// IDE 命令 (e.g., "code", "cursor", "rustrover")
    #[serde(default)]
    pub ide: Option<String>,
    /// Terminal 命令 (e.g., "iterm", "warp", "kitty")
    #[serde(default)]
    pub terminal: Option<String>,
    /// Terminal color scheme (e.g., "dracula", "tokyo-night", "nord")
    #[serde(default)]
    pub terminal_theme: Option<String>,
}

/// 自定义布局配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CustomLayoutConfig {
    /// JSON-encoded LayoutNode tree
    pub tree: String,
}

/// 布局配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutConfig {
    /// 预设名: "single"/"agent"/"agent-shell"/"agent-monitor"/"custom"
    #[serde(default = "default_layout_name")]
    pub default: String,
    /// agent 启动命令（如 "claude", "claude --yolo"）
    #[serde(default)]
    pub agent_command: Option<String>,
    /// 自定义布局配置
    #[serde(default)]
    pub custom: Option<CustomLayoutConfig>,
    /// 选中的自定义布局 ID（当 default="custom" 时使用）
    #[serde(default)]
    pub selected_custom_id: Option<String>,
}

fn default_layout_name() -> String {
    "single".to_string()
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            default: default_layout_name(),
            agent_command: None,
            custom: None,
            selected_custom_id: None,
        }
    }
}

/// 主题配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeConfig {
    pub name: String,
}

/// 更新检查配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateConfig {
    /// Last update check time (RFC 3339 format)
    pub last_check: Option<String>,
    /// Cached latest version
    pub latest_version: Option<String>,
}

/// AutoLink 配置：自动创建软链接
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoLinkConfig {
    /// 是否启用 AutoLink
    #[serde(default = "default_auto_link_enabled")]
    pub enabled: bool,

    /// Glob 模式列表（支持 **, *, ? 等通配符）
    #[serde(default = "default_auto_link_patterns")]
    pub patterns: Vec<String>,

    /// 是否检查 git ignore 状态（推荐开启）
    #[serde(default = "default_check_gitignore")]
    pub check_gitignore: bool,
}

fn default_auto_link_enabled() -> bool {
    true // 默认启用
}

fn default_auto_link_patterns() -> Vec<String> {
    vec![
        "node_modules".to_string(),    // 根目录 node_modules
        "**/node_modules".to_string(), // 所有子目录中的 node_modules
        ".vscode".to_string(),
        ".idea".to_string(),
        ".fleet".to_string(),
        "target".to_string(), // Rust 构建产物
        "dist".to_string(),
        "build".to_string(),
        ".next".to_string(),
        ".nuxt".to_string(),
    ]
}

fn default_check_gitignore() -> bool {
    true
}

impl Default for AutoLinkConfig {
    fn default() -> Self {
        Self {
            enabled: default_auto_link_enabled(),
            patterns: default_auto_link_patterns(),
            check_gitignore: default_check_gitignore(),
        }
    }
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            name: "Auto".to_string(),
        }
    }
}

/// 获取配置文件路径
fn config_path() -> PathBuf {
    grove_dir().join("config.toml")
}

/// 加载配置（不存在则返回默认值）
pub fn load_config() -> Config {
    let path = config_path();
    let mut config = if !path.exists() {
        Config::default()
    } else {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    };

    // 智能选择 multiplexer：根据实际安装情况自动调整
    let tmux_installed = crate::check::check_tmux_available();
    let zellij_installed = crate::check::check_zellij_available();

    // 检查当前配置的 multiplexer 是否已安装
    let current_installed = match config.multiplexer {
        Multiplexer::Tmux => tmux_installed,
        Multiplexer::Zellij => zellij_installed,
    };

    // 如果当前选择的未安装，自动切换到已安装的
    if !current_installed {
        config.multiplexer = match config.multiplexer {
            Multiplexer::Tmux => {
                // tmux 未安装，尝试切换到 zellij
                if zellij_installed {
                    Multiplexer::Zellij
                } else {
                    // zellij 也没装，保持 tmux（启动不失败）
                    Multiplexer::Tmux
                }
            }
            Multiplexer::Zellij => {
                // zellij 未安装，尝试切换到 tmux
                if tmux_installed {
                    Multiplexer::Tmux
                } else {
                    // tmux 也没装，保持 zellij（启动不失败）
                    Multiplexer::Zellij
                }
            }
        };
    }

    config
}

/// 保存配置
pub fn save_config(config: &Config) -> Result<()> {
    // 确保 ~/.grove 目录存在
    let dir = grove_dir();
    fs::create_dir_all(&dir)?;

    let path = config_path();
    let content = toml::to_string_pretty(config)?;
    fs::write(path, content)?;
    Ok(())
}
