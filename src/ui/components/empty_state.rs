use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::model::ProjectTab;
use crate::theme::Colors;

/// ASCII Art Logo
const LOGO: &[&str] = &[
    " ██████╗ ██████╗  ██████╗ ██╗   ██╗███████╗",
    "██╔════╝ ██╔══██╗██╔═══██╗██║   ██║██╔════╝",
    "██║  ███╗██████╔╝██║   ██║██║   ██║█████╗  ",
    "██║   ██║██╔══██╗██║   ██║╚██╗ ██╔╝██╔══╝  ",
    "╚██████╔╝██║  ██║╚██████╔╝ ╚████╔╝ ███████╗",
    " ╚═════╝ ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝",
];

/// 渲染空状态（带 Logo 和提示文字）
pub fn render(frame: &mut Frame, area: Rect, current_tab: ProjectTab) {
    let block = Block::default()
        .borders(Borders::LEFT | Borders::RIGHT)
        .border_style(Style::default().fg(Colors::BORDER));

    let inner_area = block.inner(area);
    frame.render_widget(block, area);

    // 垂直居中布局
    let logo_height = LOGO.len() as u16;
    let text_height = 3u16; // 提示文字行数
    let total_height = logo_height + 2 + text_height; // 2 是间距

    if inner_area.height < total_height {
        // 空间不足，只显示提示文字
        render_hint_only(frame, inner_area, current_tab);
        return;
    }

    let vertical_padding = (inner_area.height - total_height) / 2;

    let [_, logo_area, _, text_area, _] = Layout::vertical([
        Constraint::Length(vertical_padding),
        Constraint::Length(logo_height),
        Constraint::Length(2),
        Constraint::Length(text_height),
        Constraint::Fill(1),
    ])
    .areas(inner_area);

    // 渲染 Logo
    render_logo(frame, logo_area);

    // 渲染提示文字
    render_hint(frame, text_area, current_tab);
}

fn render_logo(frame: &mut Frame, area: Rect) {
    let logo_lines: Vec<Line> = LOGO
        .iter()
        .map(|line| {
            Line::from(Span::styled(
                *line,
                Style::default().fg(Colors::LOGO),
            ))
        })
        .collect();

    let logo_widget = Paragraph::new(logo_lines).alignment(Alignment::Center);

    frame.render_widget(logo_widget, area);
}

fn render_hint(frame: &mut Frame, area: Rect, current_tab: ProjectTab) {
    let (message, hint) = get_hint_text(current_tab);

    let lines = vec![
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

    let hint_widget = Paragraph::new(lines).alignment(Alignment::Center);

    frame.render_widget(hint_widget, area);
}

fn render_hint_only(frame: &mut Frame, area: Rect, current_tab: ProjectTab) {
    let (message, hint) = get_hint_text(current_tab);

    let lines = vec![
        Line::from(Span::styled(message, Style::default().fg(Colors::MUTED))),
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

    let hint_widget = Paragraph::new(lines).alignment(Alignment::Center);

    // 垂直居中
    let y_offset = (area.height.saturating_sub(2)) / 2;
    let centered_area = Rect {
        x: area.x,
        y: area.y + y_offset,
        width: area.width,
        height: 2,
    };

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
