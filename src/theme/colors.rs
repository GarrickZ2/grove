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
        card_backgrounds: [
            Color::Rgb(40, 28, 28), // warm red
            Color::Rgb(28, 40, 30), // forest green
            Color::Rgb(28, 30, 45), // navy blue
            Color::Rgb(42, 36, 24), // amber
            Color::Rgb(36, 28, 44), // purple
            Color::Rgb(26, 38, 42), // teal
            Color::Rgb(44, 34, 26), // rust
            Color::Rgb(30, 36, 36), // slate
        ],
        accent_palette: [
            Color::Rgb(235, 130, 130), // coral
            Color::Rgb(240, 170, 115), // peach
            Color::Rgb(230, 200, 105), // gold
            Color::Rgb(130, 205, 145), // mint
            Color::Rgb(110, 198, 195), // aqua
            Color::Rgb(120, 175, 225), // sky
            Color::Rgb(150, 155, 230), // periwinkle
            Color::Rgb(185, 148, 225), // lavender
            Color::Rgb(220, 148, 195), // orchid
            Color::Rgb(230, 150, 160), // rose
        ],
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
        card_backgrounds: [
            Color::Rgb(252, 235, 235), // soft pink
            Color::Rgb(232, 248, 238), // soft mint
            Color::Rgb(232, 238, 252), // soft blue
            Color::Rgb(252, 248, 230), // soft yellow
            Color::Rgb(244, 234, 252), // soft lavender
            Color::Rgb(228, 246, 250), // soft cyan
            Color::Rgb(252, 240, 228), // soft peach
            Color::Rgb(238, 244, 238), // soft sage
        ],
        accent_palette: [
            Color::Rgb(220, 80, 80),   // warm red
            Color::Rgb(230, 140, 60),  // tangerine
            Color::Rgb(200, 170, 40),  // olive gold
            Color::Rgb(60, 170, 90),   // emerald
            Color::Rgb(40, 160, 160),  // teal
            Color::Rgb(50, 130, 200),  // ocean
            Color::Rgb(100, 100, 210), // indigo
            Color::Rgb(150, 90, 200),  // violet
            Color::Rgb(190, 80, 150),  // magenta
            Color::Rgb(210, 90, 110),  // berry
        ],
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
        card_backgrounds: [
            Color::Rgb(50, 42, 54), // pink tint
            Color::Rgb(40, 52, 46), // green tint
            Color::Rgb(40, 46, 62), // cyan tint
            Color::Rgb(54, 52, 40), // yellow tint
            Color::Rgb(48, 42, 58), // purple tint
            Color::Rgb(38, 48, 56), // blue tint
            Color::Rgb(56, 46, 40), // orange tint
            Color::Rgb(44, 48, 52), // slate tint
        ],
        accent_palette: [
            Color::Rgb(255, 85, 85),   // red
            Color::Rgb(255, 184, 108), // orange
            Color::Rgb(241, 250, 140), // yellow
            Color::Rgb(80, 250, 123),  // green
            Color::Rgb(139, 233, 253), // cyan
            Color::Rgb(98, 114, 164),  // comment blue
            Color::Rgb(189, 147, 249), // purple
            Color::Rgb(255, 121, 198), // pink
            Color::Rgb(248, 248, 242), // foreground
            Color::Rgb(255, 150, 150), // light red
        ],
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
        card_backgrounds: [
            Color::Rgb(58, 52, 60), // red aurora tint
            Color::Rgb(50, 58, 56), // green aurora tint
            Color::Rgb(48, 56, 66), // frost blue tint
            Color::Rgb(60, 58, 50), // yellow aurora tint
            Color::Rgb(54, 50, 62), // purple tint
            Color::Rgb(46, 56, 64), // frost cyan tint
            Color::Rgb(62, 54, 50), // orange tint
            Color::Rgb(52, 56, 58), // polar night tint
        ],
        accent_palette: [
            Color::Rgb(191, 97, 106),  // aurora red
            Color::Rgb(208, 135, 112), // aurora orange
            Color::Rgb(235, 203, 139), // aurora yellow
            Color::Rgb(163, 190, 140), // aurora green
            Color::Rgb(143, 188, 187), // frost teal
            Color::Rgb(136, 192, 208), // frost blue
            Color::Rgb(129, 161, 193), // frost dark
            Color::Rgb(180, 142, 173), // aurora purple
            Color::Rgb(210, 160, 170), // soft pink
            Color::Rgb(200, 130, 120), // warm coral
        ],
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
        card_backgrounds: [
            Color::Rgb(52, 38, 36), // red tint
            Color::Rgb(38, 48, 34), // green tint
            Color::Rgb(36, 42, 54), // blue tint
            Color::Rgb(54, 48, 32), // yellow tint
            Color::Rgb(48, 36, 50), // purple tint
            Color::Rgb(34, 46, 48), // aqua tint
            Color::Rgb(56, 44, 34), // orange tint
            Color::Rgb(44, 44, 42), // gray tint
        ],
        accent_palette: [
            Color::Rgb(251, 73, 52),   // red
            Color::Rgb(254, 128, 25),  // orange
            Color::Rgb(250, 189, 47),  // yellow
            Color::Rgb(184, 187, 38),  // green
            Color::Rgb(131, 165, 152), // aqua
            Color::Rgb(69, 133, 136),  // dark aqua
            Color::Rgb(104, 157, 106), // faded green
            Color::Rgb(211, 134, 155), // purple
            Color::Rgb(235, 219, 178), // fg
            Color::Rgb(214, 93, 14),   // dark orange
        ],
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
        card_backgrounds: [
            Color::Rgb(38, 30, 44), // red tint
            Color::Rgb(28, 38, 34), // green tint
            Color::Rgb(28, 34, 50), // blue tint
            Color::Rgb(42, 38, 28), // yellow tint
            Color::Rgb(38, 28, 48), // purple tint
            Color::Rgb(26, 36, 42), // cyan tint
            Color::Rgb(44, 34, 28), // orange tint
            Color::Rgb(32, 36, 38), // slate tint
        ],
        accent_palette: [
            Color::Rgb(247, 118, 142), // red
            Color::Rgb(224, 175, 104), // orange
            Color::Rgb(224, 220, 140), // yellow
            Color::Rgb(158, 206, 106), // green
            Color::Rgb(115, 218, 202), // teal
            Color::Rgb(125, 207, 255), // cyan
            Color::Rgb(122, 162, 247), // blue
            Color::Rgb(187, 154, 247), // purple
            Color::Rgb(245, 194, 231), // pink
            Color::Rgb(255, 158, 170), // light red
        ],
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
        card_backgrounds: [
            Color::Rgb(42, 30, 46), // red/pink tint
            Color::Rgb(30, 40, 38), // green tint
            Color::Rgb(30, 36, 52), // blue tint
            Color::Rgb(44, 40, 30), // yellow tint
            Color::Rgb(40, 30, 50), // mauve tint
            Color::Rgb(28, 38, 44), // teal tint
            Color::Rgb(46, 36, 30), // peach tint
            Color::Rgb(36, 38, 42), // surface tint
        ],
        accent_palette: [
            Color::Rgb(243, 139, 168), // red
            Color::Rgb(250, 179, 135), // peach
            Color::Rgb(249, 226, 175), // yellow
            Color::Rgb(166, 227, 161), // green
            Color::Rgb(148, 226, 213), // teal
            Color::Rgb(137, 180, 250), // blue
            Color::Rgb(116, 199, 236), // sapphire
            Color::Rgb(203, 166, 247), // mauve
            Color::Rgb(245, 194, 231), // pink
            Color::Rgb(242, 205, 205), // flamingo
        ],
    }
}

