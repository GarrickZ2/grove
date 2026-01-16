//! 主题颜色定义

use ratatui::style::Color;

use super::ThemeColors;

/// 深色主题（默认）
pub fn dark_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(24, 24, 24),           // 深灰背景
        bg_secondary: Color::Rgb(48, 48, 48), // 选中行背景
        logo: Color::Rgb(0, 255, 136),        // 亮绿色
        highlight: Color::Rgb(0, 255, 136),   // 亮绿色
        text: Color::White,
        muted: Color::Rgb(128, 128, 128),     // 灰色
        border: Color::Rgb(68, 68, 68),       // 深灰边框
        status_live: Color::Rgb(0, 255, 136), // 绿色
        status_idle: Color::Rgb(128, 128, 128),
        status_merged: Color::Rgb(138, 43, 226),  // 紫色
        status_conflict: Color::Rgb(255, 165, 0), // 橙色
        status_error: Color::Rgb(255, 85, 85),    // 红色
        tab_active_fg: Color::Black,
        tab_active_bg: Color::Rgb(0, 255, 136),
        info: Color::Rgb(100, 181, 246),   // 蓝色
        warning: Color::Rgb(255, 213, 79), // 黄色
        error: Color::Rgb(255, 85, 85),    // 红色
    }
}

/// 浅色主题
pub fn light_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(250, 250, 250),           // 浅灰背景
        bg_secondary: Color::Rgb(230, 230, 230), // 选中行背景
        logo: Color::Rgb(0, 128, 68),            // 深绿色
        highlight: Color::Rgb(0, 128, 68),
        text: Color::Rgb(30, 30, 30), // 深灰文字
        muted: Color::Rgb(120, 120, 120),
        border: Color::Rgb(200, 200, 200),
        status_live: Color::Rgb(0, 150, 80),
        status_idle: Color::Rgb(140, 140, 140),
        status_merged: Color::Rgb(128, 0, 128),
        status_conflict: Color::Rgb(200, 120, 0),
        status_error: Color::Rgb(200, 50, 50),
        tab_active_fg: Color::White,
        tab_active_bg: Color::Rgb(0, 128, 68),
        info: Color::Rgb(33, 150, 243),   // 蓝色
        warning: Color::Rgb(255, 152, 0), // 橙黄色
        error: Color::Rgb(200, 50, 50),   // 红色
    }
}

/// Dracula 主题
pub fn dracula_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(40, 42, 54),            // 背景色
        bg_secondary: Color::Rgb(68, 71, 90),  // 选中行
        logo: Color::Rgb(189, 147, 249),       // 紫色
        highlight: Color::Rgb(255, 121, 198),  // 粉色
        text: Color::Rgb(248, 248, 242),       // 前景色
        muted: Color::Rgb(98, 114, 164),       // 注释色
        border: Color::Rgb(68, 71, 90),        // 边框
        status_live: Color::Rgb(80, 250, 123), // 绿色
        status_idle: Color::Rgb(98, 114, 164),
        status_merged: Color::Rgb(189, 147, 249),   // 紫色
        status_conflict: Color::Rgb(255, 184, 108), // 橙色
        status_error: Color::Rgb(255, 85, 85),      // 红色
        tab_active_fg: Color::Rgb(40, 42, 54),      // 背景色
        tab_active_bg: Color::Rgb(255, 121, 198),   // 粉色
        info: Color::Rgb(139, 233, 253),            // cyan
        warning: Color::Rgb(241, 250, 140),         // yellow
        error: Color::Rgb(255, 85, 85),             // red
    }
}

