//! Delete Project 选择弹窗

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::dialog_utils::{center_dialog, render_dialog_frame, render_hint, render_option};
use crate::theme::ThemeColors;
use crate::ui::click_areas::{ClickAreas, DialogAction};

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
pub fn render(
    frame: &mut Frame,
    data: &DeleteProjectData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let dialog_area = center_dialog(frame.area(), DIALOG_WIDTH, DIALOG_HEIGHT);
    let inner_area = render_dialog_frame(
        frame,
        dialog_area,
        " Remove Project ",
        colors.status_error,
        colors,
    );

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
    render_hint(
        frame,
        hint_area,
        &[("j/k", "switch"), ("Enter", "confirm"), ("Esc", "cancel")],
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    click_areas
        .dialog_items
        .push((Rect::new(options_area.x, options_area.y, options_area.width, 1), 0));
    click_areas.dialog_items.push((
        Rect::new(options_area.x, options_area.y + 1, options_area.width, 1),
        1,
    ));
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
