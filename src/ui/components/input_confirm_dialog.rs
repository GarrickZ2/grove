//! 输入确认弹窗组件（强确认）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;
use crate::ui::click_areas::{ClickAreas, DialogAction};

/// 输入确认弹窗数据
#[derive(Debug, Clone)]
pub struct InputConfirmData {
    pub task_name: String,
    pub branch: String,
    pub input: String,
}

impl InputConfirmData {
    pub fn new(task_name: String, branch: String) -> Self {
        Self {
            task_name,
            branch,
            input: String::new(),
        }
    }

    pub fn is_confirmed(&self) -> bool {
        self.input.to_lowercase() == "delete"
    }
}

/// 渲染输入确认弹窗
pub fn render(
    frame: &mut Frame,
    data: &InputConfirmData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();

    // 计算弹窗尺寸
    let popup_width = 45u16;
    let popup_height = 13u16;

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框 - 使用红色表示危险操作
    let block = Block::default()
        .title(" ⚠ Clean (Unmerged) ")
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.status_error))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局
    let [content_area, input_area, hint_area] = Layout::vertical([
        Constraint::Length(6),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    // 渲染消息内容
    let message_lines = vec![
        Line::from(Span::styled(
            format!("Task: {}", data.task_name),
            Style::default().fg(colors.text),
        )),
        Line::from(Span::styled(
            format!("Branch: {}", data.branch),
            Style::default().fg(colors.text),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "⚠ Branch has NOT been merged!",
            Style::default()
                .fg(colors.status_error)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "Type 'delete' to confirm:",
            Style::default().fg(colors.text),
        )),
    ];

    let content = Paragraph::new(message_lines).alignment(Alignment::Center);
    frame.render_widget(content, content_area);

    // 渲染输入框
    let input_style = if data.is_confirmed() {
        Style::default().fg(colors.status_live)
    } else {
        Style::default().fg(colors.text)
    };

    let input_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border));

    let input_inner = input_block.inner(input_area);
    frame.render_widget(input_block, input_area);

    let input_text = Paragraph::new(Line::from(vec![
        Span::styled(&data.input, input_style),
        Span::styled(
            "_",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ]))
    .alignment(Alignment::Center);
    frame.render_widget(input_text, input_inner);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" confirm  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, hint_area);

    // 注册点击区域
    click_areas.dialog_area = Some(popup_area);
    let half = hint_area.width / 2;
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x, hint_area.y, half, 1),
        DialogAction::Confirm,
    ));
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}
