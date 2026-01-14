use ratatui::{
    layout::{Alignment, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::model::ProjectTab;
use crate::theme::Colors;

/// 渲染空状态（只有提示文字，Logo 已移到顶部 Header）
pub fn render(frame: &mut Frame, area: Rect, current_tab: ProjectTab) {
    let block = Block::default()
        .borders(Borders::LEFT | Borders::RIGHT)
        .border_style(Style::default().fg(Colors::BORDER));

    let inner_area = block.inner(area);
    frame.render_widget(block, area);

    let (message, hint) = get_hint_text(current_tab);

    let lines = vec![
        Line::from(""),
        Line::from(Span::styled(message, Style::default().fg(Colors::MUTED))),
        Line::from(""),
        Line::from(vec![
            Span::styled("Press ", Style::default().fg(Colors::TEXT)),
            Span::styled(
                " n ",
                Style::default()
                    .fg(Colors::HIGHLIGHT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(hint, Style::default().fg(Colors::TEXT)),
        ]),
    ];

    // 垂直居中
    let content_height = 4u16;
    let y_offset = inner_area.height.saturating_sub(content_height) / 2;
    let centered_area = Rect {
        x: inner_area.x,
        y: inner_area.y + y_offset,
        width: inner_area.width,
        height: content_height,
    };

    let hint_widget = Paragraph::new(lines).alignment(Alignment::Center);
    frame.render_widget(hint_widget, centered_area);
}

fn get_hint_text(current_tab: ProjectTab) -> (&'static str, &'static str) {
    match current_tab {
        ProjectTab::Current | ProjectTab::Other => {
            ("No worktrees yet", "to create a new task")
        }
        ProjectTab::Archived => ("No archived worktrees", "to create a new task"),
    }
}