/// Solarized Light 主题
pub fn solarized_light_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(253, 246, 227),            // base3
        bg_secondary: Color::Rgb(238, 232, 213),  // base2
        logo: Color::Rgb(38, 139, 210),           // blue
        highlight: Color::Rgb(42, 161, 152),      // cyan
        text: Color::Rgb(101, 123, 131),          // base00
        muted: Color::Rgb(147, 161, 161),         // base1
        border: Color::Rgb(238, 232, 213),        // base2
        status_live: Color::Rgb(133, 153, 0),     // green
        status_idle: Color::Rgb(147, 161, 161),   // base1
        status_merged: Color::Rgb(108, 113, 196), // violet
        status_conflict: Color::Rgb(203, 75, 22), // orange
        status_error: Color::Rgb(220, 50, 47),    // red
        tab_active_fg: Color::Rgb(253, 246, 227), // base3
        tab_active_bg: Color::Rgb(38, 139, 210),  // blue
        info: Color::Rgb(38, 139, 210),           // blue
        warning: Color::Rgb(181, 137, 0),         // yellow
        error: Color::Rgb(220, 50, 47),           // red
        card_backgrounds: [
            Color::Rgb(252, 238, 230), // red tint
            Color::Rgb(245, 250, 235), // green tint
            Color::Rgb(240, 245, 252), // blue tint
            Color::Rgb(252, 250, 230), // yellow tint
            Color::Rgb(248, 242, 252), // violet tint
            Color::Rgb(238, 250, 250), // cyan tint
            Color::Rgb(252, 242, 230), // orange tint
            Color::Rgb(245, 245, 240), // base tint
        ],
        accent_palette: [
            Color::Rgb(220, 50, 47),   // red
            Color::Rgb(203, 75, 22),   // orange
            Color::Rgb(181, 137, 0),   // yellow
            Color::Rgb(133, 153, 0),   // green
            Color::Rgb(42, 161, 152),  // cyan
            Color::Rgb(38, 139, 210),  // blue
            Color::Rgb(108, 113, 196), // violet
            Color::Rgb(211, 54, 130),  // magenta
            Color::Rgb(147, 161, 161), // base1
            Color::Rgb(101, 123, 131), // base00
        ],
    }
}

