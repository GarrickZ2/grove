//! 从 Task 元数据加载 Worktree 数据

use std::path::Path;

use crate::git;
use crate::storage::tasks::{self, Task, TaskStatus};
use crate::storage::workspace::project_hash;
use crate::tmux;

use super::{FileChanges, Worktree, WorktreeStatus};

/// 从 Task 元数据加载 worktree 列表
/// 返回: (current, other, archived)
pub fn load_worktrees(project_path: &str) -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    // 1. 获取项目 key（路径的 hash）
    let project_key = project_hash(project_path);

    // 2. 加载 tasks.toml (活跃任务)
    let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();

    // 3. 获取当前分支
    let current_branch = git::current_branch(project_path).unwrap_or_else(|_| "main".to_string());

    // 4. 检查主仓库是否有正在 merge 的 commit（冲突状态）
    let merging_commit = git::merging_commit(project_path);

    // 5. 转换活跃任务
    let mut current = Vec::new();
    let mut other = Vec::new();

    for task in active_tasks {
        let worktree =
            task_to_worktree(&task, &project_key, project_path, merging_commit.as_deref());

        if task.target == current_branch {
            current.push(worktree);
        } else {
            other.push(worktree);
        }
    }

    // 5. 懒加载归档任务（仅当需要时）
    let archived = Vec::new(); // 初始为空，切换到 Archived Tab 时再加载

    (current, other, archived)
}

/// 加载归档任务（懒加载）
pub fn load_archived_worktrees(project_path: &str) -> Vec<Worktree> {
    let project_key = project_hash(project_path);

    let archived_tasks = tasks::load_archived_tasks(&project_key).unwrap_or_default();

    archived_tasks
        .into_iter()
        .map(archived_task_to_worktree)
        .collect()
}

/// 将 Archived Task 转换为 UI Worktree (直接标记为 Archived 状态)
fn archived_task_to_worktree(task: Task) -> Worktree {
    Worktree {
        id: task.id,
        task_name: task.name,
        branch: task.branch,
        target: task.target,
        status: WorktreeStatus::Archived,
        commits_behind: None,
        file_changes: FileChanges::default(),
        archived: true,
        path: task.worktree_path,
        created_at: task.created_at,
        updated_at: task.updated_at,
    }
}

/// 将 Task 转换为 UI Worktree
/// merging_commit: 主仓库正在 merge 的 commit hash（如果有冲突的话）
fn task_to_worktree(
    task: &Task,
    project: &str,
    project_path: &str,
    merging_commit: Option<&str>,
) -> Worktree {
    let path = &task.worktree_path;

    // 检查 worktree 是否存在
    let exists = Path::new(path).exists();

    // 检查是否是这个 task 导致的 merge 冲突
    let is_merging_this_task = merging_commit
        .map(|commit| git::branch_head_equals(project_path, &task.branch, commit))
        .unwrap_or(false);

    // 确定状态
    let status = if !exists {
        WorktreeStatus::Broken // worktree 被删除
    } else if is_merging_this_task {
        // 主仓库正在 merge 这个 task 的分支，且有冲突
        WorktreeStatus::Conflict
    } else if git::has_conflicts(path) {
        // worktree 内部有冲突（如 rebase 冲突）
        WorktreeStatus::Conflict
    } else {
        // 先计算 commits behind (branch 相对于 target 的新 commit 数)
        let commits_behind = git::commits_behind(path, &task.branch, &task.target).unwrap_or(0);

        // 只有当有新 commit 且已合并时才算 Merged
        // 避免刚创建的任务（branch 和 target 同一个 commit）被误判为 Merged
        let is_merged = commits_behind > 0
            && git::is_merged(project_path, &task.branch, &task.target).unwrap_or(false);

        if is_merged {
            WorktreeStatus::Merged
        } else {
            // 再检查 session 是否运行
            let session = tmux::session_name(project, &task.id);
            if tmux::session_exists(&session) {
                WorktreeStatus::Live
            } else {
                WorktreeStatus::Idle
            }
        }
    };

    // 获取 commits_behind 和 file_changes (仅当 worktree 存在时)
    let (commits_behind, file_changes) = if exists {
        // commits_behind 已在上面计算过，这里重新获取以保持 Option 类型
        let behind = git::commits_behind(path, &task.branch, &task.target).ok();
        let changes = git::file_changes(path, &task.target)
            .map(|(a, d)| FileChanges::new(a, d))
            .unwrap_or_default();
        (behind, changes)
    } else {
        (None, FileChanges::default())
    };

    Worktree {
        id: task.id.clone(),
        task_name: task.name.clone(),
        branch: task.branch.clone(),
        target: task.target.clone(),
        status,
        commits_behind,
        file_changes,
        archived: task.status == TaskStatus::Archived,
        path: path.clone(),
        created_at: task.created_at,
        updated_at: task.updated_at,
    }
}
