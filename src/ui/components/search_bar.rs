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
/// is_editing: 是否正在输入（显示光标）
pub fn render(frame: &mut Frame, area: Rect, query: &str, is_editing: bool, colors: &ThemeColors) {
    let mut spans = vec![
        Span::styled(" /", Style::default().fg(colors.highlight)),
        Span::styled(query, Style::default().fg(colors.text)),
    ];

    // 只在输入模式显示闪烁光标
    if is_editing {
        spans.push(Span::styled(
            "█",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::SLOW_BLINK),
        ));
    }

    let line = Line::from(spans);

    let paragraph = Paragraph::new(line).style(Style::default().bg(colors.bg_secondary));

    frame.render_widget(paragraph, area);
}
