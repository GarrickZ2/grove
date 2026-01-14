use ratatui::{
    layout::{Constraint, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Cell, Row, Table, TableState},
    Frame,
};

use crate::model::{Worktree, WorktreeStatus};
use crate::theme::Colors;

/// 渲染 Worktree 列表
pub fn render(
    frame: &mut Frame,
    area: Rect,
    worktrees: &[Worktree],
    selected_index: Option<usize>,
) {
    // 表头
    let header = Row::new(vec![
        Cell::from(""),     // 选择指示器
        Cell::from(""),     // 状态图标
        Cell::from("TASK"),
        Cell::from("BRANCH"),
        Cell::from("↓"),    // commits behind
        Cell::from("FILES"),
    ])
    .style(Style::default().fg(Colors::MUTED))
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
                WorktreeStatus::Live => Style::default().fg(Colors::STATUS_LIVE),
                WorktreeStatus::Idle => Style::default().fg(Colors::STATUS_IDLE),
                WorktreeStatus::Merged => Style::default().fg(Colors::STATUS_MERGED),
                WorktreeStatus::Conflict => Style::default().fg(Colors::STATUS_CONFLICT),
                WorktreeStatus::Error => Style::default().fg(Colors::STATUS_ERROR),
            };

            let commits = wt
                .commits_behind
                .map(|n| n.to_string())
                .unwrap_or_else(|| "—".to_string());

            let row_style = if is_selected {
                Style::default()
                    .fg(Colors::TEXT)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Colors::TEXT)
            };

            Row::new(vec![
                Cell::from(selector).style(Style::default().fg(Colors::HIGHLIGHT)),
                Cell::from(wt.status.icon()).style(icon_style),
                Cell::from(wt.task_name.clone()),
                Cell::from(wt.branch.clone()).style(Style::default().fg(Colors::MUTED)),
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
        Constraint::Fill(2),    // BRANCH (flex)
        Constraint::Length(4),  // commits behind
        Constraint::Length(10), // FILES
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .block(
            Block::default()
                .borders(Borders::LEFT | Borders::RIGHT)
                .border_style(Style::default().fg(Colors::BORDER)),
        )
        .row_highlight_style(
            Style::default()
                .bg(Color::from_u32(0x303030))
                .add_modifier(Modifier::BOLD),
        );

    // 渲染表格（使用 TableState）
    let mut table_state = TableState::default();
    table_state.select(selected_index);

    frame.render_stateful_widget(table, area, &mut table_state);
}
