use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

use super::logo;

/// Replace home directory prefix with ~
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

/// Header 总高度：1 (边框) + 6 (Logo) + 1 (下边距) + 1 (项目信息) = 9
pub const HEADER_HEIGHT: u16 = 9;

/// 渲染顶部区域（Logo + 项目信息）
pub fn render(
    frame: &mut Frame,
    area: Rect,
    project_path: &str,
    worktree_count: usize,
    colors: &ThemeColors,
) {
    // 外框
    let block = Block::default()
        .borders(Borders::TOP | Borders::LEFT | Borders::RIGHT)
        .border_style(Style::default().fg(colors.border));

    let inner_area = block.inner(area);
    frame.render_widget(block, area);

    // 内部垂直布局
    let [logo_area, bottom_padding, info_area] = Layout::vertical([
        Constraint::Length(logo::LOGO_HEIGHT), // Logo
        Constraint::Length(1),                 // 下边距
        Constraint::Length(1),                 // 项目信息
    ])
    .areas(inner_area);

    // 渲染 Logo
    logo::render(frame, logo_area, colors);

    // 渲染项目信息行
    render_project_info(frame, info_area, project_path, worktree_count, colors);

    // 填充空白区域（防止残留）
    let empty = Paragraph::new("");
    frame.render_widget(empty, bottom_padding);
}

fn render_project_info(
    frame: &mut Frame,
    area: Rect,
    project_path: &str,
    worktree_count: usize,
    colors: &ThemeColors,
) {
    let left = Span::styled(
        format!(" {}", shorten_path(project_path)),
        Style::default().fg(colors.text),
    );

    let right = Span::styled(
        format!("{} tasks ", worktree_count),
        Style::default().fg(colors.muted),
    );

    // 计算中间填充空格
    let total_width = area.width as usize;
    let used_width = left.width() + right.width();
    let padding_len = total_width.saturating_sub(used_width);
    let padding = " ".repeat(padding_len);

    let line = Line::from(vec![left, Span::raw(padding), right]);

    let paragraph = Paragraph::new(line);
    frame.render_widget(paragraph, area);
}
