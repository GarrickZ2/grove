//! 应用配置持久化

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use super::grove_dir;
use crate::error::Result;

/// Terminal 复用器（只包含真正的 terminal multiplexer）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalMultiplexer {
    #[default]
    Tmux,
    Zellij,
}

impl fmt::Display for TerminalMultiplexer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TerminalMultiplexer::Tmux => write!(f, "tmux"),
            TerminalMultiplexer::Zellij => write!(f, "zellij"),
        }
    }
}

impl FromStr for TerminalMultiplexer {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "tmux" => Ok(TerminalMultiplexer::Tmux),
            "zellij" => Ok(TerminalMultiplexer::Zellij),
            _ => Err(format!("unknown terminal multiplexer: {}", s)),
        }
    }
}

/// 旧的 Multiplexer enum（仅用于向后兼容的反序列化）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LegacyMultiplexer {
    Tmux,
    Zellij,
    Acp,
}

/// 自定义 ACP Agent Server 配置（local 命令 / remote URL）
///
/// 注意：TOML key 仍是 `custom_agents`（保持向后兼容），但 Rust 类型名采用
/// `CustomAgentServer` 以与新加的 Custom Agent (Persona, SQLite 存储) 区分。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAgentServer {
    /// 唯一标识 (e.g., "my-agent")
    pub id: String,
    /// 显示名 (e.g., "My Agent")
    pub name: String,
    /// "local" | "remote"
    #[serde(rename = "type")]
    pub agent_type: String,
    /// Local: 命令路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Local: 额外参数
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Remote: WebSocket URL
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Remote: Authorization header
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_header: Option<String>,
}

fn default_acp_render_window_trigger() -> u32 {
    1500
}

/// Hooks 通知配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksConfig {
    /// Agent Response 声音开关（Chat Turn End）
    #[serde(default = "default_true", alias = "sound_enabled")]
    pub response_sound_enabled: bool,
    /// Agent Response 声音名称（默认 Glass）
    #[serde(default = "default_response_sound", alias = "sound")]
    pub response_sound: String,
    /// Agent Permission Required 声音开关
    #[serde(default = "default_true")]
    pub permission_sound_enabled: bool,
    /// Agent Permission Required 声音名称（默认 Purr）
    #[serde(default = "default_permission_sound")]
    pub permission_sound: String,
}

fn default_true() -> bool {
    true
}

fn default_response_sound() -> String {
    "Glass".to_string()
}

fn default_permission_sound() -> String {
    "Purr".to_string()
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            response_sound_enabled: true,
            response_sound: default_response_sound(),
            permission_sound_enabled: true,
            permission_sound: default_permission_sound(),
        }
    }
}

/// ACP (Agent Client Protocol) 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpConfig {
    /// Agent 命令 (e.g., "claude")
    #[serde(default)]
    pub agent_command: Option<String>,
    /// Agent 额外参数
    #[serde(default)]
    pub agent_args: Vec<String>,
    /// 自定义 Agents
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_agents: Vec<CustomAgentServer>,
    /// Frontend chat view message window. 0 means unlimited.
    #[serde(default)]
    pub render_window_limit: u32,
    /// Prune when the frontend chat view reaches this many UI messages.
    #[serde(default = "default_acp_render_window_trigger")]
    pub render_window_trigger: u32,
}

impl Default for AcpConfig {
    fn default() -> Self {
        Self {
            agent_command: None,
            agent_args: Vec::new(),
            custom_agents: Vec::new(),
            render_window_limit: 0,
            render_window_trigger: default_acp_render_window_trigger(),
        }
    }
}

impl AcpConfig {
    pub fn normalize(&mut self) {
        if self.render_window_limit == 0 {
            if self.render_window_trigger == 0 {
                self.render_window_trigger = default_acp_render_window_trigger();
            }
            return;
        }

        if self.render_window_trigger <= self.render_window_limit {
            self.render_window_trigger = self.render_window_limit.saturating_add(500);
        }
    }
}

