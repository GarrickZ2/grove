use std::path::Path;
use std::time::{Duration, Instant};

use chrono::Utc;
use ratatui::widgets::ListState;

use crate::git;
use crate::model::{loader, ProjectTab, Worktree, WorktreeStatus, WorkspaceState};
use crate::ui::components::add_project_dialog::AddProjectData;
use crate::ui::components::branch_selector::BranchSelectorData;
use crate::ui::components::confirm_dialog::ConfirmType;
use crate::ui::components::delete_project_dialog::{DeleteProjectData, DeleteMode};
use crate::ui::components::input_confirm_dialog::InputConfirmData;
use crate::ui::components::merge_dialog::{MergeDialogData, MergeMethod};
use crate::storage::{self, tasks::{self, Task, TaskStatus}, workspace::project_hash};
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
    /// 项目 key（路径的 hash，用于存储）
    pub project_key: String,
    /// 是否处于搜索模式
    pub search_mode: bool,
    /// 搜索输入
    pub search_query: String,
    /// 每个 Tab 的过滤索引 [Current, Other, Archived]
    filtered_indices: [Vec<usize>; 3],
}

impl ProjectState {
    pub fn new(project_path: &str) -> Self {
        // 计算项目 key (路径的 hash)
        let project_key = project_hash(project_path);

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

        // 初始化过滤索引（全部显示）
        let current_indices: Vec<usize> = (0..current.len()).collect();
        let other_indices: Vec<usize> = (0..other.len()).collect();
        let archived_indices: Vec<usize> = (0..archived.len()).collect();

        Self {
            current_tab: ProjectTab::Current,
            list_states: [current_state, other_state, archived_state],
            worktrees: [current, other, archived],
            project_path: project_path.to_string(),
            project_key,
            search_mode: false,
            search_query: String::new(),
            filtered_indices: [current_indices, other_indices, archived_indices],
        }
    }

