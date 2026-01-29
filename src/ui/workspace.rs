//! Workspace 层级视图渲染

use ratatui::{
    layout::{Constraint, Layout},
    style::Style,
    widgets::{Block, Widget},
    Frame,
};

use crate::app::App;

use super::components::{
    add_project_dialog, delete_project_dialog, help_panel, logo, search_bar, theme_selector, toast,
    workspace_empty, workspace_footer, workspace_list,
};

/// 渲染 Workspace 页面
pub fn render(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let colors = &app.colors;

    // 填充整个背景
    Block::default()
        .style(Style::default().bg(colors.bg))
        .render(area, frame.buffer_mut());

    // 是否显示搜索框
    let show_search = app.workspace.search_mode || !app.workspace.search_query.is_empty();

    render_grid(frame, app, show_search);

    // 渲染 Toast
    if let Some(ref t) = app.toast {
        if !t.is_expired() {
            toast::render(frame, &t.message, &app.colors);
        }
    }

    // 渲染主题选择器
    if app.show_theme_selector {
        theme_selector::render(frame, app.theme_selector_index, &app.colors);
    }

    // 渲染帮助面板
    if app.show_help {
        help_panel::render(frame, &app.colors, app.update_info.as_ref());
    }

    // 渲染 Add Project 弹窗
    if let Some(ref data) = app.add_project_dialog {
        add_project_dialog::render(frame, data, &app.colors);
    }

    // 渲染 Delete Project 弹窗
    if let Some(ref data) = app.delete_project_dialog {
        delete_project_dialog::render(frame, data, &app.colors);
    }
}

/// 渲染网格布局
fn render_grid(frame: &mut Frame, app: &mut App, show_search: bool) {
    let area = frame.area();
    let colors = &app.colors;

    // 布局
    let (logo_area, search_area, content_area, footer_area) = if show_search {
        let [logo_area, search_area, content_area, footer_area] = Layout::vertical([
            Constraint::Length(9), // Logo
            Constraint::Length(1), // 搜索框
            Constraint::Fill(1),   // 内容
            Constraint::Length(3), // Footer
        ])
        .areas(area);
        (logo_area, Some(search_area), content_area, footer_area)
    } else {
        let [logo_area, content_area, footer_area] = Layout::vertical([
            Constraint::Length(9), // Logo
            Constraint::Fill(1),   // 内容
            Constraint::Length(3), // Footer
        ])
        .areas(area);
        (logo_area, None, content_area, footer_area)
    };

    // 渲染 Logo（带顶部间距）
    logo::render_with_padding(frame, logo_area, colors, 2);

    // 渲染搜索框
    if let Some(search_area) = search_area {
        search_bar::render(
            frame,
            search_area,
            &app.workspace.search_query,
            app.workspace.search_mode,
            colors,
        );
    }

    // 渲染内容（卡片网格或空状态）
    let projects = app.workspace.filtered_projects();
    if projects.is_empty() {
        workspace_empty::render(frame, content_area, colors);
    } else {
        workspace_list::render(
            frame,
            content_area,
            &mut app.workspace,
            colors,
            &app.workspace_notifications,
        );
    }

    // 渲染 Footer
    let has_items = !app.workspace.projects.is_empty();
    workspace_footer::render(frame, footer_area, has_items, colors);
}
