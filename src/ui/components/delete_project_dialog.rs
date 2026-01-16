//! Delete Project 选择弹窗

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 删除模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeleteMode {
    #[default]
    /// 仅清理 worktrees + sessions（保留 branches）
    CleanOnly,
    /// 全部清理（worktrees + sessions + branches）
    FullClean,
}

impl DeleteMode {
    pub fn toggle(&self) -> Self {
        match self {
            DeleteMode::CleanOnly => DeleteMode::FullClean,
            DeleteMode::FullClean => DeleteMode::CleanOnly,
        }
    }
}

/// Delete Project 弹窗数据
#[derive(Debug, Clone)]
pub struct DeleteProjectData {
    /// 项目名称
    pub project_name: String,
    /// 项目路径
    pub project_path: String,
    /// 任务数量
    pub task_count: usize,
    /// 当前选中的删除模式
    pub selected: DeleteMode,
}

impl DeleteProjectData {
    pub fn new(project_name: String, project_path: String, task_count: usize) -> Self {
        Self {
            project_name,
            project_path,
            task_count,
            selected: DeleteMode::CleanOnly,
        }
    }

    pub fn toggle(&mut self) {
        self.selected = self.selected.toggle();
    }
}

/// 弹窗尺寸
const DIALOG_WIDTH: u16 = 50;
const DIALOG_HEIGHT: u16 = 13;

/// 渲染 Delete Project 弹窗
pub fn render(frame: &mut Frame, data: &DeleteProjectData, colors: &ThemeColors) {
    let area = frame.area();

    // 居中计算
    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(DIALOG_HEIGHT) / 2;
    let dialog_area = Rect::new(
        x,
        y,
        DIALOG_WIDTH.min(area.width),
        DIALOG_HEIGHT.min(area.height),
    );

    // 清除背景
    frame.render_widget(Clear, dialog_area);

    // 外框
    let block = Block::default()
        .title(" Remove Project ")
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(colors.status_error)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    // 内部布局
    let [info_area, _spacer1, options_area, _spacer2, hint_area] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(1),
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    // 渲染项目信息
    let task_info = if data.task_count > 0 {
        format!(" ({} tasks)", data.task_count)
    } else {
        String::new()
    };

    let info = Paragraph::new(vec![
        Line::from(vec![
            Span::styled("Remove ", Style::default().fg(colors.text)),
            Span::styled(
                &data.project_name,
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(task_info, Style::default().fg(colors.muted)),
            Span::styled("?", Style::default().fg(colors.text)),
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "Choose what to clean:",
            Style::default().fg(colors.muted),
        )),
    ])
    .alignment(Alignment::Center);
    frame.render_widget(info, info_area);

    // 渲染选项
    let clean_selected = data.selected == DeleteMode::CleanOnly;
    let options = Paragraph::new(vec![
        render_option(
            "Clean only",
            "remove worktrees + sessions",
            clean_selected,
            colors,
        ),
        render_option(
            "Full clean",
            "also delete branches",
            !clean_selected,
            colors,
        ),
    ])
    .alignment(Alignment::Center);
    frame.render_widget(options, options_area);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("j/k", Style::default().fg(colors.highlight)),
        Span::styled(" switch  ", Style::default().fg(colors.muted)),
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" confirm  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);
    frame.render_widget(hint, hint_area);
}

/// 渲染选项行
fn render_option(label: &str, desc: &str, selected: bool, colors: &ThemeColors) -> Line<'static> {
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
