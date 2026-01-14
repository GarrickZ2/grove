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
    let logo_lines: Vec<Line> = LOGO
        .iter()
        .map(|line| Line::from(Span::styled(*line, Style::default().fg(colors.logo))))
        .collect();

    let logo_widget = Paragraph::new(logo_lines).alignment(Alignment::Center);

    frame.render_widget(logo_widget, area);
}
