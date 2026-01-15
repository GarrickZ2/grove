use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind};

use crate::app::App;
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

        // 功能按键 - Archive
        KeyCode::Char('a') => {
            if app.project.current_tab != ProjectTab::Archived {
                app.start_archive();
            }
        }

        // 功能按键 - Clean
        KeyCode::Char('x') => {
            app.start_clean();
        }

        // 功能按键 - Rebase to / Recover
        KeyCode::Char('r') => {
            if app.project.current_tab == ProjectTab::Archived {
                app.start_recover();
            } else {
                app.open_branch_selector();
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

        // 功能按键 - 返回
        KeyCode::Esc => {
            app.show_toast("返回 Workspace - 功能开发中");
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