    /// 刷新数据
    pub fn refresh(&mut self) {
        let (current, other, _) = loader::load_worktrees(&self.project_path);
        let archived = loader::load_archived_worktrees(&self.project_path);
        self.worktrees = [current, other, archived];

        // 清空搜索状态并重置过滤索引
        self.search_mode = false;
        self.search_query.clear();
        self.reset_filter();

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

    /// 活跃任务数量（Current + Other，不包含 Archived）
    pub fn active_task_count(&self) -> usize {
        self.worktrees[0].len() + self.worktrees[1].len()
    }

    /// 切换到下一个 Tab
    pub fn next_tab(&mut self) {
        self.current_tab = self.current_tab.next();
        // 懒加载 Archived tab
        if self.current_tab == ProjectTab::Archived && self.worktrees[2].is_empty() {
            self.load_archived();
        }
        self.ensure_selection();
    }

    /// 懒加载归档任务
    fn load_archived(&mut self) {
        self.worktrees[2] = loader::load_archived_worktrees(&self.project_path);
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
        let list_len = self.filtered_len();
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
        let list_len = self.filtered_len();
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

    // ========== 搜索功能 ==========

    /// 重置过滤索引（显示全部）
    fn reset_filter(&mut self) {
        for (i, worktrees) in self.worktrees.iter().enumerate() {
            self.filtered_indices[i] = (0..worktrees.len()).collect();
        }
    }

    /// 更新过滤索引
    fn update_filter(&mut self) {
        let query_lower = self.search_query.to_lowercase();

        for (tab_idx, worktrees) in self.worktrees.iter().enumerate() {
            if query_lower.is_empty() {
                self.filtered_indices[tab_idx] = (0..worktrees.len()).collect();
            } else {
                self.filtered_indices[tab_idx] = worktrees
                    .iter()
                    .enumerate()
                    .filter(|(_, wt)| {
                        wt.task_name.to_lowercase().contains(&query_lower)
                            || wt.branch.to_lowercase().contains(&query_lower)
                    })
                    .map(|(i, _)| i)
                    .collect();
            }
        }

        // 确保选中项在过滤范围内
        self.ensure_filter_selection();
    }

    /// 确保选中项在过滤范围内
    fn ensure_filter_selection(&mut self) {
        let filtered_len = self.filtered_len();
        let state = self.current_list_state_mut();

        if filtered_len == 0 {
            state.select(None);
        } else if let Some(selected) = state.selected() {
            if selected >= filtered_len {
                state.select(Some(0));
            }
        } else {
            state.select(Some(0));
        }
    }

    /// 获取当前 Tab 过滤后的列表长度
    fn filtered_len(&self) -> usize {
        self.filtered_indices[self.current_tab.index()].len()
    }

    /// 进入搜索模式
    pub fn enter_search_mode(&mut self) {
        self.search_mode = true;
        self.search_query.clear();
        self.reset_filter();
    }

    /// 退出搜索模式（保留过滤）
    pub fn exit_search_mode(&mut self) {
        self.search_mode = false;
    }

    /// 取消搜索（清空并退出）
    pub fn cancel_search(&mut self) {
        self.search_mode = false;
        self.search_query.clear();
        self.reset_filter();
        self.ensure_selection();
    }

    /// 搜索输入字符
    pub fn search_input_char(&mut self, c: char) {
        self.search_query.push(c);
        self.update_filter();
    }

    /// 搜索删除字符
    pub fn search_delete_char(&mut self) {
        self.search_query.pop();
        self.update_filter();
    }

    /// 获取当前 Tab 过滤后的 worktrees
    pub fn filtered_worktrees(&self) -> Vec<&Worktree> {
        let tab_idx = self.current_tab.index();
        self.filtered_indices[tab_idx]
            .iter()
            .filter_map(|&i| self.worktrees[tab_idx].get(i))
            .collect()
    }
}

impl Default for ProjectState {
    fn default() -> Self {
        let project_path = git::repo_root(".").unwrap_or_else(|_| ".".to_string());
        Self::new(&project_path)
    }
}

/// 应用模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMode {
    /// Workspace 层级 - 项目列表
    Workspace,
    /// Project 层级 - 任务列表
    Project,
}

/// 全局应用状态
pub struct App {
    /// 当前模式
    pub mode: AppMode,
    /// Workspace 状态
    pub workspace: WorkspaceState,
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
    /// 待 attach 的 session (暂停 TUI 后执行，完成后恢复 TUI)
    pub pending_tmux_attach: Option<String>,
    /// 确认弹窗（弱确认）
    pub confirm_dialog: Option<ConfirmType>,
    /// 输入确认弹窗（强确认）
    pub input_confirm_dialog: Option<InputConfirmData>,
    /// 分支选择器（Rebase To）
    pub branch_selector: Option<BranchSelectorData>,
    /// 待执行的操作（确认后执行）
    pending_action: Option<PendingAction>,
    /// 是否显示帮助面板
    pub show_help: bool,
    /// Merge 方式选择弹窗
    pub merge_dialog: Option<MergeDialogData>,
    /// Add Project 弹窗
    pub add_project_dialog: Option<AddProjectData>,
    /// Delete Project 弹窗
    pub delete_project_dialog: Option<DeleteProjectData>,
}

/// 待执行的操作
#[derive(Debug, Clone)]
pub enum PendingAction {
    /// Archive 任务
    Archive { task_id: String },
    /// Clean 任务
    Clean { task_id: String, is_archived: bool },
    /// Rebase To (修改 target)
    RebaseTo { task_id: String },
    /// Recover 归档任务
    Recover { task_id: String },
    /// Sync - 从 target 同步到当前分支
    Sync { task_id: String, check_target: bool },
    /// Merge - 将当前分支合并到 target
    Merge { task_id: String, check_target: bool },
    /// Merge 成功后询问是否 Archive
    MergeArchive { task_id: String },
}

impl App {
    pub fn new() -> Self {
        // 加载配置
        let config = storage::config::load_config();
        let theme = Theme::from_name(&config.theme.name);
        let last_system_dark = detect_system_theme();
        let colors = get_theme_colors(theme);

        // 判断是否在 git 仓库中
        let is_in_git_repo = git::is_git_repo(".");

        let (mode, project, workspace, target_branch) = if is_in_git_repo {
            // 在 git 仓库中 -> Project 模式
            let project_path = git::repo_root(".").unwrap_or_else(|_| ".".to_string());
            let target_branch = git::current_branch(&project_path)
                .unwrap_or_else(|_| "main".to_string());

            // 自动注册/更新项目 metadata
            let project_name = Path::new(&project_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let _ = storage::workspace::upsert_project(&project_name, &project_path);

            (
                AppMode::Project,
                ProjectState::new(&project_path),
                WorkspaceState::default(),
                target_branch,
            )
        } else {
            // 非 git 仓库 -> Workspace 模式
            (
                AppMode::Workspace,
                ProjectState::default(),
                WorkspaceState::new(),
                "main".to_string(),
            )
        };

        Self {
            mode,
            workspace,
            should_quit: false,
            project,
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
            confirm_dialog: None,
            input_confirm_dialog: None,
            branch_selector: None,
            pending_action: None,
            show_help: false,
            merge_dialog: None,
            add_project_dialog: None,
            delete_project_dialog: None,
        }
    }

    /// 从 Workspace 进入 Project
    pub fn enter_project(&mut self, project_path: &str) {
        // 更新项目 metadata（刷新 name）
        let project_name = Path::new(project_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let _ = storage::workspace::upsert_project(&project_name, project_path);

        self.project = ProjectState::new(project_path);
        self.target_branch = git::current_branch(project_path)
            .unwrap_or_else(|_| "main".to_string());
        self.mode = AppMode::Project;
    }

    /// 从 Project 返回 Workspace
    pub fn back_to_workspace(&mut self) {
        self.workspace.reload_projects();
        self.mode = AppMode::Workspace;
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
        // 保存主题配置
        self.save_theme_config();
    }

    /// 保存主题配置到文件
    fn save_theme_config(&self) {
        use storage::config::{Config, ThemeConfig, save_config};
        let config = Config {
            theme: ThemeConfig {
                name: self.theme.label().to_string(),
            },
        };
        let _ = save_config(&config);
    }

    /// 应用指定索引的主题
    fn apply_theme_at_index(&mut self, index: usize) {
        if let Some(theme) = Theme::all().get(index) {
            self.theme = *theme;
            self.colors = get_theme_colors(*theme);
        }
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

        let project_key = project_hash(&repo_root);

        // 2. 生成标识符
        let slug = tasks::to_slug(&name);
        let branch = tasks::generate_branch_name(&name);

        // 3. 计算路径（使用 project_key 作为目录名）
        let worktree_path = match storage::ensure_worktree_dir(&project_key) {
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
        let now = Utc::now();
        let task = Task {
            id: slug.clone(),
            name: name.clone(),
            branch: branch.clone(),
            target: self.target_branch.clone(),
            worktree_path: worktree_path.to_string_lossy().to_string(),
            created_at: now,
            updated_at: now,
            status: TaskStatus::Active,
        };

        if let Err(e) = tasks::add_task(&project_key, task) {
            // 只是警告，worktree 已创建
            eprintln!("Warning: Failed to save task: {}", e);
        }

        // 6. 创建 session（使用 project_key 保持一致）
        let session = tmux::session_name(&project_key, &slug);
        if let Err(e) = tmux::create_session(&session, worktree_path.to_str().unwrap_or(".")) {
            self.show_toast(format!("Session error: {}", e));
            self.close_new_task_dialog();
            return;
        }

        // 7. 关闭弹窗，设置待 attach 的 session
        self.close_new_task_dialog();
        self.show_toast(format!("Created: {}", name));

        // 8. 标记需要 attach（主循环会暂停 TUI，attach 完成后恢复）
        self.pending_tmux_attach = Some(session);
    }

    /// 进入当前选中的 worktree (attach session)
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

        // 3. 获取 session 名称（使用 project_key）
        let slug = slug_from_path(&wt.path);
        let session = tmux::session_name(&self.project.project_key, &slug);

        // 4. 如果 session 不存在，创建它
        if !tmux::session_exists(&session) {
            if let Err(e) = tmux::create_session(&session, &wt.path) {
                self.show_toast(format!("Session error: {}", e));
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

    // ========== Archive 功能 ==========

    /// 开始归档流程
    pub fn start_archive(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        // Broken 状态不能 archive，应该 clean
        if wt.status == WorktreeStatus::Broken {
            self.show_toast("Broken worktree - use Clean instead");
            return;
        }

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let branch = wt.branch.clone();
        let target = wt.target.clone();

        // 检查是否已 merge
        let is_merged = git::is_merged(&self.project.project_path, &branch, &target)
            .unwrap_or(false);

        if is_merged {
            // 已 merge，直接归档
            self.do_archive(&task_id);
        } else {
            // 未 merge，显示确认弹窗
            self.pending_action = Some(PendingAction::Archive { task_id });
            self.confirm_dialog = Some(ConfirmType::ArchiveUnmerged { task_name, branch });
        }
    }

    /// 执行归档
    fn do_archive(&mut self, task_id: &str) {
        // 1. 关闭 session
        let session = tmux::session_name(&self.project.project_key, task_id);
        let _ = tmux::kill_session(&session);

        // 2. 获取 worktree 路径并删除
        if let Ok(Some(task)) = tasks::get_task(&self.project.project_key, task_id) {
            if Path::new(&task.worktree_path).exists() {
                let _ = git::remove_worktree(&self.project.project_path, &task.worktree_path);
            }
        }

        // 3. 移动到 archived.toml
        if let Err(e) = tasks::archive_task(&self.project.project_key, task_id) {
            self.show_toast(format!("Archive failed: {}", e));
            return;
        }

        // 4. 刷新数据
        self.project.refresh();
        self.show_toast("Task archived");
    }

    // ========== Clean 功能 ==========

    /// 开始清理流程
    pub fn start_clean(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let branch = wt.branch.clone();
        let target = wt.target.clone();
        let is_archived = wt.archived;

        // 检查是否已 merge
        let is_merged = git::is_merged(&self.project.project_path, &branch, &target)
            .unwrap_or(false);

        self.pending_action = Some(PendingAction::Clean { task_id, is_archived });

        if is_merged {
            // 已 merge，弱提示
            self.confirm_dialog = Some(ConfirmType::CleanMerged { task_name, branch });
        } else {
            // 未 merge，强确认（需要输入 delete）
            self.input_confirm_dialog = Some(InputConfirmData::new(task_name, branch));
        }
    }

    /// 执行清理
    fn do_clean(&mut self, task_id: &str, is_archived: bool) {
        // 1. 关闭 session
        let session = tmux::session_name(&self.project.project_key, task_id);
        let _ = tmux::kill_session(&session);

        // 2. 获取 task 信息
        let task = if is_archived {
            tasks::get_archived_task(&self.project.project_key, task_id).ok().flatten()
        } else {
            tasks::get_task(&self.project.project_key, task_id).ok().flatten()
        };

        if let Some(task) = task {
            // 3. 删除 worktree (如果存在)
            if Path::new(&task.worktree_path).exists() {
                let _ = git::remove_worktree(&self.project.project_path, &task.worktree_path);
            }

            // 4. 删除 branch
            let _ = git::delete_branch(&self.project.project_path, &task.branch);
        }

        // 5. 删除 task 记录
        let result = if is_archived {
            tasks::remove_archived_task(&self.project.project_key, task_id)
        } else {
            tasks::remove_task(&self.project.project_key, task_id)
        };

        if let Err(e) = result {
            self.show_toast(format!("Clean failed: {}", e));
            return;
        }

        // 6. 刷新数据
        self.project.refresh();
        self.show_toast("Task cleaned");
    }

    // ========== 弹窗操作 ==========

    /// 确认弱确认弹窗
    pub fn confirm_dialog_yes(&mut self) {
        if let Some(action) = self.pending_action.take() {
            self.confirm_dialog = None;
            match action {
                PendingAction::Archive { task_id } => self.do_archive(&task_id),
                PendingAction::Clean { task_id, is_archived } => self.do_clean(&task_id, is_archived),
                PendingAction::RebaseTo { .. } => {} // RebaseTo 不使用确认弹窗
                PendingAction::Recover { task_id } => self.recover_worktree(&task_id),
                PendingAction::Sync { task_id, check_target } => {
                    if check_target {
                        self.check_sync_target(&task_id);
                    } else {
                        self.do_sync(&task_id);
                    }
                }
                PendingAction::Merge { task_id, check_target } => {
                    if check_target {
                        self.check_merge_target(&task_id);
                    } else {
                        self.open_merge_dialog(&task_id);
                    }
                }
                PendingAction::MergeArchive { task_id } => self.do_archive(&task_id),
            }
        }
    }

    /// 取消弱确认弹窗
    pub fn confirm_dialog_cancel(&mut self) {
        self.confirm_dialog = None;
        self.pending_action = None;
    }

    /// 输入确认弹窗 - 输入字符
    pub fn input_confirm_char(&mut self, c: char) {
        if let Some(ref mut data) = self.input_confirm_dialog {
            data.input.push(c);
        }
    }

    /// 输入确认弹窗 - 删除字符
    pub fn input_confirm_backspace(&mut self) {
        if let Some(ref mut data) = self.input_confirm_dialog {
            data.input.pop();
        }
    }

    /// 输入确认弹窗 - 确认
    pub fn input_confirm_submit(&mut self) {
        let confirmed = self.input_confirm_dialog
            .as_ref()
            .map(|d| d.is_confirmed())
            .unwrap_or(false);

        if confirmed {
            if let Some(action) = self.pending_action.take() {
                self.input_confirm_dialog = None;
                if let PendingAction::Clean { task_id, is_archived } = action {
                    self.do_clean(&task_id, is_archived);
                }
            }
        } else {
            self.show_toast("Type 'delete' to confirm");
        }
    }

    /// 输入确认弹窗 - 取消
    pub fn input_confirm_cancel(&mut self) {
        self.input_confirm_dialog = None;
        self.pending_action = None;
    }

    // ========== Recover 功能 ==========

    /// 开始恢复流程（显示弱确认弹窗）
    pub fn start_recover(&mut self) {
        // 获取当前选中的 archived worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let branch = wt.branch.clone();

        // 显示确认弹窗
        self.pending_action = Some(PendingAction::Recover { task_id });
        self.confirm_dialog = Some(ConfirmType::Recover { task_name, branch });
    }

    /// 恢复归档的任务
    fn recover_worktree(&mut self, task_id: &str) {
        // 获取 task 信息
        let task = match tasks::get_archived_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        // 检查 branch 是否还存在
        if !git::branch_exists(&self.project.project_path, &task.branch) {
            self.show_toast("Branch deleted - cannot recover");
            return;
        }

        // 重新创建 worktree
        let worktree_path = Path::new(&task.worktree_path);
        if let Err(e) = git::create_worktree_from_branch(
            &self.project.project_path,
            &task.branch,
            worktree_path,
        ) {
            self.show_toast(format!("Git error: {}", e));
            return;
        }

        // 移回 tasks.toml
        if let Err(e) = tasks::recover_task(&self.project.project_key, task_id) {
            self.show_toast(format!("Recover failed: {}", e));
            return;
        }

        // 创建 session
        let session = tmux::session_name(&self.project.project_key, task_id);
        if let Err(e) = tmux::create_session(&session, task.worktree_path.as_str()) {
            self.show_toast(format!("Session error: {}", e));
            return;
        }

        // 刷新数据并进入
        self.project.refresh();
        self.show_toast("Task recovered");
        self.pending_tmux_attach = Some(session);
    }

    // ========== Rebase To 功能 ==========

    /// 打开分支选择器
    pub fn open_branch_selector(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let current_target = wt.target.clone();

        // 获取所有分支
        let branches = match git::list_branches(&self.project.project_path) {
            Ok(b) => b,
            Err(e) => {
                self.show_toast(format!("Failed to list branches: {}", e));
                return;
            }
        };

        // 存储待操作的 task_id
        self.pending_action = Some(PendingAction::RebaseTo { task_id });

        // 打开选择器
        self.branch_selector = Some(BranchSelectorData::new(branches, task_name, current_target));
    }

    /// 分支选择器 - 向上
    pub fn branch_selector_prev(&mut self) {
        if let Some(ref mut data) = self.branch_selector {
            data.select_prev();
        }
    }

    /// 分支选择器 - 向下
    pub fn branch_selector_next(&mut self) {
        if let Some(ref mut data) = self.branch_selector {
            data.select_next();
        }
    }

    /// 分支选择器 - 输入字符
    pub fn branch_selector_char(&mut self, c: char) {
        if let Some(ref mut data) = self.branch_selector {
            data.input_char(c);
        }
    }

    /// 分支选择器 - 删除字符
    pub fn branch_selector_backspace(&mut self) {
        if let Some(ref mut data) = self.branch_selector {
            data.delete_char();
        }
    }

    /// 分支选择器 - 确认
    pub fn branch_selector_confirm(&mut self) {
        let new_target = self
            .branch_selector
            .as_ref()
            .and_then(|d| d.selected_branch())
            .map(|s| s.to_string());

        if let (Some(new_target), Some(PendingAction::RebaseTo { task_id })) =
            (new_target, self.pending_action.take())
        {
            // 更新 task target
            if let Err(e) = tasks::update_task_target(&self.project.project_key, &task_id, &new_target) {
                self.show_toast(format!("Failed to update target: {}", e));
            } else {
                self.project.refresh();
                self.show_toast(format!("Target changed to {}", new_target));
            }
        }

        self.branch_selector = None;
    }

    /// 分支选择器 - 取消
    pub fn branch_selector_cancel(&mut self) {
        self.branch_selector = None;
        self.pending_action = None;
    }

    // ========== Sync 功能 ==========

    /// 开始 Sync 流程
    pub fn start_sync(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        // Archived/Broken 状态不能 sync
        if wt.archived || wt.status == WorktreeStatus::Broken {
            self.show_toast("Cannot sync archived or broken task");
            return;
        }

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let worktree_path = wt.path.clone();

        // 检查 worktree 是否有未提交的代码
        match git::has_uncommitted_changes(&worktree_path) {
            Ok(true) => {
                self.pending_action = Some(PendingAction::Sync { task_id, check_target: true });
                self.confirm_dialog = Some(ConfirmType::SyncUncommittedWorktree { task_name });
            }
            Ok(false) => {
                self.check_sync_target(&task_id);
            }
            Err(e) => {
                self.show_toast(format!("Git error: {}", e));
            }
        }
    }

    /// 检查 Sync 的 target 是否有未提交代码
    fn check_sync_target(&mut self, task_id: &str) {
        // 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        // 检查 target branch（主仓库）是否有未提交的代码
        match git::has_uncommitted_changes(&self.project.project_path) {
            Ok(true) => {
                self.pending_action = Some(PendingAction::Sync { task_id: task_id.to_string(), check_target: false });
                self.confirm_dialog = Some(ConfirmType::SyncUncommittedTarget {
                    task_name: task.name.clone(),
                    target: task.target.clone(),
                });
            }
            Ok(false) => {
                self.do_sync(task_id);
            }
            Err(e) => {
                self.show_toast(format!("Git error: {}", e));
            }
        }
    }

    /// 执行 Sync
    fn do_sync(&mut self, task_id: &str) {
        // 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        // 执行 rebase
        match git::rebase(&task.worktree_path, &task.target) {
            Ok(()) => {
                self.project.refresh();
                self.show_toast(format!("Synced with {}", task.target));
            }
            Err(e) => {
                if e.contains("conflict") || e.contains("CONFLICT") {
                    self.show_toast("Conflict - resolve in worktree");
                } else {
                    self.show_toast(format!("Sync failed: {}", e));
                }
            }
        }
    }

    // ========== Merge 功能 ==========

    /// 开始 Merge 流程
    pub fn start_merge(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else { return };

        // Archived/Broken 状态不能 merge
        if wt.archived || wt.status == WorktreeStatus::Broken {
            self.show_toast("Cannot merge archived or broken task");
            return;
        }

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let worktree_path = wt.path.clone();

        // 检查 worktree 是否有未提交的代码
        match git::has_uncommitted_changes(&worktree_path) {
            Ok(true) => {
                self.pending_action = Some(PendingAction::Merge { task_id, check_target: true });
                self.confirm_dialog = Some(ConfirmType::MergeUncommittedWorktree { task_name });
            }
            Ok(false) => {
                self.check_merge_target(&task_id);
            }
            Err(e) => {
                self.show_toast(format!("Git error: {}", e));
            }
        }
    }

    /// 检查 Merge 的 target 是否有未提交代码
    fn check_merge_target(&mut self, task_id: &str) {
        // 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        // 检查 target branch（主仓库）是否有未提交的代码
        match git::has_uncommitted_changes(&self.project.project_path) {
            Ok(true) => {
                self.pending_action = Some(PendingAction::Merge { task_id: task_id.to_string(), check_target: false });
                self.confirm_dialog = Some(ConfirmType::MergeUncommittedTarget {
                    task_name: task.name.clone(),
                    target: task.target.clone(),
                });
            }
            Ok(false) => {
                self.open_merge_dialog(task_id);
            }
            Err(e) => {
                self.show_toast(format!("Git error: {}", e));
            }
        }
    }

    /// 打开 Merge 方式选择弹窗
    fn open_merge_dialog(&mut self, task_id: &str) {
        // 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        self.merge_dialog = Some(MergeDialogData::new(
            task_id.to_string(),
            task.name,
            task.branch,
            task.target,
        ));
    }

    /// Merge 弹窗 - 切换选项
    pub fn merge_dialog_toggle(&mut self) {
        if let Some(ref mut data) = self.merge_dialog {
            data.toggle();
        }
    }

    /// Merge 弹窗 - 确认
    pub fn merge_dialog_confirm(&mut self) {
        let dialog_data = self.merge_dialog.take();
        let Some(data) = dialog_data else { return };

        self.do_merge(&data.task_id, data.selected);
    }

    /// Merge 弹窗 - 取消
    pub fn merge_dialog_cancel(&mut self) {
        self.merge_dialog = None;
    }

    /// 执行 Merge
    fn do_merge(&mut self, task_id: &str, method: MergeMethod) {
        // 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        let result = match method {
            MergeMethod::Squash => {
                // Squash merge + commit
                git::merge_squash(&self.project.project_path, &task.branch)
                    .and_then(|()| git::commit(&self.project.project_path, &task.name))
            }
            MergeMethod::MergeCommit => {
                // Merge commit
                let message = format!("Merge: {}", task.name);
                git::merge_no_ff(&self.project.project_path, &task.branch, &message)
            }
        };

        match result {
            Ok(()) => {
                // 成功，显示询问是否 Archive 的弹窗
                self.pending_action = Some(PendingAction::MergeArchive { task_id: task_id.to_string() });
                self.confirm_dialog = Some(ConfirmType::MergeSuccess { task_name: task.name });
                self.project.refresh();
            }
            Err(e) => {
                if e.contains("conflict") || e.contains("CONFLICT") {
                    self.show_toast("Merge conflict - resolve manually");
                } else {
                    self.show_toast(format!("Merge failed: {}", e));
                }
            }
        }
    }

    // ========== Add Project 功能 ==========

    /// 打开 Add Project 弹窗
    pub fn open_add_project_dialog(&mut self) {
        self.add_project_dialog = Some(AddProjectData::new());
    }

    /// 关闭 Add Project 弹窗
    pub fn close_add_project_dialog(&mut self) {
        self.add_project_dialog = None;
    }

    /// Add Project - 输入字符
    pub fn add_project_input_char(&mut self, c: char) {
        if let Some(ref mut data) = self.add_project_dialog {
            data.input_char(c);
        }
    }

    /// Add Project - 删除字符
    pub fn add_project_delete_char(&mut self) {
        if let Some(ref mut data) = self.add_project_dialog {
            data.delete_char();
        }
    }

    /// Add Project - 确认添加
    pub fn add_project_confirm(&mut self) {
        let path = match &self.add_project_dialog {
            Some(data) => data.expanded_path(),
            None => return,
        };

        if path.is_empty() {
            if let Some(ref mut data) = self.add_project_dialog {
                data.set_error("Path cannot be empty");
            }
            return;
        }

        // 验证路径是否存在
        if !Path::new(&path).exists() {
            if let Some(ref mut data) = self.add_project_dialog {
                data.set_error("Path does not exist");
            }
            return;
        }

        // 验证是否是 git 仓库
        if !git::is_git_repo(&path) {
            if let Some(ref mut data) = self.add_project_dialog {
                data.set_error("Not a git repository");
            }
            return;
        }

        // 验证是否已注册
        if storage::workspace::is_project_registered(&path).unwrap_or(false) {
            if let Some(ref mut data) = self.add_project_dialog {
                data.set_error("Project already registered");
            }
            return;
        }

        // 提取项目名
        let name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        // 添加项目
        if let Err(e) = storage::workspace::add_project(&name, &path) {
            if let Some(ref mut data) = self.add_project_dialog {
                data.set_error(format!("Failed to add: {}", e));
            }
            return;
        }

        // 成功，关闭弹窗并刷新
        self.close_add_project_dialog();
        self.workspace.reload_projects();
        self.show_toast(format!("Added: {}", name));
    }

    // ========== Delete Project 功能 ==========

    /// 打开 Delete Project 弹窗
    pub fn open_delete_project_dialog(&mut self) {
        if let Some(project) = self.workspace.selected_project() {
            self.delete_project_dialog = Some(DeleteProjectData::new(
                project.name.clone(),
                project.path.clone(),
                project.task_count,
            ));
        }
    }

    /// 关闭 Delete Project 弹窗
    pub fn close_delete_project_dialog(&mut self) {
        self.delete_project_dialog = None;
    }

    /// Delete Project - 切换选项
    pub fn delete_project_toggle(&mut self) {
        if let Some(ref mut data) = self.delete_project_dialog {
            data.toggle();
        }
    }

    /// Delete Project - 确认删除
    pub fn delete_project_confirm(&mut self) {
        let dialog_data = self.delete_project_dialog.take();
        let Some(data) = dialog_data else { return };

        let project_key = project_hash(&data.project_path);

        // 1. 加载所有任务
        let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();
        let archived_tasks = tasks::load_archived_tasks(&project_key).unwrap_or_default();

        // 2. 清理所有任务
        for task in active_tasks.iter().chain(archived_tasks.iter()) {
            // 关闭 session
            let session = tmux::session_name(&project_key, &task.id);
            let _ = tmux::kill_session(&session);

            // 删除 worktree (如果存在)
            if Path::new(&task.worktree_path).exists() {
                let _ = git::remove_worktree(&data.project_path, &task.worktree_path);
            }

            // Full clean 模式：删除 branch
            if data.selected == DeleteMode::FullClean {
                let _ = git::delete_branch(&data.project_path, &task.branch);
            }
        }

        // 3. 删除项目注册（这会删除整个 ~/.grove/projects/<hash>/ 目录）
        if let Err(e) = storage::workspace::remove_project(&data.project_path) {
            self.show_toast(format!("Remove failed: {}", e));
            return;
        }

        // 4. 刷新项目列表
        self.workspace.reload_projects();

        let mode_text = if data.selected == DeleteMode::FullClean {
            "fully cleaned"
        } else {
            "removed"
        };
        self.show_toast(format!("{} {}", data.project_name, mode_text));
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
