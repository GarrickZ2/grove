//! Workspace 底部快捷键栏

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 渲染 Workspace Footer
pub fn render(
    frame: &mut Frame,
    area: Rect,
    has_items: bool,
    expanded: bool,
    colors: &ThemeColors,
) {
    let shortcuts = get_shortcuts(has_items, expanded);

    let mut spans = Vec::new();
    spans.push(Span::raw("  "));

    for (i, (key, desc)) in shortcuts.iter().enumerate() {
        spans.push(Span::styled(
            *key,
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {}", desc),
            Style::default().fg(colors.muted),
        ));

        if i < shortcuts.len() - 1 {
            spans.push(Span::raw("   "));
        }
    }

    let line = Line::from(spans);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border));

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}

fn get_shortcuts(has_items: bool, expanded: bool) -> Vec<(&'static str, &'static str)> {
    if has_items {
        let expand_text = if expanded { "collapse" } else { "expand" };
        vec![
            ("Enter", "open"),
            ("Tab", expand_text),
            ("a", "add"),
            ("x", "delete"),
            ("/", "search"),
            ("t", "theme"),
            ("q", "quit"),
        ]
    } else {
        vec![("a", "add"), ("t", "theme"), ("q", "quit")]
    }
}
