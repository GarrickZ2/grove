use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::{
    layout::{Alignment, Rect},
    style::{Modifier, Style},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

const SPINNER_FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// 在屏幕底部居中显示 Toast 消息
pub fn render(frame: &mut Frame, message: &str, colors: &ThemeColors) {
    let area = frame.area();

    // 计算 Toast 尺寸和位置
    let toast_width = (message.len() + 6).min(area.width as usize - 4) as u16;
    let toast_height = 3;
    let toast_x = (area.width - toast_width) / 2;
    let toast_y = area.height - toast_height - 3;

    let toast_area = Rect::new(toast_x, toast_y, toast_width, toast_height);

    // 清除背景
    frame.render_widget(Clear, toast_area);

    // 渲染 Toast
    let toast = Paragraph::new(message)
        .style(
            Style::default()
                .fg(colors.text)
                .add_modifier(Modifier::BOLD),
        )
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors.highlight))
                .style(Style::default().bg(colors.bg)),
        );

    frame.render_widget(toast, toast_area);
}

/// 在屏幕底部居中显示 Loading Toast（带 spinner 动画）
pub fn render_loading(frame: &mut Frame, message: &str, colors: &ThemeColors) {
    let area = frame.area();

    // 选择 spinner 帧（基于时间，每 100ms 切换）
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        / 100;
    let spinner = SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()];
    let display = format!("{} {}", spinner, message);

    // 计算 Toast 尺寸和位置
    let toast_width = (display.len() + 6).min(area.width as usize - 4) as u16;
    let toast_height = 3;
    let toast_x = (area.width - toast_width) / 2;
    let toast_y = area.height - toast_height - 3;

    let toast_area = Rect::new(toast_x, toast_y, toast_width, toast_height);

    // 清除背景
    frame.render_widget(Clear, toast_area);

    // 渲染 Loading Toast
    let toast = Paragraph::new(display.as_str())
        .style(
            Style::default()
                .fg(colors.text)
                .add_modifier(Modifier::BOLD),
        )
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors.highlight))
                .style(Style::default().bg(colors.bg)),
        );

    frame.render_widget(toast, toast_area);
}
