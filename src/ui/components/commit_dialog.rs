//! Commit 弹窗组件

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// Commit 弹窗数据
#[derive(Debug, Clone)]
pub struct CommitDialogData {
    /// commit message 输入
    pub message: String,
    /// 任务名称（用于显示）
    pub task_name: String,
    /// worktree 路径
    pub worktree_path: String,
}

impl CommitDialogData {
    pub fn new(task_name: String, worktree_path: String) -> Self {
        Self {
            message: String::new(),
            task_name,
            worktree_path,
        }
    }
}

/// 渲染 Commit 弹窗
pub fn render(frame: &mut Frame, data: &CommitDialogData, colors: &ThemeColors) {
    let area = frame.area();

    // 计算弹窗尺寸
    let popup_width = 60u16.min(area.width.saturating_sub(4));
    let popup_height = 11u16;

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框
    let block = Block::default()
        .title(" Commit Changes ")
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.highlight))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局
    let [_, task_area, _, desc_area, _, input_area, _, hint_area] = Layout::vertical([
        Constraint::Length(1), // 顶部空行
        Constraint::Length(1), // 任务名
        Constraint::Length(1), // 空行
        Constraint::Length(1), // 描述
        Constraint::Length(1), // 空行
        Constraint::Length(1), // 输入行
        Constraint::Length(1), // 空行
        Constraint::Length(1), // 提示行
    ])
    .areas(inner_area);

    // 渲染任务名
    let task_line = Line::from(vec![
        Span::styled("  Task: ", Style::default().fg(colors.muted)),
        Span::styled(
            &data.task_name,
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    frame.render_widget(Paragraph::new(task_line), task_area);

    // 渲染描述
    let desc_line = Line::from(Span::styled(
        "  Will run: git add -A && git commit",
        Style::default().fg(colors.muted),
    ));
    frame.render_widget(Paragraph::new(desc_line), desc_area);

    // 渲染输入行: "Message: {input}█"
    let input_line = Line::from(vec![
        Span::styled("  Message: ", Style::default().fg(colors.muted)),
        Span::styled(&data.message, Style::default().fg(colors.text)),
        Span::styled("█", Style::default().fg(colors.highlight)), // 光标
    ]);
    frame.render_widget(Paragraph::new(input_line), input_area);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" commit  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, hint_area);
}
