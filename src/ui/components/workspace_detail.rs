//! Workspace 项目详情面板（展开时显示）

use std::collections::HashMap;

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::hooks::{HookEntry, NotificationLevel};
use crate::model::{ProjectDetail, WorktreeStatus};
use crate::theme::ThemeColors;

use super::truncate;

/// 渲染项目详情面板
pub fn render(
    frame: &mut Frame,
    area: Rect,
    detail: &ProjectDetail,
    colors: &ThemeColors,
    notifications: &HashMap<String, HookEntry>,
) {
    let mut lines = vec![
        // 空行
        Line::from(""),
        // 基本信息
        info_line("Path", &shorten_path(&detail.path), colors),
        info_line("Branch", &detail.branch, colors),
        info_line("Added", &detail.added_at, colors),
        // 空行分隔
        Line::from(""),
    ];

    // Active Tasks
    if !detail.active_tasks.is_empty() {
        lines.push(section_header("Active Tasks", colors));
        for task in &detail.active_tasks {
            let notification = notifications.get(&task.id).map(|e| e.level);
            lines.push(task_line(
                &task.id,
                task.name.as_str(),
                task.status,
                task.additions,
                task.deletions,
                notification,
                colors,
            ));
        }
        lines.push(Line::from(""));
    }

    // Archived Tasks
    if !detail.archived_tasks.is_empty() {
        lines.push(section_header("Archived", colors));
        for task in detail.archived_tasks.iter().take(5) {
            lines.push(archived_task_line(&task.name, colors));
        }
        if detail.archived_tasks.len() > 5 {
            lines.push(Line::from(Span::styled(
                format!("  ... and {} more", detail.archived_tasks.len() - 5),
                Style::default().fg(colors.muted),
            )));
        }
    }

    let block = Block::default()
        .title(format!(" {} ", detail.name))
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

/// 信息行
fn info_line(label: &str, value: &str, colors: &ThemeColors) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {:<8}", label), Style::default().fg(colors.muted)),
        Span::styled(value.to_string(), Style::default().fg(colors.text)),
    ])
}

/// 分组标题
fn section_header(title: &str, colors: &ThemeColors) -> Line<'static> {
    Line::from(Span::styled(
        format!("  ─── {} ───", title),
        Style::default().fg(colors.muted),
    ))
}

/// 任务行
fn task_line(
    _id: &str,
    name: &str,
    status: WorktreeStatus,
    additions: u32,
    deletions: u32,
    notification: Option<NotificationLevel>,
    colors: &ThemeColors,
) -> Line<'static> {
    let status_icon = match status {
        WorktreeStatus::Live => Span::styled("●", Style::default().fg(colors.status_live)),
        WorktreeStatus::Idle => Span::styled("○", Style::default().fg(colors.muted)),
        WorktreeStatus::Merged => Span::styled("✓", Style::default().fg(colors.status_merged)),
        _ => Span::styled("?", Style::default().fg(colors.status_error)),
    };

    // 通知标记
    let (notif_marker, notif_style) = match notification {
        Some(NotificationLevel::Critical) => ("[!!]", Style::default().fg(colors.error)),
        Some(NotificationLevel::Warn) => ("[!]", Style::default().fg(colors.warning)),
        Some(NotificationLevel::Notice) => ("[i]", Style::default().fg(colors.info)),
        None => ("    ", Style::default()),
    };

    let changes: Vec<Span> = if additions > 0 || deletions > 0 {
        vec![
            Span::styled(
                format!("+{}", additions),
                Style::default().fg(colors.status_live),
            ),
            Span::raw(" "),
            Span::styled(
                format!("-{}", deletions),
                Style::default().fg(colors.status_error),
            ),
        ]
    } else {
        vec![Span::styled("clean", Style::default().fg(colors.muted))]
    };

    let mut spans = vec![
        Span::raw("  "),
        status_icon,
        Span::raw(" "),
        Span::styled(notif_marker, notif_style),
        Span::raw(" "),
        Span::styled(
            format!("{:<32}", truncate(name, 32)),
            Style::default().fg(colors.text),
        ),
        Span::raw(" "),
    ];
    spans.extend(changes);

    Line::from(spans)
}

/// 归档任务行
fn archived_task_line(name: &str, colors: &ThemeColors) -> Line<'static> {
    Line::from(vec![
        Span::raw("  "),
        Span::styled("✓", Style::default().fg(colors.status_merged)),
        Span::raw(" "),
        Span::styled(truncate(name, 20), Style::default().fg(colors.muted)),
    ])
}

/// 缩短路径（显示 ~ 代替 home）
fn shorten_path(path: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Some(home_str) = home.to_str() {
            if let Some(stripped) = path.strip_prefix(home_str) {
                return format!("~{}", stripped);
            }
        }
    }
    path.to_string()
}
