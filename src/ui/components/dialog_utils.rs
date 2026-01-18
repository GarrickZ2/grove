//! Dialog 组件共享工具函数
//!
//! 提供 dialog 组件常用的渲染工具，减少重复代码

use ratatui::{
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 计算居中 dialog 区域
pub fn center_dialog(frame_area: Rect, width: u16, height: u16) -> Rect {
    let x = frame_area.width.saturating_sub(width) / 2;
    let y = frame_area.height.saturating_sub(height) / 2;
    Rect::new(
        x,
        y,
        width.min(frame_area.width),
        height.min(frame_area.height),
    )
}

/// 渲染 dialog 框架（带标题、边框）并返回内部可用区域
///
/// # Arguments
/// * `frame` - ratatui Frame
/// * `area` - dialog 区域
/// * `title` - 标题文本
/// * `border_color` - 边框颜色
/// * `colors` - 主题颜色
///
/// # Returns
/// 内部可用区域 (已扣除边框)
pub fn render_dialog_frame(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    border_color: Color,
    colors: &ThemeColors,
) -> Rect {
    // 清除背景
    frame.render_widget(Clear, area);

    // 外框
    let block = Block::default()
        .title(title)
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(border_color)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color))
        .style(Style::default().bg(colors.bg));

    let inner = block.inner(area);
    frame.render_widget(block, area);
    inner
}

/// 渲染标准提示行
///
/// # Arguments
/// * `frame` - ratatui Frame
/// * `area` - 提示行区域
/// * `hints` - 提示内容列表，格式为 [(快捷键, 描述), ...]
/// * `colors` - 主题颜色
pub fn render_hint(frame: &mut Frame, area: Rect, hints: &[(&str, &str)], colors: &ThemeColors) {
    let spans: Vec<Span> = hints
        .iter()
        .enumerate()
        .flat_map(|(i, (key, desc))| {
            let mut v = vec![];
            if i > 0 {
                v.push(Span::styled("  ", Style::default().fg(colors.muted)));
            }
            v.push(Span::styled(*key, Style::default().fg(colors.highlight)));
            v.push(Span::styled(
                format!(" {}", desc),
                Style::default().fg(colors.muted),
            ));
            v
        })
        .collect();

    let hint = Paragraph::new(Line::from(spans)).alignment(Alignment::Center);
    frame.render_widget(hint, area);
}

/// 渲染可选择的选项（带圆点指示器）
///
/// # Arguments
/// * `label` - 选项标签
/// * `desc` - 选项描述
/// * `selected` - 是否选中
/// * `colors` - 主题颜色
///
/// # Returns
/// 格式化后的 Line
pub fn render_option(
    label: &str,
    desc: &str,
    selected: bool,
    colors: &ThemeColors,
) -> Line<'static> {
    let bullet = if selected { "●" } else { "○" };
    let style = if selected {
        Style::default().fg(colors.highlight)
    } else {
        Style::default().fg(colors.muted)
    };

    Line::from(vec![
        Span::styled(format!(" {} ", bullet), style),
        Span::styled(
            label.to_string(),
            style.add_modifier(if selected {
                Modifier::BOLD
            } else {
                Modifier::empty()
            }),
        ),
        Span::styled(format!(" ({})", desc), Style::default().fg(colors.muted)),
    ])
}

/// 渲染错误信息
///
/// # Arguments
/// * `frame` - ratatui Frame
/// * `area` - 错误信息区域
/// * `message` - 错误信息
/// * `colors` - 主题颜色
#[allow(dead_code)]
pub fn render_error(frame: &mut Frame, area: Rect, message: &str, colors: &ThemeColors) {
    let error = Paragraph::new(message)
        .style(Style::default().fg(colors.status_error))
        .alignment(Alignment::Center);
    frame.render_widget(error, area);
}

/// 渲染输入框
///
/// # Arguments
/// * `frame` - ratatui Frame
/// * `area` - 输入框区域
/// * `value` - 当前输入值
/// * `colors` - 主题颜色
/// * `show_cursor` - 是否显示光标
#[allow(dead_code)]
pub fn render_input(
    frame: &mut Frame,
    area: Rect,
    value: &str,
    colors: &ThemeColors,
    show_cursor: bool,
) {
    let display = if show_cursor {
        format!("{}▏", value)
    } else {
        value.to_string()
    };

    let input = Paragraph::new(display)
        .style(Style::default().fg(colors.text))
        .alignment(Alignment::Left);
    frame.render_widget(input, area);
}
