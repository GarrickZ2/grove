//! Workspace 层级视图渲染

use ratatui::{
    layout::{Constraint, Layout},
    style::Style,
    widgets::{Block, Widget},
    Frame,
};

use crate::app::App;

use super::components::{
    add_project_dialog, help_panel, logo, search_bar, theme_selector, toast,
    workspace_detail, workspace_empty, workspace_footer, workspace_list,
};

/// 渲染 Workspace 页面
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let colors = &app.colors;

    // 填充整个背景
    Block::default()
        .style(Style::default().bg(colors.bg))
        .render(area, frame.buffer_mut());

    // 是否展开详情面板
    let expanded = app.workspace.expanded;

    // 是否显示搜索框
    let show_search = app.workspace.search_mode || !app.workspace.search_query.is_empty();

    if expanded {
        // 展开模式：左右分栏
        render_expanded(frame, app, show_search);
    } else {
        // 折叠模式：居中列表
        render_collapsed(frame, app, show_search);
    }

    // 渲染 Toast
    if let Some(ref t) = app.toast {
        if !t.is_expired() {
            toast::render(frame, &t.message);
        }
    }

    // 渲染主题选择器
    if app.show_theme_selector {
        theme_selector::render(frame, app.theme_selector_index, colors);
    }

    // 渲染帮助面板
    if app.show_help {
        help_panel::render(frame, colors);
    }

    // 渲染 Add Project 弹窗
    if let Some(ref data) = app.add_project_dialog {
        add_project_dialog::render(frame, data, colors);
    }
}

/// 渲染折叠模式（居中）
fn render_collapsed(frame: &mut Frame, app: &App, show_search: bool) {
    let area = frame.area();
    let colors = &app.colors;

    // 布局
    let (logo_area, search_area, content_area, footer_area) = if show_search {
        let [logo_area, search_area, content_area, footer_area] = Layout::vertical([
            Constraint::Length(9),  // Logo
            Constraint::Length(1),  // 搜索框
            Constraint::Fill(1),    // 内容
            Constraint::Length(3),  // Footer
        ])
        .areas(area);
        (logo_area, Some(search_area), content_area, footer_area)
    } else {
        let [logo_area, content_area, footer_area] = Layout::vertical([
            Constraint::Length(9),  // Logo
            Constraint::Fill(1),    // 内容
            Constraint::Length(3),  // Footer
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

    // 渲染内容（项目列表或空状态）
    let projects = app.workspace.filtered_projects();
    if projects.is_empty() {
        workspace_empty::render(frame, content_area, colors);
    } else {
        let selected = app.workspace.list_state.selected();
        workspace_list::render(frame, content_area, &projects, selected, colors);
    }

    // 渲染 Footer
    let has_items = !app.workspace.projects.is_empty();
    workspace_footer::render(frame, footer_area, has_items, false, colors);
}

/// 渲染展开模式（左右分栏）
fn render_expanded(frame: &mut Frame, app: &App, show_search: bool) {
    let area = frame.area();
    let colors = &app.colors;

    // 上下布局
    let (logo_area, search_area, main_area, footer_area) = if show_search {
        let [logo_area, search_area, main_area, footer_area] = Layout::vertical([
            Constraint::Length(9),  // Logo
            Constraint::Length(1),  // 搜索框
            Constraint::Fill(1),    // 主内容
            Constraint::Length(3),  // Footer
        ])
        .areas(area);
        (logo_area, Some(search_area), main_area, footer_area)
    } else {
        let [logo_area, main_area, footer_area] = Layout::vertical([
            Constraint::Length(9),  // Logo
            Constraint::Fill(1),    // 主内容
            Constraint::Length(3),  // Footer
        ])
        .areas(area);
        (logo_area, None, main_area, footer_area)
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

    // 左右分栏
    let [left_area, right_area] = Layout::horizontal([
        Constraint::Percentage(35),
        Constraint::Percentage(65),
    ])
    .areas(main_area);

    // 左侧：项目列表
    let projects = app.workspace.filtered_projects();
    if projects.is_empty() {
        workspace_empty::render(frame, left_area, colors);
    } else {
        let selected = app.workspace.list_state.selected();
        workspace_list::render(frame, left_area, &projects, selected, colors);
    }

    // 右侧：详情面板
    if let Some(ref detail) = app.workspace.detail {
        workspace_detail::render(frame, right_area, detail, colors);
    }

    // 渲染 Footer
    let has_items = !app.workspace.projects.is_empty();
    workspace_footer::render(frame, footer_area, has_items, true, colors);
}
