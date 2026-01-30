use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use chrono::Utc;
use ratatui::widgets::ListState;

use crate::git;
use crate::hooks::{self, HooksFile, NotificationLevel};
use crate::model::{loader, ProjectInfo, ProjectTab, WorkspaceState, Worktree, WorktreeStatus};
use crate::storage::{
    self, ai_data, notes,
    tasks::{self, Task, TaskStatus},
    workspace::project_hash,
};
use crate::theme::{detect_system_theme, get_theme_colors, Theme, ThemeColors};
use crate::tmux;
use crate::tmux::layout::{
    self as layout_mod, CustomLayout, LayoutNode, PaneRole, SplitDirection, TaskLayout,
};
use crate::ui::click_areas::ClickAreas;
use crate::ui::components::action_palette::{ActionPaletteData, ActionType};
use crate::ui::components::add_project_dialog::AddProjectData;
use crate::ui::components::branch_selector::BranchSelectorData;
use crate::ui::components::commit_dialog::CommitDialogData;
use crate::ui::components::config_panel::{ConfigPanelData, ConfigStep};
use crate::ui::components::confirm_dialog::ConfirmType;
use crate::ui::components::delete_project_dialog::{DeleteMode, DeleteProjectData};
use crate::ui::components::hook_panel::HookConfigStep;
use crate::ui::components::input_confirm_dialog::InputConfirmData;
use crate::ui::components::merge_dialog::{MergeDialogData, MergeMethod};
use crate::update::UpdateInfo;

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

/// 设置终端 tab 标题
fn set_terminal_title(title: &str) {
    let _ = write!(std::io::stdout(), "\x1b]0;{}\x07", title);
    let _ = std::io::stdout().flush();
}

/// 预览面板 sub-tab
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewSubTab {
    Git,
    Ai,
    Notes,
}

/// 面板数据缓存
#[derive(Debug, Default)]
pub struct PanelData {
    /// Git tab: branch name
    pub git_branch: String,
    /// Git tab: target branch name
    pub git_target: String,
    /// Git tab: recent commits
    pub git_log: Vec<git::LogEntry>,
    /// Git tab: changed files
    pub git_diff: Vec<git::DiffStatEntry>,
    /// Git tab: uncommitted file count
    pub git_uncommitted: usize,
    /// Git tab: stash count
    pub git_stash_count: usize,
    /// Git tab: has merge conflicts
    pub git_has_conflicts: bool,
    /// AI tab: summary
    pub ai_summary: String,
    /// AI tab: TODO data
    pub ai_todo: ai_data::TodoData,
    /// AI tab: whether grove init has been run
    pub ai_initialized: bool,
    /// AI tab: TODO 是否处于活跃状态（60 秒内有更新且有未完成项）
    pub ai_todo_active: bool,
    /// Notes tab: content
    pub notes_content: String,
    /// 上次加载的 task id
    pub last_task_id: Option<String>,
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
    /// 预览面板是否可见
    pub preview_visible: bool,
    /// 当前 sub-tab
    pub preview_sub_tab: PreviewSubTab,
    /// 面板数据缓存
    pub panel_data: PanelData,
    /// Notes 滚动偏移
    pub notes_scroll: u16,
    /// AI Summary 滚动偏移
    pub ai_summary_scroll: u16,
    /// Git tab 滚动偏移
    pub git_scroll: u16,
    /// 待打开外部编辑器的 notes 文件路径
    pub pending_notes_edit: Option<String>,
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
            preview_visible: true,
            preview_sub_tab: PreviewSubTab::Git,
            panel_data: PanelData::default(),
            notes_scroll: 0,
            ai_summary_scroll: 0,
            git_scroll: 0,
            pending_notes_edit: None,
        }
    }

    /// 刷新数据
    pub fn refresh(&mut self) {
        git::cache::clear_all();
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

    /// 切换到上一个 Tab
    pub fn prev_tab(&mut self) {
        self.current_tab = match self.current_tab {
            ProjectTab::Current => ProjectTab::Archived,
            ProjectTab::Other => ProjectTab::Current,
            ProjectTab::Archived => ProjectTab::Other,
        };
        // 懒加载 Archived tab
        if self.current_tab == ProjectTab::Archived && self.worktrees[2].is_empty() {
            self.load_archived();
        }
        self.ensure_selection();
    }

    /// 切换到指定 Tab（鼠标点击用）
    pub fn switch_to_tab(&mut self, tab: ProjectTab) {
        self.current_tab = tab;
        if tab == ProjectTab::Archived && self.worktrees[2].is_empty() {
            self.load_archived();
        }
        self.ensure_selection();
    }

    /// 切换预览面板显示/隐藏
    pub fn toggle_preview(&mut self) {
        self.preview_visible = !self.preview_visible;
        if self.preview_visible {
            self.refresh_panel_data();
        }
    }

    /// 刷新面板数据
    pub fn refresh_panel_data(&mut self) {
        let Some(wt) = self.selected_worktree_cloned() else {
            return;
        };

        // 检查是否切换了 task，以及是否首次打开面板
        let first_open = self.panel_data.last_task_id.is_none();
        let changed = self.panel_data.last_task_id.as_deref() != Some(&wt.id);
        if changed {
            self.panel_data.last_task_id = Some(wt.id.clone());
            self.notes_scroll = 0;
            self.ai_summary_scroll = 0;
            self.git_scroll = 0;
        }

        // Git data
        self.panel_data.git_branch = git::current_branch(&wt.path).unwrap_or_default();
        self.panel_data.git_target = wt.target.clone();
        self.panel_data.git_log = git::recent_log(&wt.path, &wt.target, 10).unwrap_or_default();
        self.panel_data.git_diff = git::diff_stat(&wt.path, &wt.target).unwrap_or_default();
        self.panel_data.git_uncommitted = git::uncommitted_count(&wt.path).unwrap_or(0);
        self.panel_data.git_stash_count = git::stash_count(&wt.path).unwrap_or(0);
        self.panel_data.git_has_conflicts = git::has_conflicts(&wt.path);

        // AI data
        self.panel_data.ai_initialized = std::path::Path::new(&wt.path).join("GROVE.md").exists();
        self.panel_data.ai_summary =
            ai_data::load_summary(&self.project_key, &wt.id).unwrap_or_default();
        self.panel_data.ai_todo = ai_data::load_todo(&self.project_key, &wt.id).unwrap_or_default();
        let recently_updated = ai_data::todo_modified_secs_ago(&self.project_key, &wt.id)
            .map(|secs| secs < 60)
            .unwrap_or(false);
        self.panel_data.ai_todo_active =
            recently_updated && !self.panel_data.ai_todo.todo.is_empty();

        // Notes data
        self.panel_data.notes_content =
            notes::load_notes(&self.project_key, &wt.id).unwrap_or_default();

        // 智能默认 sub-tab：仅首次打开面板时设置，切换任务时保持用户选择
        if changed && first_open {
            let has_ai =
                !self.panel_data.ai_summary.is_empty() || !self.panel_data.ai_todo.is_empty();
            self.preview_sub_tab = if has_ai {
                PreviewSubTab::Ai
            } else {
                PreviewSubTab::Git
            };
        }
    }

    /// 请求打开外部编辑器编辑 notes
    pub fn request_notes_edit(&mut self) {
        let Some(wt) = self.selected_worktree_cloned() else {
            return;
        };
        // 确保 notes 文件存在
        let _ = notes::save_notes_if_not_exists(&self.project_key, &wt.id);
        if let Ok(path) = notes::notes_file_path(&self.project_key, &wt.id) {
            self.pending_notes_edit = Some(path);
        }
    }

    /// 向下滚动 notes
    pub fn scroll_notes_down(&mut self) {
        let line_count = self.panel_data.notes_content.lines().count() as u16;
        if self.notes_scroll < line_count.saturating_sub(1) {
            self.notes_scroll += 1;
        }
    }

    /// 向上滚动 notes
    pub fn scroll_notes_up(&mut self) {
        self.notes_scroll = self.notes_scroll.saturating_sub(1);
    }

    /// 向下滚动 AI summary
    pub fn scroll_ai_summary_down(&mut self) {
        let line_count = self.panel_data.ai_summary.lines().count() as u16;
        if self.ai_summary_scroll < line_count.saturating_sub(1) {
            self.ai_summary_scroll += 1;
        }
    }

    /// 向上滚动 AI summary
    pub fn scroll_ai_summary_up(&mut self) {
        self.ai_summary_scroll = self.ai_summary_scroll.saturating_sub(1);
    }

    /// 向下滚动 Git tab
    pub fn scroll_git_down(&mut self) {
        self.git_scroll += 1;
    }

    /// 向上滚动 Git tab
    pub fn scroll_git_up(&mut self) {
        self.git_scroll = self.git_scroll.saturating_sub(1);
    }

    /// Clone 选中的 worktree（避免借用冲突）
    fn selected_worktree_cloned(&self) -> Option<Worktree> {
        self.selected_worktree().cloned()
    }

    /// 获取当前选中的 worktree
    pub fn selected_worktree(&self) -> Option<&Worktree> {
        let filtered = self.filtered_worktrees();
        let index = self.current_list_state().selected()?;
        filtered.into_iter().nth(index)
    }

    /// 懒加载归档任务
    fn load_archived(&mut self) {
        self.worktrees[2] = loader::load_archived_worktrees(&self.project_path);
    }

    /// 确保当前 Tab 有选中项
    pub fn ensure_selection(&mut self) {
        let list_len = self.current_worktrees().len();
        let state = self.current_list_state_mut();

        if list_len == 0 {
            state.select(None);
        } else if let Some(selected) = state.selected() {
            if selected >= list_len {
                state.select(Some(list_len - 1));
            }
        } else {
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
        if self.preview_visible {
            self.refresh_panel_data();
        }
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
        if self.preview_visible {
            self.refresh_panel_data();
        }
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
    /// Monitor 模式 - task 监控面板（在 tmux pane 内运行）
    Monitor,
}

/// Monitor 焦点区域
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorFocus {
    /// 左侧操作栏
    Sidebar,
    /// 右侧信息面板
    Content,
}

/// Monitor 操作列表
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorAction {
    Commit,
    Sync,
    Merge,
    Archive,
    Clean,
    Notes,
    Leave,
    Exit,
}

impl MonitorAction {
    /// 分组（带标签，UI 中组间加 section header）
    pub fn groups() -> &'static [(&'static str, &'static [MonitorAction])] {
        &[
            (
                "Git",
                &[
                    MonitorAction::Commit,
                    MonitorAction::Sync,
                    MonitorAction::Merge,
                ],
            ),
            ("Task", &[MonitorAction::Archive, MonitorAction::Clean]),
            ("Edit", &[MonitorAction::Notes]),
            ("Session", &[MonitorAction::Leave, MonitorAction::Exit]),
        ]
    }

    /// 扁平列表
    pub fn all() -> Vec<MonitorAction> {
        Self::groups()
            .iter()
            .flat_map(|(_, actions)| actions.iter().copied())
            .collect()
    }

    pub fn label(&self) -> &'static str {
        match self {
            MonitorAction::Commit => "Commit",
            MonitorAction::Sync => "Sync",
            MonitorAction::Merge => "Merge",
            MonitorAction::Archive => "Archive",
            MonitorAction::Clean => "Clean",
            MonitorAction::Notes => "Notes",
            MonitorAction::Leave => "Leave",
            MonitorAction::Exit => "Exit",
        }
    }
}

