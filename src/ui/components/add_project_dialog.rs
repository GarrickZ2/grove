//! Add Project 弹窗组件

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;
use crate::ui::click_areas::{ClickAreas, DialogAction};

/// Add Project 弹窗数据
#[derive(Debug, Clone)]
pub struct AddProjectData {
    /// 输入的路径
    pub input: String,
    /// 验证错误消息
    pub error: Option<String>,
}

impl AddProjectData {
    pub fn new() -> Self {
        Self {
            input: String::new(),
            error: None,
        }
    }

    /// 输入字符
    pub fn input_char(&mut self, c: char) {
        self.input.push(c);
        self.error = None; // 清除错误
    }

    /// 删除字符
    pub fn delete_char(&mut self) {
        self.input.pop();
        self.error = None;
    }

    /// 设置错误
    pub fn set_error(&mut self, msg: impl Into<String>) {
        self.error = Some(msg.into());
    }

    /// 获取展开后的路径（处理 ~）
    pub fn expanded_path(&self) -> String {
        let path = self.input.trim();
        if let Some(stripped) = path.strip_prefix("~/") {
            if let Some(home) = dirs::home_dir() {
                return home.join(stripped).to_string_lossy().to_string();
            }
        }
        path.to_string()
    }
}

impl Default for AddProjectData {
    fn default() -> Self {
        Self::new()
    }
}

/// 渲染 Add Project 弹窗
pub fn render(
    frame: &mut Frame,
    data: &AddProjectData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();

    // 计算弹窗尺寸
    let popup_width = 60u16.min(area.width.saturating_sub(4));
    let popup_height = if data.error.is_some() { 9 } else { 7 };

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框
    let block = Block::default()
        .title(" Add Project ")
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.highlight))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局
    let hint_area;
    if data.error.is_some() {
        let [_, input_area, _, error_area, _, ha] = Layout::vertical([
            Constraint::Length(1), // 顶部空行
            Constraint::Length(1), // 输入行
            Constraint::Length(1), // 空行
            Constraint::Length(1), // 错误行
            Constraint::Length(1), // 空行
            Constraint::Length(1), // 提示行
        ])
        .areas(inner_area);
        hint_area = ha;

        render_input(frame, input_area, data, colors);
        render_error(frame, error_area, data, colors);
        render_hint(frame, hint_area, colors);
    } else {
        let [_, input_area, _, _, ha] = Layout::vertical([
            Constraint::Length(1), // 顶部空行
            Constraint::Length(1), // 输入行
            Constraint::Length(1), // 空行
            Constraint::Length(1), // 空行
            Constraint::Length(1), // 提示行
        ])
        .areas(inner_area);
        hint_area = ha;

        render_input(frame, input_area, data, colors);
        render_hint(frame, hint_area, colors);
    }

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

fn render_input(frame: &mut Frame, area: Rect, data: &AddProjectData, colors: &ThemeColors) {
    let input_line = Line::from(vec![
        Span::styled("  Path: ", Style::default().fg(colors.muted)),
        Span::styled(&data.input, Style::default().fg(colors.text)),
        Span::styled("█", Style::default().fg(colors.highlight)), // 光标
    ]);
    frame.render_widget(Paragraph::new(input_line), area);
}

fn render_error(frame: &mut Frame, area: Rect, data: &AddProjectData, colors: &ThemeColors) {
    if let Some(ref error) = data.error {
        let error_line = Line::from(vec![
            Span::styled("  ✗ ", Style::default().fg(colors.status_error)),
            Span::styled(error.as_str(), Style::default().fg(colors.status_error)),
        ]);
        frame.render_widget(Paragraph::new(error_line), area);
    }
}

fn render_hint(frame: &mut Frame, area: Rect, colors: &ThemeColors) {
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" add  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, area);
}
