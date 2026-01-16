use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind};

use crate::app::{App, AppMode};
use crate::model::ProjectTab;

/// 处理事件，返回 true 表示应该继续运行
pub fn handle_events(app: &mut App) -> io::Result<bool> {
    // 更新 Toast 状态
    app.update_toast();

    // 检查系统主题变化（用于 Auto 模式）
    app.check_system_theme();

    // 轮询事件（100ms 超时）
    if event::poll(Duration::from_millis(100))? {
        if let Event::Key(key) = event::read()? {
            // 只处理按下事件
            if key.kind != KeyEventKind::Press {
                return Ok(true);
            }
            handle_key(app, key);
        }
    }

    Ok(!app.should_quit)
}

fn handle_key(app: &mut App, key: KeyEvent) {
    // 优先处理弹窗事件

    // 帮助面板
    if app.show_help {
        handle_help_key(app, key);
        return;
    }

    // Merge 选择弹窗
    if app.merge_dialog.is_some() {
        handle_merge_dialog_key(app, key);
        return;
    }

    // 分支选择器
    if app.branch_selector.is_some() {
        handle_branch_selector_key(app, key);
        return;
    }

    // 输入确认弹窗（强确认）
    if app.input_confirm_dialog.is_some() {
        handle_input_confirm_key(app, key);
        return;
    }

    // 确认弹窗（弱确认）
    if app.confirm_dialog.is_some() {
        handle_confirm_dialog_key(app, key);
        return;
    }

    // New Task 弹窗
    if app.show_new_task_dialog {
        handle_new_task_dialog_key(app, key);
        return;
    }

    // 主题选择器
    if app.show_theme_selector {
        handle_theme_selector_key(app, key);
        return;
    }

    // Add Project 弹窗
    if app.add_project_dialog.is_some() {
        handle_add_project_dialog_key(app, key);
        return;
    }

    // Delete Project 弹窗
    if app.delete_project_dialog.is_some() {
        handle_delete_project_dialog_key(app, key);
        return;
    }

    // Action Palette
    if app.action_palette.is_some() {
        handle_action_palette_key(app, key);
        return;
    }

    // Commit Dialog
    if app.commit_dialog.is_some() {
        handle_commit_dialog_key(app, key);
        return;
    }

    // Hook Panel
    if app.hook_panel.is_some() {
        handle_hook_panel_key(app, key);
        return;
    }

    // 根据模式分发事件
    match app.mode {
        AppMode::Workspace => handle_workspace_key(app, key),
        AppMode::Project => handle_project_key(app, key),
    }
}

/// 处理 Workspace 模式的键盘事件
fn handle_workspace_key(app: &mut App, key: KeyEvent) {
    // 搜索模式
    if app.workspace.search_mode {
        handle_workspace_search_key(app, key);
        return;
    }

    match key.code {
        // 退出
        KeyCode::Char('q') => app.quit(),

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            app.workspace.select_next();
        }

        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.workspace.select_previous();
        }

        // Tab - 展开/折叠详情
        KeyCode::Tab => {
            app.workspace.toggle_expand();
        }

        // Enter - 进入项目
        KeyCode::Enter => {
            if let Some(project) = app.workspace.selected_project() {
                let path = project.path.clone();
                app.enter_project(&path);
            }
        }

        // 功能按键 - 添加项目
        KeyCode::Char('a') => {
            app.open_add_project_dialog();
        }

        // 功能按键 - 删除项目
        KeyCode::Char('x') => {
            if app.workspace.selected_project().is_some() {
                app.open_delete_project_dialog();
            }
        }

        // 功能按键 - 搜索
        KeyCode::Char('/') => {
            app.workspace.enter_search_mode();
        }

        // 功能按键 - Theme 选择器
        KeyCode::Char('T') | KeyCode::Char('t') => {
            app.open_theme_selector();
        }

        // 功能按键 - 帮助
        KeyCode::Char('?') => {
            app.show_help = true;
        }

        // 功能按键 - 刷新
        KeyCode::Char('r') | KeyCode::Char('R') => {
            app.refresh();
        }

        _ => {}
    }
}

/// 处理 Workspace 搜索模式的键盘事件
fn handle_workspace_search_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 退出搜索
        KeyCode::Enter => {
            app.workspace.exit_search_mode();
        }

        // 取消搜索
        KeyCode::Esc => {
            app.workspace.clear_search();
        }

        // 导航
        KeyCode::Down => {
            app.workspace.select_next();
        }
        KeyCode::Up => {
            app.workspace.select_previous();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.workspace.search_pop();
        }

        // 输入字符
        KeyCode::Char(c) => {
            app.workspace.search_push(c);
        }

        _ => {}
    }
}

