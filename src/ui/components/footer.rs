use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::model::ProjectTab;
use crate::theme::Colors;

/// 渲染底部快捷键提示栏
pub fn render(frame: &mut Frame, area: Rect, current_tab: ProjectTab, has_items: bool) {
    let shortcuts = get_shortcuts(current_tab, has_items);

    let mut spans = Vec::new();
    spans.push(Span::raw("  "));

    for (i, (key, desc)) in shortcuts.iter().enumerate() {
        spans.push(Span::styled(
            *key,
            Style::default()
                .fg(Colors::HIGHLIGHT)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {}", desc),
            Style::default().fg(Colors::MUTED),
        ));

        if i < shortcuts.len() - 1 {
            spans.push(Span::raw("   "));
        }
    }

    let line = Line::from(spans);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Colors::BORDER));

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}

fn get_shortcuts(current_tab: ProjectTab, has_items: bool) -> Vec<(&'static str, &'static str)> {
    match current_tab {
        ProjectTab::Archived => {
            if has_items {
                vec![
                    ("Enter", "recover"),
                    ("x", "clean"),
                    ("Tab", "switch"),
                    ("Esc", "back"),
                    ("q", "quit"),
                ]
            } else {
                vec![("Tab", "switch"), ("Esc", "back"), ("q", "quit")]
            }
        }
        _ => {
            if has_items {
                vec![
                    ("n", "new"),
                    ("a", "arch"),
                    ("x", "clean"),
                    ("r", "rebase"),
                    ("Tab", "switch"),
                    ("q", "quit"),
                ]
            } else {
                vec![("n", "new"), ("Tab", "switch"), ("Esc", "back"), ("q", "quit")]
            }
        }
    }
}
