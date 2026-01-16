use ratatui::{
    layout::{Alignment, Rect},
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::theme::ThemeColors;

/// ASCII Art Logo - 6 行高
const LOGO: &[&str] = &[
    " ██████╗ ██████╗  ██████╗ ██╗   ██╗███████╗",
    "██╔════╝ ██╔══██╗██╔═══██╗██║   ██║██╔════╝",
    "██║  ███╗██████╔╝██║   ██║██║   ██║█████╗  ",
    "██║   ██║██╔══██╗██║   ██║╚██╗ ██╔╝██╔══╝  ",
    "╚██████╔╝██║  ██║╚██████╔╝ ╚████╔╝ ███████╗",
    " ╚═════╝ ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝",
];

/// Logo 的高度（行数）
pub const LOGO_HEIGHT: u16 = 6;

/// 渲染居中的 Logo
pub fn render(frame: &mut Frame, area: Rect, colors: &ThemeColors) {
    render_with_padding(frame, area, colors, 0);
}

/// 渲染居中的 Logo（带顶部间距）
pub fn render_with_padding(frame: &mut Frame, area: Rect, colors: &ThemeColors, top_padding: u16) {
    let mut lines: Vec<Line> = Vec::new();

    // 顶部空行
    for _ in 0..top_padding {
        lines.push(Line::from(""));
    }

    // Logo 行
    for line in LOGO {
        lines.push(Line::from(Span::styled(
            *line,
            Style::default().fg(colors.logo),
        )));
    }

    let logo_widget = Paragraph::new(lines).alignment(Alignment::Center);

    frame.render_widget(logo_widget, area);
}
