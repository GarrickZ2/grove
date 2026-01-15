//! Merge 方式选择弹窗

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// Merge 方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MergeMethod {
    #[default]
    Squash,
    MergeCommit,
}

impl MergeMethod {
    pub fn toggle(&self) -> Self {
        match self {
            MergeMethod::Squash => MergeMethod::MergeCommit,
            MergeMethod::MergeCommit => MergeMethod::Squash,
        }
    }
}

/// Merge 弹窗数据
#[derive(Debug, Clone)]
pub struct MergeDialogData {
    pub task_id: String,
    pub task_name: String,
    pub branch: String,
    pub target: String,
    pub selected: MergeMethod,
}

impl MergeDialogData {
    pub fn new(task_id: String, task_name: String, branch: String, target: String) -> Self {
        Self {
            task_id,
            task_name,
            branch,
            target,
            selected: MergeMethod::Squash,
        }
    }

    pub fn toggle(&mut self) {
        self.selected = self.selected.toggle();
    }
}

/// 弹窗尺寸
const DIALOG_WIDTH: u16 = 42;
const DIALOG_HEIGHT: u16 = 12;

/// 渲染 Merge 弹窗
pub fn render(frame: &mut Frame, data: &MergeDialogData, colors: &ThemeColors) {
    let area = frame.area();

    // 居中计算
    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(DIALOG_HEIGHT) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), DIALOG_HEIGHT.min(area.height));

    // 清除背景
    frame.render_widget(Clear, dialog_area);

    // 外框
    let block = Block::default()
        .title(" Merge ")
        .title_alignment(Alignment::Center)
        .title_style(Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    // 内部布局
    let [info_area, _spacer1, options_area, _spacer2, hint_area] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(1),
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    // 渲染任务信息
    let info = Paragraph::new(vec![
        Line::from(vec![
            Span::styled("Merge ", Style::default().fg(colors.text)),
            Span::styled(&data.task_name, Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD)),
        ]),
        Line::from(vec![
            Span::styled("into ", Style::default().fg(colors.text)),
            Span::styled(&data.target, Style::default().fg(colors.highlight)),
            Span::styled("?", Style::default().fg(colors.text)),
        ]),
    ])
    .alignment(Alignment::Center);
    frame.render_widget(info, info_area);

    // 渲染选项
    let squash_selected = data.selected == MergeMethod::Squash;
    let options = Paragraph::new(vec![
        render_option("Squash", "combine all commits", squash_selected, colors),
        render_option("Merge commit", "keep history", !squash_selected, colors),
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
        Span::styled(label.to_string(), style.add_modifier(if selected { Modifier::BOLD } else { Modifier::empty() })),
        Span::styled(format!(" ({})", desc), Style::default().fg(colors.muted)),
    ])
}
