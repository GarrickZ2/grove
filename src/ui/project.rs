use ratatui::{layout::Constraint, Frame};

use crate::app::App;

use super::components::{empty_state, footer, header, tabs, toast, worktree_list};

/// 渲染 Project 页面
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // 垂直布局
    let [header_area, tabs_area, list_area, footer_area] =
        ratatui::layout::Layout::vertical([
            Constraint::Length(2),  // Header
            Constraint::Length(2),  // Tabs (包含底边框)
            Constraint::Fill(1),    // Worktree List / Empty State
            Constraint::Length(3),  // Footer
        ])
        .areas(area);

    // 渲染 Header
    header::render(
        frame,
        header_area,
        &app.project.project_path,
        app.project.total_worktrees(),
    );

    // 渲染 Tabs
    tabs::render(frame, tabs_area, app.project.current_tab);

    // 渲染列表或空状态
    let worktrees = app.project.current_worktrees();
    if worktrees.is_empty() {
        empty_state::render(frame, list_area, app.project.current_tab);
    } else {
        let selected = app.project.current_list_state().selected();
        worktree_list::render(frame, list_area, worktrees, selected);
    }

    // 渲染 Footer
    footer::render(
        frame,
        footer_area,
        app.project.current_tab,
        !worktrees.is_empty(),
    );

    // 渲染 Toast（如果有）
    if let Some(ref t) = app.toast {
        if !t.is_expired() {
            toast::render(frame, &t.message);
        }
    }
}
