//! 确认弹窗组件

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 确认弹窗类型
#[derive(Debug, Clone)]
pub enum ConfirmType {
    /// 弱确认 - Archive 未 merge 的分支
    ArchiveUnmerged { task_name: String, branch: String },
    /// 弱确认 - Clean 已 merge 的分支
    CleanMerged { task_name: String, branch: String },
    /// 弱确认 - Recover 归档的任务
    Recover { task_name: String, branch: String },
    /// Sync - worktree 有未提交代码
    SyncUncommittedWorktree { task_name: String },
    /// Sync - target 有未提交代码
    SyncUncommittedTarget { task_name: String, target: String },
    /// Merge - worktree 有未提交代码
    MergeUncommittedWorktree { task_name: String },
    /// Merge - target 有未提交代码
    MergeUncommittedTarget { task_name: String, target: String },
    /// Merge 成功后询问是否 Archive
    MergeSuccess { task_name: String },
    /// Reset - 重置任务
    Reset {
        task_name: String,
        branch: String,
        target: String,
    },
}

impl ConfirmType {
    pub fn title(&self) -> &str {
        match self {
            ConfirmType::ArchiveUnmerged { .. } => " Archive ",
            ConfirmType::CleanMerged { .. } => " Clean ",
            ConfirmType::Recover { .. } => " Recover ",
            ConfirmType::SyncUncommittedWorktree { .. } => " Sync ",
            ConfirmType::SyncUncommittedTarget { .. } => " Sync ",
            ConfirmType::MergeUncommittedWorktree { .. } => " Merge ",
            ConfirmType::MergeUncommittedTarget { .. } => " Merge ",
            ConfirmType::MergeSuccess { .. } => " Success ",
            ConfirmType::Reset { .. } => " Reset ",
        }
    }

    pub fn message(&self) -> Vec<Line<'static>> {
        match self {
            ConfirmType::ArchiveUnmerged { task_name, branch } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(format!("Branch: {}", branch)),
                    Line::from(""),
                    Line::from("Branch not merged yet."),
                    Line::from("Archive anyway?"),
                ]
            }
            ConfirmType::CleanMerged { task_name, branch } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(format!("Branch: {}", branch)),
                    Line::from(""),
                    Line::from("This will delete:"),
                    Line::from("• Worktree directory"),
                    Line::from("• Git branch"),
                    Line::from("• Task record"),
                ]
            }
            ConfirmType::Recover { task_name, branch } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(format!("Branch: {}", branch)),
                    Line::from(""),
                    Line::from("This will:"),
                    Line::from("• Recreate worktree"),
                    Line::from("• Start session"),
                ]
            }
            ConfirmType::SyncUncommittedWorktree { task_name } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(""),
                    Line::from("Worktree has uncommitted changes."),
                    Line::from("They will NOT be synced."),
                    Line::from(""),
                    Line::from("Continue anyway?"),
                ]
            }
            ConfirmType::SyncUncommittedTarget { task_name, target } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(""),
                    Line::from(format!("Target '{}' has uncommitted", target)),
                    Line::from("changes."),
                    Line::from(""),
                    Line::from("Continue anyway?"),
                ]
            }
            ConfirmType::MergeUncommittedWorktree { task_name } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(""),
                    Line::from("Worktree has uncommitted changes."),
                    Line::from("They will NOT be merged."),
                    Line::from(""),
                    Line::from("Continue anyway?"),
                ]
            }
            ConfirmType::MergeUncommittedTarget { task_name, target } => {
                vec![
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(""),
                    Line::from(format!("Target '{}' has uncommitted", target)),
                    Line::from("changes."),
                    Line::from(""),
                    Line::from("Continue anyway?"),
                ]
            }
            ConfirmType::MergeSuccess { task_name } => {
                vec![
                    Line::from("Merged successfully!"),
                    Line::from(""),
                    Line::from(format!("Task: {}", task_name)),
                    Line::from(""),
                    Line::from("Archive this task?"),
                ]
            }
            ConfirmType::Reset {
                task_name,
                branch,
                target,
            } => {
                vec![
                    Line::from(format!("Reset \"{}\"?", task_name)),
                    Line::from(""),
                    Line::from("This will:"),
                    Line::from("  - Kill tmux session"),
                    Line::from(format!("  - Delete branch \"{}\"", branch)),
                    Line::from(format!("  - Recreate from \"{}\"", target)),
                    Line::from("  - Recreate worktree"),
                    Line::from(""),
                    Line::from("All changes will be lost!"),
                ]
            }
        }
    }
}

/// 渲染确认弹窗
pub fn render(frame: &mut Frame, confirm_type: &ConfirmType, colors: &ThemeColors) {
    let area = frame.area();

    // 计算弹窗尺寸
    let popup_width = 40u16;
    let message_lines = confirm_type.message();
    let popup_height = (message_lines.len() as u16) + 5; // 标题 + 边框 + 内容 + 提示

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框
    let block = Block::default()
        .title(confirm_type.title())
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.status_conflict))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局
    let [content_area, hint_area] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(inner_area);

    // 渲染消息内容
    let styled_lines: Vec<Line> = message_lines
        .into_iter()
        .map(|line| {
            Line::from(Span::styled(
                line.to_string(),
                Style::default().fg(colors.text),
            ))
        })
        .collect();

    let content = Paragraph::new(styled_lines).alignment(Alignment::Center);
    frame.render_widget(content, content_area);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled(
            "Y",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("/", Style::default().fg(colors.muted)),
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" confirm  ", Style::default().fg(colors.muted)),
        Span::styled(
            "N",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("/", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, hint_area);
}