/// Nord 主题
pub fn nord_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(46, 52, 64),             // polar night
        bg_secondary: Color::Rgb(59, 66, 82),   // polar night lighter
        logo: Color::Rgb(136, 192, 208),        // frost
        highlight: Color::Rgb(129, 161, 193),   // frost darker
        text: Color::Rgb(236, 239, 244),        // snow storm
        muted: Color::Rgb(76, 86, 106),         // polar night light
        border: Color::Rgb(59, 66, 82),         // polar night
        status_live: Color::Rgb(163, 190, 140), // aurora green
        status_idle: Color::Rgb(76, 86, 106),
        status_merged: Color::Rgb(180, 142, 173), // aurora purple
        status_conflict: Color::Rgb(235, 203, 139), // aurora yellow
        status_error: Color::Rgb(191, 97, 106),   // aurora red
        tab_active_fg: Color::Rgb(46, 52, 64),    // polar night dark
        tab_active_bg: Color::Rgb(136, 192, 208), // frost
        info: Color::Rgb(136, 192, 208),          // frost (蓝色)
        warning: Color::Rgb(235, 203, 139),       // aurora yellow
        error: Color::Rgb(191, 97, 106),          // aurora red
    }
}

/// Gruvbox 主题 (dark)
pub fn gruvbox_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(40, 40, 40),            // bg0
        bg_secondary: Color::Rgb(60, 56, 54),  // bg1
        logo: Color::Rgb(250, 189, 47),        // yellow
        highlight: Color::Rgb(254, 128, 25),   // orange
        text: Color::Rgb(235, 219, 178),       // fg
        muted: Color::Rgb(146, 131, 116),      // gray
        border: Color::Rgb(80, 73, 69),        // bg1
        status_live: Color::Rgb(184, 187, 38), // green
        status_idle: Color::Rgb(146, 131, 116),
        status_merged: Color::Rgb(211, 134, 155),  // purple
        status_conflict: Color::Rgb(254, 128, 25), // orange
        status_error: Color::Rgb(251, 73, 52),     // red
        tab_active_fg: Color::Rgb(40, 40, 40),     // bg0_h
        tab_active_bg: Color::Rgb(250, 189, 47),   // yellow
        info: Color::Rgb(131, 165, 152),           // aqua/blue
        warning: Color::Rgb(250, 189, 47),         // yellow
        error: Color::Rgb(251, 73, 52),            // red
    }
}

/// Tokyo Night 主题
pub fn tokyo_night_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(26, 27, 38),             // bg_dark
        bg_secondary: Color::Rgb(41, 46, 66),   // bg_highlight
        logo: Color::Rgb(125, 207, 255),        // cyan
        highlight: Color::Rgb(187, 154, 247),   // purple
        text: Color::Rgb(192, 202, 245),        // fg
        muted: Color::Rgb(86, 95, 137),         // comment
        border: Color::Rgb(41, 46, 66),         // bg_highlight
        status_live: Color::Rgb(158, 206, 106), // green
        status_idle: Color::Rgb(86, 95, 137),
        status_merged: Color::Rgb(187, 154, 247),   // purple
        status_conflict: Color::Rgb(224, 175, 104), // orange
        status_error: Color::Rgb(247, 118, 142),    // red
        tab_active_fg: Color::Rgb(26, 27, 38),      // bg_dark
        tab_active_bg: Color::Rgb(125, 207, 255),   // cyan
        info: Color::Rgb(125, 207, 255),            // cyan
        warning: Color::Rgb(224, 175, 104),         // orange
        error: Color::Rgb(247, 118, 142),           // red
    }
}

/// Catppuccin 主题 (Mocha)
pub fn catppuccin_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(30, 30, 46),             // base
        bg_secondary: Color::Rgb(49, 50, 68),   // surface0
        logo: Color::Rgb(203, 166, 247),        // mauve
        highlight: Color::Rgb(245, 194, 231),   // pink
        text: Color::Rgb(205, 214, 244),        // text
        muted: Color::Rgb(127, 132, 156),       // overlay1
        border: Color::Rgb(69, 71, 90),         // surface1
        status_live: Color::Rgb(166, 227, 161), // green
        status_idle: Color::Rgb(127, 132, 156),
        status_merged: Color::Rgb(203, 166, 247),   // mauve
        status_conflict: Color::Rgb(250, 179, 135), // peach
        status_error: Color::Rgb(243, 139, 168),    // red
        tab_active_fg: Color::Rgb(30, 30, 46),      // base
        tab_active_bg: Color::Rgb(245, 194, 231),   // pink
        info: Color::Rgb(137, 180, 250),            // blue
        warning: Color::Rgb(249, 226, 175),         // yellow
        error: Color::Rgb(243, 139, 168),           // red
    }
}