/// 处理 Project 模式的键盘事件
fn handle_project_key(app: &mut App, key: KeyEvent) {
    // 搜索模式
    if app.project.search_mode {
        handle_search_mode_key(app, key);
        return;
    }

    match key.code {
        // 退出
        KeyCode::Char('q') => app.quit(),

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            app.project.select_next();
        }

        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.project.select_previous();
        }

        // Tab 切换
        KeyCode::Tab => {
            app.project.next_tab();
        }

        // 数字快捷键切换 Tab
        KeyCode::Char('1') => {
            app.project.current_tab = ProjectTab::Current;
        }
        KeyCode::Char('2') => {
            app.project.current_tab = ProjectTab::Other;
        }
        KeyCode::Char('3') => {
            app.project.current_tab = ProjectTab::Archived;
        }

        // 功能按键 - New Task
        KeyCode::Char('n') => {
            app.open_new_task_dialog();
        }

        // 功能按键 - Enter (进入 worktree)
        KeyCode::Enter => {
            if app.project.current_tab != ProjectTab::Archived {
                app.enter_worktree();
            }
        }

        // 功能按键 - Recover (仅 Archived Tab) / Refresh (其他 Tab)
        KeyCode::Char('r') | KeyCode::Char('R') => {
            if app.project.current_tab == ProjectTab::Archived {
                app.start_recover();
            } else {
                app.refresh();
            }
        }

        // 功能按键 - Clean (仅 Archived Tab)
        KeyCode::Char('x') => {
            if app.project.current_tab == ProjectTab::Archived {
                app.start_clean();
            }
        }

        // 功能按键 - Theme 选择器
        KeyCode::Char('T') | KeyCode::Char('t') => {
            app.open_theme_selector();
        }

        // 功能按键 - 搜索
        KeyCode::Char('/') => {
            app.project.enter_search_mode();
        }

        // 功能按键 - 帮助
        KeyCode::Char('?') => {
            app.show_help = true;
        }

        // 功能按键 - 返回 Workspace
        KeyCode::Esc => {
            app.back_to_workspace();
        }

        // 功能按键 - Action Palette (非 Archived Tab)
        KeyCode::Char(' ') => {
            if app.project.current_tab != ProjectTab::Archived {
                app.open_action_palette();
            }
        }

        // 功能按键 - Hook 配置面板
        KeyCode::Char('h') => {
            app.open_hook_panel();
        }

        _ => {}
    }
}

/// 处理 Action Palette 的键盘事件
fn handle_action_palette_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.action_palette_prev();
        }

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            app.action_palette_next();
        }

        // 确认
        KeyCode::Enter => {
            app.action_palette_confirm();
        }

        // 取消
        KeyCode::Esc => {
            app.action_palette_cancel();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.action_palette_backspace();
        }

        // 输入字符（非 j/k）
        KeyCode::Char(c) if c != 'j' && c != 'k' => {
            app.action_palette_char(c);
        }

        _ => {}
    }
}

/// 处理分支选择器
fn handle_branch_selector_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.branch_selector_prev();
        }

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            app.branch_selector_next();
        }

        // 确认选择
        KeyCode::Enter => {
            app.branch_selector_confirm();
        }

        // 取消
        KeyCode::Esc => {
            app.branch_selector_cancel();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.branch_selector_backspace();
        }

        // 输入字符（搜索）
        KeyCode::Char(c) => {
            app.branch_selector_char(c);
        }

        _ => {}
    }
}

/// 处理确认弹窗（弱确认）
fn handle_confirm_dialog_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 确认
        KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
            app.confirm_dialog_yes();
        }

        // 取消
        KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
            app.confirm_dialog_cancel();
        }

        _ => {}
    }
}

/// 处理输入确认弹窗（强确认）
fn handle_input_confirm_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 确认
        KeyCode::Enter => {
            app.input_confirm_submit();
        }

        // 取消
        KeyCode::Esc => {
            app.input_confirm_cancel();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.input_confirm_backspace();
        }

        // 输入字符
        KeyCode::Char(c) => {
            app.input_confirm_char(c);
        }

        _ => {}
    }
}

