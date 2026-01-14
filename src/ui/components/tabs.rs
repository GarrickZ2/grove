use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::model::ProjectTab;
use crate::theme::Colors;

/// 渲染 Tab 栏
pub fn render(frame: &mut Frame, area: Rect, current_tab: ProjectTab) {
    let tabs = [ProjectTab::Current, ProjectTab::Other, ProjectTab::Archived];

    let mut spans = Vec::new();
    spans.push(Span::raw("  "));

    for (i, tab) in tabs.iter().enumerate() {
        let label = tab.label();

        if *tab == current_tab {
            // 选中的 Tab: 带圆点和高亮
            spans.push(Span::styled(
                "● ",
                Style::default().fg(Colors::HIGHLIGHT),
            ));
            spans.push(Span::styled(
                label,
                Style::default()
                    .fg(Colors::HIGHLIGHT)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            // 未选中的 Tab
            spans.push(Span::raw("  ")); // 对齐用的空格
            spans.push(Span::styled(label, Style::default().fg(Colors::MUTED)));
        }

        if i < tabs.len() - 1 {
            spans.push(Span::raw("   "));
        }
    }

    let line = Line::from(spans);

    let block = Block::default()
        .borders(Borders::LEFT | Borders::RIGHT | Borders::BOTTOM)
        .border_style(Style::default().fg(Colors::BORDER));

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}
