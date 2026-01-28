//! 快捷键帮助面板

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;
use crate::update::UpdateInfo;

/// 帮助面板宽度
const PANEL_WIDTH: u16 = 38;
/// 帮助面板高度（增加版本信息区域）
const PANEL_HEIGHT: u16 = 39;

/// 渲染帮助面板
pub fn render(frame: &mut Frame, colors: &ThemeColors, update_info: Option<&UpdateInfo>) {
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
    let lines = build_help_lines(colors, update_info);

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
fn build_help_lines(colors: &ThemeColors, update_info: Option<&UpdateInfo>) -> Vec<Line<'static>> {
    let mut lines = vec![
        // Navigation 分组
        section_header("Navigation", colors),
        key_line("j / ↓", "Move down", colors),
        key_line("k / ↑", "Move up", colors),
        key_line("Tab", "Toggle info panel", colors),
        key_line("← / →", "Switch tab", colors),
        key_line("1 / 2 / 3", "Tab / sub-tab", colors),
        key_line("Enter", "Enter worktree", colors),
        Line::from(""),
        // Info Panel 分组
        section_header("Info Panel", colors),
        key_line("1", "Git tab", colors),
        key_line("2", "AI tab", colors),
        key_line("3", "Notes tab", colors),
        key_line("j / k", "Scroll notes", colors),
        key_line("i", "Edit notes ($EDITOR)", colors),
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
    ];

    // 添加版本信息区域
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  ────────────────────────────────",
        Style::default().fg(colors.muted),
    )));

    if let Some(info) = update_info {
        // 显示当前版本
        lines.push(Line::from(Span::styled(
            format!("  Grove v{}", info.current_version),
            Style::default().fg(colors.text),
        )));

        // 显示更新状态
        if info.has_update() {
            if let Some(latest) = &info.latest_version {
                lines.push(Line::from(Span::styled(
                    format!("  Update: {}", latest),
                    Style::default().fg(colors.highlight),
                )));
                lines.push(Line::from(Span::styled(
                    format!("  {}", info.update_command()),
                    Style::default().fg(colors.muted),
                )));
            }
        } else {
            lines.push(Line::from(Span::styled(
                "  Up to date",
                Style::default().fg(colors.status_merged),
            )));
        }
    } else {
        // 没有更新信息时只显示版本
        lines.push(Line::from(Span::styled(
            format!("  Grove v{}", env!("CARGO_PKG_VERSION")),
            Style::default().fg(colors.text),
        )));
    }

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
        Span::styled(
            format!("  {:10}", key),
            Style::default()
                .fg(colors.text)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(desc, Style::default().fg(colors.muted)),
    ])
}
