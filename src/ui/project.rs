use ratatui::{
    layout::Constraint,
    style::Style,
    widgets::{Block, Widget},
    Frame,
};

use crate::app::App;

use super::components::{
    action_palette, branch_selector, commit_dialog, confirm_dialog, empty_state, footer, header,
    help_panel, hook_panel, input_confirm_dialog, merge_dialog, new_task_dialog, preview_panel,
    project_info, search_bar, tabs, theme_selector, toast, worktree_list,
};

/// 渲染 Project 页面
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let colors = &app.colors;

    // 填充整个背景
    Block::default()
        .style(Style::default().bg(colors.bg))
        .render(area, frame.buffer_mut());

    // 是否显示搜索框：正在输入或有搜索内容
    let show_search = app.project.search_mode || !app.project.search_query.is_empty();

    // 根据搜索状态决定布局
    let (header_area, project_info_area, tabs_area, search_area, list_area, footer_area) =
        if show_search {
            let [header_area, project_info_area, tabs_area, search_area, list_area, footer_area] =
                ratatui::layout::Layout::vertical([
                    Constraint::Length(header::HEADER_HEIGHT),
                    Constraint::Length(project_info::PROJECT_INFO_HEIGHT),
                    Constraint::Length(2),
                    Constraint::Length(1), // 搜索框
                    Constraint::Fill(1),
                    Constraint::Length(3),
                ])
                .areas(area);
            (
                header_area,
                project_info_area,
                tabs_area,
                Some(search_area),
                list_area,
                footer_area,
            )
        } else {
            let [header_area, project_info_area, tabs_area, list_area, footer_area] =
                ratatui::layout::Layout::vertical([
                    Constraint::Length(header::HEADER_HEIGHT),
                    Constraint::Length(project_info::PROJECT_INFO_HEIGHT),
                    Constraint::Length(2),
                    Constraint::Fill(1),
                    Constraint::Length(3),
                ])
                .areas(area);
            (
                header_area,
                project_info_area,
                tabs_area,
                None,
                list_area,
                footer_area,
            )
        };

    // 渲染 Header
    header::render(
        frame,
        header_area,
        &app.project.project_path,
        app.project.active_task_count(),
        colors,
    );

    // 获取并渲染 Project Info (使用缓存避免每帧都执行 git 命令)
    let project_info_data = {
        use crate::git::cache;
        let repo_path = &app.project.project_path;
        const CACHE_TTL: u64 = 2; // 2 秒缓存

        let branch =
            cache::get_string_or_compute(&format!("branch:{}", repo_path), CACHE_TTL, || {
                crate::git::current_branch(repo_path).unwrap_or_else(|_| "unknown".to_string())
            });

        let commits_ahead = cache::get_option_u32_or_compute(
            &format!("commits_ahead:{}", repo_path),
            CACHE_TTL,
            || crate::git::commits_ahead_of_origin(repo_path).unwrap_or(None),
        );

        let (additions, deletions) =
            cache::get_tuple_u32_or_compute(&format!("changes:{}", repo_path), CACHE_TTL, || {
                crate::git::changes_from_origin(repo_path).unwrap_or((0, 0))
            });

        let last_commit =
            cache::get_string_or_compute(&format!("last_commit:{}", repo_path), CACHE_TTL, || {
                crate::git::last_commit_time(repo_path).unwrap_or_else(|_| "unknown".to_string())
            });

        project_info::ProjectInfoData {
            branch,
            commits_ahead,
            additions,
            deletions,
            last_commit,
        }
    };
    project_info::render(frame, project_info_area, &project_info_data, colors);

    // 渲染 Tabs
    tabs::render(frame, tabs_area, app.project.current_tab, colors);

    // 渲染搜索框（如果有搜索内容或正在输入）
    if let Some(search_area) = search_area {
        search_bar::render(
            frame,
            search_area,
            &app.project.search_query,
            app.project.search_mode,
            colors,
        );
    }

    // 渲染列表或空状态（使用过滤后的数据）
    let worktrees = app.project.filtered_worktrees();
    if app.project.preview_visible {
        // 分割布局：左侧列表 + 右侧预览
        let [left_area, right_area] = ratatui::layout::Layout::horizontal([
            Constraint::Percentage(50),
            Constraint::Percentage(50),
        ])
        .areas(list_area);

        if worktrees.is_empty() {
            empty_state::render(frame, left_area, app.project.current_tab, colors);
        } else {
            let selected = app.project.current_list_state().selected();
            worktree_list::render(
                frame,
                left_area,
                &worktrees,
                selected,
                colors,
                &app.notifications,
            );
        }

        preview_panel::render(
            frame,
            right_area,
            app.project.selected_worktree(),
            app.project.preview_sub_tab,
            &app.project.panel_data,
            app.project.notes_scroll,
            app.project.ai_summary_scroll,
            app.project.git_scroll,
            colors,
        );
    } else if worktrees.is_empty() {
        empty_state::render(frame, list_area, app.project.current_tab, colors);
    } else {
        let selected = app.project.current_list_state().selected();
        worktree_list::render(
            frame,
            list_area,
            &worktrees,
            selected,
            colors,
            &app.notifications,
        );
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
            toast::render(frame, &t.message, colors);
        }
    }

    // 渲染主题选择器（如果打开）
    if app.show_theme_selector {
        theme_selector::render(frame, app.theme_selector_index, colors);
    }

    // 渲染 New Task 弹窗（如果打开）
    if app.show_new_task_dialog {
        new_task_dialog::render(frame, &app.new_task_input, &app.target_branch, colors);
    }

    // 渲染确认弹窗（弱确认）
    if let Some(ref confirm_type) = app.confirm_dialog {
        confirm_dialog::render(frame, confirm_type, colors);
    }

    // 渲染输入确认弹窗（强确认）
    if let Some(ref data) = app.input_confirm_dialog {
        input_confirm_dialog::render(frame, data, colors);
    }

    // 渲染分支选择器
    if let Some(ref data) = app.branch_selector {
        branch_selector::render(frame, data, colors);
    }

    // 渲染 Merge 选择弹窗
    if let Some(ref data) = app.merge_dialog {
        merge_dialog::render(frame, data, colors);
    }

    // 渲染 Action Palette
    if let Some(ref data) = app.action_palette {
        action_palette::render(frame, data, colors);
    }

    // 渲染 Commit Dialog
    if let Some(ref data) = app.commit_dialog {
        commit_dialog::render(frame, data, colors);
    }

    // 渲染 Hook 配置面板
    if let Some(ref data) = app.hook_panel {
        hook_panel::render(frame, data, colors);
    }

    // 渲染帮助面板
    if app.show_help {
        help_panel::render(frame, colors, app.update_info.as_ref());
    }
}
