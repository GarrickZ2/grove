use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, MouseButton, MouseEventKind};

use crate::app::{App, AppMode, MonitorFocus, PreviewSubTab};
use crate::model::ProjectTab;
use crate::ui::click_areas::{contains, DialogAction};

/// 每帧最多处理的事件数（防止事件风暴阻塞渲染）
const MAX_EVENTS_PER_FRAME: usize = 64;

/// 处理事件，返回 true 表示应该继续运行
pub fn handle_events(app: &mut App) -> io::Result<bool> {
    // 更新 Toast 状态
    app.update_toast();

    // 检查系统主题变化（用于 Auto 模式）
    app.check_system_theme();

    // 首次等待事件（16ms 超时 ≈ 60fps）
    if !event::poll(Duration::from_millis(16))? {
        return Ok(!app.should_quit);
    }

    // 批量排空事件队列：合并连续滚轮，保留最后一次按键
    let mut last_key: Option<KeyEvent> = None;
    let mut scroll_v: i32 = 0; // 竖向滚轮（正=下，负=上）
    let mut scroll_h: i32 = 0; // 横向滚轮（正=右，负=左）
    let mut last_scroll_col: u16 = 0;
    let mut last_scroll_row: u16 = 0;
    let mut other_events: Vec<crossterm::event::MouseEvent> = Vec::new();

    for _ in 0..MAX_EVENTS_PER_FRAME {
        // 第一次已经 poll 过了；后续用 0ms poll 排空剩余事件
        match event::read()? {
            Event::Key(key) => {
                if key.kind == KeyEventKind::Press {
                    // 按键不合并：逐个处理以保证操作顺序
                    if let Some(prev_key) = last_key.take() {
                        handle_key(app, prev_key);
                    }
                    last_key = Some(key);
                }
            }
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::ScrollDown => {
                    scroll_v += 1;
                    last_scroll_col = mouse.column;
                    last_scroll_row = mouse.row;
                }
                MouseEventKind::ScrollUp => {
                    scroll_v -= 1;
                    last_scroll_col = mouse.column;
                    last_scroll_row = mouse.row;
                }
                MouseEventKind::ScrollRight => {
                    scroll_h += 1;
                }
                MouseEventKind::ScrollLeft => {
                    scroll_h -= 1;
                }
                _ => {
                    other_events.push(mouse);
                }
            },
            _ => {}
        }

        // 检查队列中是否还有事件（0ms = 不等待）
        if !event::poll(Duration::ZERO)? {
            break;
        }
    }

    // 处理最后一个按键
    if let Some(key) = last_key {
        handle_key(app, key);
    }

    // 处理非滚轮鼠标事件（点击等）
    for mouse in other_events {
        handle_mouse(app, mouse);
    }

    // 合并竖向滚轮
    let v_capped = scroll_v.clamp(-5, 5);
    if v_capped > 0 {
        for _ in 0..v_capped {
            handle_scroll_down(app, last_scroll_col, last_scroll_row);
        }
    } else if v_capped < 0 {
        for _ in 0..(-v_capped) {
            handle_scroll_up(app, last_scroll_col, last_scroll_row);
        }
    }

    // 合并横向滚轮（含 Shift+竖向滚轮 模拟）
    let h_capped = scroll_h.clamp(-3, 3);
    if h_capped > 0 {
        for _ in 0..h_capped {
            handle_scroll_right(app);
        }
    } else if h_capped < 0 {
        for _ in 0..(-h_capped) {
            handle_scroll_left(app);
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

    // Config Panel
    if app.config_panel.is_some() {
        handle_config_panel_key(app, key);
        return;
    }

    // 根据模式分发事件
    match app.mode {
        AppMode::Workspace => handle_workspace_key(app, key),
        AppMode::Project => handle_project_key(app, key),
        AppMode::Monitor => handle_monitor_key(app, key),
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
            app.workspace.select_down();
        }

        // 导航 - 上移
        KeyCode::Char('k') | KeyCode::Up => {
            app.workspace.select_up();
        }

        // 导航 - 左移
        KeyCode::Char('h') | KeyCode::Left => {
            app.workspace.select_left();
        }

        // 导航 - 右移
        KeyCode::Char('l') | KeyCode::Right => {
            app.workspace.select_right();
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

        // 功能按键 - Config 配置面板
        KeyCode::Char('c') => {
            app.open_config_panel();
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

        // j/k - 面板打开时滚动内容，关闭时切换任务
        KeyCode::Char('j') => {
            if app.project.preview_visible {
                match app.project.preview_sub_tab {
                    PreviewSubTab::Notes => app.project.scroll_notes_down(),
                    PreviewSubTab::Ai => app.project.scroll_ai_summary_down(),
                    PreviewSubTab::Git => app.project.scroll_git_down(),
                }
            } else {
                app.project.select_next();
            }
        }
        KeyCode::Char('k') => {
            if app.project.preview_visible {
                match app.project.preview_sub_tab {
                    PreviewSubTab::Notes => app.project.scroll_notes_up(),
                    PreviewSubTab::Ai => app.project.scroll_ai_summary_up(),
                    PreviewSubTab::Git => app.project.scroll_git_up(),
                }
            } else {
                app.project.select_previous();
            }
        }

        // Up/Down - 始终切换任务
        KeyCode::Down => app.project.select_next(),
        KeyCode::Up => app.project.select_previous(),

        // Tab - 切换预览面板
        KeyCode::Tab => {
            app.project.toggle_preview();
        }

        // 左右方向键始终切换主 Tab（Current/Other/Archived）
        KeyCode::Left => app.project.prev_tab(),
        KeyCode::Right => app.project.next_tab(),

        // 数字快捷键：面板打开时切换 sub-tab，关闭时切换主 tab
        KeyCode::Char('1') => {
            if app.project.preview_visible {
                app.project.preview_sub_tab = PreviewSubTab::Git;
            } else {
                app.project.current_tab = ProjectTab::Current;
            }
        }
        KeyCode::Char('2') => {
            if app.project.preview_visible {
                app.project.preview_sub_tab = PreviewSubTab::Ai;
            } else {
                app.project.current_tab = ProjectTab::Other;
            }
        }
        KeyCode::Char('3') => {
            if app.project.preview_visible {
                app.project.preview_sub_tab = PreviewSubTab::Notes;
            } else {
                app.project.current_tab = ProjectTab::Archived;
            }
        }

        // Notes 编辑：打开外部编辑器
        KeyCode::Char('i')
            if app.project.preview_visible
                && app.project.preview_sub_tab == PreviewSubTab::Notes =>
        {
            app.project.request_notes_edit();
        }

        // 功能按键 - New Task
        KeyCode::Char('n') => {
            app.open_new_task_dialog();
        }

        // 功能按键 - Enter
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

        // 功能按键 - Checkout (在主仓库切换分支)
        KeyCode::Char('C') => {
            app.open_checkout_selector();
        }

        // 功能按键 - Config 配置面板
        KeyCode::Char('c') => {
            app.open_config_panel();
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

/// 处理 Config 配置面板的键盘事件
fn handle_config_panel_key(app: &mut App, key: KeyEvent) {
    use crate::ui::components::config_panel::ConfigStep;
    use crate::ui::components::hook_panel::HookConfigStep;

    let step = app.config_panel.as_ref().map(|p| p.step.clone());
    let Some(step) = step else { return };

    match step {
        ConfigStep::Main => match key.code {
            KeyCode::Char('k') | KeyCode::Up => app.config_panel_prev(),
            KeyCode::Char('j') | KeyCode::Down => app.config_panel_next(),
            KeyCode::Enter => app.config_panel_confirm(),
            KeyCode::Esc => app.config_panel_back(),
            _ => {}
        },
        ConfigStep::AgentMenu => match key.code {
            KeyCode::Char('k') | KeyCode::Up => app.config_panel_prev(),
            KeyCode::Char('j') | KeyCode::Down => app.config_panel_next(),
            KeyCode::Enter => app.config_panel_confirm(),
            KeyCode::Esc => app.config_panel_back(),
            _ => {}
        },
        ConfigStep::EditAgentCommand => match key.code {
            KeyCode::Enter => app.config_panel_confirm(),
            KeyCode::Esc => app.config_panel_back(),
            KeyCode::Backspace => app.config_agent_delete_char(),
            KeyCode::Char(c) => app.config_agent_input_char(c),
            _ => {}
        },
        ConfigStep::SelectLayout => match key.code {
            KeyCode::Char('k') | KeyCode::Up => app.config_panel_prev(),
            KeyCode::Char('j') | KeyCode::Down => app.config_panel_next(),
            KeyCode::Enter => app.config_panel_confirm(),
            KeyCode::Esc => app.config_panel_back(),
            _ => {}
        },
        ConfigStep::SelectContextDocs => {
            if let Some(ref mut panel) = app.config_panel {
                if panel.context_docs_editing_custom {
                    // 编辑 custom 名称模式
                    match key.code {
                        KeyCode::Enter => {
                            // 确认输入
                            panel.context_docs_editing_custom = false;
                            if !panel.context_docs_custom_name.is_empty() {
                                panel.context_docs_custom_enabled = true;
                            }
                        }
                        KeyCode::Esc => {
                            // 取消编辑
                            panel.context_docs_editing_custom = false;
                        }
                        KeyCode::Backspace => {
                            panel.context_docs_custom_name.pop();
                        }
                        KeyCode::Char(c) => {
                            panel.context_docs_custom_name.push(c);
                        }
                        _ => {}
                    }
                } else {
                    // 正常多选模式
                    match key.code {
                        KeyCode::Char('k') | KeyCode::Up => {
                            if panel.context_docs_cursor == 0 {
                                panel.context_docs_cursor = 3;
                            } else {
                                panel.context_docs_cursor -= 1;
                            }
                        }
                        KeyCode::Char('j') | KeyCode::Down => {
                            panel.context_docs_cursor = (panel.context_docs_cursor + 1) % 4;
                        }
                        KeyCode::Char(' ') => {
                            let idx = panel.context_docs_cursor;
                            if idx < 3 {
                                // 预设项 toggle
                                panel.context_docs_selected[idx] =
                                    !panel.context_docs_selected[idx];
                            } else {
                                // Custom 项
                                if panel.context_docs_custom_enabled
                                    && !panel.context_docs_custom_name.is_empty()
                                {
                                    // 已有 custom: toggle enabled
                                    panel.context_docs_custom_enabled =
                                        !panel.context_docs_custom_enabled;
                                } else {
                                    // 无 custom 名称: 进入编辑模式
                                    panel.context_docs_editing_custom = true;
                                    panel.context_docs_custom_name.clear();
                                }
                            }
                        }
                        KeyCode::Enter => {
                            app.config_save_context_docs();
                        }
                        KeyCode::Esc => {
                            panel.step = ConfigStep::AgentMenu;
                        }
                        _ => {}
                    }
                }
            }
        }
        ConfigStep::HookWizard => {
            let is_result = app
                .config_panel
                .as_ref()
                .map(|p| p.hook_data.step == HookConfigStep::ShowResult)
                .unwrap_or(false);

            match key.code {
                KeyCode::Char('k') | KeyCode::Up => {
                    if !is_result {
                        app.config_panel_prev();
                    }
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    if !is_result {
                        app.config_panel_next();
                    }
                }
                KeyCode::Enter => app.config_panel_confirm(),
                KeyCode::Esc => app.config_panel_back(),
                KeyCode::Char('c') => {
                    if is_result {
                        app.config_hook_copy();
                    }
                }
                _ => {}
            }
        }
    }
}

/// 处理 Monitor 模式的键盘事件
fn handle_monitor_key(app: &mut App, key: KeyEvent) {
    match key.code {
        // Tab: 展开/折叠 sidebar
        KeyCode::Tab => app.monitor.toggle_sidebar(),

        // h/l/←/→: 切换焦点（折叠时先展开）
        KeyCode::Char('h') | KeyCode::Char('l') | KeyCode::Left | KeyCode::Right => {
            app.monitor.toggle_focus()
        }

        // 数字键切换 content tab
        KeyCode::Char('1') => app.monitor.content_tab = PreviewSubTab::Git,
        KeyCode::Char('2') => app.monitor.content_tab = PreviewSubTab::Ai,
        KeyCode::Char('3') => app.monitor.content_tab = PreviewSubTab::Notes,

        // j/k/↑/↓ 行为取决于焦点
        KeyCode::Char('j') | KeyCode::Down => match app.monitor.focus {
            MonitorFocus::Sidebar => app.monitor.action_next(),
            MonitorFocus::Content => app.monitor.scroll_down(),
        },
        KeyCode::Char('k') | KeyCode::Up => match app.monitor.focus {
            MonitorFocus::Sidebar => app.monitor.action_prev(),
            MonitorFocus::Content => app.monitor.scroll_up(),
        },

        // 操作执行（Sidebar 焦点时）
        KeyCode::Enter if app.monitor.focus == MonitorFocus::Sidebar => {
            app.monitor_execute_action();
        }

        // Notes 编辑（Content 焦点 + Notes tab）
        KeyCode::Char('i')
            if app.monitor.focus == MonitorFocus::Content
                && app.monitor.content_tab == PreviewSubTab::Notes =>
        {
            app.monitor.request_notes_edit();
        }

        // 刷新
        KeyCode::Char('r') | KeyCode::Char('R') => app.monitor.refresh_panel_data(),

        // 主题
        KeyCode::Char('T') | KeyCode::Char('t') => app.open_theme_selector(),

        // 帮助
        KeyCode::Char('?') => app.show_help = !app.show_help,

        // 退出
        KeyCode::Char('q') => app.quit(),

        _ => {}
    }
}

// ─── 鼠标事件处理 ───

fn handle_mouse(app: &mut App, mouse: crossterm::event::MouseEvent) {
    let col = mouse.column;
    let row = mouse.row;

    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            handle_left_click(app, col, row);
        }
        MouseEventKind::ScrollDown => {
            handle_scroll_down(app, col, row);
        }
        MouseEventKind::ScrollUp => {
            handle_scroll_up(app, col, row);
        }
        MouseEventKind::ScrollRight => {
            handle_scroll_right(app);
        }
        MouseEventKind::ScrollLeft => {
            handle_scroll_left(app);
        }
        _ => {}
    }
}

fn has_active_popup(app: &App) -> bool {
    app.show_help
        || app.merge_dialog.is_some()
        || app.branch_selector.is_some()
        || app.input_confirm_dialog.is_some()
        || app.confirm_dialog.is_some()
        || app.show_new_task_dialog
        || app.show_theme_selector
        || app.add_project_dialog.is_some()
        || app.delete_project_dialog.is_some()
        || app.action_palette.is_some()
        || app.commit_dialog.is_some()
        || app.config_panel.is_some()
}

fn handle_left_click(app: &mut App, col: u16, row: u16) {
    let is_double = app.is_double_click(col, row);
    app.record_click(col, row);

    // 弹窗优先：有弹窗时消费点击（帮助面板点击关闭）
    if app.show_help {
        app.show_help = false;
        return;
    }
    if has_active_popup(app) {
        handle_popup_click(app, col, row);
        return;
    }

    match app.mode {
        AppMode::Workspace => handle_workspace_click(app, col, row, is_double),
        AppMode::Project => handle_project_click(app, col, row, is_double),
        AppMode::Monitor => handle_monitor_click(app, col, row),
    }
}

fn handle_workspace_click(app: &mut App, col: u16, row: u16, is_double: bool) {
    // 检查卡片点击
    let clicked = app
        .click_areas
        .workspace_cards
        .iter()
        .find(|(rect, _)| contains(rect, col, row))
        .map(|(_, idx)| *idx);

    if let Some(idx) = clicked {
        app.workspace.selected_index = Some(idx);
        if is_double {
            if let Some(project) = app.workspace.selected_project() {
                let path = project.path.clone();
                app.enter_project(&path);
            }
        }
    }
}

fn handle_project_click(app: &mut App, col: u16, row: u16, is_double: bool) {
    // 检查 header 区域（点击返回 Workspace）
    if let Some(area) = app.click_areas.project_header_area {
        if contains(&area, col, row) {
            app.back_to_workspace();
            return;
        }
    }

    // 检查 project tabs
    let clicked_tab = app
        .click_areas
        .project_tabs
        .iter()
        .find(|(rect, _)| contains(rect, col, row))
        .map(|(_, tab)| *tab);

    if let Some(tab) = clicked_tab {
        app.project.switch_to_tab(tab);
        return;
    }

    // 检查 preview sub-tabs
    let clicked_sub = app
        .click_areas
        .preview_sub_tabs
        .iter()
        .find(|(rect, _)| contains(rect, col, row))
        .map(|(_, sub)| *sub);

    if let Some(sub_tab) = clicked_sub {
        app.project.preview_sub_tab = sub_tab;
        return;
    }

    // 检查 worktree 行
    let clicked_row = app
        .click_areas
        .worktree_rows
        .iter()
        .find(|(rect, _)| contains(rect, col, row))
        .map(|(_, idx)| *idx);

    if let Some(idx) = clicked_row {
        app.project.current_list_state_mut().select(Some(idx));
        if app.project.preview_visible {
            app.project.refresh_panel_data();
        }
        if is_double && app.project.current_tab != ProjectTab::Archived {
            app.enter_worktree();
        }
    }
}

fn handle_monitor_click(app: &mut App, col: u16, row: u16) {
    use crate::app::MonitorFocus;

    // 检查 action 按钮点击
    let clicked_action = app
        .click_areas
        .monitor_actions
        .iter()
        .find(|(rect, _)| contains(rect, col, row))
        .map(|(_, idx)| *idx);

    if let Some(idx) = clicked_action {
        app.monitor.focus = MonitorFocus::Sidebar;
        app.monitor.action_selected = idx;
        app.monitor_execute_action();
        return;
    }

    // 检查 tab bar 点击
    let clicked_tab = app
        .click_areas
        .monitor_tabs
        .iter()
        .find(|(rect, _)| contains(rect, col, row))
        .map(|(_, tab)| *tab);

    if let Some(tab) = clicked_tab {
        app.monitor.focus = MonitorFocus::Content;
        app.monitor.content_tab = tab;
        return;
    }

    // 点击 sidebar 区域
    if let Some(area) = app.click_areas.monitor_sidebar_area {
        if contains(&area, col, row) {
            if app.monitor.sidebar_collapsed {
                // 折叠时点击展开
                app.monitor.toggle_sidebar();
            } else {
                app.monitor.focus = MonitorFocus::Sidebar;
            }
            return;
        }
    }

    // 点击 content 区域 → 切换焦点到 content
    if let Some(area) = app.click_areas.monitor_content_area {
        if contains(&area, col, row) {
            app.monitor.focus = MonitorFocus::Content;
        }
    }
}

fn handle_scroll_down(app: &mut App, col: u16, row: u16) {
    if has_active_popup(app) {
        if app.show_theme_selector {
            app.theme_selector_next();
        } else if app.action_palette.is_some() {
            app.action_palette_next();
        } else if app.branch_selector.is_some() {
            app.branch_selector_next();
        } else if app.config_panel.is_some() {
            app.config_panel_next();
        }
        return;
    }

    match app.mode {
        AppMode::Monitor => {
            app.monitor.scroll_down();
        }
        AppMode::Workspace => {
            if let Some(area) = app.click_areas.workspace_content_area {
                if contains(&area, col, row) {
                    app.workspace.select_down();
                }
            }
        }
        AppMode::Project => {
            // 优先检查 preview 区域
            if let Some(area) = app.click_areas.preview_content_area {
                if contains(&area, col, row) {
                    match app.project.preview_sub_tab {
                        PreviewSubTab::Notes => app.project.scroll_notes_down(),
                        PreviewSubTab::Ai => app.project.scroll_ai_summary_down(),
                        PreviewSubTab::Git => app.project.scroll_git_down(),
                    }
                    return;
                }
            }
            if let Some(area) = app.click_areas.worktree_list_area {
                if contains(&area, col, row) {
                    app.project.select_next();
                }
            }
        }
    }
}

fn handle_scroll_up(app: &mut App, col: u16, row: u16) {
    if has_active_popup(app) {
        if app.show_theme_selector {
            app.theme_selector_prev();
        } else if app.action_palette.is_some() {
            app.action_palette_prev();
        } else if app.branch_selector.is_some() {
            app.branch_selector_prev();
        } else if app.config_panel.is_some() {
            app.config_panel_prev();
        }
        return;
    }

    match app.mode {
        AppMode::Monitor => {
            app.monitor.scroll_up();
        }
        AppMode::Workspace => {
            if let Some(area) = app.click_areas.workspace_content_area {
                if contains(&area, col, row) {
                    app.workspace.select_up();
                }
            }
        }
        AppMode::Project => {
            if let Some(area) = app.click_areas.preview_content_area {
                if contains(&area, col, row) {
                    match app.project.preview_sub_tab {
                        PreviewSubTab::Notes => app.project.scroll_notes_up(),
                        PreviewSubTab::Ai => app.project.scroll_ai_summary_up(),
                        PreviewSubTab::Git => app.project.scroll_git_up(),
                    }
                    return;
                }
            }
            if let Some(area) = app.click_areas.worktree_list_area {
                if contains(&area, col, row) {
                    app.project.select_previous();
                }
            }
        }
    }
}

fn handle_scroll_right(app: &mut App) {
    if has_active_popup(app) {
        return;
    }
    match app.mode {
        AppMode::Workspace => app.workspace.select_right(),
        AppMode::Project => app.project.next_tab(),
        AppMode::Monitor => {}
    }
}

fn handle_scroll_left(app: &mut App) {
    if has_active_popup(app) {
        return;
    }
    match app.mode {
        AppMode::Workspace => app.workspace.select_left(),
        AppMode::Project => app.project.prev_tab(),
        AppMode::Monitor => {}
    }
}

// ─── 弹窗鼠标点击处理 ───

fn handle_popup_click(app: &mut App, col: u16, row: u16) {
    // 1. 检查是否在弹窗外 → 不处理（消费事件）
    if let Some(dialog_rect) = app.click_areas.dialog_area {
        if !contains(&dialog_rect, col, row) {
            return;
        }
    }

    // 2. 检查按钮点击
    let clicked_btn = app
        .click_areas
        .dialog_buttons
        .iter()
        .find(|(r, _)| contains(r, col, row))
        .map(|(_, a)| *a);
    if let Some(action) = clicked_btn {
        match action {
            DialogAction::Confirm => popup_confirm(app),
            DialogAction::Cancel => popup_cancel(app),
        }
        return;
    }

    // 3. 检查列表/选项项点击
    let clicked_item = app
        .click_areas
        .dialog_items
        .iter()
        .find(|(r, _)| contains(r, col, row))
        .map(|(_, idx)| *idx);
    if let Some(idx) = clicked_item {
        popup_select_item(app, idx);
    }
}

fn popup_confirm(app: &mut App) {
    if app.confirm_dialog.is_some() {
        app.confirm_dialog_yes();
    } else if app.merge_dialog.is_some() {
        app.merge_dialog_confirm();
    } else if app.input_confirm_dialog.is_some() {
        app.input_confirm_submit();
    } else if app.show_new_task_dialog {
        app.create_new_task();
    } else if app.add_project_dialog.is_some() {
        app.add_project_confirm();
    } else if app.delete_project_dialog.is_some() {
        app.delete_project_confirm();
    } else if app.show_theme_selector {
        app.theme_selector_confirm();
    } else if app.action_palette.is_some() {
        app.action_palette_confirm();
    } else if app.branch_selector.is_some() {
        app.branch_selector_confirm();
    } else if app.commit_dialog.is_some() {
        app.commit_dialog_confirm();
    } else if app.config_panel.is_some() {
        app.config_panel_confirm();
    }
}

fn popup_cancel(app: &mut App) {
    if app.confirm_dialog.is_some() {
        app.confirm_dialog_cancel();
    } else if app.merge_dialog.is_some() {
        app.merge_dialog_cancel();
    } else if app.input_confirm_dialog.is_some() {
        app.input_confirm_cancel();
    } else if app.show_new_task_dialog {
        app.close_new_task_dialog();
    } else if app.add_project_dialog.is_some() {
        app.close_add_project_dialog();
    } else if app.delete_project_dialog.is_some() {
        app.close_delete_project_dialog();
    } else if app.show_theme_selector {
        app.close_theme_selector();
    } else if app.action_palette.is_some() {
        app.action_palette_cancel();
    } else if app.branch_selector.is_some() {
        app.branch_selector_cancel();
    } else if app.commit_dialog.is_some() {
        app.commit_dialog_cancel();
    } else if app.config_panel.is_some() {
        app.config_panel_back();
    }
}

fn popup_select_item(app: &mut App, idx: usize) {
    use crate::ui::components::config_panel::ConfigStep;
    use crate::ui::components::delete_project_dialog::DeleteMode;
    use crate::ui::components::merge_dialog::MergeMethod;

    // Merge dialog: 设置选中的合并方式
    if let Some(ref mut d) = app.merge_dialog {
        d.selected = if idx == 0 {
            MergeMethod::Squash
        } else {
            MergeMethod::MergeCommit
        };
    }
    // Delete project dialog: 设置删除模式
    else if let Some(ref mut d) = app.delete_project_dialog {
        d.selected = if idx == 0 {
            DeleteMode::CleanOnly
        } else {
            DeleteMode::FullClean
        };
    }
    // Theme selector: 设置选中索引
    else if app.show_theme_selector {
        app.theme_selector_index = idx;
    }
    // Action palette: 设置选中索引
    else if let Some(ref mut d) = app.action_palette {
        d.selected_index = idx;
    }
    // Branch selector: 设置选中索引
    else if let Some(ref mut d) = app.branch_selector {
        d.selected_index = idx;
    }
    // Config panel: 根据当前 step 设置对应光标
    else if let Some(ref mut d) = app.config_panel {
        match d.step {
            ConfigStep::Main => d.main_selected = idx,
            ConfigStep::AgentMenu => d.agent_menu_selected = idx,
            ConfigStep::SelectLayout => d.layout_selected = idx,
            ConfigStep::SelectContextDocs => {
                // 点击 = toggle（等同于 Space 键）
                if idx < 3 {
                    d.context_docs_cursor = idx;
                    d.context_docs_selected[idx] = !d.context_docs_selected[idx];
                } else if idx == 3 {
                    d.context_docs_cursor = 3;
                    if d.context_docs_custom_enabled && !d.context_docs_custom_name.is_empty() {
                        d.context_docs_custom_enabled = !d.context_docs_custom_enabled;
                    } else {
                        d.context_docs_editing_custom = true;
                        d.context_docs_custom_name.clear();
                    }
                }
            }
            ConfigStep::HookWizard => d.hook_data.selected_index = idx,
            _ => {}
        }
    }
}