/// 上次使用的启动模式命令（用于 `grove` 无参数时重放）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "command", rename_all = "lowercase")]
pub enum LastLaunch {
    Tui,
    Web {
        #[serde(default = "default_web_port")]
        port: u16,
        #[serde(default)]
        no_open: bool,
        #[serde(default)]
        dev: bool,
    },
    Mobile {
        #[serde(default = "default_web_port")]
        port: u16,
        #[serde(default)]
        no_open: bool,
        #[serde(default)]
        tls: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cert: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        #[serde(default)]
        public: bool,
    },
    Gui {
        #[serde(default = "default_gui_port")]
        port: u16,
    },
}

fn default_web_port() -> u16 {
    3001
}

fn default_gui_port() -> u16 {
    3001
}

impl LastLaunch {
    /// 获取用于显示的描述文本
    pub fn display_label(&self) -> String {
        match self {
            LastLaunch::Tui => "tui".to_string(),
            LastLaunch::Web { port, dev, .. } => {
                if *dev {
                    format!("web --dev (port {})", port)
                } else {
                    format!("web (port {})", port)
                }
            }
            LastLaunch::Mobile { port, tls, .. } => {
                if *tls {
                    format!("mobile --tls (port {})", port)
                } else {
                    format!("mobile (port {})", port)
                }
            }
            LastLaunch::Gui { port } => format!("gui (port {})", port),
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
    pub auto_link: AutoLinkConfig,
    #[serde(default)]
    pub acp: AcpConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub notifications: NotificationsConfig,
    #[serde(default)]
    pub indexing: IndexingConfig,

    /// Storage layout version (None = legacy, "1.0" = task-centric layout)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_version: Option<String>,

    /// 是否启用 Terminal 模式（不再持久化，TUI 内部运行时管理）
    #[serde(skip)]
    pub enable_terminal: bool,

    /// 是否启用 Chat 模式（不再持久化，TUI 内部运行时管理）
    #[serde(skip)]
    pub enable_chat: bool,

    /// Terminal 模式使用的复用器
    #[serde(default)]
    pub terminal_multiplexer: TerminalMultiplexer,

    /// 上次使用的启动模式（用于 `grove` 无参数时重放）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_launch: Option<LastLaunch>,

    // ===== 向后兼容字段（反序列化时使用，序列化时跳过） =====
    #[serde(skip_serializing, default)]
    multiplexer: Option<LegacyMultiplexer>,

    #[serde(skip_serializing, default)]
    enabled_modes: Vec<String>,
}

/// Menubar tray + macOS notifications config. The two surfaces are
/// independently togglable per category so users can pair them however they
/// like (e.g. tray for permissions, system notifications for completions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationsConfig {
    /// Whether the menubar tray icon is enabled at all.
    #[serde(default = "default_true")]
    pub tray_enabled: bool,
    #[serde(default = "default_true")]
    pub tray_show_permission: bool,
    #[serde(default = "default_true")]
    pub tray_show_done: bool,
    #[serde(default = "default_true")]
    pub tray_show_running: bool,

    /// Whether macOS / system notifications fire at all.
    #[serde(default)]
    pub notification_enabled: bool,
    #[serde(default = "default_true")]
    pub notification_show_permission: bool,
    #[serde(default = "default_true")]
    pub notification_show_done: bool,
    /// System notifications for running sessions are disabled by default —
    /// they fire continuously and would be too noisy.
    #[serde(default)]
    pub notification_show_running: bool,

    /// Global shortcut to show / hide the menubar tray popover.
    /// Stored in display form (e.g. "Cmd+Shift+M"); empty/None disables.
    #[serde(default)]
    pub menubar_shortcut: Option<String>,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            tray_enabled: true,
            tray_show_permission: true,
            tray_show_done: true,
            tray_show_running: true,
            notification_enabled: false,
            notification_show_permission: true,
            notification_show_done: true,
            notification_show_running: false,
            menubar_shortcut: None,
        }
    }
}

/// MCP Server 配置（预留扩展）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfig {
    // 预留字段，目前仅用于显示配置说明
}

/// Symbol-indexing config (cmd+click navigation).
///
/// `disabled_languages` is a deny-list (rather than the symmetric
/// "enabled list") so newly added languages opt-in by default — when a
/// future grove release ships, say, a TS grammar, existing users get
/// it without re-touching their config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexingConfig {
    /// Master toggle. When false, `on_watch_started` no-ops and no
    /// build is triggered for newly activated tasks.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Language IDs (matching `Language::as_str()`) the user has opted
    /// out of. Files with these languages are skipped during build.
    #[serde(default)]
    pub disabled_languages: Vec<String>,
}