/// Rosé Pine Dawn 主题 (粉色系浅色)
pub fn rose_pine_dawn_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(250, 244, 237),             // base
        bg_secondary: Color::Rgb(242, 233, 222),   // surface
        logo: Color::Rgb(215, 130, 126),           // rose
        highlight: Color::Rgb(234, 154, 151),      // rose lighter
        text: Color::Rgb(87, 82, 121),             // text
        muted: Color::Rgb(152, 147, 165),          // muted
        border: Color::Rgb(223, 218, 217),         // highlight med
        status_live: Color::Rgb(40, 105, 131),     // pine
        status_idle: Color::Rgb(152, 147, 165),    // muted
        status_merged: Color::Rgb(144, 122, 169),  // iris
        status_conflict: Color::Rgb(234, 157, 52), // gold
        status_error: Color::Rgb(180, 99, 122),    // love
        tab_active_fg: Color::Rgb(250, 244, 237),  // base
        tab_active_bg: Color::Rgb(215, 130, 126),  // rose
        info: Color::Rgb(40, 105, 131),            // pine
        warning: Color::Rgb(234, 157, 52),         // gold
        error: Color::Rgb(180, 99, 122),           // love
        card_backgrounds: [
            Color::Rgb(252, 240, 242), // love tint
            Color::Rgb(240, 248, 248), // pine tint
            Color::Rgb(245, 242, 252), // iris tint
            Color::Rgb(252, 248, 235), // gold tint
            Color::Rgb(252, 242, 240), // rose tint
            Color::Rgb(240, 245, 248), // foam tint
            Color::Rgb(248, 240, 235), // dawn tint
            Color::Rgb(245, 242, 238), // surface tint
        ],
        accent_palette: [
            Color::Rgb(180, 99, 122),  // love
            Color::Rgb(215, 130, 126), // rose
            Color::Rgb(234, 157, 52),  // gold
            Color::Rgb(40, 105, 131),  // pine
            Color::Rgb(86, 148, 159),  // foam
            Color::Rgb(144, 122, 169), // iris
            Color::Rgb(152, 147, 165), // subtle
            Color::Rgb(121, 117, 147), // overlay
            Color::Rgb(200, 138, 138), // rose light
            Color::Rgb(87, 82, 121),   // text
        ],
    }
}

