use std::path::Path;
use std::time::{Duration, Instant};

use chrono::Utc;
use ratatui::widgets::ListState;

use crate::git;
use crate::model::{loader, ProjectTab, Worktree, WorktreeStatus};
use crate::storage::{self, tasks::{self, Task, TaskStatus}};
use crate::theme::{detect_system_theme, get_theme_colors, Theme, ThemeColors};
use crate::tmux;

/// Toast 消息
#[derive(Debug, Clone)]
pub struct Toast {
    pub message: String,
    pub expires_at: Instant,
}

impl Toast {
    pub fn new(message: impl Into<String>, duration: Duration) -> Self {
        Self {
            message: message.into(),
            expires_at: Instant::now() + duration,
        }
    }

    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

/// Project 页面状态
pub struct ProjectState {
    /// 当前选中的 Tab
    pub current_tab: ProjectTab,
    /// 列表选择状态（每个 Tab 独立维护）
    pub list_states: [ListState; 3], // Current, Other, Archived
    /// 各 Tab 的 Worktree 列表
    pub worktrees: [Vec<Worktree>; 3],
    /// 项目路径
    pub project_path: String,
    /// 项目名称
    pub project_name: String,
}

impl ProjectState {
    pub fn new(project_path: &str) -> Self {
        // 从 Task 元数据加载真实数据
        let (current, other, archived) = loader::load_worktrees(project_path);

        let mut current_state = ListState::default();
        if !current.is_empty() {
            current_state.select(Some(0));
        }

        let mut other_state = ListState::default();
        if !other.is_empty() {
            other_state.select(Some(0));
        }

        let mut archived_state = ListState::default();
        if !archived.is_empty() {
            archived_state.select(Some(0));
        }

        // 获取项目名称
        let project_name = Path::new(project_path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        Self {
            current_tab: ProjectTab::Current,
            list_states: [current_state, other_state, archived_state],
            worktrees: [current, other, archived],
            project_path: project_path.to_string(),
            project_name,
        }
    }

    /// 刷新数据
    pub fn refresh(&mut self) {
        let (current, other, archived) = loader::load_worktrees(&self.project_path);
        self.worktrees = [current, other, archived];
        self.ensure_selection();
    }

    /// 获取当前 Tab 的 worktree 列表
    pub fn current_worktrees(&self) -> &Vec<Worktree> {
        &self.worktrees[self.current_tab.index()]
    }

    /// 获取当前 Tab 的列表状态（可变）
    pub fn current_list_state_mut(&mut self) -> &mut ListState {
        &mut self.list_states[self.current_tab.index()]
    }

    /// 获取当前 Tab 的列表状态（不可变）
    pub fn current_list_state(&self) -> &ListState {
        &self.list_states[self.current_tab.index()]
    }

    /// 总 worktree 数量
    pub fn total_worktrees(&self) -> usize {
        self.worktrees.iter().map(|w| w.len()).sum()
    }

    /// 切换到下一个 Tab
    pub fn next_tab(&mut self) {
        self.current_tab = self.current_tab.next();
        self.ensure_selection();
    }

    /// 确保当前 Tab 有选中项
    pub fn ensure_selection(&mut self) {
        let list_len = self.current_worktrees().len();
        let state = self.current_list_state_mut();

        if list_len > 0 && state.selected().is_none() {
            state.select(Some(0));
        }
    }

    /// 选中下一项
    pub fn select_next(&mut self) {
        let list_len = self.current_worktrees().len();
        if list_len == 0 {
            return;
        }

        let state = self.current_list_state_mut();
        let current = state.selected().unwrap_or(0);
        let next = (current + 1) % list_len;
        state.select(Some(next));
    }

    /// 选中上一项
    pub fn select_previous(&mut self) {
        let list_len = self.current_worktrees().len();
        if list_len == 0 {
            return;
        }

        let state = self.current_list_state_mut();
        let current = state.selected().unwrap_or(0);
        let prev = if current == 0 {
            list_len - 1
        } else {
            current - 1
        };
        state.select(Some(prev));
    }
}

impl Default for ProjectState {
    fn default() -> Self {
        let project_path = git::repo_root(".").unwrap_or_else(|_| ".".to_string());
        Self::new(&project_path)
    }
}

/// 全局应用状态
pub struct App {
    /// 是否应该退出
    pub should_quit: bool,
    /// Project 页面状态
    pub project: ProjectState,
    /// Toast 提示
    pub toast: Option<Toast>,
    /// 当前主题
    pub theme: Theme,
    /// 当前颜色方案
    pub colors: ThemeColors,
    /// 是否显示主题选择器
    pub show_theme_selector: bool,
    /// 主题选择器当前选中索引
    pub theme_selector_index: usize,
    /// 上次检测到的系统主题（用于 Auto 模式检测变化）
    last_system_dark: bool,
    /// 是否显示 New Task 弹窗
    pub show_new_task_dialog: bool,
    /// New Task 输入内容
    pub new_task_input: String,
    /// 当前目标分支 (用于显示 "from {branch}")
    pub target_branch: String,
    /// 待 attach 的 tmux session (暂停 TUI 后执行，完成后恢复 TUI)
    pub pending_tmux_attach: Option<String>,
}

impl App {
    pub fn new() -> Self {
        let theme = Theme::Auto;
        let last_system_dark = detect_system_theme();
        let colors = get_theme_colors(theme);

        // 获取项目路径
        let project_path = git::repo_root(".").unwrap_or_else(|_| ".".to_string());

        // 尝试获取当前分支
        let target_branch = git::current_branch(&project_path)
            .unwrap_or_else(|_| "main".to_string());

        Self {
            should_quit: false,
            project: ProjectState::new(&project_path),
            toast: None,
            theme,
            colors,
            show_theme_selector: false,
            theme_selector_index: 0,
            last_system_dark,
            show_new_task_dialog: false,
            new_task_input: String::new(),
            target_branch,
            pending_tmux_attach: None,
        }
    }

