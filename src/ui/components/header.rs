use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::theme::Colors;

/// 渲染顶部标题栏
pub fn render(frame: &mut Frame, area: Rect, project_path: &str, worktree_count: usize) {
    let left = Span::styled(
        format!(" {}", project_path),
        Style::default().fg(Colors::TEXT),
    );

    let right = Span::styled(
        format!("{} worktrees ", worktree_count),
        Style::default().fg(Colors::MUTED),
    );

    // 计算中间填充空格
    let total_width = area.width as usize;
    let used_width = left.width() + right.width() + 4; // 边框占用
    let padding_len = total_width.saturating_sub(used_width);
    let padding = " ".repeat(padding_len);

    let line = Line::from(vec![left, Span::raw(padding), right]);

    let block = Block::default()
        .borders(Borders::TOP | Borders::LEFT | Borders::RIGHT)
        .border_style(Style::default().fg(Colors::BORDER))
        .title(" Grove ")
        .title_style(
            Style::default()
                .fg(Colors::HIGHLIGHT)
                .add_modifier(Modifier::BOLD),
        );

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}
