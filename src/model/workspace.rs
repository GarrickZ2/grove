//! Workspace 状态管理
//! 管理项目列表和 UI 状态

use chrono::{DateTime, Utc};
use ratatui::widgets::ListState;

use crate::storage::tasks;
use crate::storage::workspace::{self as storage, project_hash};

use super::worktree::WorktreeStatus;

/// 项目信息（带运行时统计）
#[derive(Debug, Clone)]
pub struct ProjectInfo {
    /// 项目名称
    pub name: String,
    /// 项目路径
    pub path: String,
    /// 添加时间
    pub added_at: DateTime<Utc>,
    /// 任务总数
    pub task_count: usize,
    /// Live 状态的任务数
    pub live_count: usize,
}

/// 任务摘要（用于详情面板）
#[derive(Debug, Clone)]
pub struct TaskSummary {
    pub id: String,
    pub name: String,
    pub status: WorktreeStatus,
    pub additions: u32,
    pub deletions: u32,
}

/// 项目详情（展开时加载）
#[derive(Debug, Clone)]
pub struct ProjectDetail {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub added_at: String,
    pub active_tasks: Vec<TaskSummary>,
    pub archived_tasks: Vec<TaskSummary>,
}

/// Workspace 状态
#[derive(Debug, Default)]
pub struct WorkspaceState {
    /// 项目列表
    pub projects: Vec<ProjectInfo>,
    /// 列表选择状态
    pub list_state: ListState,
    /// 是否展开详情面板
    pub expanded: bool,
    /// 当前选中项目的详情（展开时加载）
    pub detail: Option<ProjectDetail>,
    /// 搜索模式
    pub search_mode: bool,
    /// 搜索关键词
    pub search_query: String,
    /// 过滤后的索引
    pub filtered_indices: Vec<usize>,
}

impl WorkspaceState {
    /// 创建新的 WorkspaceState
    pub fn new() -> Self {
        let mut state = Self::default();
        state.reload_projects();
        state
    }

    /// 重新加载项目列表
    pub fn reload_projects(&mut self) {
        let registered = storage::load_projects().unwrap_or_default();

        self.projects = registered
            .into_iter()
            .map(|p| {
                // 计算任务数（使用项目路径的 hash 作为存储 key）
                let hash = project_hash(&p.path);
                let (task_count, live_count) = count_tasks(&hash);

                ProjectInfo {
                    name: p.name,
                    path: p.path,
                    added_at: p.added_at,
                    task_count,
                    live_count,
                }
            })
            .collect();

        // 重建过滤索引
        self.rebuild_filter();

        // 如果有项目，选中第一个
        if !self.filtered_indices.is_empty() && self.list_state.selected().is_none() {
            self.list_state.select(Some(0));
        }
    }

    /// 重建过滤索引
    pub fn rebuild_filter(&mut self) {
        if self.search_query.is_empty() {
            self.filtered_indices = (0..self.projects.len()).collect();
        } else {
            let query = self.search_query.to_lowercase();
            self.filtered_indices = self
                .projects
                .iter()
                .enumerate()
                .filter(|(_, p)| {
                    p.name.to_lowercase().contains(&query) || p.path.to_lowercase().contains(&query)
                })
                .map(|(i, _)| i)
                .collect();
        }
    }

    /// 获取过滤后的项目列表
    pub fn filtered_projects(&self) -> Vec<&ProjectInfo> {
        self.filtered_indices
            .iter()
            .filter_map(|&i| self.projects.get(i))
            .collect()
    }

    /// 获取当前选中的项目
    pub fn selected_project(&self) -> Option<&ProjectInfo> {
        self.list_state
            .selected()
            .and_then(|i| self.filtered_indices.get(i))
            .and_then(|&i| self.projects.get(i))
    }