/// Monitor 模式状态
#[allow(dead_code)]
pub struct MonitorState {
    /// 当前焦点
    pub focus: MonitorFocus,
    /// Sidebar 是否折叠
    pub sidebar_collapsed: bool,
    /// 右侧信息 tab
    pub content_tab: PreviewSubTab,
    /// 面板数据缓存
    pub panel_data: PanelData,
    /// Git tab 滚动偏移
    pub git_scroll: u16,
    /// AI summary 滚动偏移
    pub ai_summary_scroll: u16,
    /// Notes 滚动偏移
    pub notes_scroll: u16,
    /// Sidebar 选中操作索引
    pub action_selected: usize,
    /// GROVE_TASK_ID
    pub task_id: String,
    /// GROVE_TASK_NAME
    pub task_name: String,
    /// GROVE_BRANCH
    pub branch: String,
    /// GROVE_TARGET
    pub target: String,
    /// GROVE_WORKTREE
    pub worktree_path: String,
    /// GROVE_PROJECT_NAME
    pub project_name: String,
    /// GROVE_PROJECT
    pub project_path: String,
    /// project storage key
    pub project_key: String,
    /// 待打开外部编辑器的 notes 文件路径
    pub pending_notes_edit: Option<String>,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            focus: MonitorFocus::Sidebar,
            sidebar_collapsed: false,
            content_tab: PreviewSubTab::Git,
            panel_data: PanelData::default(),
            git_scroll: 0,
            ai_summary_scroll: 0,
            notes_scroll: 0,
            action_selected: 0,
            task_id: String::new(),
            task_name: String::new(),
            branch: String::new(),
            target: String::new(),
            worktree_path: String::new(),
            project_name: String::new(),
            project_path: String::new(),
            project_key: String::new(),
            pending_notes_edit: None,
        }
    }
}

impl MonitorState {
    /// 从环境变量初始化
    pub fn from_env() -> Self {
        let task_id = std::env::var("GROVE_TASK_ID").unwrap_or_default();
        let task_name = std::env::var("GROVE_TASK_NAME").unwrap_or_default();
        let branch = std::env::var("GROVE_BRANCH").unwrap_or_default();
        let target = std::env::var("GROVE_TARGET").unwrap_or_default();
        let worktree_path = std::env::var("GROVE_WORKTREE").unwrap_or_default();
        let project_name = std::env::var("GROVE_PROJECT_NAME").unwrap_or_default();
        let project_path = std::env::var("GROVE_PROJECT").unwrap_or_default();
        let project_key = if project_path.is_empty() {
            String::new()
        } else {
            project_hash(&project_path)
        };

        let mut state = Self {
            focus: MonitorFocus::Sidebar,
            sidebar_collapsed: false,
            content_tab: PreviewSubTab::Git,
            panel_data: PanelData::default(),
            git_scroll: 0,
            ai_summary_scroll: 0,
            notes_scroll: 0,
            action_selected: 0,
            task_id,
            task_name,
            branch,
            target,
            worktree_path,
            project_name,
            project_path,
            project_key,
            pending_notes_edit: None,
        };

        // 加载初始数据
        state.refresh_panel_data();
        state
    }

    /// 刷新面板数据
    pub fn refresh_panel_data(&mut self) {
        if self.worktree_path.is_empty() {
            return;
        }

        // Git 数据
        self.panel_data.git_branch = git::current_branch(&self.worktree_path).unwrap_or_default();
        self.panel_data.git_target = self.target.clone();
        self.panel_data.git_log =
            git::recent_log(&self.worktree_path, &self.target, 10).unwrap_or_default();
        self.panel_data.git_diff =
            git::diff_stat(&self.worktree_path, &self.target).unwrap_or_default();
        self.panel_data.git_uncommitted = git::uncommitted_count(&self.worktree_path).unwrap_or(0);
        self.panel_data.git_stash_count = git::stash_count(&self.worktree_path).unwrap_or(0);
        self.panel_data.git_has_conflicts = git::has_conflicts(&self.worktree_path);

        // AI 数据
        self.panel_data.ai_initialized = std::path::Path::new(&self.worktree_path)
            .join("GROVE.md")
            .exists();
        self.panel_data.ai_summary =
            ai_data::load_summary(&self.project_key, &self.task_id).unwrap_or_default();
        self.panel_data.ai_todo =
            ai_data::load_todo(&self.project_key, &self.task_id).unwrap_or_default();
        let recently_updated = ai_data::todo_modified_secs_ago(&self.project_key, &self.task_id)
            .map(|secs| secs < 60)
            .unwrap_or(false);
        self.panel_data.ai_todo_active =
            recently_updated && !self.panel_data.ai_todo.todo.is_empty();

        // Notes 数据
        self.panel_data.notes_content =
            notes::load_notes(&self.project_key, &self.task_id).unwrap_or_default();
    }