    /// 打开主题选择器
    pub fn open_theme_selector(&mut self) {
        // 找到当前主题在列表中的索引
        let themes = Theme::all();
        self.theme_selector_index = themes
            .iter()
            .position(|t| *t == self.theme)
            .unwrap_or(0);
        self.show_theme_selector = true;
    }

    /// 关闭主题选择器
    pub fn close_theme_selector(&mut self) {
        self.show_theme_selector = false;
    }

    /// 主题选择器 - 选择上一个
    pub fn theme_selector_prev(&mut self) {
        let len = Theme::all().len();
        self.theme_selector_index = if self.theme_selector_index == 0 {
            len - 1
        } else {
            self.theme_selector_index - 1
        };
        // 实时预览
        self.apply_theme_at_index(self.theme_selector_index);
    }

    /// 主题选择器 - 选择下一个
    pub fn theme_selector_next(&mut self) {
        let len = Theme::all().len();
        self.theme_selector_index = (self.theme_selector_index + 1) % len;
        // 实时预览
        self.apply_theme_at_index(self.theme_selector_index);
    }

    /// 主题选择器 - 确认选择
    pub fn theme_selector_confirm(&mut self) {
        self.apply_theme_at_index(self.theme_selector_index);
        self.show_theme_selector = false;
        self.show_toast(format!("Theme: {}", self.theme.label()));
    }

    /// 应用指定索引的主题
    fn apply_theme_at_index(&mut self, index: usize) {
        if let Some(theme) = Theme::all().get(index) {
            self.theme = *theme;
            self.colors = get_theme_colors(*theme);
        }
    }

    /// 切换到下一个主题（快捷方式）
    pub fn cycle_theme(&mut self) {
        self.theme = self.theme.next();
        self.colors = get_theme_colors(self.theme);
        self.show_toast(format!("Theme: {}", self.theme.label()));
    }

    // ========== New Task Dialog ==========

    /// 打开 New Task 弹窗
    pub fn open_new_task_dialog(&mut self) {
        // 刷新目标分支
        if let Ok(branch) = git::current_branch(".") {
            self.target_branch = branch;
        }
        self.new_task_input.clear();
        self.show_new_task_dialog = true;
    }

    /// 关闭 New Task 弹窗
    pub fn close_new_task_dialog(&mut self) {
        self.show_new_task_dialog = false;
        self.new_task_input.clear();
    }

    /// New Task 输入字符
    pub fn new_task_input_char(&mut self, c: char) {
        self.new_task_input.push(c);
    }