/// GitHub Light 主题
pub fn github_light_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(255, 255, 255),            // white
        bg_secondary: Color::Rgb(246, 248, 250),  // gray-100
        logo: Color::Rgb(9, 105, 218),            // blue-500
        highlight: Color::Rgb(9, 105, 218),       // blue-500
        text: Color::Rgb(31, 35, 40),             // gray-900
        muted: Color::Rgb(101, 109, 118),         // gray-500
        border: Color::Rgb(208, 215, 222),        // gray-300
        status_live: Color::Rgb(26, 127, 55),     // green-600
        status_idle: Color::Rgb(101, 109, 118),   // gray-500
        status_merged: Color::Rgb(130, 80, 223),  // purple-500
        status_conflict: Color::Rgb(191, 135, 0), // yellow-700
        status_error: Color::Rgb(207, 34, 46),    // red-500
        tab_active_fg: Color::Rgb(255, 255, 255), // white
        tab_active_bg: Color::Rgb(9, 105, 218),   // blue-500
        info: Color::Rgb(9, 105, 218),            // blue-500
        warning: Color::Rgb(154, 103, 0),         // yellow-800
        error: Color::Rgb(207, 34, 46),           // red-500
        card_backgrounds: [
            Color::Rgb(255, 245, 245), // red tint
            Color::Rgb(240, 255, 244), // green tint
            Color::Rgb(240, 248, 255), // blue tint
            Color::Rgb(255, 252, 235), // yellow tint
            Color::Rgb(250, 245, 255), // purple tint
            Color::Rgb(240, 253, 255), // cyan tint
            Color::Rgb(255, 248, 240), // orange tint
            Color::Rgb(248, 250, 252), // gray tint
        ],
        accent_palette: [
            Color::Rgb(207, 34, 46),   // red-500
            Color::Rgb(188, 76, 0),    // orange-600
            Color::Rgb(154, 103, 0),   // yellow-800
            Color::Rgb(26, 127, 55),   // green-600
            Color::Rgb(8, 125, 139),   // teal
            Color::Rgb(9, 105, 218),   // blue-500
            Color::Rgb(130, 80, 223),  // purple-500
            Color::Rgb(191, 57, 137),  // pink-600
            Color::Rgb(101, 109, 118), // gray-500
            Color::Rgb(31, 35, 40),    // gray-900
        ],
    }
}

/// Catppuccin Latte 主题 (Light)
pub fn catppuccin_latte_colors() -> ThemeColors {
    ThemeColors {
        bg: Color::Rgb(239, 241, 245),             // base
        bg_secondary: Color::Rgb(220, 224, 232),   // surface0
        logo: Color::Rgb(136, 57, 239),            // mauve
        highlight: Color::Rgb(234, 118, 203),      // pink
        text: Color::Rgb(76, 79, 105),             // text
        muted: Color::Rgb(140, 143, 161),          // overlay1
        border: Color::Rgb(188, 192, 204),         // surface1
        status_live: Color::Rgb(64, 160, 43),      // green
        status_idle: Color::Rgb(140, 143, 161),    // overlay1
        status_merged: Color::Rgb(136, 57, 239),   // mauve
        status_conflict: Color::Rgb(254, 100, 11), // peach
        status_error: Color::Rgb(210, 15, 57),     // red
        tab_active_fg: Color::Rgb(239, 241, 245),  // base
        tab_active_bg: Color::Rgb(234, 118, 203),  // pink
        info: Color::Rgb(30, 102, 245),            // blue
        warning: Color::Rgb(223, 142, 29),         // yellow
        error: Color::Rgb(210, 15, 57),            // red
        card_backgrounds: [
            Color::Rgb(250, 235, 240), // red/pink tint
            Color::Rgb(235, 248, 235), // green tint
            Color::Rgb(235, 242, 252), // blue tint
            Color::Rgb(252, 248, 230), // yellow tint
            Color::Rgb(248, 235, 252), // mauve tint
            Color::Rgb(230, 248, 248), // teal tint
            Color::Rgb(252, 240, 230), // peach tint
            Color::Rgb(242, 244, 248), // surface tint
        ],
        accent_palette: [
            Color::Rgb(210, 15, 57),   // red
            Color::Rgb(254, 100, 11),  // peach
            Color::Rgb(223, 142, 29),  // yellow
            Color::Rgb(64, 160, 43),   // green
            Color::Rgb(23, 146, 153),  // teal
            Color::Rgb(30, 102, 245),  // blue
            Color::Rgb(32, 159, 181),  // sapphire
            Color::Rgb(136, 57, 239),  // mauve
            Color::Rgb(234, 118, 203), // pink
            Color::Rgb(221, 120, 120), // flamingo
        ],
    }
}
