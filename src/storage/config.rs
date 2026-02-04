//! 应用配置持久化

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::PathBuf;

use super::grove_dir;

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
    if !path.exists() {
        return Config::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| toml::from_str(&s).ok())
        .unwrap_or_default()
}

/// 保存配置
pub fn save_config(config: &Config) -> io::Result<()> {
    // 确保 ~/.grove 目录存在
    let dir = grove_dir();
    fs::create_dir_all(&dir)?;

    let path = config_path();
    let content = toml::to_string_pretty(config)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(path, content)
}
