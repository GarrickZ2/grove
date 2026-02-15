//! 应用配置持久化

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use super::grove_dir;
use crate::error::Result;

/// Terminal multiplexer / agent 交互模式选择
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Multiplexer {
    #[default]
    Tmux,
    Zellij,
    Acp,
}

impl fmt::Display for Multiplexer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Multiplexer::Tmux => write!(f, "tmux"),
            Multiplexer::Zellij => write!(f, "zellij"),
            Multiplexer::Acp => write!(f, "acp"),
        }
    }
}

impl FromStr for Multiplexer {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "tmux" => Ok(Multiplexer::Tmux),
            "zellij" => Ok(Multiplexer::Zellij),
            "acp" => Ok(Multiplexer::Acp),
            _ => Err(format!("unknown multiplexer: {}", s)),
        }
    }
}

/// ACP (Agent Client Protocol) 配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AcpConfig {
    /// Agent 命令 (e.g., "claude")
    #[serde(default)]
    pub agent_command: Option<String>,
    /// Agent 额外参数
    #[serde(default)]
    pub agent_args: Vec<String>,
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
    #[serde(default)]
    pub acp: AcpConfig,
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
///
/// 注意：AutoLink 始终启用，且仅链接被 gitignore 的路径
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoLinkConfig {
    /// Glob 模式列表（支持 **, *, ? 等通配符）
    #[serde(default = "default_auto_link_patterns")]
    pub patterns: Vec<String>,
}

fn default_auto_link_patterns() -> Vec<String> {
    vec![]
}

impl AutoLinkConfig {
    /// 规范化模式列表:去重、去除空白、过滤空模式
    pub fn normalize(&mut self) {
        // 去除首尾空白
        self.patterns = self
            .patterns
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // 去重(保持顺序)
        let mut seen = std::collections::HashSet::new();
        self.patterns.retain(|pattern| seen.insert(pattern.clone()));
    }
}

impl Default for AutoLinkConfig {
    fn default() -> Self {
        Self {
            patterns: default_auto_link_patterns(),
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
    // ACP 模式不需要终端复用器检查，跳过自动切换
    if config.multiplexer != Multiplexer::Acp {
        let tmux_installed = crate::check::check_tmux_available();
        let zellij_installed = crate::check::check_zellij_available();

        let current_installed = match config.multiplexer {
            Multiplexer::Tmux => tmux_installed,
            Multiplexer::Zellij => zellij_installed,
            Multiplexer::Acp => true, // unreachable due to outer check
        };

        if !current_installed {
            config.multiplexer = match config.multiplexer {
                Multiplexer::Tmux => {
                    if zellij_installed {
                        Multiplexer::Zellij
                    } else {
                        Multiplexer::Tmux
                    }
                }
                Multiplexer::Zellij => {
                    if tmux_installed {
                        Multiplexer::Tmux
                    } else {
                        Multiplexer::Zellij
                    }
                }
                Multiplexer::Acp => Multiplexer::Acp,
            };
        }
    }

    config
}

/// 保存配置
pub fn save_config(config: &Config) -> Result<()> {
    // 确保 ~/.grove 目录存在
    let dir = grove_dir();
    fs::create_dir_all(&dir)?;

    // 规范化配置(去重、去空)
    let mut normalized_config = config.clone();
    normalized_config.auto_link.normalize();

    let path = config_path();
    let content = toml::to_string_pretty(&normalized_config)?;
    fs::write(path, content)?;
    Ok(())
}
