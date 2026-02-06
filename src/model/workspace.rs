//! Workspace 状态管理
//! 管理项目列表和 UI 状态

use chrono::{DateTime, Utc};

use crate::session;
use crate::storage::workspace::{self as storage, project_hash};
use crate::storage::{config, tasks};

/// 项目信息（带运行时统计）
#[derive(Debug, Clone)]
#[allow(dead_code)]
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

/// Workspace 状态
#[derive(Debug, Default)]
pub struct WorkspaceState {
    /// 项目列表
    pub projects: Vec<ProjectInfo>,
    /// 当前选中项目的索引（在过滤列表中的索引）
    pub selected_index: Option<usize>,
    /// 网格列数（渲染时更新）
    pub grid_cols: usize,
    /// 网格滚动偏移（以行为单位）
    pub grid_scroll: usize,
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
        if !self.filtered_indices.is_empty() && self.selected_index.is_none() {
            self.selected_index = Some(0);
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
        self.selected_index
            .and_then(|i| self.filtered_indices.get(i))
            .and_then(|&i| self.projects.get(i))
    }

    /// 向右移动选择
    pub fn select_right(&mut self) {
        let count = self.filtered_indices.len();
        if count == 0 {
            return;
        }
        let i = self.selected_index.unwrap_or(0);
        self.selected_index = Some((i + 1) % count);
    }

    /// 向左移动选择
    pub fn select_left(&mut self) {
        let count = self.filtered_indices.len();
        if count == 0 {
            return;
        }
        let i = self.selected_index.unwrap_or(0);
        self.selected_index = Some(if i == 0 { count - 1 } else { i - 1 });
    }

    /// 向下移动选择（下一行同列）
    pub fn select_down(&mut self) {
        let count = self.filtered_indices.len();
        let cols = self.grid_cols.max(1);
        if count == 0 {
            return;
        }
        let i = self.selected_index.unwrap_or(0);
        let next = i + cols;
        if next >= count {
            // 回到同列第一行
            let col = i % cols;
            self.selected_index = Some(if col < count { col } else { 0 });
        } else {
            self.selected_index = Some(next);
        }
    }

    /// 向上移动选择（上一行同列）
    pub fn select_up(&mut self) {
        let count = self.filtered_indices.len();
        let cols = self.grid_cols.max(1);
        if count == 0 {
            return;
        }
        let i = self.selected_index.unwrap_or(0);
        if i < cols {
            // 在第一行，跳到最后一行同列
            let col = i;
            let last_row_start = (count.saturating_sub(1)) / cols * cols;
            let target = last_row_start + col;
            self.selected_index = Some(if target < count {
                target
            } else {
                // 最后一行该列没有项目，退回上一行
                target.saturating_sub(cols)
            });
        } else {
            self.selected_index = Some(i - cols);
        }
    }

    /// 向下移动选择（线性，用于搜索模式）
    pub fn select_next(&mut self) {
        self.select_right();
    }

    /// 向上移动选择（线性，用于搜索模式）
    pub fn select_previous(&mut self) {
        self.select_left();
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
            self.selected_index = Some(0);
        }
    }

    /// 添加搜索字符
    pub fn search_push(&mut self, c: char) {
        self.search_query.push(c);
        self.rebuild_filter();
        // 重置选择到第一个
        if !self.filtered_indices.is_empty() {
            self.selected_index = Some(0);
        } else {
            self.selected_index = None;
        }
    }

    /// 删除搜索字符
    pub fn search_pop(&mut self) {
        self.search_query.pop();
        self.rebuild_filter();
        if !self.filtered_indices.is_empty() {
            self.selected_index = Some(0);
        }
    }

    /// 刷新数据（重新加载项目列表）
    pub fn refresh(&mut self) {
        self.reload_projects();
    }

    /// 确保选中项在可见区域内，更新 grid_scroll
    pub fn ensure_visible(&mut self, visible_rows: usize) {
        if visible_rows == 0 || self.grid_cols == 0 {
            return;
        }
        if let Some(idx) = self.selected_index {
            let row = idx / self.grid_cols;
            if row < self.grid_scroll {
                self.grid_scroll = row;
            } else if row >= self.grid_scroll + visible_rows {
                self.grid_scroll = row - visible_rows + 1;
            }
        }
    }
}

/// 计算任务数量
/// project_key: 项目路径的 hash，用于加载任务数据
fn count_tasks(project_key: &str) -> (usize, usize) {
    let active_tasks = tasks::load_tasks(project_key).unwrap_or_default();
    let task_count = active_tasks.len();

    let global_mux = config::load_config().multiplexer;

    // 计算 live 数量（检查 session 是否运行）
    let live_count = active_tasks
        .iter()
        .filter(|t| {
            let task_mux = session::resolve_multiplexer(&t.multiplexer, &global_mux);
            let sname = session::resolve_session_name(&t.session_name, project_key, &t.id);
            session::session_exists(&task_mux, &sname)
        })
        .count();

    (task_count, live_count)
}
