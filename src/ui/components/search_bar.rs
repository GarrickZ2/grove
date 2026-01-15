//! 搜索框组件

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::theme::ThemeColors;

/// 渲染搜索框
pub fn render(frame: &mut Frame, area: Rect, query: &str, colors: &ThemeColors) {
    let line = Line::from(vec![
        Span::styled(" /", Style::default().fg(colors.highlight)),
        Span::styled(query, Style::default().fg(colors.text)),
        Span::styled("█", Style::default().fg(colors.highlight).add_modifier(Modifier::SLOW_BLINK)),
    ]);

    let paragraph = Paragraph::new(line)
        .style(Style::default().bg(colors.bg_secondary));

    frame.render_widget(paragraph, area);
}
