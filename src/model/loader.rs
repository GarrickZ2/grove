//! 从 Task 元数据加载 Worktree 数据

use std::path::Path;

use crate::git;
use crate::storage::tasks::{self, Task, TaskStatus};
use crate::tmux;

use super::{FileChanges, Worktree, WorktreeStatus};

/// 从 Task 元数据加载 worktree 列表
/// 返回: (current, other, archived)
pub fn load_worktrees(project_path: &str) -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    // 1. 获取项目名
    let project_name = Path::new(project_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    if project_name.is_empty() {
        return (Vec::new(), Vec::new(), Vec::new());
    }

    // 2. 加载 tasks.toml (主数据源)
    let tasks = tasks::load_tasks(&project_name).unwrap_or_default();

    // 3. 获取默认分支
    let default_branch = git::default_branch(project_path).unwrap_or_else(|_| "main".to_string());

    // 4. 转换每个 Task 为 Worktree 并分类
    let mut current = Vec::new();
    let mut other = Vec::new();
    let mut archived = Vec::new();

    for task in tasks {
        let worktree = task_to_worktree(&task, &project_name, &default_branch);

        match task.status {
            TaskStatus::Archived => archived.push(worktree),
            TaskStatus::Active => {
                if task.target == default_branch {
                    current.push(worktree);
                } else {
                    other.push(worktree);
                }
            }
        }
    }

    (current, other, archived)
}

/// 将 Task 转换为 UI Worktree
fn task_to_worktree(task: &Task, project: &str, _default_branch: &str) -> Worktree {
    let path = &task.worktree_path;

    // 检查 worktree 是否存在
    let exists = Path::new(path).exists();

    // 确定状态
    let status = if !exists {
        WorktreeStatus::Broken // worktree 被删除
    } else {
        // 检查 tmux session
        let session = tmux::session_name(project, &task.id);
        if tmux::session_exists(&session) {
            WorktreeStatus::Live
        } else {
            WorktreeStatus::Idle
        }
    };

    // 获取 commits_behind 和 file_changes (仅当 worktree 存在时)
    let (commits_behind, file_changes) = if exists {
        let behind = git::commits_behind(path, &task.branch, &task.target).ok();
        let changes = git::file_changes(path, &task.target)
            .map(|(a, d)| FileChanges::new(a, d))
            .unwrap_or_default();
        (behind, changes)
    } else {
        (None, FileChanges::default())
    };

    Worktree {
        task_name: task.name.clone(),
        branch: task.branch.clone(),
        status,
        commits_behind,
        file_changes,
        archived: task.status == TaskStatus::Archived,
        path: path.clone(),
    }
}
