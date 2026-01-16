//! New Task 弹窗组件

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::storage::tasks::generate_branch_name;
use crate::theme::ThemeColors;

/// 渲染 New Task 弹窗
pub fn render(frame: &mut Frame, input: &str, target_branch: &str, colors: &ThemeColors) {
    let area = frame.area();

    // 计算弹窗尺寸
    let popup_width = 60u16.min(area.width.saturating_sub(4));
    let popup_height = 9u16;

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框
    let block = Block::default()
        .title(" New Task ")
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.highlight))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局: 空行 + 输入行 + 空行 + 预览行 + 空行 + 提示行
    let [_, input_area, _, preview_area, _, hint_area] = Layout::vertical([
        Constraint::Length(1), // 顶部空行
        Constraint::Length(1), // 输入行
        Constraint::Length(1), // 空行
        Constraint::Length(1), // 预览行
        Constraint::Length(1), // 空行
        Constraint::Length(1), // 提示行
    ])
    .areas(inner_area);

    // 渲染输入行: "Task: {input}█"
    let input_line = Line::from(vec![
        Span::styled("  Task: ", Style::default().fg(colors.muted)),
        Span::styled(input, Style::default().fg(colors.text)),
        Span::styled("█", Style::default().fg(colors.highlight)), // 光标
    ]);
    frame.render_widget(Paragraph::new(input_line), input_area);

    // 渲染预览行: "→ {branch} from {target}"
    let preview_line = if input.trim().is_empty() {
        Line::from(Span::styled(
            "  (enter task name)",
            Style::default().fg(colors.muted),
        ))
    } else {
        let branch = generate_branch_name(input);
        Line::from(vec![
            Span::styled("  → ", Style::default().fg(colors.status_live)),
            Span::styled(
                branch,
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" from ", Style::default().fg(colors.muted)),
            Span::styled(target_branch, Style::default().fg(colors.text)),
        ])
    };
    frame.render_widget(Paragraph::new(preview_line), preview_area);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" create  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, hint_area);
}