    /// Tab 键：展开/折叠 sidebar
    pub fn toggle_sidebar(&mut self) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
        if self.sidebar_collapsed {
            self.focus = MonitorFocus::Content;
        } else {
            self.focus = MonitorFocus::Sidebar;
        }
    }

    /// h/l 切换焦点（如果 sidebar 折叠则先展开）
    pub fn toggle_focus(&mut self) {
        if self.sidebar_collapsed {
            self.sidebar_collapsed = false;
            self.focus = MonitorFocus::Sidebar;
        } else {
            self.focus = match self.focus {
                MonitorFocus::Sidebar => MonitorFocus::Content,
                MonitorFocus::Content => MonitorFocus::Sidebar,
            };
        }
    }

    /// 选中下一个操作
    pub fn action_next(&mut self) {
        let count = MonitorAction::all().len();
        self.action_selected = (self.action_selected + 1) % count;
    }

    /// 选中上一个操作
    pub fn action_prev(&mut self) {
        let count = MonitorAction::all().len();
        if self.action_selected == 0 {
            self.action_selected = count - 1;
        } else {
            self.action_selected -= 1;
        }
    }

    /// 向下滚动当前 tab
    pub fn scroll_down(&mut self) {
        match self.content_tab {
            PreviewSubTab::Notes => {
                let line_count = self.panel_data.notes_content.lines().count() as u16;
                if self.notes_scroll < line_count.saturating_sub(1) {
                    self.notes_scroll += 1;
                }
            }
            PreviewSubTab::Ai => {
                let line_count = self.panel_data.ai_summary.lines().count() as u16;
                if self.ai_summary_scroll < line_count.saturating_sub(1) {
                    self.ai_summary_scroll += 1;
                }
            }
            PreviewSubTab::Git => {
                self.git_scroll += 1;
            }
        }
    }

    /// 向上滚动当前 tab
    pub fn scroll_up(&mut self) {
        match self.content_tab {
            PreviewSubTab::Notes => {
                self.notes_scroll = self.notes_scroll.saturating_sub(1);
            }
            PreviewSubTab::Ai => {
                self.ai_summary_scroll = self.ai_summary_scroll.saturating_sub(1);
            }
            PreviewSubTab::Git => {
                self.git_scroll = self.git_scroll.saturating_sub(1);
            }
        }
    }

    /// 请求打开外部编辑器编辑 notes
    pub fn request_notes_edit(&mut self) {
        let _ = notes::save_notes_if_not_exists(&self.project_key, &self.task_id);
        if let Ok(path) = notes::notes_file_path(&self.project_key, &self.task_id) {
            self.pending_notes_edit = Some(path);
        }
    }
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
    /// Action Palette
    pub action_palette: Option<ActionPaletteData>,
    /// Commit 弹窗
    pub commit_dialog: Option<CommitDialogData>,
    /// Hook 通知数据 (task_id -> level) - 当前项目
    pub notifications: HashMap<String, NotificationLevel>,
    /// Workspace 级别的通知数据 (project_name -> task_id -> level)
    pub workspace_notifications: HashMap<String, HashMap<String, NotificationLevel>>,
    /// Config 配置面板
    pub config_panel: Option<ConfigPanelData>,
    /// 当前布局预设
    pub task_layout: TaskLayout,
    /// Agent 启动命令
    pub agent_command: String,
    /// 自定义布局（当 task_layout == Custom 时使用）
    pub custom_layout: Option<CustomLayout>,
    /// Update info (version check result)
    pub update_info: Option<UpdateInfo>,
    /// 后台操作结果通道
    pub bg_result_rx: Option<mpsc::Receiver<BgResult>>,
    /// Loading 消息（后台操作进行中时显示）
    pub loading_message: Option<String>,
    /// 可点击区域缓存（每帧渲染时填充）
    pub click_areas: ClickAreas,
    /// 上次点击时间（双击检测）
    pub last_click_time: Instant,
    /// 上次点击位置（双击检测）
    pub last_click_pos: (u16, u16),
    /// Monitor 模式状态
    pub monitor: MonitorState,
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
    /// Reset - 重置任务
    Reset { task_id: String },
    /// Checkout - 在主仓库 checkout 到选择的分支
    Checkout,
    /// Exit - 退出 tmux session
    ExitSession,
}

/// 后台操作结果
pub enum BgResult {
    MergeOk { task_id: String, task_name: String },
    MergeErr(String),
}