    /// 向下移动选择
    pub fn select_next(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i >= self.filtered_indices.len() - 1 {
                    0
                } else {
                    i + 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
        self.update_detail();
    }

    /// 向上移动选择
    pub fn select_previous(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i == 0 {
                    self.filtered_indices.len() - 1
                } else {
                    i - 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
        self.update_detail();
    }

    /// 切换展开/折叠状态
    pub fn toggle_expand(&mut self) {
        self.expanded = !self.expanded;
        if self.expanded {
            self.update_detail();
        } else {
            self.detail = None;
        }
    }

    /// 更新当前选中项目的详情
    pub fn update_detail(&mut self) {
        if !self.expanded {
            return;
        }

        self.detail = self.selected_project().map(load_project_detail);
    }

    /// 进入搜索模式
    pub fn enter_search_mode(&mut self) {
        self.search_mode = true;
    }

    /// 退出搜索模式
    pub fn exit_search_mode(&mut self) {
        self.search_mode = false;
    }

    /// 清空搜索
    pub fn clear_search(&mut self) {
        self.search_query.clear();
        self.search_mode = false;
        self.rebuild_filter();
        // 重置选择
        if !self.filtered_indices.is_empty() {
            self.list_state.select(Some(0));
        }
    }

    /// 添加搜索字符
    pub fn search_push(&mut self, c: char) {
        self.search_query.push(c);
        self.rebuild_filter();
        // 重置选择到第一个
        if !self.filtered_indices.is_empty() {
            self.list_state.select(Some(0));
        } else {
            self.list_state.select(None);
        }
    }

    /// 删除搜索字符
    pub fn search_pop(&mut self) {
        self.search_query.pop();
        self.rebuild_filter();
        if !self.filtered_indices.is_empty() {
            self.list_state.select(Some(0));
        }
    }
}

/// 计算任务数量
/// project_key: 项目路径的 hash，用于加载任务数据
fn count_tasks(project_key: &str) -> (usize, usize) {
    let active_tasks = tasks::load_tasks(project_key).unwrap_or_default();
    let task_count = active_tasks.len();

    // 计算 live 数量（检查 session 是否运行）
    // 注意：session 名称使用的是任务的 worktree 路径来提取项目名
    let live_count = active_tasks
        .iter()
        .filter(|t| {
            // 从 worktree_path 提取项目名用于 session 命名
            // worktree_path 通常是 ~/.grove/worktrees/<hash>/<task-id>
            // 我们直接使用 project_key 和 task_id 组合
            let session_name = format!("grove-{}-{}", project_key, t.id);
            crate::tmux::session_exists(&session_name)
        })
        .count();

    (task_count, live_count)
}

/// 加载项目详情
fn load_project_detail(project: &ProjectInfo) -> ProjectDetail {
    let project_key = project_hash(&project.path);

    // 获取当前分支
    let branch =
        crate::git::current_branch(&project.path).unwrap_or_else(|_| "unknown".to_string());

    // 格式化添加时间
    let added_at = super::worktree::format_relative_time(project.added_at);

    // 加载活跃任务
    let active_tasks = tasks::load_tasks(&project_key)
        .unwrap_or_default()
        .into_iter()
        .map(|t| {
            let session_name = format!("grove-{}-{}", project_key, t.id);
            let status = if crate::tmux::session_exists(&session_name) {
                WorktreeStatus::Live
            } else {
                WorktreeStatus::Idle
            };

            // 获取变更统计
            let (additions, deletions) =
                crate::git::file_changes(&t.worktree_path, &t.target).unwrap_or((0, 0));

            TaskSummary {
                id: t.id,
                name: t.name,
                status,
                additions,
                deletions,
            }
        })
        .collect();

    // 加载归档任务
    let archived_tasks = tasks::load_archived_tasks(&project_key)
        .unwrap_or_default()
        .into_iter()
        .map(|t| TaskSummary {
            id: t.id,
            name: t.name,
            status: WorktreeStatus::Merged,
            additions: 0,
            deletions: 0,
        })
        .collect();

    ProjectDetail {
        name: project.name.clone(),
        path: project.path.clone(),
        branch,
        added_at,
        active_tasks,
        archived_tasks,
    }
}
