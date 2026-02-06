use std::collections::HashMap;

use ratatui::{
    layout::{Constraint, Rect},
    style::{Modifier, Style},
    widgets::{Block, Borders, Cell, Row, Table, TableState},
    Frame,
};

use crate::hooks::{HookEntry, NotificationLevel};
use crate::model::{format_relative_time, Worktree, WorktreeStatus};
use crate::theme::ThemeColors;
use crate::ui::click_areas::ClickAreas;

/// 渲染 Worktree 列表
#[allow(clippy::too_many_arguments)]
pub fn render(
    frame: &mut Frame,
    area: Rect,
    worktrees: &[&Worktree],
    selected_index: Option<usize>,
    colors: &ThemeColors,
    notifications: &HashMap<String, HookEntry>,
    click_areas: &mut ClickAreas,
) {
    // 表头
    let header = Row::new(vec![
        Cell::from(""), // 选择指示器
        Cell::from(""), // 状态图标
        Cell::from(""), // 通知标记
        Cell::from("TASK"),
        Cell::from("STATUS"),
        Cell::from("BRANCH"),
        Cell::from("↓"), // commits behind
        Cell::from("FILES"),
        Cell::from("UPDATED"),
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
                WorktreeStatus::Archived => Style::default().fg(colors.muted),
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

            let updated = format_relative_time(wt.updated_at);

            // 获取通知标记
            let (notif_marker, notif_style) = match notifications.get(&wt.id).map(|e| e.level) {
                Some(NotificationLevel::Notice) => ("[i]", Style::default().fg(colors.info)),
                Some(NotificationLevel::Warn) => ("[!]", Style::default().fg(colors.warning)),
                Some(NotificationLevel::Critical) => ("[!!]", Style::default().fg(colors.error)),
                None => ("", Style::default()),
            };

            Row::new(vec![
                Cell::from(selector).style(Style::default().fg(colors.highlight)),
                Cell::from(wt.status.icon()).style(icon_style),
                Cell::from(notif_marker).style(notif_style),
                Cell::from(wt.task_name.clone()),
                Cell::from(wt.status.label()).style(icon_style),
                Cell::from(ratatui::text::Line::from(vec![
                    ratatui::text::Span::styled(&wt.branch, Style::default().fg(colors.muted)),
                    ratatui::text::Span::styled(" → ", Style::default().fg(colors.muted)),
                    ratatui::text::Span::styled(&wt.target, Style::default().fg(colors.text)),
                ])),
                Cell::from(commits),
                Cell::from(ratatui::text::Line::from(vec![
                    ratatui::text::Span::styled(
                        format!("+{}", wt.file_changes.additions),
                        Style::default().fg(colors.status_live),
                    ),
                    ratatui::text::Span::raw(" "),
                    ratatui::text::Span::styled(
                        format!("-{}", wt.file_changes.deletions),
                        Style::default().fg(colors.status_error),
                    ),
                ])),
                Cell::from(updated).style(Style::default().fg(colors.muted)),
            ])
            .style(row_style)
        })
        .collect();

    let widths = [
        Constraint::Length(2),  // 选择器
        Constraint::Length(2),  // 状态图标
        Constraint::Length(4),  // 通知标记
        Constraint::Fill(2),    // TASK (flex)
        Constraint::Length(8),  // STATUS
        Constraint::Fill(2),    // BRANCH (flex)
        Constraint::Length(4),  // commits behind
        Constraint::Length(10), // FILES
        Constraint::Length(14), // UPDATED
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

    // 记录行点击区域（header 占 2 行：1 行内容 + 1 行 bottom_margin）
    let header_height = 2u16;
    for i in 0..worktrees.len() {
        let row_y = area.y + header_height + i as u16;
        if row_y < area.y + area.height {
            let row_rect = Rect::new(area.x, row_y, area.width, 1);
            click_areas.worktree_rows.push((row_rect, i));
        }
    }

    // 渲染表格（使用 TableState）
    let mut table_state = TableState::default();
    table_state.select(selected_index);

    frame.render_stateful_widget(table, area, &mut table_state);
}
