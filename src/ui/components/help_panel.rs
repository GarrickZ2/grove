//! 快捷键帮助面板

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 帮助面板宽度
const PANEL_WIDTH: u16 = 38;
/// 帮助面板高度
const PANEL_HEIGHT: u16 = 26;

/// 渲染帮助面板
pub fn render(frame: &mut Frame, colors: &ThemeColors) {
    let area = frame.area();

    // 居中计算
    let x = area.width.saturating_sub(PANEL_WIDTH) / 2;
    let y = area.height.saturating_sub(PANEL_HEIGHT) / 2;
    let panel_area = Rect::new(
        x,
        y,
        PANEL_WIDTH.min(area.width),
        PANEL_HEIGHT.min(area.height),
    );

    // 清除背景
    frame.render_widget(Clear, panel_area);

    // 构建帮助内容
    let lines = build_help_lines(colors);

    let block = Block::default()
        .title(" Help ")
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let paragraph = Paragraph::new(lines).block(block);

    frame.render_widget(paragraph, panel_area);
}

/// 构建帮助内容行
fn build_help_lines(colors: &ThemeColors) -> Vec<Line<'static>> {
    vec![
        // Navigation 分组
        section_header("Navigation", colors),
        key_line("j / ↓", "Move down", colors),
        key_line("k / ↑", "Move up", colors),
        key_line("Tab", "Switch tab", colors),
        key_line("1 / 2 / 3", "Jump to tab", colors),
        key_line("Enter", "Enter worktree", colors),
        Line::from(""),
        // Actions 分组
        section_header("Actions", colors),
        key_line("n", "New task", colors),
        key_line("Space", "Action palette", colors),
        Line::from(""),
        // Archived Tasks 分组
        section_header("Archived Tasks", colors),
        key_line("r", "Recover", colors),
        key_line("x", "Clean (delete)", colors),
        Line::from(""),
        // Search 分组
        section_header("Search", colors),
        key_line("/", "Start search", colors),
        key_line("Enter", "Confirm search", colors),
        key_line("Esc", "Clear search", colors),
        Line::from(""),
        // Other 分组
        section_header("Other", colors),
        key_line("t", "Theme selector", colors),
        key_line("?", "This help", colors),
        key_line("q", "Quit", colors),
        Line::from(""),
        // 底部提示
        Line::from(Span::styled(
            "      Press ? or Esc to close",
            Style::default().fg(colors.muted),
        )),
    ]
}

/// 分组标题
fn section_header(title: &'static str, colors: &ThemeColors) -> Line<'static> {
    Line::from(Span::styled(
        format!("  {}", title),
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD),
    ))
}

/// 快捷键行
fn key_line(key: &'static str, desc: &'static str, colors: &ThemeColors) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("  {:10}", key),
            Style::default()
                .fg(colors.text)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(desc, Style::default().fg(colors.muted)),
    ])
}
