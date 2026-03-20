//! 从 Task 元数据加载 Worktree 数据

use std::path::Path;

use crate::git;
use crate::session::{self, SessionType};
use crate::storage::tasks::{self, Task, TaskStatus, LOCAL_TASK_ID};
use crate::storage::workspace::{self, project_hash};

use super::{FileChanges, Worktree, WorktreeStatus};

/// 从 Task 元数据加载 worktree 列表
/// 返回: (current, other, archived)
pub fn load_worktrees(project_path: &str) -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    // 1. 获取项目 key（路径的 hash）
    let project_key = project_hash(project_path);

    // 2. 加载 tasks.toml (活跃任务)
    let mut active_tasks = match tasks::load_tasks(&project_key) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "Warning: failed to load active tasks for {}: {}",
                project_key, e
            );
            Vec::new()
        }
    };

    // 3. 获取当前分支
    let current_branch = git::current_branch(project_path).unwrap_or_else(|_| "main".to_string());

    // 3.5 确保 Local Task 存在并同步分支信息
    // 获取项目名称（用作 Local Task 的显示名）
    let project_name = workspace::load_project_by_hash(&project_key)
        .ok()
        .flatten()
        .map(|p| p.name)
        .unwrap_or_else(|| {
            // Fallback: 从路径取最后一段目录名
            std::path::Path::new(project_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Local")
                .to_string()
        });

    if let Some(local_task) = active_tasks.iter_mut().find(|t| t.id == LOCAL_TASK_ID) {
        // 同步 branch/target 为当前分支，worktree_path 为主仓库路径，name 为项目名
        let mut needs_save = false;
        if local_task.branch != current_branch {
            local_task.branch = current_branch.clone();
            needs_save = true;
        }
        if local_task.target != current_branch {
            local_task.target = current_branch.clone();
            needs_save = true;
        }
        if local_task.worktree_path != project_path {
            local_task.worktree_path = project_path.to_string();
            needs_save = true;
        }
        if local_task.name != project_name {
            local_task.name = project_name.clone();
            needs_save = true;
        }
        if needs_save {
            let _ = tasks::save_tasks(&project_key, &active_tasks);
        }
    } else {
        // 自动创建 Local Task
        let local_task = tasks::create_local_task(project_path, &current_branch, &project_name);
        if tasks::add_task(&project_key, local_task.clone()).is_ok() {
            active_tasks.push(local_task);
        }
    }

    // 4. 检查主仓库是否有正在 merge 的 commit（冲突状态）
    let merging_commit = git::merging_commit(project_path);

    // 5. 转换活跃任务 (并行处理以提升性能)
    use rayon::prelude::*;

    let worktrees: Vec<_> = active_tasks
        .par_iter() // 🚀 并行迭代
        .map(|task| task_to_worktree(task, &project_key, project_path, merging_commit.as_deref()))
        .collect();

    // 分类到 current 和 other
    let mut current = Vec::new();
    let mut other = Vec::new();

    for (idx, task) in active_tasks.iter().enumerate() {
        if task.is_local || task.target == current_branch {
            current.push(worktrees[idx].clone());
        } else {
            other.push(worktrees[idx].clone());
        }
    }

    // Local Task 始终排在 current 列表最上方
    if let Some(pos) = current.iter().position(|w| w.is_local) {
        if pos != 0 {
            let local = current.remove(pos);
            current.insert(0, local);
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
    // Resolve session type for archived tasks
    let resolved_session_type = session::resolve_session_type(&task.multiplexer);
    let mux_str = match resolved_session_type {
        SessionType::Tmux => "tmux",
        SessionType::Zellij => "zellij",
        SessionType::Acp => "acp",
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
        created_by: task.created_by,
        is_local: false,
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

    // 解析 session 类型（提前计算，status 判断和输出都需要）
    let resolved_session_type = session::resolve_session_type(&task.multiplexer);

    // Local Task: 简化状态判断，只检查 session Live/Idle
    if task.is_local {
        let exists = Path::new(path).exists();
        let status = if !exists {
            WorktreeStatus::Broken
        } else if git::has_conflicts(path) {
            WorktreeStatus::Conflict
        } else {
            // 只检查 session 状态
            if matches!(resolved_session_type, SessionType::Acp) {
                let chats = tasks::load_chat_sessions(project, &task.id).unwrap_or_default();
                let has_live = if chats.is_empty() {
                    let key = format!("{}:{}", project, &task.id);
                    session::session_exists(&resolved_session_type, &key)
                } else {
                    chats.iter().any(|chat| {
                        let key = format!("{}:{}:{}", project, &task.id, &chat.id);
                        session::session_exists(&resolved_session_type, &key)
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
                if session::session_exists(&resolved_session_type, &session_key) {
                    WorktreeStatus::Live
                } else {
                    WorktreeStatus::Idle
                }
            }
        };

        // Local Task: 只显示未提交变更（diff against HEAD），不计算 commits_behind
        let file_changes = if exists {
            git::file_changes(path, "HEAD")
                .map(|(a, d, f)| FileChanges::new(a, d, f))
                .unwrap_or_default()
        } else {
            FileChanges::default()
        };

        let mux_str = match resolved_session_type {
            SessionType::Tmux => "tmux",
            SessionType::Zellij => "zellij",
            SessionType::Acp => "acp",
        };

        return Worktree {
            id: task.id.clone(),
            task_name: task.name.clone(),
            branch: task.branch.clone(),
            target: task.target.clone(),
            status,
            commits_behind: None,
            file_changes,
            archived: false,
            path: path.clone(),
            multiplexer: mux_str.to_string(),
            created_at: task.created_at,
            updated_at: task.updated_at,
            created_by: task.created_by.clone(),
            is_local: true,
        };
    }

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
            && (git::is_merged(project_path, &task.branch, &task.target).unwrap_or(false)
                || git::is_diff_empty(project_path, &task.branch, &task.target).unwrap_or(false));

        if is_merged {
            WorktreeStatus::Merged
        } else {
            // 检查 session 是否运行
            if matches!(resolved_session_type, SessionType::Acp) {
                // Multi-chat: 检查每个 chat 的 session，或旧的 task 级 key
                let chats = tasks::load_chat_sessions(project, &task.id).unwrap_or_default();
                let has_live = if chats.is_empty() {
                    let key = format!("{}:{}", project, &task.id);
                    session::session_exists(&resolved_session_type, &key)
                } else {
                    chats.iter().any(|chat| {
                        let key = format!("{}:{}:{}", project, &task.id, &chat.id);
                        session::session_exists(&resolved_session_type, &key)
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
                if session::session_exists(&resolved_session_type, &session_key) {
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

    let mux_str = match resolved_session_type {
        SessionType::Tmux => "tmux",
        SessionType::Zellij => "zellij",
        SessionType::Acp => "acp",
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
        created_by: task.created_by.clone(),
        is_local: false,
    }
}
