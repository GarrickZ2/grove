//! New Project 对话框 — 创建一个新目录并(可选)初始化 git,然后注册到 Grove
//!
//! UX:
//! - Path 输入框(~/ 展开),和 Add Project 对话框一样
//! - 下方灰色预览行实时展示展开后的绝对路径
//! - `[x] Initialize as Git repository` 复选框,默认勾选,Space 切换
//! - Tab 切换焦点(Path ↔ 复选框)
//! - Enter 提交,Esc 取消
//!
//! 注:Grove 项目名固定使用目录名(path 的 `file_name`),不提供独立的 name 字段。
//! Web 侧允许 name 与目录名不同;TUI 为了保持键盘流的简洁省略了该字段。

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;
use crate::ui::click_areas::{ClickAreas, DialogAction};

/// New Project 对话框焦点
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewProjectFocus {
    Path,
    InitGit,
}

/// New Project 对话框数据
#[derive(Debug, Clone)]
pub struct NewProjectData {
    /// 完整路径输入(如 `~/code/my-project`)
    pub input: String,
    /// 是否初始化为 git 仓库
    pub init_git: bool,
    /// 当前焦点
    pub focus: NewProjectFocus,
    /// 验证错误消息
    pub error: Option<String>,
}

impl NewProjectData {
    pub fn new() -> Self {
        Self {
            input: String::new(),
            init_git: true,
            focus: NewProjectFocus::Path,
            error: None,
        }
    }

    pub fn input_char(&mut self, c: char) {
        if self.focus == NewProjectFocus::Path {
            self.input.push(c);
            self.error = None;
        }
    }

    pub fn delete_char(&mut self) {
        if self.focus == NewProjectFocus::Path {
            self.input.pop();
            self.error = None;
        }
    }

    pub fn toggle_focus(&mut self) {
        self.focus = match self.focus {
            NewProjectFocus::Path => NewProjectFocus::InitGit,
            NewProjectFocus::InitGit => NewProjectFocus::Path,
        };
    }

    pub fn toggle_init_git(&mut self) {
        if self.focus == NewProjectFocus::InitGit {
            self.init_git = !self.init_git;
        }
    }

    pub fn set_error(&mut self, msg: impl Into<String>) {
        self.error = Some(msg.into());
    }

    /// 展开 ~ 到 HOME
    pub fn expanded_path(&self) -> String {
        crate::storage::workspace::expand_tilde(self.input.trim())
    }
}

impl Default for NewProjectData {
    fn default() -> Self {
        Self::new()
    }
}

/// 渲染 New Project 对话框
pub fn render(
    frame: &mut Frame,
    data: &NewProjectData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();

    let popup_width = 64u16.min(area.width.saturating_sub(4));
    let popup_height = if data.error.is_some() { 12 } else { 10 };

    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    frame.render_widget(Clear, popup_area);

    let block = Block::default()
        .title(" New Project ")
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.highlight))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    let hint_area;
    if data.error.is_some() {
        let [_, input_area, preview_area, _, check_area, _, error_area, _, ha] =
            Layout::vertical([
                Constraint::Length(1), // 顶部空行
                Constraint::Length(1), // 输入行
                Constraint::Length(1), // 预览行
                Constraint::Length(1), // 空行
                Constraint::Length(1), // 复选框
                Constraint::Length(1), // 空行
                Constraint::Length(1), // 错误行
                Constraint::Length(1), // 空行
                Constraint::Length(1), // 提示行
            ])
            .areas(inner_area);
        hint_area = ha;

        render_input(frame, input_area, data, colors);
        render_preview(frame, preview_area, data, colors);
        render_checkbox(frame, check_area, data, colors);
        render_error(frame, error_area, data, colors);
        render_hint(frame, hint_area, colors);
    } else {
        let [_, input_area, preview_area, _, check_area, _, _, ha] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas(inner_area);
        hint_area = ha;

        render_input(frame, input_area, data, colors);
        render_preview(frame, preview_area, data, colors);
        render_checkbox(frame, check_area, data, colors);
        render_hint(frame, hint_area, colors);
    }

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

fn render_input(frame: &mut Frame, area: Rect, data: &NewProjectData, colors: &ThemeColors) {
    let is_focused = data.focus == NewProjectFocus::Path;
    let label_color = if is_focused {
        colors.highlight
    } else {
        colors.muted
    };
    let mut spans = vec![
        Span::styled("  Path: ", Style::default().fg(label_color)),
        Span::styled(&data.input, Style::default().fg(colors.text)),
    ];
    if is_focused {
        spans.push(Span::styled("█", Style::default().fg(colors.highlight)));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_checkbox(frame: &mut Frame, area: Rect, data: &NewProjectData, colors: &ThemeColors) {
    let is_focused = data.focus == NewProjectFocus::InitGit;
    let label_color = if is_focused {
        colors.highlight
    } else {
        colors.muted
    };
    let box_str = if data.init_git { "[x]" } else { "[ ]" };
    let spans = vec![
        Span::styled("  ", Style::default()),
        Span::styled(
            box_str,
            Style::default().fg(if is_focused {
                colors.highlight
            } else {
                colors.text
            }),
        ),
        Span::styled(
            " Initialize as Git repository",
            Style::default().fg(label_color),
        ),
    ];
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_preview(frame: &mut Frame, area: Rect, data: &NewProjectData, colors: &ThemeColors) {
    let raw = data.input.trim();
    // 空输入时留空,避免干扰
    if raw.is_empty() {
        return;
    }
    let expanded = data.expanded_path();
    // 只有展开后与原输入不同时才展示(避免重复信息)
    if expanded == raw {
        return;
    }
    let line = Line::from(vec![
        Span::styled("     → ", Style::default().fg(colors.muted)),
        Span::styled(expanded, Style::default().fg(colors.muted)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn render_error(frame: &mut Frame, area: Rect, data: &NewProjectData, colors: &ThemeColors) {
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
        Span::styled("Tab", Style::default().fg(colors.highlight)),
        Span::styled(" switch  ", Style::default().fg(colors.muted)),
        Span::styled("Space", Style::default().fg(colors.highlight)),
        Span::styled(" toggle  ", Style::default().fg(colors.muted)),
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" create  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, area);
}
