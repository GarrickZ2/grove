//! 从 Task 元数据加载 Worktree 数据

use std::path::Path;

use crate::git;
use crate::session;
use crate::storage::config::Multiplexer;
use crate::storage::tasks::{self, Task, TaskStatus};
use crate::storage::workspace::project_hash;

use super::{FileChanges, Worktree, WorktreeStatus};

/// 从 Task 元数据加载 worktree 列表
/// 返回: (current, other, archived)
pub fn load_worktrees(project_path: &str) -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    // 1. 获取项目 key（路径的 hash）
    let project_key = project_hash(project_path);

    // 2. 加载全局 multiplexer 配置
    let global_mux = crate::storage::config::load_config().multiplexer;

    // 3. 加载 tasks.toml (活跃任务)
    let active_tasks = match tasks::load_tasks(&project_key) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "Warning: failed to load active tasks for {}: {}",
                project_key, e
            );
            Vec::new()
        }
    };

    // 4. 获取当前分支
    let current_branch = git::current_branch(project_path).unwrap_or_else(|_| "main".to_string());

    // 5. 检查主仓库是否有正在 merge 的 commit（冲突状态）
    let merging_commit = git::merging_commit(project_path);

    // 6. 转换活跃任务 (并行处理以提升性能)
    use rayon::prelude::*;

    let worktrees: Vec<_> = active_tasks
        .par_iter() // 🚀 并行迭代
        .map(|task| {
            task_to_worktree(
                task,
                &project_key,
                project_path,
                merging_commit.as_deref(),
                &global_mux,
            )
        })
        .collect();

    // 分类到 current 和 other
    let mut current = Vec::new();
    let mut other = Vec::new();

    for (idx, task) in active_tasks.iter().enumerate() {
        if task.target == current_branch {
            current.push(worktrees[idx].clone());
        } else {
            other.push(worktrees[idx].clone());
        }
    }

    // 5. 懒加载归档任务（仅当需要时）
    let archived = Vec::new(); // 初始为空，切换到 Archived Tab 时再加载

    (current, other, archived)
}

/// 加载归档任务（懒加载）
pub fn load_archived_worktrees(project_path: &str) -> Vec<Worktree> {
    let project_key = project_hash(project_path);

    let archived_tasks = match tasks::load_archived_tasks(&project_key) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "Warning: failed to load archived tasks for {}: {}",
                project_key, e
            );
            Vec::new()
        }
    };

    archived_tasks
        .into_iter()
        .map(archived_task_to_worktree)
        .collect()
}

/// 将 Archived Task 转换为 UI Worktree (直接标记为 Archived 状态)
fn archived_task_to_worktree(task: Task) -> Worktree {
    // Resolve multiplexer for archived tasks (use stored value or fall back to global)
    let global_mux = crate::storage::config::load_config().multiplexer;
    let resolved_mux = session::resolve_multiplexer(&task.multiplexer, &global_mux);
    let mux_str = match resolved_mux {
        Multiplexer::Tmux => "tmux",
        Multiplexer::Zellij => "zellij",
        Multiplexer::Acp => "acp",
    };

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
        multiplexer: mux_str.to_string(),
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
    global_mux: &Multiplexer,
) -> Worktree {
    let path = &task.worktree_path;

    // 解析 multiplexer 类型（提前计算，status 判断和输出都需要）
    let resolved_mux = session::resolve_multiplexer(&task.multiplexer, global_mux);

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
        // 🚀 优化: 只计算一次 commits_behind,后面复用结果
        let commits_behind_result = git::commits_behind(path, &task.branch, &task.target);
        let commits_behind_count = commits_behind_result.as_ref().ok().copied().unwrap_or(0);

        // 只有当有新 commit 且已合并时才算 Merged
        // 避免刚创建的任务（branch 和 target 同一个 commit）被误判为 Merged
        let is_merged = commits_behind_count > 0
            && git::is_merged(project_path, &task.branch, &task.target).unwrap_or(false);

        if is_merged {
            WorktreeStatus::Merged
        } else {
            // 检查 session 是否运行
            if matches!(resolved_mux, Multiplexer::Acp) {
                // Multi-chat: 检查每个 chat 的 session，或旧的 task 级 key
                let has_live = if task.chats.is_empty() {
                    let key = format!("{}:{}", project, &task.id);
                    session::session_exists(&resolved_mux, &key)
                } else {
                    task.chats.iter().any(|chat| {
                        let key = format!("{}:{}:{}", project, &task.id, &chat.id);
                        session::session_exists(&resolved_mux, &key)
                    })
                };
                if has_live {
                    WorktreeStatus::Live
                } else {
                    WorktreeStatus::Idle
                }
            } else {
                let session_key =
                    session::resolve_session_name(&task.session_name, project, &task.id);
                if session::session_exists(&resolved_mux, &session_key) {
                    WorktreeStatus::Live
                } else {
                    WorktreeStatus::Idle
                }
            }
        }
    };

    // 获取 commits_behind 和 file_changes (仅当 worktree 存在时)
    // 🚀 优化: commits_behind 已在上面计算,直接复用,不再重复调用 git
    let (commits_behind, file_changes) = if exists {
        // 复用上面计算的 commits_behind_result(如果存在的话)
        let behind = if status != WorktreeStatus::Broken && status != WorktreeStatus::Conflict {
            // commits_behind 已在上面计算过,这里需要再次获取是因为作用域问题
            // TODO: 进一步优化可以重构为返回 (status, commits_behind) 元组
            git::commits_behind(path, &task.branch, &task.target).ok()
        } else {
            None
        };
        let changes = git::file_changes(path, &task.target)
            .map(|(a, d, f)| FileChanges::new(a, d, f))
            .unwrap_or_default();
        (behind, changes)
    } else {
        (None, FileChanges::default())
    };

    let mux_str = match resolved_mux {
        Multiplexer::Tmux => "tmux",
        Multiplexer::Zellij => "zellij",
        Multiplexer::Acp => "acp",
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
        multiplexer: mux_str.to_string(),
        created_at: task.created_at,
        updated_at: task.updated_at,
    }
}
