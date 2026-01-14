use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::model::ProjectTab;
use crate::theme::ThemeColors;

/// 渲染 Tab 栏
pub fn render(frame: &mut Frame, area: Rect, current_tab: ProjectTab, colors: &ThemeColors) {
    let tabs = [ProjectTab::Current, ProjectTab::Other, ProjectTab::Archived];

    let mut spans = Vec::new();
    spans.push(Span::raw("   "));

    for (i, tab) in tabs.iter().enumerate() {
        let label = tab.label();

        if *tab == current_tab {
            // 选中的 Tab: 背景高亮块
            spans.push(Span::styled(
                format!("  {}  ", label),
                Style::default()
                    .fg(colors.tab_active_fg)
                    .bg(colors.tab_active_bg)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            // 未选中的 Tab: 普通显示
            spans.push(Span::styled(
                format!("  {}  ", label),
                Style::default().fg(colors.muted),
            ));
        }

        if i < tabs.len() - 1 {
            spans.push(Span::raw("  "));
        }
    }

    let line = Line::from(spans);

    let block = Block::default()
        .borders(Borders::LEFT | Borders::RIGHT | Borders::BOTTOM)
        .border_style(Style::default().fg(colors.border));

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}