impl Default for IndexingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            disabled_languages: Vec::new(),
        }
    }
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
    /// Web 端 Terminal 后端模式: "multiplexer" (default) | "direct"
    ///   - "multiplexer": 使用 terminal_multiplexer 配置的 tmux/zellij
    ///   - "direct": 每个 Tab 一个独立 PTY 实例，无需 multiplexer
    ///
    /// CLI 不使用此字段，始终走 multiplexer
    #[serde(default)]
    pub terminal_mode: Option<String>,
    /// Workspace 布局模式: "flex" (default) | "ide"
    ///   - "flex": 自由拖拽的 FlexLayout 面板
    ///   - "ide": 固定三栏 IDE 布局 (Chat-centric)
    #[serde(default)]
    pub workspace_layout: Option<String>,
    /// GUI-only global shortcut for showing or hiding the main window.
    #[serde(default)]
    pub show_hide_window_shortcut: Option<String>,
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

    // ===== 向后兼容：从旧字段迁移到新字段 =====

    // 优先从 enabled_modes 迁移（如果存在）
    if !config.enabled_modes.is_empty() {
        for mode_str in &config.enabled_modes {
            match mode_str.as_str() {
                "tmux" => {
                    config.enable_terminal = true;
                    config.terminal_multiplexer = TerminalMultiplexer::Tmux;
                }
                "zellij" => {
                    config.enable_terminal = true;
                    config.terminal_multiplexer = TerminalMultiplexer::Zellij;
                }
                "acp" => {
                    config.enable_chat = true;
                }
                _ => {}
            }
        }
    }
    // 否则从 multiplexer 迁移
    else if let Some(legacy_mux) = &config.multiplexer {
        match legacy_mux {
            LegacyMultiplexer::Tmux => {
                config.enable_terminal = true;
                config.terminal_multiplexer = TerminalMultiplexer::Tmux;
            }
            LegacyMultiplexer::Zellij => {
                config.enable_terminal = true;
                config.terminal_multiplexer = TerminalMultiplexer::Zellij;
            }
            LegacyMultiplexer::Acp => {
                config.enable_chat = true;
            }
        }
    }

    // 智能选择 terminal_multiplexer：根据实际安装情况自动调整
    if config.enable_terminal {
        let tmux_installed = crate::check::check_tmux_available();
        let zellij_installed = crate::check::check_zellij_available();

        let current_installed = match config.terminal_multiplexer {
            TerminalMultiplexer::Tmux => tmux_installed,
            TerminalMultiplexer::Zellij => zellij_installed,
        };

        if !current_installed {
            config.terminal_multiplexer = match config.terminal_multiplexer {
                TerminalMultiplexer::Tmux => {
                    if zellij_installed {
                        TerminalMultiplexer::Zellij
                    } else {
                        TerminalMultiplexer::Tmux
                    }
                }
                TerminalMultiplexer::Zellij => {
                    if tmux_installed {
                        TerminalMultiplexer::Tmux
                    } else {
                        TerminalMultiplexer::Zellij
                    }
                }
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
    normalized_config.acp.normalize();

    let path = config_path();
    let content = toml::to_string_pretty(&normalized_config)?;
    fs::write(path, content)?;
    Ok(())
}

impl Config {
    /// 获取默认的 Session 类型（用于新建 Task）
    ///
    /// 返回当前启用的第一个模式对应的 session 类型字符串：
    /// - 如果启用 Chat → "acp"
    /// - 否则如果启用 Terminal → terminal_multiplexer.to_string()
    /// - 都未启用 → terminal_multiplexer.to_string() (兜底)
    pub fn default_session_type(&self) -> String {
        // 当 Terminal + Chat 同时启用时，使用 terminal multiplexer
        // 这样 Terminal 可以连接 tmux/zellij，Chat 通过独立 ACP API 连接
        if self.enable_chat && !self.enable_terminal {
            "acp".to_string()
        } else {
            self.terminal_multiplexer.to_string()
        }
    }
}
