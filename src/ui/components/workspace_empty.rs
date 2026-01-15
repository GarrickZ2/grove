//! Workspace 空状态组件

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::theme::ThemeColors;

/// 渲染空状态
pub fn render(frame: &mut Frame, area: Rect, colors: &ThemeColors) {
    let lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            "No projects registered",
            Style::default().fg(colors.text),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Press 'a' to add your first project",
            Style::default().fg(colors.muted),
        )),
        Line::from(Span::styled(
            "or run grove in a git repo",
            Style::default().fg(colors.muted),
        )),
    ];

    // 垂直居中
    let content_height = lines.len() as u16;
    let vertical_padding = area.height.saturating_sub(content_height) / 2;

    let [_, content_area, _] = Layout::vertical([
        Constraint::Length(vertical_padding),
        Constraint::Length(content_height),
        Constraint::Fill(1),
    ])
    .areas(area);

    let paragraph = Paragraph::new(lines).alignment(Alignment::Center);
    frame.render_widget(paragraph, content_area);
}
