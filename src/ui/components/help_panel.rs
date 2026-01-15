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
    let panel_area = Rect::new(x, y, PANEL_WIDTH.min(area.width), PANEL_HEIGHT.min(area.height));

    // 清除背景
    frame.render_widget(Clear, panel_area);

    // 构建帮助内容
    let lines = build_help_lines(colors);

    let block = Block::default()
        .title(" Help ")
        .title_style(Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let paragraph = Paragraph::new(lines).block(block);

    frame.render_widget(paragraph, panel_area);
}

/// 构建帮助内容行
fn build_help_lines(colors: &ThemeColors) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    // Navigation 分组
    lines.push(section_header("Navigation", colors));
    lines.push(key_line("j / ↓", "Move down", colors));
    lines.push(key_line("k / ↑", "Move up", colors));
    lines.push(key_line("Tab", "Switch tab", colors));
    lines.push(key_line("Enter", "Enter worktree", colors));
    lines.push(Line::from(""));

    // Actions 分组
    lines.push(section_header("Actions", colors));
    lines.push(key_line("n", "New task", colors));
    lines.push(key_line("s", "Sync from target", colors));
    lines.push(key_line("m", "Merge to target", colors));
    lines.push(key_line("a", "Archive task", colors));
    lines.push(key_line("x", "Clean (delete)", colors));
    lines.push(key_line("r", "Rebase to / Recover", colors));
    lines.push(Line::from(""));

    // Search 分组
    lines.push(section_header("Search", colors));
    lines.push(key_line("/", "Start search", colors));
    lines.push(key_line("Enter", "Confirm search", colors));
    lines.push(key_line("Esc", "Clear search", colors));
    lines.push(Line::from(""));

    // Other 分组
    lines.push(section_header("Other", colors));
    lines.push(key_line("t", "Theme selector", colors));
    lines.push(key_line("?", "This help", colors));
    lines.push(key_line("q", "Quit", colors));
    lines.push(Line::from(""));

    // 底部提示
    lines.push(Line::from(Span::styled(
        "      Press ? or Esc to close",
        Style::default().fg(colors.muted),
    )));

    lines
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
        Span::styled(format!("  {:10}", key), Style::default().fg(colors.text).add_modifier(Modifier::BOLD)),
        Span::styled(desc, Style::default().fg(colors.muted)),
    ])
}
