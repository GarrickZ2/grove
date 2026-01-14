use ratatui::{
    layout::Constraint,
    style::Style,
    widgets::{Block, Widget},
    Frame,
};

use crate::app::App;

use super::components::{empty_state, footer, header, tabs, theme_selector, toast, worktree_list};

/// 渲染 Project 页面
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let colors = &app.colors;

    // 填充整个背景
    Block::default()
        .style(Style::default().bg(colors.bg))
        .render(area, frame.buffer_mut());

    // 垂直布局
    let [header_area, tabs_area, list_area, footer_area] =
        ratatui::layout::Layout::vertical([
            Constraint::Length(header::HEADER_HEIGHT), // Header (Logo + 项目信息)
            Constraint::Length(2),                     // Tabs (包含底边框)
            Constraint::Fill(1),                       // Worktree List / Empty State
            Constraint::Length(3),                     // Footer
        ])
        .areas(area);

    // 渲染 Header
    header::render(
        frame,
        header_area,
        &app.project.project_path,
        app.project.total_worktrees(),
        colors,
    );

    // 渲染 Tabs
    tabs::render(frame, tabs_area, app.project.current_tab, colors);

    // 渲染列表或空状态
    let worktrees = app.project.current_worktrees();
    if worktrees.is_empty() {
        empty_state::render(frame, list_area, app.project.current_tab, colors);
    } else {
        let selected = app.project.current_list_state().selected();
        worktree_list::render(frame, list_area, worktrees, selected, colors);
    }

    // 渲染 Footer
    footer::render(
        frame,
        footer_area,
        app.project.current_tab,
        !worktrees.is_empty(),
        colors,
    );

    // 渲染 Toast（如果有）
    if let Some(ref t) = app.toast {
        if !t.is_expired() {
            toast::render(frame, &t.message);
        }
    }

    // 渲染主题选择器（如果打开）
    if app.show_theme_selector {
        theme_selector::render(frame, app.theme_selector_index, colors);
    }
}