/// 处理主题选择器的键盘事件
fn handle_theme_selector_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.theme_selector_prev();
        }

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            app.theme_selector_next();
        }

        // 确认选择
        KeyCode::Enter => {
            app.theme_selector_confirm();
        }

        // 取消
        KeyCode::Esc | KeyCode::Char('q') => {
            app.close_theme_selector();
        }

        _ => {}
    }
}

/// 处理 New Task 弹窗的键盘事件
fn handle_new_task_dialog_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 确认创建
        KeyCode::Enter => {
            app.create_new_task();
        }

        // 取消
        KeyCode::Esc => {
            app.close_new_task_dialog();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.new_task_delete_char();
        }

        // 输入字符
        KeyCode::Char(c) => {
            app.new_task_input_char(c);
        }

        _ => {}
    }
}

/// 处理搜索模式的键盘事件
fn handle_search_mode_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 退出搜索输入模式（保留过滤结果）
        KeyCode::Enter => {
            app.project.exit_search_mode();
        }

        // 取消搜索（清空过滤）
        KeyCode::Esc => {
            app.project.cancel_search();
        }

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            app.project.select_next();
        }

        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.project.select_previous();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.project.search_delete_char();
        }

        // 输入字符
        KeyCode::Char(c) => {
            app.project.search_input_char(c);
        }

        _ => {}
    }
}

/// 处理帮助面板的键盘事件
fn handle_help_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 关闭帮助面板
        KeyCode::Char('?') | KeyCode::Esc | KeyCode::Char('q') => {
            app.show_help = false;
        }
        _ => {}
    }
}

/// 处理 Merge 选择弹窗的键盘事件
fn handle_merge_dialog_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 切换选项
        KeyCode::Char('j') | KeyCode::Char('k') | KeyCode::Up | KeyCode::Down => {
            app.merge_dialog_toggle();
        }

        // 确认
        KeyCode::Enter => {
            app.merge_dialog_confirm();
        }

        // 取消
        KeyCode::Esc | KeyCode::Char('q') => {
            app.merge_dialog_cancel();
        }

        _ => {}
    }
}

/// 处理 Add Project 弹窗的键盘事件
fn handle_add_project_dialog_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 确认添加
        KeyCode::Enter => {
            app.add_project_confirm();
        }

        // 取消
        KeyCode::Esc => {
            app.close_add_project_dialog();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.add_project_delete_char();
        }

        // 输入字符
        KeyCode::Char(c) => {
            app.add_project_input_char(c);
        }

        _ => {}
    }
}

/// 处理 Delete Project 弹窗的键盘事件
fn handle_delete_project_dialog_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 切换选项
        KeyCode::Char('j') | KeyCode::Char('k') | KeyCode::Up | KeyCode::Down => {
            app.delete_project_toggle();
        }

        // 确认
        KeyCode::Enter => {
            app.delete_project_confirm();
        }

        // 取消
        KeyCode::Esc | KeyCode::Char('q') => {
            app.close_delete_project_dialog();
        }

        _ => {}
    }
}

/// 处理 Commit Dialog 的键盘事件
fn handle_commit_dialog_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // 确认提交
        KeyCode::Enter => {
            app.commit_dialog_confirm();
        }

        // 取消
        KeyCode::Esc => {
            app.commit_dialog_cancel();
        }

        // 删除字符
        KeyCode::Backspace => {
            app.commit_dialog_backspace();
        }

        // 输入字符
        KeyCode::Char(c) => {
            app.commit_dialog_char(c);
        }

        _ => {}
    }
}

/// 处理 Hook 配置面板的键盘事件
fn handle_hook_panel_key(app: &mut App, key: KeyEvent) {
    use crate::ui::components::hook_panel::HookConfigStep;

    let is_result_step = app
        .hook_panel
        .as_ref()
        .map(|p| p.step == HookConfigStep::ShowResult)
        .unwrap_or(false);

    match key.code {
        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            if !is_result_step {
                app.hook_panel_prev();
            }
        }

        // 导航 - 下移
        KeyCode::Char('j') | KeyCode::Down => {
            if !is_result_step {
                app.hook_panel_next();
            }
        }

        // 确认/关闭
        KeyCode::Enter => {
            if is_result_step {
                // 结果页面，关闭面板
                app.hook_panel = None;
            } else {
                // 其他步骤，进入下一步
                app.hook_panel_confirm();
            }
        }

        // 返回/取消
        KeyCode::Esc => {
            app.hook_panel_back();
        }

        // 复制命令（仅结果页面）
        KeyCode::Char('c') => {
            if is_result_step {
                app.hook_panel_copy();
            }
        }

        _ => {}
    }
}
