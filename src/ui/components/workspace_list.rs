//! Workspace 项目列表组件（居中样式）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::model::ProjectInfo;
use crate::theme::ThemeColors;

/// 渲染居中项目列表
pub fn render(
    frame: &mut Frame,
    area: Rect,
    projects: &[&ProjectInfo],
    selected: Option<usize>,
    colors: &ThemeColors,
) {
    if projects.is_empty() {
        return;
    }

    let mut lines = Vec::new();

    // 标题行
    lines.push(Line::from(Span::styled(
        "─── Your Projects ───",
        Style::default().fg(colors.muted),
    )));
    lines.push(Line::from(""));

    // 项目行
    for (i, project) in projects.iter().enumerate() {
        let is_selected = selected == Some(i);

        // 构建行内容
        let cursor = if is_selected { "❯" } else { " " };

        // 状态指示器
        let status_indicator = if project.live_count > 0 {
            Span::styled("●", Style::default().fg(colors.status_live))
        } else if project.task_count > 0 {
            Span::styled("○", Style::default().fg(colors.muted))
        } else {
            Span::styled(" ", Style::default())
        };

        // 任务数文本
        let task_text = if project.task_count == 1 {
            "1 task".to_string()
        } else {
            format!("{} tasks", project.task_count)
        };

        let line = Line::from(vec![
            Span::styled(
                format!(" {}  ", cursor),
                Style::default().fg(if is_selected { colors.highlight } else { colors.text }),
            ),
            Span::styled(
                format!("{:<20}", truncate(&project.name, 20)),
                Style::default()
                    .fg(if is_selected { colors.highlight } else { colors.text })
                    .add_modifier(if is_selected { Modifier::BOLD } else { Modifier::empty() }),
            ),
            Span::styled(
                format!("{:>10}   ", task_text),
                Style::default().fg(colors.muted),
            ),
            status_indicator,
        ]);

        lines.push(line);
    }

    // 计算居中位置
    let content_height = lines.len() as u16;
    let vertical_padding = area.height.saturating_sub(content_height) / 2;

    // 创建带垂直居中的布局
    let [_, content_area, _] = Layout::vertical([
        Constraint::Length(vertical_padding),
        Constraint::Length(content_height),
        Constraint::Fill(1),
    ])
    .areas(area);

    let paragraph = Paragraph::new(lines).alignment(Alignment::Center);
    frame.render_widget(paragraph, content_area);
}

/// 截断字符串
fn truncate(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max_len - 1).collect::<String>())
    }
}
