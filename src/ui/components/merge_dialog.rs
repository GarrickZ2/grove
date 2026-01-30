//! Merge 方式选择弹窗

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
    #[allow(dead_code)] // 预留用于显示
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
pub fn render(
    frame: &mut Frame,
    data: &MergeDialogData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let dialog_area = center_dialog(frame.area(), DIALOG_WIDTH, DIALOG_HEIGHT);
    let inner_area = render_dialog_frame(frame, dialog_area, " Merge ", colors.highlight, colors);

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
            Span::styled(
                &data.task_name,
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ),
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
    render_hint(
        frame,
        hint_area,
        &[("j/k", "switch"), ("Enter", "confirm"), ("Esc", "cancel")],
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    // 选项行（每个选项 1 行）
    click_areas
        .dialog_items
        .push((Rect::new(options_area.x, options_area.y, options_area.width, 1), 0));
    click_areas.dialog_items.push((
        Rect::new(options_area.x, options_area.y + 1, options_area.width, 1),
        1,
    ));
    // 按钮
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
