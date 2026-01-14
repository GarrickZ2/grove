use ratatui::{
    layout::{Constraint, Rect},
    style::{Modifier, Style},
    widgets::{Block, Borders, Cell, Row, Table, TableState},
    Frame,
};

use crate::model::{Worktree, WorktreeStatus};
use crate::theme::ThemeColors;

/// 渲染 Worktree 列表
pub fn render(
    frame: &mut Frame,
    area: Rect,
    worktrees: &[Worktree],
    selected_index: Option<usize>,
    colors: &ThemeColors,
) {
    // 表头
    let header = Row::new(vec![
        Cell::from(""),     // 选择指示器
        Cell::from(""),     // 状态图标
        Cell::from("TASK"),
        Cell::from("STATUS"),
        Cell::from("BRANCH"),
        Cell::from("↓"),    // commits behind
        Cell::from("FILES"),
    ])
    .style(Style::default().fg(colors.muted))
    .height(1)
    .bottom_margin(1);

    // 数据行
    let rows: Vec<Row> = worktrees
        .iter()
        .enumerate()
        .map(|(i, wt)| {
            let is_selected = selected_index == Some(i);
            let selector = if is_selected { "❯" } else { " " };

            // 状态图标样式
            let icon_style = match wt.status {
                WorktreeStatus::Live => Style::default().fg(colors.status_live),
                WorktreeStatus::Idle => Style::default().fg(colors.status_idle),
                WorktreeStatus::Merged => Style::default().fg(colors.status_merged),
                WorktreeStatus::Conflict => Style::default().fg(colors.status_conflict),
                WorktreeStatus::Broken => Style::default().fg(colors.status_error),
                WorktreeStatus::Error => Style::default().fg(colors.status_error),
            };

            let commits = wt
                .commits_behind
                .map(|n| n.to_string())
                .unwrap_or_else(|| "—".to_string());

            let row_style = if is_selected {
                Style::default()
                    .fg(colors.text)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.text)
            };

            Row::new(vec![
                Cell::from(selector).style(Style::default().fg(colors.highlight)),
                Cell::from(wt.status.icon()).style(icon_style),
                Cell::from(wt.task_name.clone()),
                Cell::from(wt.status.label()).style(icon_style),
                Cell::from(wt.branch.clone()).style(Style::default().fg(colors.muted)),
                Cell::from(commits),
                Cell::from(wt.file_changes.display()),
            ])
            .style(row_style)
        })
        .collect();

    let widths = [
        Constraint::Length(2),  // 选择器
        Constraint::Length(2),  // 状态图标
        Constraint::Fill(2),    // TASK (flex)
        Constraint::Length(8),  // STATUS
        Constraint::Fill(2),    // BRANCH (flex)
        Constraint::Length(4),  // commits behind
        Constraint::Length(10), // FILES
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .block(
            Block::default()
                .borders(Borders::LEFT | Borders::RIGHT)
                .border_style(Style::default().fg(colors.border)),
        )
        .row_highlight_style(
            Style::default()
                .bg(colors.bg_secondary)
                .add_modifier(Modifier::BOLD),
        );

    // 渲染表格（使用 TableState）
    let mut table_state = TableState::default();
    table_state.select(selected_index);

    frame.render_stateful_widget(table, area, &mut table_state);
}
