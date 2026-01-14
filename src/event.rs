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
    // 如果主题选择器打开，优先处理选择器事件
    if app.show_theme_selector {
        handle_theme_selector_key(app, key);
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
            app.show_toast("New Task - 功能开发中");
        }

        // 功能按键 - Enter
        KeyCode::Enter => {
            if app.project.current_tab == ProjectTab::Archived {
                app.show_toast("Recover - 功能开发中");
            } else {
                app.show_toast("Enter Worktree - 功能开发中");
            }
        }

        // 功能按键 - Archive
        KeyCode::Char('a') => {
            if app.project.current_tab != ProjectTab::Archived {
                app.show_toast("Archive - 功能开发中");
            }
        }

        // 功能按键 - Clean
        KeyCode::Char('x') => {
            app.show_toast("Clean - 功能开发中");
        }

        // 功能按键 - Rebase to
        KeyCode::Char('r') => {
            if app.project.current_tab != ProjectTab::Archived {
                app.show_toast("Rebase to - 功能开发中");
            }
        }

        // 功能按键 - Theme 选择器
        KeyCode::Char('T') | KeyCode::Char('t') => {
            app.open_theme_selector();
        }

        // 功能按键 - 返回
        KeyCode::Esc => {
            app.show_toast("返回 Workspace - 功能开发中");
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
