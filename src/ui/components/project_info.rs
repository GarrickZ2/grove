//! Project Info 区域组件
//! 显示主仓库的详细状态：分支、commits ahead、文件变更、最近提交时间

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// Project Info 区域高度
pub const PROJECT_INFO_HEIGHT: u16 = 3;

/// Project Info 数据
pub struct ProjectInfoData {
    pub branch: String,
    pub commits_ahead: Option<u32>,
    pub additions: u32,
    pub deletions: u32,
    pub last_commit: String,
}

/// 渲染 Project Info 区域
pub fn render(frame: &mut Frame, area: Rect, data: &ProjectInfoData, colors: &ThemeColors) {
    // 外框：左 + 右 + 下（与 header 衔接）
    let block = Block::default()
        .borders(Borders::LEFT | Borders::RIGHT | Borders::BOTTOM)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(area);
    frame.render_widget(block, area);

    // 左右两列布局
    let [left_area, right_area] =
        Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
            .areas(inner_area);

    // 左侧内容
    let left_content = build_left_content(data, colors);
    let left_para = Paragraph::new(left_content);
    frame.render_widget(left_para, left_area);

    // 右侧内容
    let right_content = build_right_content(data, colors);
    let right_para = Paragraph::new(right_content);
    frame.render_widget(right_para, right_area);
}

/// 构建左侧内容
fn build_left_content(data: &ProjectInfoData, colors: &ThemeColors) -> Vec<Line<'static>> {
    vec![
        // 第一行：Branch 名称
        Line::from(vec![
            Span::styled("  Branch: ", Style::default().fg(colors.muted)),
            Span::styled(
                data.branch.clone(),
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ),
        ]),
        // 第二行：文件变更统计
        Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled(
                format!("+{}", data.additions),
                Style::default().fg(colors.status_live),
            ),
            Span::styled(" ", Style::default()),
            Span::styled(
                format!("-{}", data.deletions),
                Style::default().fg(colors.status_error),
            ),
            Span::styled(" lines changed", Style::default().fg(colors.muted)),
        ]),
    ]
}

/// 构建右侧内容
fn build_right_content(data: &ProjectInfoData, colors: &ThemeColors) -> Vec<Line<'static>> {
    // 第一行：commits ahead
    let commits_text = match data.commits_ahead {
        Some(0) => "in sync with origin".to_string(),
        Some(n) => format!("+{} commits ahead of origin", n),
        None => "no remote tracking".to_string(),
    };

    let commits_color = match data.commits_ahead {
        Some(0) => colors.status_merged,
        Some(_) => colors.highlight,
        None => colors.muted,
    };

    vec![
        Line::from(Span::styled(
            commits_text,
            Style::default().fg(commits_color),
        )),
        // 第二行：最近提交时间
        Line::from(vec![
            Span::styled("Last commit: ", Style::default().fg(colors.muted)),
            Span::styled(data.last_commit.clone(), Style::default().fg(colors.text)),
        ]),
    ]
}
