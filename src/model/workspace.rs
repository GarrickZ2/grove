//! Workspace 状态管理
//! 管理项目列表和 UI 状态

use chrono::{DateTime, Utc};
use ratatui::widgets::ListState;

use crate::storage::workspace as storage;
use crate::storage::tasks;

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
#[derive(Debug)]
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

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            list_state: ListState::default(),
            expanded: false,
            detail: None,
            search_mode: false,
            search_query: String::new(),
            filtered_indices: Vec::new(),
        }
    }
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
                // 计算任务数
                let project_name = extract_project_name(&p.path);
                let (task_count, live_count) = count_tasks(&project_name);

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
                    p.name.to_lowercase().contains(&query)
                        || p.path.to_lowercase().contains(&query)
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

    /// 获取当前选中项目的原始索引
    pub fn selected_project_index(&self) -> Option<usize> {
        self.list_state
            .selected()
            .and_then(|i| self.filtered_indices.get(i).copied())
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

        self.detail = self.selected_project().map(|p| load_project_detail(p));
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

    /// 添加项目
    pub fn add_project(&mut self, path: &str) -> Result<(), String> {
        // 检查路径是否存在
        if !std::path::Path::new(path).exists() {
            return Err("Path does not exist".to_string());
        }

        // 检查是否是 git 仓库
        if !crate::git::is_git_repo(path) {
            return Err("Not a git repository".to_string());
        }

        // 获取项目名（从路径提取）
        let name = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        // 添加到存储
        storage::add_project(&name, path)
            .map_err(|e| e.to_string())?;

        // 重新加载
        self.reload_projects();
        Ok(())
    }

    /// 删除当前选中的项目
    pub fn remove_selected_project(&mut self) -> Result<(), String> {
        if let Some(project) = self.selected_project() {
            let path = project.path.clone();
            storage::remove_project(&path)
                .map_err(|e| e.to_string())?;
            self.reload_projects();
            Ok(())
        } else {
            Err("No project selected".to_string())
        }
    }
}

/// 从路径提取项目名
fn extract_project_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string()
}

/// 计算任务数量
fn count_tasks(project_name: &str) -> (usize, usize) {
    let active_tasks = tasks::load_tasks(project_name).unwrap_or_default();
    let task_count = active_tasks.len();

    // 计算 live 数量（检查 tmux session）
    let live_count = active_tasks
        .iter()
        .filter(|t| {
            let session_name = format!("grove-{}-{}", project_name, t.id);
            crate::tmux::session_exists(&session_name)
        })
        .count();

    (task_count, live_count)
}

/// 加载项目详情
fn load_project_detail(project: &ProjectInfo) -> ProjectDetail {
    let project_name = extract_project_name(&project.path);

    // 获取当前分支
    let branch = crate::git::current_branch(&project.path).unwrap_or_else(|_| "unknown".to_string());

    // 格式化添加时间
    let added_at = super::worktree::format_relative_time(project.added_at);

    // 加载活跃任务
    let active_tasks = tasks::load_tasks(&project_name)
        .unwrap_or_default()
        .into_iter()
        .map(|t| {
            let session_name = format!("grove-{}-{}", project_name, t.id);
            let status = if crate::tmux::session_exists(&session_name) {
                WorktreeStatus::Live
            } else {
                WorktreeStatus::Idle
            };

            // 获取变更统计
            let (additions, deletions) = crate::git::file_changes(&t.worktree_path, &t.target)
                .unwrap_or((0, 0));

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
    let archived_tasks = tasks::load_archived_tasks(&project_name)
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
