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
        info: Color::Rgb(100, 181, 246),      // 蓝色
        warning: Color::Rgb(255, 213, 79),    // 黄色
        error: Color::Rgb(255, 85, 85),       // 红色
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
        info: Color::Rgb(33, 150, 243),   // 蓝色
        warning: Color::Rgb(255, 152, 0), // 橙黄色
        error: Color::Rgb(200, 50, 50),   // 红色
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
        info: Color::Rgb(139, 233, 253),       // cyan
        warning: Color::Rgb(241, 250, 140),    // yellow
        error: Color::Rgb(255, 85, 85),        // red
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
        info: Color::Rgb(136, 192, 208),        // frost (蓝色)
        warning: Color::Rgb(235, 203, 139),     // aurora yellow
        error: Color::Rgb(191, 97, 106),        // aurora red
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
        info: Color::Rgb(131, 165, 152),       // aqua/blue
        warning: Color::Rgb(250, 189, 47),     // yellow
        error: Color::Rgb(251, 73, 52),        // red
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
        info: Color::Rgb(125, 207, 255),        // cyan
        warning: Color::Rgb(224, 175, 104),     // orange
        error: Color::Rgb(247, 118, 142),       // red
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
        info: Color::Rgb(137, 180, 250),        // blue
        warning: Color::Rgb(249, 226, 175),     // yellow
        error: Color::Rgb(243, 139, 168),       // red
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
        bg: Color::Rgb(253, 246, 227),           // base3
        bg_secondary: Color::Rgb(238, 232, 213), // base2
        logo: Color::Rgb(38, 139, 210),          // blue
        highlight: Color::Rgb(42, 161, 152),     // cyan
        text: Color::Rgb(101, 123, 131),         // base00
        muted: Color::Rgb(147, 161, 161),        // base1
        border: Color::Rgb(238, 232, 213),       // base2
        status_live: Color::Rgb(133, 153, 0),    // green
        info: Color::Rgb(38, 139, 210),          // blue
        warning: Color::Rgb(181, 137, 0),        // yellow
        error: Color::Rgb(220, 50, 47),          // red
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
        bg: Color::Rgb(250, 244, 237),           // base
        bg_secondary: Color::Rgb(242, 233, 222), // surface
        logo: Color::Rgb(215, 130, 126),         // rose
        highlight: Color::Rgb(234, 154, 151),    // rose lighter
        text: Color::Rgb(87, 82, 121),           // text
        muted: Color::Rgb(152, 147, 165),        // muted
        border: Color::Rgb(223, 218, 217),       // highlight med
        status_live: Color::Rgb(40, 105, 131),   // pine
        info: Color::Rgb(40, 105, 131),          // pine
        warning: Color::Rgb(234, 157, 52),       // gold
        error: Color::Rgb(180, 99, 122),         // love
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
        bg: Color::Rgb(255, 255, 255),           // white
        bg_secondary: Color::Rgb(246, 248, 250), // gray-100
        logo: Color::Rgb(9, 105, 218),           // blue-500
        highlight: Color::Rgb(9, 105, 218),      // blue-500
        text: Color::Rgb(31, 35, 40),            // gray-900
        muted: Color::Rgb(101, 109, 118),        // gray-500
        border: Color::Rgb(208, 215, 222),       // gray-300
        status_live: Color::Rgb(26, 127, 55),    // green-600
        info: Color::Rgb(9, 105, 218),           // blue-500
        warning: Color::Rgb(154, 103, 0),        // yellow-800
        error: Color::Rgb(207, 34, 46),          // red-500
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
        bg: Color::Rgb(239, 241, 245),           // base
        bg_secondary: Color::Rgb(220, 224, 232), // surface0
        logo: Color::Rgb(136, 57, 239),          // mauve
        highlight: Color::Rgb(234, 118, 203),    // pink
        text: Color::Rgb(76, 79, 105),           // text
        muted: Color::Rgb(140, 143, 161),        // overlay1
        border: Color::Rgb(188, 192, 204),       // surface1
        status_live: Color::Rgb(64, 160, 43),    // green
        info: Color::Rgb(30, 102, 245),          // blue
        warning: Color::Rgb(223, 142, 29),       // yellow
        error: Color::Rgb(210, 15, 57),          // red
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