impl App {
    pub fn new() -> Self {
        // 加载配置
        let config = storage::config::load_config();
        let theme = Theme::from_name(&config.theme.name);
        let last_system_dark = detect_system_theme();
        let colors = get_theme_colors(theme);

        // 检查更新
        let update_info = crate::update::check_for_updates(
            config.update.latest_version.as_deref(),
            config.update.last_check.as_deref(),
        );

        // 如果进行了新的检查，保存结果到配置
        if crate::update::should_check(config.update.last_check.as_deref()) {
            if let Some(ref check_time) = update_info.check_time {
                let mut new_config = config.clone();
                new_config.update.last_check = Some(check_time.to_rfc3339());
                new_config.update.latest_version = update_info.latest_version.clone();
                let _ = storage::config::save_config(&new_config);
            }
        }

        // 检查是否有更新，用于后续显示 Toast
        let has_update = update_info.has_update();

        // 判断是否在 Monitor 模式（GROVE_TASK_ID 存在）
        let is_monitor = std::env::var("GROVE_TASK_ID").is_ok();

        // 判断是否在 git 仓库中
        let is_in_git_repo = git::is_git_repo(".");

        let (mode, project, workspace, target_branch, notifications, workspace_notifications) =
            if is_monitor {
                // Monitor 模式 - 从环境变量读取
                let project_path = std::env::var("GROVE_PROJECT").unwrap_or_default();
                let target = std::env::var("GROVE_TARGET").unwrap_or_else(|_| "main".to_string());
                (
                    AppMode::Monitor,
                    if !project_path.is_empty() {
                        ProjectState::new(&project_path)
                    } else {
                        ProjectState::default()
                    },
                    WorkspaceState::default(),
                    target,
                    HashMap::new(),
                    HashMap::new(),
                )
            } else if is_in_git_repo {
                // 在 git 仓库中 -> Project 模式
                let project_path = git::repo_root(".").unwrap_or_else(|_| ".".to_string());
                let target_branch =
                    git::current_branch(&project_path).unwrap_or_else(|_| "main".to_string());

                // 自动注册/更新项目 metadata
                let project_name = Path::new(&project_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let _ = storage::workspace::upsert_project(&project_name, &project_path);

                // 加载 hook 通知数据（自动清理不存在的 task）
                let hooks_file = hooks::load_hooks_with_cleanup(&project_path);

                (
                    AppMode::Project,
                    ProjectState::new(&project_path),
                    WorkspaceState::default(),
                    target_branch,
                    hooks_file.tasks,
                    HashMap::new(),
                )
            } else {
                // 非 git 仓库 -> Workspace 模式
                let workspace = WorkspaceState::new();
                let workspace_notifications = load_all_project_notifications(&workspace.projects);
                (
                    AppMode::Workspace,
                    ProjectState::default(),
                    workspace,
                    "main".to_string(),
                    HashMap::new(),
                    workspace_notifications,
                )
            };

        // 构建初始 Toast（如果有更新）
        let initial_toast = if has_update {
            update_info.latest_version.as_ref().map(|v| {
                Toast::new(
                    format!("New version available: {} (press ? for details)", v),
                    Duration::from_secs(5),
                )
            })
        } else {
            None
        };

        // 初始化 Monitor 状态
        let monitor = if is_monitor {
            MonitorState::from_env()
        } else {
            MonitorState::default()
        };

        // 设置终端 tab 标题
        match mode {
            AppMode::Monitor => {
                let task_name = &monitor.task_name;
                if task_name.is_empty() {
                    set_terminal_title("Grove Monitor");
                } else {
                    set_terminal_title(&format!("{} (monitor)", task_name));
                }
            }
            AppMode::Project => {
                let name = Path::new(&project.project_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Project");
                set_terminal_title(&format!("{} (grove)", name));
            }
            AppMode::Workspace => set_terminal_title("Grove"),
        }

        Self {
            mode,
            workspace,
            should_quit: false,
            project,
            toast: initial_toast,
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
            action_palette: None,
            commit_dialog: None,
            notifications,
            workspace_notifications,
            config_panel: None,
            task_layout: TaskLayout::from_name(&config.layout.default)
                .unwrap_or(TaskLayout::Single),
            agent_command: config.layout.agent_command.clone().unwrap_or_default(),
            custom_layout: config
                .layout
                .custom
                .as_ref()
                .and_then(|c| serde_json::from_str::<LayoutNode>(&c.tree).ok())
                .map(|root| CustomLayout { root }),
            update_info: Some(update_info),
            bg_result_rx: None,
            loading_message: None,
            click_areas: ClickAreas::default(),
            last_click_time: Instant::now() - Duration::from_secs(10),
            last_click_pos: (0, 0),
            monitor,
        }
    }

    /// 检测是否为双击（400ms 内同位置）
    pub fn is_double_click(&self, col: u16, row: u16) -> bool {
        self.last_click_time.elapsed() < Duration::from_millis(400)
            && self.last_click_pos == (col, row)
    }

    /// 记录点击位置和时间
    pub fn record_click(&mut self, col: u16, row: u16) {
        self.last_click_time = Instant::now();
        self.last_click_pos = (col, row);
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
        self.target_branch =
            git::current_branch(project_path).unwrap_or_else(|_| "main".to_string());
        self.mode = AppMode::Project;

        set_terminal_title(&format!("{} (grove)", project_name));

        // 加载 hook 通知数据（自动清理不存在的 task）
        let hooks_file = hooks::load_hooks_with_cleanup(project_path);
        self.notifications = hooks_file.tasks;
    }

    /// 从 Project 返回 Workspace
    pub fn back_to_workspace(&mut self) {
        self.workspace.reload_projects();
        self.workspace_notifications = load_all_project_notifications(&self.workspace.projects);
        self.mode = AppMode::Workspace;
        set_terminal_title("Grove");
    }

    /// 打开主题选择器
    pub fn open_theme_selector(&mut self) {
        // 找到当前主题在列表中的索引
        let themes = Theme::all();
        self.theme_selector_index = themes.iter().position(|t| *t == self.theme).unwrap_or(0);
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
        use storage::config::{load_config, save_config, ThemeConfig};
        let mut config = load_config();
        config.theme = ThemeConfig {
            name: self.theme.label().to_string(),
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
        if let Ok(branch) = git::current_branch(&self.project.project_path) {
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
        let repo_root = self.project.project_path.clone();

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
        if let Err(e) =
            git::create_worktree(&repo_root, &branch, &worktree_path, &self.target_branch)
        {
            self.show_toast(format!("Git error: {}", e));
            self.close_new_task_dialog();
            return;
        }

        // 4.5. 自动设置 AI 集成（GROVE.md + CLAUDE.md/AGENTS.md）
        {
            let cfg = storage::config::load_config();
            crate::cli::init::setup_worktree(
                worktree_path.to_str().unwrap_or("."),
                &cfg.layout.context_docs,
            );
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
        let session_env = self.build_session_env(
            &slug,
            &name,
            &branch,
            &self.target_branch.clone(),
            &worktree_path.to_string_lossy(),
        );
        if let Err(e) = tmux::create_session(
            &session,
            worktree_path.to_str().unwrap_or("."),
            Some(&session_env),
        ) {
            self.show_toast(format!("Session error: {}", e));
            self.close_new_task_dialog();
            return;
        }

        // 7. 应用布局（如果不是 Single）
        if self.task_layout != TaskLayout::Single {
            if let Err(e) = tmux::layout::apply_layout(
                &session,
                worktree_path.to_str().unwrap_or("."),
                &self.task_layout,
                &self.agent_command,
                self.custom_layout.as_ref(),
            ) {
                self.show_toast(format!("Layout: {}", e));
            }
        }

        // 8. 关闭弹窗，刷新数据
        self.close_new_task_dialog();
        self.project.refresh();
        self.show_toast(format!("Created: {}", name));

        // 9. 标记需要 attach（主循环会暂停 TUI，attach 完成后恢复）
        self.pending_tmux_attach = Some(session);
    }

    /// 进入当前选中的 worktree (attach session)
    pub fn enter_worktree(&mut self) {
        // 1. 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else {
            return;
        };

        // 2. 检查状态 - Broken 不能进入
        if wt.status == WorktreeStatus::Broken {
            self.show_toast("Worktree broken - please fix or delete");
            return;
        }

        // 3. Clone 需要的数据，避免后续借用冲突
        let wt_id = wt.id.clone();
        let wt_task_name = wt.task_name.clone();
        let wt_branch = wt.branch.clone();
        let wt_target = wt.target.clone();
        let wt_path = wt.path.clone();
        let slug = slug_from_path(&wt_path);
        let session = tmux::session_name(&self.project.project_key, &slug);

        // 4. 如果 session 不存在，创建它
        if !tmux::session_exists(&session) {
            let session_env =
                self.build_session_env(&wt_id, &wt_task_name, &wt_branch, &wt_target, &wt_path);
            if let Err(e) = tmux::create_session(&session, &wt_path, Some(&session_env)) {
                self.show_toast(format!("Session error: {}", e));
                return;
            }

            // 应用布局
            if self.task_layout != TaskLayout::Single {
                if let Err(e) = tmux::layout::apply_layout(
                    &session,
                    &wt_path,
                    &self.task_layout,
                    &self.agent_command,
                    self.custom_layout.as_ref(),
                ) {
                    self.show_toast(format!("Layout: {}", e));
                }
            }
        }

        // 5. 清除该任务的通知标记
        self.remove_notification(&wt_id);

        // 6. 设置 pending attach（主循环会暂停 TUI，attach 完成后恢复）
        self.pending_tmux_attach = Some(session);
    }

    /// 清除指定任务的 hook 通知（根据 session 名称提取 task_id）
    /// session 格式: grove-{project_key}-{task_id}
    pub fn clear_task_hook_by_session(&mut self, session: &str) {
        // 从 session 名称提取 task_id
        // 格式: grove-{project_key}-{task_id}
        // 需要跳过 "grove-{project_key}-" 前缀
        let prefix = format!("grove-{}-", self.project.project_key);
        if let Some(task_id) = session.strip_prefix(&prefix) {
            self.remove_notification(task_id);
        }
    }

    /// 清除指定任务的通知标记并保存到文件
    fn remove_notification(&mut self, task_id: &str) {
        if self.notifications.remove(task_id).is_some() {
            let hooks_file = HooksFile {
                tasks: self.notifications.clone(),
            };
            let _ = hooks::save_hooks(&self.project.project_key, &hooks_file);
        }
    }

    /// 构建 tmux SessionEnv
    fn build_session_env(
        &self,
        task_id: &str,
        task_name: &str,
        branch: &str,
        target: &str,
        worktree: &str,
    ) -> tmux::SessionEnv {
        let project_name = Path::new(&self.project.project_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        tmux::SessionEnv {
            task_id: task_id.to_string(),
            task_name: task_name.to_string(),
            branch: branch.to_string(),
            target: target.to_string(),
            worktree: worktree.to_string(),
            project_name,
            project_path: self.project.project_path.clone(),
        }
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

    /// 刷新数据（根据当前模式）
    pub fn refresh(&mut self) {
        match self.mode {
            AppMode::Project => {
                self.project.refresh();
                // 重新加载通知
                let hooks_file = hooks::load_hooks_with_cleanup(&self.project.project_path);
                self.notifications = hooks_file.tasks;
            }
            AppMode::Workspace => {
                self.workspace.refresh();
                // 重新加载所有项目的通知
                self.workspace_notifications =
                    load_all_project_notifications(&self.workspace.projects);
            }
            AppMode::Monitor => {
                self.monitor.refresh_panel_data();
            }
        }
    }

    // ========== Archive 功能 ==========

    /// 开始归档流程
    pub fn start_archive(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else {
            return;
        };

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
        let is_merged =
            git::is_merged(&self.project.project_path, &branch, &target).unwrap_or(false);

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

        // 4. 删除 hook 通知
        hooks::remove_task_hook(&self.project.project_key, task_id);
        self.remove_notification(task_id);

        // 5. 刷新数据
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
        let Some(wt) = worktrees.get(index) else {
            return;
        };

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let branch = wt.branch.clone();
        let target = wt.target.clone();
        let is_archived = wt.archived;

        // 检查是否已 merge
        let is_merged =
            git::is_merged(&self.project.project_path, &branch, &target).unwrap_or(false);

        self.pending_action = Some(PendingAction::Clean {
            task_id,
            is_archived,
        });

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
            tasks::get_archived_task(&self.project.project_key, task_id)
                .ok()
                .flatten()
        } else {
            tasks::get_task(&self.project.project_key, task_id)
                .ok()
                .flatten()
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

        // 6. 删除 hook 通知
        hooks::remove_task_hook(&self.project.project_key, task_id);
        self.remove_notification(task_id);

        // 7. 刷新数据
        self.project.refresh();
        self.show_toast("Task cleaned");
    }

    // ========== Reset 功能 ==========

    /// 开始 Reset 流程
    pub fn start_reset(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else {
            return;
        };

        // Archived/Broken 状态不能 reset
        if wt.archived || wt.status == WorktreeStatus::Broken {
            self.show_toast("Cannot reset archived or broken task");
            return;
        }

        let task_id = wt.id.clone();
        let task_name = wt.task_name.clone();
        let branch = wt.branch.clone();
        let target = wt.target.clone();

        // 显示确认弹窗
        self.pending_action = Some(PendingAction::Reset { task_id });
        self.confirm_dialog = Some(ConfirmType::Reset {
            task_name,
            branch,
            target,
        });
    }

    /// 执行 Reset
    fn do_reset(&mut self, task_id: &str) {
        // 1. 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        // 2. Kill tmux session
        let session = tmux::session_name(&self.project.project_key, task_id);
        let _ = tmux::kill_session(&session);

        // 3. Remove worktree (如果存在)
        if Path::new(&task.worktree_path).exists() {
            if let Err(e) = git::remove_worktree(&self.project.project_path, &task.worktree_path) {
                self.show_toast(format!("Failed to remove worktree: {}", e));
                return;
            }
        }

        // 4. Delete branch
        if let Err(e) = git::delete_branch(&self.project.project_path, &task.branch) {
            self.show_toast(format!("Failed to delete branch: {}", e));
            return;
        }

        // 5. 重新创建 branch 和 worktree (从 target)
        let worktree_path = Path::new(&task.worktree_path);
        if let Err(e) = git::create_worktree(
            &self.project.project_path,
            &task.branch,
            worktree_path,
            &task.target,
        ) {
            self.show_toast(format!("Failed to recreate worktree: {}", e));
            return;
        }

        // 5.5. 自动设置 AI 集成
        {
            let cfg = storage::config::load_config();
            crate::cli::init::setup_worktree(
                worktree_path.to_str().unwrap_or("."),
                &cfg.layout.context_docs,
            );
        }

        // 6. 更新 task metadata (updated_at)
        if let Err(e) = tasks::touch_task(&self.project.project_key, task_id) {
            // 只是警告，不中断流程
            eprintln!("Warning: Failed to update task: {}", e);
        }

        // 7. 创建新的 tmux session
        let session_env = self.build_session_env(
            &task.id,
            &task.name,
            &task.branch,
            &task.target,
            &task.worktree_path,
        );
        if let Err(e) = tmux::create_session(&session, &task.worktree_path, Some(&session_env)) {
            self.show_toast(format!("Failed to create session: {}", e));
            return;
        }

        // 8. 刷新数据
        self.project.refresh();
        self.show_toast("Task reset");

        // 9. 自动进入 session
        self.pending_tmux_attach = Some(session);
    }

    // ========== 弹窗操作 ==========

    /// 确认弱确认弹窗
    pub fn confirm_dialog_yes(&mut self) {
        if let Some(action) = self.pending_action.take() {
            self.confirm_dialog = None;
            match action {
                PendingAction::Archive { task_id } => self.do_archive(&task_id),
                PendingAction::Clean {
                    task_id,
                    is_archived,
                } => self.do_clean(&task_id, is_archived),
                PendingAction::RebaseTo { .. } => {} // RebaseTo 不使用确认弹窗
                PendingAction::Checkout => {}        // Checkout 不使用确认弹窗
                PendingAction::Recover { task_id } => self.recover_worktree(&task_id),
                PendingAction::Sync {
                    task_id,
                    check_target,
                } => {
                    if check_target {
                        self.check_sync_target(&task_id);
                    } else {
                        self.do_sync(&task_id);
                    }
                }
                PendingAction::Merge {
                    task_id,
                    check_target,
                } => {
                    if check_target {
                        self.check_merge_target(&task_id);
                    } else {
                        self.open_merge_dialog(&task_id);
                    }
                }
                PendingAction::MergeArchive { task_id } => self.do_archive(&task_id),
                PendingAction::Reset { task_id } => self.do_reset(&task_id),
                PendingAction::ExitSession => {
                    self.should_quit = true;
                }
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
        let confirmed = self
            .input_confirm_dialog
            .as_ref()
            .map(|d| d.is_confirmed())
            .unwrap_or(false);

        if confirmed {
            if let Some(action) = self.pending_action.take() {
                self.input_confirm_dialog = None;
                if let PendingAction::Clean {
                    task_id,
                    is_archived,
                } = action
                {
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
        let Some(wt) = worktrees.get(index) else {
            return;
        };

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

        // 自动设置 AI 集成
        {
            let cfg = storage::config::load_config();
            crate::cli::init::setup_worktree(
                worktree_path.to_str().unwrap_or("."),
                &cfg.layout.context_docs,
            );
        }

        // 移回 tasks.toml
        if let Err(e) = tasks::recover_task(&self.project.project_key, task_id) {
            self.show_toast(format!("Recover failed: {}", e));
            return;
        }

        // 创建 session
        let session = tmux::session_name(&self.project.project_key, task_id);
        let session_env = self.build_session_env(
            &task.id,
            &task.name,
            &task.branch,
            &task.target,
            &task.worktree_path,
        );
        if let Err(e) =
            tmux::create_session(&session, task.worktree_path.as_str(), Some(&session_env))
        {
            self.show_toast(format!("Session error: {}", e));
            return;
        }

        // 刷新数据并进入
        self.project.refresh();
        self.show_toast("Task recovered");
        self.pending_tmux_attach = Some(session);
    }

    // ========== Checkout 功能 ==========

    /// 打开 Checkout 分支选择器（在主仓库执行 checkout）
    pub fn open_checkout_selector(&mut self) {
        // 获取所有分支
        let branches = match git::list_branches(&self.project.project_path) {
            Ok(b) => b,
            Err(e) => {
                self.show_toast(format!("Failed to list branches: {}", e));
                return;
            }
        };

        // 获取当前分支
        let current_branch = git::current_branch(&self.project.project_path)
            .unwrap_or_else(|_| "unknown".to_string());

        // 设置 pending action
        self.pending_action = Some(PendingAction::Checkout);

        // 打开选择器
        self.branch_selector = Some(BranchSelectorData::new_checkout(branches, current_branch));
    }

    // ========== Rebase To 功能 ==========

    /// 打开分支选择器
    pub fn open_branch_selector(&mut self) {
        // 获取当前选中的 worktree
        let selected = self.project.current_list_state().selected();
        let Some(index) = selected else { return };

        let worktrees = self.project.current_worktrees();
        let Some(wt) = worktrees.get(index) else {
            return;
        };

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
        let selected_branch = self
            .branch_selector
            .as_ref()
            .and_then(|d| d.selected_branch())
            .map(|s| s.to_string());

        let Some(branch) = selected_branch else {
            self.branch_selector = None;
            return;
        };

        match self.pending_action.take() {
            Some(PendingAction::RebaseTo { task_id }) => {
                // 更新 task target
                if let Err(e) =
                    tasks::update_task_target(&self.project.project_key, &task_id, &branch)
                {
                    self.show_toast(format!("Failed to update target: {}", e));
                } else {
                    self.project.refresh();
                    self.show_toast(format!("Target changed to {}", branch));
                }
            }
            Some(PendingAction::Checkout) => {
                // 在主仓库执行 checkout
                match git::has_uncommitted_changes(&self.project.project_path) {
                    Ok(true) => {
                        self.show_toast("Cannot checkout: uncommitted changes".to_string());
                    }
                    Ok(false) => {
                        match git::checkout_branch(&self.project.project_path, &branch) {
                            Ok(_) => {
                                // 使缓存失效
                                git::cache::invalidate_prefix(&format!(
                                    "branch:{}",
                                    self.project.project_path
                                ));
                                self.project.refresh();
                                self.show_toast(format!("Switched to {}", branch));
                            }
                            Err(e) => {
                                self.show_toast(format!("Checkout failed: {}", e));
                            }
                        }
                    }
                    Err(e) => {
                        self.show_toast(format!("Error: {}", e));
                    }
                }
            }
            _ => {}
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
        let Some(wt) = worktrees.get(index) else {
            return;
        };

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
                self.pending_action = Some(PendingAction::Sync {
                    task_id,
                    check_target: true,
                });
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
                self.pending_action = Some(PendingAction::Sync {
                    task_id: task_id.to_string(),
                    check_target: false,
                });
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
        let Some(wt) = worktrees.get(index) else {
            return;
        };

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
                self.pending_action = Some(PendingAction::Merge {
                    task_id,
                    check_target: true,
                });
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
                self.pending_action = Some(PendingAction::Merge {
                    task_id: task_id.to_string(),
                    check_target: false,
                });
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

    /// 执行 Merge（后台线程）
    fn do_merge(&mut self, task_id: &str, method: MergeMethod) {
        // 获取 task 信息
        let task = match tasks::get_task(&self.project.project_key, task_id) {
            Ok(Some(t)) => t,
            _ => {
                self.show_toast("Task not found");
                return;
            }
        };

        // 设置 loading 状态
        self.loading_message = Some("Merging...".to_string());

        // 准备后台线程需要的数据
        let repo_path = self.project.project_path.clone();
        let branch = task.branch.clone();
        let task_name = task.name.clone();
        let task_id = task_id.to_string();

        let (tx, rx) = mpsc::channel();
        self.bg_result_rx = Some(rx);

        std::thread::spawn(move || {
            let result = match method {
                MergeMethod::Squash => {
                    // Squash merge + commit; rollback on commit failure
                    git::merge_squash(&repo_path, &branch).and_then(|()| {
                        git::commit(&repo_path, &task_name).inspect_err(|_| {
                            let _ = git::reset_merge(&repo_path);
                        })
                    })
                }
                MergeMethod::MergeCommit => {
                    let message = format!("Merge: {}", task_name);
                    git::merge_no_ff(&repo_path, &branch, &message)
                }
            };

            let bg_result = match result {
                Ok(()) => BgResult::MergeOk { task_id, task_name },
                Err(e) => BgResult::MergeErr(e),
            };
            let _ = tx.send(bg_result);
        });
    }

    /// 处理后台操作结果（主循环调用）
    pub fn poll_bg_result(&mut self) {
        let result = self.bg_result_rx.as_ref().and_then(|rx| rx.try_recv().ok());
        if let Some(result) = result {
            self.bg_result_rx = None;
            self.loading_message = None;

            match result {
                BgResult::MergeOk { task_id, task_name } => {
                    self.project.refresh();
                    self.pending_action = Some(PendingAction::MergeArchive { task_id });
                    self.confirm_dialog = Some(ConfirmType::MergeSuccess { task_name });
                }
                BgResult::MergeErr(e) => {
                    self.show_toast(e);
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

    // ========== Action Palette 功能 ==========

    /// 打开 Action Palette
    pub fn open_action_palette(&mut self) {
        // 检查是否有选中的任务
        if self.project.current_list_state().selected().is_none() {
            return;
        }

        // 根据当前 Tab 决定可用 actions
        let actions = match self.project.current_tab {
            ProjectTab::Archived => vec![ActionType::Clean, ActionType::Recover],
            ProjectTab::Current => vec![
                ActionType::Commit,
                ActionType::Archive,
                ActionType::Clean,
                ActionType::RebaseTo,
                ActionType::Sync,
                ActionType::Merge,
                ActionType::Reset,
            ],
            ProjectTab::Other => vec![
                ActionType::Commit,
                ActionType::Archive,
                ActionType::Clean,
                ActionType::RebaseTo,
                ActionType::Sync,
                ActionType::Reset,
            ],
        };

        self.action_palette = Some(ActionPaletteData::new(actions));
    }

    /// Action Palette - 向上移动
    pub fn action_palette_prev(&mut self) {
        if let Some(ref mut palette) = self.action_palette {
            palette.select_prev();
        }
    }

    /// Action Palette - 向下移动
    pub fn action_palette_next(&mut self) {
        if let Some(ref mut palette) = self.action_palette {
            palette.select_next();
        }
    }

    /// Action Palette - 输入字符
    pub fn action_palette_char(&mut self, c: char) {
        if let Some(ref mut palette) = self.action_palette {
            palette.push_char(c);
        }
    }

    /// Action Palette - 删除字符
    pub fn action_palette_backspace(&mut self) {
        if let Some(ref mut palette) = self.action_palette {
            palette.pop_char();
        }
    }

    /// Action Palette - 确认执行
    pub fn action_palette_confirm(&mut self) {
        let action = self
            .action_palette
            .as_ref()
            .and_then(|p| p.selected_action());

        self.action_palette = None;

        if let Some(action) = action {
            match action {
                ActionType::Archive => self.start_archive(),
                ActionType::Clean => self.start_clean(),
                ActionType::RebaseTo => self.open_branch_selector(),
                ActionType::Sync => self.start_sync(),
                ActionType::Merge => self.start_merge(),
                ActionType::Recover => self.start_recover(),
                ActionType::Commit => self.open_commit_dialog(),
                ActionType::Reset => self.start_reset(),
            }
        }
    }

    /// Action Palette - 取消
    pub fn action_palette_cancel(&mut self) {
        self.action_palette = None;
    }

    // ========== Commit Dialog 功能 ==========

    /// 打开 Commit 弹窗
    pub fn open_commit_dialog(&mut self) {
        // 获取当前选中的 worktree
        let worktrees = self.project.filtered_worktrees();
        let selected_idx = self.project.current_list_state().selected();

        if let Some(idx) = selected_idx {
            if let Some(worktree) = worktrees.get(idx) {
                self.commit_dialog = Some(CommitDialogData::new(
                    worktree.task_name.clone(),
                    worktree.path.clone(),
                ));
            }
        }
    }

    /// Commit Dialog - 输入字符
    pub fn commit_dialog_char(&mut self, c: char) {
        if let Some(ref mut dialog) = self.commit_dialog {
            dialog.message.push(c);
        }
    }

    /// Commit Dialog - 删除字符
    pub fn commit_dialog_backspace(&mut self) {
        if let Some(ref mut dialog) = self.commit_dialog {
            dialog.message.pop();
        }
    }

    /// Commit Dialog - 取消
    pub fn commit_dialog_cancel(&mut self) {
        self.commit_dialog = None;
    }

    /// Commit Dialog - 确认提交
    pub fn commit_dialog_confirm(&mut self) {
        let dialog = self.commit_dialog.take();

        if let Some(dialog) = dialog {
            if dialog.message.trim().is_empty() {
                self.show_toast("Commit message cannot be empty");
                return;
            }

            // 执行 git add -A && git commit
            let result = git::add_and_commit(&dialog.worktree_path, &dialog.message);

            match result {
                Ok(_) => {
                    self.show_toast("Committed successfully");
                    // 刷新 worktree 列表
                    self.project.refresh();
                }
                Err(e) => {
                    self.show_toast(format!("Commit failed: {}", e));
                }
            }
        }
    }
    // ========== Config Panel 功能 ==========

    /// 打开 Config 配置面板
    pub fn open_config_panel(&mut self) {
        let config = storage::config::load_config();
        self.config_panel = Some(ConfigPanelData::new(&config.layout));
    }

    /// Config Panel - 上移选择
    pub fn config_panel_prev(&mut self) {
        if let Some(ref mut panel) = self.config_panel {
            match panel.step {
                ConfigStep::Main => {
                    if panel.main_selected == 0 {
                        panel.main_selected = 2;
                    } else {
                        panel.main_selected -= 1;
                    }
                }
                ConfigStep::AgentMenu => {
                    if panel.agent_menu_selected == 0 {
                        panel.agent_menu_selected = 1;
                    } else {
                        panel.agent_menu_selected -= 1;
                    }
                }
                ConfigStep::SelectLayout => {
                    // 5 presets + 1 custom = 6 items
                    let count = TaskLayout::all().len() + 1;
                    if panel.layout_selected == 0 {
                        panel.layout_selected = count - 1;
                    } else {
                        panel.layout_selected -= 1;
                    }
                }
                ConfigStep::CustomChoose => {
                    // 6 logical items: 0=SplitH, 1=SplitV, 2=Agent, 3=Grove, 4=Shell, 5=Custom
                    if panel.custom_choose_selected == 0 {
                        panel.custom_choose_selected = 5;
                    } else {
                        panel.custom_choose_selected -= 1;
                    }
                }
                ConfigStep::HookWizard => {
                    panel.hook_data.select_prev();
                }
                ConfigStep::SelectContextDocs
                | ConfigStep::EditAgentCommand
                | ConfigStep::CustomPaneCommand => {}
            }
        }
    }

    /// Config Panel - 下移选择
    pub fn config_panel_next(&mut self) {
        if let Some(ref mut panel) = self.config_panel {
            match panel.step {
                ConfigStep::Main => {
                    panel.main_selected = (panel.main_selected + 1) % 3;
                }
                ConfigStep::AgentMenu => {
                    panel.agent_menu_selected = (panel.agent_menu_selected + 1) % 2;
                }
                ConfigStep::SelectLayout => {
                    let count = TaskLayout::all().len() + 1;
                    panel.layout_selected = (panel.layout_selected + 1) % count;
                }
                ConfigStep::CustomChoose => {
                    panel.custom_choose_selected = (panel.custom_choose_selected + 1) % 6;
                }
                ConfigStep::HookWizard => {
                    panel.hook_data.select_next();
                }
                ConfigStep::EditAgentCommand
                | ConfigStep::SelectContextDocs
                | ConfigStep::CustomPaneCommand => {}
            }
        }
    }

    /// Config Panel - 确认
    pub fn config_panel_confirm(&mut self) {
        let step = self.config_panel.as_ref().map(|p| p.step.clone());
        match step {
            Some(ConfigStep::Main) => {
                if let Some(ref mut panel) = self.config_panel {
                    match panel.main_selected {
                        0 => panel.step = ConfigStep::AgentMenu,
                        1 => panel.step = ConfigStep::SelectLayout,
                        2 => {
                            panel.step = ConfigStep::HookWizard;
                            panel.hook_data =
                                crate::ui::components::hook_panel::HookConfigData::new();
                        }
                        _ => {}
                    }
                }
            }
            Some(ConfigStep::AgentMenu) => {
                if let Some(ref mut panel) = self.config_panel {
                    match panel.agent_menu_selected {
                        0 => panel.step = ConfigStep::EditAgentCommand,
                        1 => panel.step = ConfigStep::SelectContextDocs,
                        _ => {}
                    }
                }
            }
            Some(ConfigStep::EditAgentCommand) => {
                self.config_save_agent_command();
            }
            Some(ConfigStep::SelectLayout) => {
                // Check if Custom... is selected
                let is_custom = self
                    .config_panel
                    .as_ref()
                    .map(|p| p.layout_selected == TaskLayout::all().len())
                    .unwrap_or(false);

                if is_custom {
                    // Enter custom layout builder
                    if let Some(ref mut panel) = self.config_panel {
                        panel.step = ConfigStep::CustomChoose;
                        panel.custom_build_path = Vec::new();
                        panel.custom_build_root = None;
                        panel.custom_choose_selected = 3; // default to Agent
                    }
                } else {
                    self.config_save_layout();
                }
            }
            Some(ConfigStep::CustomChoose) => {
                self.config_custom_choose_confirm();
            }
            Some(ConfigStep::CustomPaneCommand) => {
                self.config_custom_pane_command_confirm();
            }
            Some(ConfigStep::HookWizard) => {
                let is_result = self
                    .config_panel
                    .as_ref()
                    .map(|p| p.hook_data.step == HookConfigStep::ShowResult)
                    .unwrap_or(false);

                if is_result {
                    // 结果页面，返回主菜单
                    if let Some(ref mut panel) = self.config_panel {
                        panel.step = ConfigStep::Main;
                    }
                } else if let Some(ref mut panel) = self.config_panel {
                    panel.hook_data.confirm();

                    // 如果进入结果页，复制到剪贴板
                    if panel.hook_data.step == HookConfigStep::ShowResult {
                        if let Ok(mut clipboard) = arboard::Clipboard::new() {
                            let _ = clipboard.set_text(&panel.hook_data.generated_command);
                        }
                    }
                }
            }
            Some(ConfigStep::SelectContextDocs) => {
                self.config_save_context_docs();
            }
            None => {}
        }
    }

    /// Config Panel - 返回/取消
    pub fn config_panel_back(&mut self) {
        let step = self.config_panel.as_ref().map(|p| p.step.clone());
        match step {
            Some(ConfigStep::Main) => {
                self.config_panel = None;
            }
            Some(ConfigStep::AgentMenu) | Some(ConfigStep::SelectLayout) => {
                if let Some(ref mut panel) = self.config_panel {
                    panel.step = ConfigStep::Main;
                }
            }
            Some(ConfigStep::EditAgentCommand) | Some(ConfigStep::SelectContextDocs) => {
                // 返回 Agent 子菜单
                if let Some(ref mut panel) = self.config_panel {
                    panel.step = ConfigStep::AgentMenu;
                }
            }
            Some(ConfigStep::CustomChoose) => {
                if let Some(ref mut panel) = self.config_panel {
                    if panel.custom_build_path.is_empty() {
                        // 回到 layout 选择
                        panel.step = ConfigStep::SelectLayout;
                        panel.custom_build_root = None;
                    } else {
                        // 回退到上一层：撤销当前路径上的节点，恢复为 Placeholder
                        panel.custom_build_path.pop();
                        // 将当前路径位置的节点重置为 Placeholder
                        if let Some(ref mut root) = panel.custom_build_root {
                            layout_mod::set_node_at_path(
                                root,
                                &panel.custom_build_path,
                                LayoutNode::Placeholder,
                            );
                        }
                    }
                }
            }
            Some(ConfigStep::CustomPaneCommand) => {
                if let Some(ref mut panel) = self.config_panel {
                    panel.step = ConfigStep::CustomChoose;
                    panel.custom_cmd_input.clear();
                    panel.custom_cmd_cursor = 0;
                }
            }
            Some(ConfigStep::HookWizard) => {
                let hook_step = self.config_panel.as_ref().map(|p| p.hook_data.step);

                match hook_step {
                    Some(HookConfigStep::SelectLevel) | Some(HookConfigStep::ShowResult) => {
                        // 返回 config 主菜单
                        if let Some(ref mut panel) = self.config_panel {
                            panel.step = ConfigStep::Main;
                        }
                    }
                    _ => {
                        if let Some(ref mut panel) = self.config_panel {
                            panel.hook_data.back();
                        }
                    }
                }
            }
            None => {}
        }
    }

    /// Config Panel - agent 命令输入字符
    pub fn config_agent_input_char(&mut self, c: char) {
        if let Some(ref mut panel) = self.config_panel {
            panel.agent_input.push(c);
            panel.agent_cursor = panel.agent_input.len();
        }
    }

    /// Config Panel - agent 命令删除字符
    pub fn config_agent_delete_char(&mut self) {
        if let Some(ref mut panel) = self.config_panel {
            panel.agent_input.pop();
            panel.agent_cursor = panel.agent_input.len();
        }
    }

    /// Config Panel - Hook 复制命令
    pub fn config_hook_copy(&mut self) {
        if let Some(ref panel) = self.config_panel {
            if panel.step == ConfigStep::HookWizard
                && panel.hook_data.step == HookConfigStep::ShowResult
            {
                if let Ok(mut clipboard) = arboard::Clipboard::new() {
                    let _ = clipboard.set_text(&panel.hook_data.generated_command);
                    self.show_toast("Copied to clipboard");
                }
            }
        }
    }

    /// 保存 agent 命令到 config
    fn config_save_agent_command(&mut self) {
        let cmd = self
            .config_panel
            .as_ref()
            .map(|p| p.agent_input.trim().to_string())
            .unwrap_or_default();

        // 更新内存状态
        self.agent_command = cmd.clone();

        // 保存到文件
        let mut config = storage::config::load_config();
        config.layout.agent_command = if cmd.is_empty() { None } else { Some(cmd) };
        let _ = storage::config::save_config(&config);

        // 返回 Agent 子菜单
        if let Some(ref mut panel) = self.config_panel {
            panel.step = ConfigStep::AgentMenu;
        }
        self.show_toast("Agent command saved");
    }

    /// 保存布局到 config
    fn config_save_layout(&mut self) {
        let layout = self
            .config_panel
            .as_ref()
            .and_then(|p| TaskLayout::all().get(p.layout_selected).cloned())
            .unwrap_or(TaskLayout::Single);

        let label = layout.label().to_string();

        // 更新内存状态
        self.task_layout = layout.clone();

        // 保存到文件
        let mut config = storage::config::load_config();
        config.layout.default = layout.name().to_string();
        let _ = storage::config::save_config(&config);

        // 返回主菜单
        if let Some(ref mut panel) = self.config_panel {
            panel.step = ConfigStep::Main;
        }
        self.show_toast(format!("Layout: {}", label));
    }

    /// Custom Choose 确认选择
    fn config_custom_choose_confirm(&mut self) {
        let (selected, can_split) = {
            let panel = match self.config_panel.as_ref() {
                Some(p) => p,
                None => return,
            };
            let current_panes = panel
                .custom_build_root
                .as_ref()
                .map(|r| r.pane_count())
                .unwrap_or(1);
            let can_split = current_panes < crate::ui::components::config_panel::CUSTOM_MAX_PANES;
            (panel.custom_choose_selected, can_split)
        };

        match selected {
            // 0 = Split Horizontal, 1 = Split Vertical
            0 | 1 => {
                if !can_split {
                    return;
                }
                let dir = if selected == 0 {
                    SplitDirection::Horizontal
                } else {
                    SplitDirection::Vertical
                };
                let node = LayoutNode::Split {
                    dir,
                    ratio: 50,
                    first: Box::new(LayoutNode::Placeholder),
                    second: Box::new(LayoutNode::Placeholder),
                };

                if let Some(ref mut panel) = self.config_panel {
                    let path = panel.custom_build_path.clone();
                    if panel.custom_build_root.is_none() {
                        panel.custom_build_root = Some(node);
                    } else if let Some(ref mut root) = panel.custom_build_root {
                        layout_mod::set_node_at_path(root, &path, node);
                    }
                    // 自动推进到 first child
                    self.config_custom_advance();
                }
            }
            // 2 = Agent, 3 = Grove, 4 = Shell
            2..=4 => {
                let role = match selected {
                    2 => PaneRole::Agent,
                    3 => PaneRole::Grove,
                    4 => PaneRole::Shell,
                    _ => unreachable!(),
                };
                let node = LayoutNode::Pane { pane: role };
                self.config_custom_set_leaf(node);
            }
            // 5 = Custom command
            5 => {
                if let Some(ref mut panel) = self.config_panel {
                    panel.step = ConfigStep::CustomPaneCommand;
                    panel.custom_cmd_input.clear();
                    panel.custom_cmd_cursor = 0;
                }
            }
            _ => {}
        }
    }

    /// Custom Pane Command 确认
    fn config_custom_pane_command_confirm(&mut self) {
        let cmd = self
            .config_panel
            .as_ref()
            .map(|p| p.custom_cmd_input.trim().to_string())
            .unwrap_or_default();

        if cmd.is_empty() {
            return;
        }

        let node = LayoutNode::Pane {
            pane: PaneRole::Custom(cmd),
        };

        if let Some(ref mut panel) = self.config_panel {
            panel.step = ConfigStep::CustomChoose;
        }

        self.config_custom_set_leaf(node);
    }

    /// 设置叶子节点并推进
    fn config_custom_set_leaf(&mut self, node: LayoutNode) {
        if let Some(ref mut panel) = self.config_panel {
            let path = panel.custom_build_path.clone();
            if panel.custom_build_root.is_none() {
                // Root is a single pane
                panel.custom_build_root = Some(node);
            } else if let Some(ref mut root) = panel.custom_build_root {
                layout_mod::set_node_at_path(root, &path, node);
            }
        }
        self.config_custom_advance();
    }

    /// 推进到下一个待配置节点，如果全部完成则保存
    fn config_custom_advance(&mut self) {
        let next = self
            .config_panel
            .as_ref()
            .and_then(|p| p.custom_build_root.as_ref())
            .and_then(layout_mod::next_incomplete_path);

        if let Some(path) = next {
            if let Some(ref mut panel) = self.config_panel {
                panel.custom_build_path = path;
                panel.custom_choose_selected = 3; // default to Agent
                panel.step = ConfigStep::CustomChoose;
            }
        } else {
            // 全部配置完毕 → 保存
            self.config_save_custom_layout();
        }
    }

    /// 保存自定义布局
    fn config_save_custom_layout(&mut self) {
        let root = self
            .config_panel
            .as_ref()
            .and_then(|p| p.custom_build_root.clone());

        let Some(root) = root else {
            return;
        };

        // 更新内存状态
        self.task_layout = TaskLayout::Custom;
        self.custom_layout = Some(CustomLayout { root: root.clone() });

        // 保存到文件
        let mut config = storage::config::load_config();
        config.layout.default = "custom".to_string();
        let tree_json = serde_json::to_string(&root).unwrap_or_default();
        config.layout.custom = Some(storage::config::CustomLayoutConfig { tree: tree_json });
        let _ = storage::config::save_config(&config);

        // 返回主菜单
        if let Some(ref mut panel) = self.config_panel {
            panel.step = ConfigStep::Main;
        }
        self.show_toast("Layout: Custom");
    }

    /// Custom layout 命令输入字符
    pub fn config_custom_cmd_input_char(&mut self, c: char) {
        if let Some(ref mut panel) = self.config_panel {
            panel.custom_cmd_input.push(c);
            panel.custom_cmd_cursor = panel.custom_cmd_input.len();
        }
    }

    /// Custom layout 命令删除字符
    pub fn config_custom_cmd_delete_char(&mut self) {
        if let Some(ref mut panel) = self.config_panel {
            panel.custom_cmd_input.pop();
            panel.custom_cmd_cursor = panel.custom_cmd_input.len();
        }
    }

    /// 保存 context docs 到 config
    pub fn config_save_context_docs(&mut self) {
        let docs = if let Some(ref panel) = self.config_panel {
            let mut docs: Vec<String> = Vec::new();
            let presets = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
            for (i, name) in presets.iter().enumerate() {
                if panel.context_docs_selected[i] {
                    docs.push(name.to_string());
                }
            }
            if panel.context_docs_custom_enabled && !panel.context_docs_custom_name.is_empty() {
                docs.push(panel.context_docs_custom_name.clone());
            }
            docs
        } else {
            return;
        };

        // 保存到文件
        let mut config = storage::config::load_config();
        config.layout.context_docs = docs;
        let _ = storage::config::save_config(&config);

        // 返回 Agent 子菜单
        if let Some(ref mut panel) = self.config_panel {
            panel.step = ConfigStep::AgentMenu;
        }
        self.show_toast("Context docs saved");
    }

    // ========== Monitor 操作 ==========

    /// Monitor - 执行选中的操作
    pub fn monitor_execute_action(&mut self) {
        let all = MonitorAction::all();
        let action = all[self.monitor.action_selected];
        match action {
            MonitorAction::Commit => {
                let worktree_path = self.monitor.worktree_path.clone();
                let task_name = self.monitor.task_name.clone();
                if worktree_path.is_empty() {
                    self.show_toast("No worktree path");
                    return;
                }
                self.commit_dialog = Some(CommitDialogData::new(task_name, worktree_path));
            }
            MonitorAction::Sync => {
                self.monitor_sync();
            }
            MonitorAction::Merge => {
                let task_id = self.monitor.task_id.clone();
                let task_name = self.monitor.task_name.clone();
                let branch = self.monitor.branch.clone();
                let target = self.monitor.target.clone();
                self.merge_dialog = Some(MergeDialogData::new(task_id, task_name, branch, target));
            }
            MonitorAction::Archive => {
                let task_name = self.monitor.task_name.clone();
                let branch = self.monitor.branch.clone();
                self.confirm_dialog = Some(ConfirmType::ArchiveUnmerged { task_name, branch });
            }
            MonitorAction::Clean => {
                let task_name = self.monitor.task_name.clone();
                let branch = self.monitor.branch.clone();
                // Clean 始终强确认
                self.input_confirm_dialog = Some(InputConfirmData::new(task_name, branch));
                self.pending_action = Some(PendingAction::Clean {
                    task_id: self.monitor.task_id.clone(),
                    is_archived: false,
                });
            }
            MonitorAction::Notes => {
                self.monitor.request_notes_edit();
            }
            MonitorAction::Leave => {
                // tmux detach-client — 脱离整个 tmux session
                let _ = std::process::Command::new("tmux")
                    .args(["detach-client"])
                    .status();
            }
            MonitorAction::Exit => {
                let session_name =
                    tmux::session_name(&self.monitor.project_key, &self.monitor.task_id);
                self.confirm_dialog = Some(
                    crate::ui::components::confirm_dialog::ConfirmType::ExitSession {
                        session_name,
                    },
                );
                self.pending_action = Some(PendingAction::ExitSession);
            }
        }
    }

    /// Monitor - Sync：从 target rebase
    fn monitor_sync(&mut self) {
        let worktree_path = self.monitor.worktree_path.clone();
        let target = self.monitor.target.clone();
        if worktree_path.is_empty() || target.is_empty() {
            self.show_toast("Missing worktree or target");
            return;
        }
        match git::rebase(&worktree_path, &target) {
            Ok(()) => {
                self.show_toast("Synced from target");
                self.monitor.refresh_panel_data();
            }
            Err(e) => self.show_toast(format!("Sync failed: {}", e)),
        }
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

/// 加载所有项目的通知数据（自动清理不存在的 task）
fn load_all_project_notifications(
    projects: &[ProjectInfo],
) -> HashMap<String, HashMap<String, NotificationLevel>> {
    let mut result = HashMap::new();
    for project in projects {
        let project_name = Path::new(&project.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let hooks_file = hooks::load_hooks_with_cleanup(&project.path);
        if !hooks_file.tasks.is_empty() {
            result.insert(project_name, hooks_file.tasks);
        }
    }
    result
}
