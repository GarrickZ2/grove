use ratatui::style::Color;

/// 颜色方案
pub struct Colors;

impl Colors {
    /// Logo 主色（绿色）
    pub const LOGO: Color = Color::Green;
    /// Logo 阴影色
    pub const LOGO_SHADOW: Color = Color::DarkGray;
    /// 高亮色（青色）
    pub const HIGHLIGHT: Color = Color::Cyan;
    /// 次要文字
    pub const MUTED: Color = Color::DarkGray;
    /// 普通文字
    pub const TEXT: Color = Color::White;
    /// 边框颜色
    pub const BORDER: Color = Color::DarkGray;

    /// 状态颜色 - Live
    pub const STATUS_LIVE: Color = Color::Green;
    /// 状态颜色 - Idle
    pub const STATUS_IDLE: Color = Color::DarkGray;
    /// 状态颜色 - Merged
    pub const STATUS_MERGED: Color = Color::Cyan;
    /// 状态颜色 - Conflict
    pub const STATUS_CONFLICT: Color = Color::Yellow;
    /// 状态颜色 - Error
    pub const STATUS_ERROR: Color = Color::Red;
}