    /// New Task 删除字符
    pub fn new_task_delete_char(&mut self) {
        self.new_task_input.pop();
    }

    /// 创建新任务
    pub fn create_new_task(&mut self) {
        let name = self.new_task_input.trim().to_string();
        if name.is_empty() {
            self.show_toast("Task name cannot be empty");
            return;
        }

        // 1. 获取项目信息
        let repo_root = match git::repo_root(".") {
            Ok(root) => root,
            Err(e) => {
                self.show_toast(format!("Not a git repo: {}", e));
                self.close_new_task_dialog();
                return;
            }
        };

        let project_name = Path::new(&repo_root)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // 2. 生成标识符
        let slug = tasks::to_slug(&name);
        let branch = tasks::generate_branch_name(&name);

        // 3. 计算路径
        let worktree_path = match storage::ensure_worktree_dir(&project_name) {
            Ok(dir) => dir.join(&slug),
            Err(e) => {
                self.show_toast(format!("Failed to create dir: {}", e));
                self.close_new_task_dialog();
                return;
            }
        };

        // 4. 创建 git worktree
        if let Err(e) = git::create_worktree(
            &repo_root,
            &branch,
            &worktree_path,
            &self.target_branch,
        ) {
            self.show_toast(format!("Git error: {}", e));
            self.close_new_task_dialog();
            return;
        }

        // 5. 保存 task 元数据
        let task = Task {
            id: slug.clone(),
            name: name.clone(),
            branch: branch.clone(),
            target: self.target_branch.clone(),
            worktree_path: worktree_path.to_string_lossy().to_string(),
            created_at: Utc::now(),
            status: TaskStatus::Active,
        };

        if let Err(e) = tasks::add_task(&project_name, task) {
            // 只是警告，worktree 已创建
            eprintln!("Warning: Failed to save task: {}", e);
        }

        // 6. 创建 tmux session
        let session = tmux::session_name(&project_name, &slug);
        if let Err(e) = tmux::create_session(&session, worktree_path.to_str().unwrap_or(".")) {
            self.show_toast(format!("tmux error: {}", e));
            self.close_new_task_dialog();
            return;
        }

        // 7. 关闭弹窗，设置待 attach 的 session
        self.close_new_task_dialog();
        self.show_toast(format!("Created: {}", name));

        // 8. 标记需要 attach（主循环会暂停 TUI，attach 完成后恢复）
        self.pending_tmux_attach = Some(session);
    }

    /// 进入当前选中的 worktree (attach tmux session)
    pub fn enter_worktree(&mut self) {
        // 1. 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        // 2. 检查状态 - Broken 不能进入
        if wt.status == WorktreeStatus::Broken {
            self.show_toast("Worktree broken - please fix or delete");
            return;
        }

        // 3. 获取 session 名称
        let slug = slug_from_path(&wt.path);
        let session = tmux::session_name(&self.project.project_name, &slug);

        // 4. 如果 session 不存在，创建它
        if !tmux::session_exists(&session) {
            if let Err(e) = tmux::create_session(&session, &wt.path) {
                self.show_toast(format!("tmux error: {}", e));
                return;
            }
        }

        // 5. 设置 pending attach（主循环会暂停 TUI，attach 完成后恢复）
        self.pending_tmux_attach = Some(session);
    }

    /// 显示 Toast 消息
    pub fn show_toast(&mut self, message: impl Into<String>) {
        self.toast = Some(Toast::new(message, Duration::from_secs(2)));
    }

    /// 更新 Toast 状态（清理过期的 Toast）
    pub fn update_toast(&mut self) {
        if let Some(ref toast) = self.toast {
            if toast.is_expired() {
                self.toast = None;
            }
        }
    }

    /// 检查系统主题变化（用于 Auto 模式）
    pub fn check_system_theme(&mut self) {
        // 只在 Auto 模式下检查
        if self.theme != Theme::Auto {
            return;
        }

        let current_dark = detect_system_theme();
        if current_dark != self.last_system_dark {
            self.last_system_dark = current_dark;
            self.colors = get_theme_colors(Theme::Auto);
        }
    }

    /// 退出应用
    pub fn quit(&mut self) {
        self.should_quit = true;
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

/// 从 worktree 路径提取 task slug
/// ~/.grove/worktrees/project/oauth-login -> oauth-login
fn slug_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}
