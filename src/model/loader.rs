//! 从 Task 元数据加载 Worktree 数据
//!
//! 设计:
//! - `load_worktrees` 只返回真正的 worktree 任务(不含 Local Task)
//! - `load_local_task` 返回单独的 Local Task
//! - Local Task 在项目注册时创建(`workspace::add_project_with_type` 等),
//!   这里的 `ensure_local_task_synced` 只做同步(branch/target/path/name drift)
//!
//! 两者都会读取 Local Task,但对外的数据契约里 Local Task 和 worktree 任务是隔离的

use std::path::Path;

use crate::git;
use crate::session::{self, SessionType};
use crate::storage::tasks::{self, Task, TaskStatus, LOCAL_TASK_ID};
use crate::storage::workspace::{self, project_hash};

use super::{FileChanges, Worktree, WorktreeStatus};

/// 确保 Local Task 记录与项目状态同步
///
/// 只同步已有 Local Task 的字段(branch/target/path/name)。
/// Local Task 的创建在项目注册时完成(`workspace::add_project_with_type` 等),
/// 此函数不再负责创建。
///
/// 返回 `(active_tasks, project_key)`。
fn ensure_local_task_synced(project_path: &str) -> (Vec<Task>, String) {
    let project_key = project_hash(project_path);

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

    // Studio 项目没有 Local Task
    let project_meta = workspace::load_project_by_hash(&project_key).ok().flatten();
    let is_studio = matches!(
        project_meta.as_ref().map(|p| &p.project_type),
        Some(workspace::ProjectType::Studio)
    );
    if is_studio {
        return (active_tasks, project_key);
    }

    // 同步已有 Local Task 的字段 drift
    if let Some(local_task) = active_tasks.iter_mut().find(|t| t.id == LOCAL_TASK_ID) {
        let is_git = git::is_git_repo(project_path);
        let (current_branch, default_branch) = if is_git {
            let cur = git::current_branch(project_path).unwrap_or_else(|_| "main".to_string());
            let def = git::default_branch(project_path);
            (cur, def)
        } else {
            (String::new(), String::new())
        };
        let project_name = project_meta
            .as_ref()
            .map(|p| p.name.clone())
            .unwrap_or_else(|| {
                Path::new(project_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Local")
                    .to_string()
            });

        let mut needs_save = false;
        if local_task.branch != current_branch {
            local_task.branch = current_branch.clone();
            needs_save = true;
        }
        if local_task.target != default_branch {
            local_task.target = default_branch.clone();
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
            let _ = tasks::update_local_task(&project_key, local_task);
        }
    }

    (active_tasks, project_key)
}

/// 从 Task 元数据加载活跃 worktree 列表(**不含** Local Task)
///
/// Local Task 在项目注册时创建,此处只做 branch/target drift 同步。
/// Local Task 不会出现在返回的列表中。需要 Local Task 请使用 [`load_local_task`]。
pub fn load_worktrees(project_path: &str) -> Vec<Worktree> {
    let (active_tasks, project_key) = ensure_local_task_synced(project_path);

    // 过滤掉 Local Task,只保留 worktree 任务
    let worktree_tasks: Vec<&Task> = active_tasks.iter().filter(|t| !t.is_local).collect();

    if worktree_tasks.is_empty() {
        return Vec::new();
    }

    // 检查主仓库是否有正在 merge 的 commit(冲突状态)
    let merging_commit = git::merging_commit(project_path);

    // 并行转换
    use rayon::prelude::*;
    let mut worktrees: Vec<Worktree> = worktree_tasks
        .par_iter()
        .map(|task| task_to_worktree(task, &project_key, project_path, merging_commit.as_deref()))
        .collect();

    // 按 updated_at 降序排列
    worktrees.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    worktrees
}

/// 加载项目的 Local Task(每个项目有且只有一个)
///
/// Local Task 在项目注册时创建。返回 `None` 表示该项目尚未注册或为 Studio 项目。
pub fn load_local_task(project_path: &str) -> Option<Worktree> {
    let (active_tasks, project_key) = ensure_local_task_synced(project_path);
    let local_task = active_tasks.iter().find(|t| t.is_local)?;
    let merging_commit = git::merging_commit(project_path);
    Some(task_to_worktree(
        local_task,
        &project_key,
        project_path,
        merging_commit.as_deref(),
    ))
}

/// 加载归档任务(懒加载)
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

    let mut archived: Vec<Worktree> = archived_tasks
        .into_iter()
        .map(archived_task_to_worktree)
        .collect();
    archived.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    archived
}

/// 将 Archived Task 转换为 UI Worktree(直接标记为 Archived 状态)
fn archived_task_to_worktree(task: Task) -> Worktree {
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
/// merging_commit: 主仓库正在 merge 的 commit hash(如果有冲突的话)
fn task_to_worktree(
    task: &Task,
    project: &str,
    project_path: &str,
    merging_commit: Option<&str>,
) -> Worktree {
    let path = &task.worktree_path;

    // 解析 session 类型(提前计算,status 判断和输出都需要)
    let resolved_session_type = session::resolve_session_type(&task.multiplexer);

    // Local Task: 简化状态判断,只检查 session Live/Idle
    if task.is_local {
        let exists = Path::new(path).exists();
        let status = if !exists {
            WorktreeStatus::Broken
        } else if git::has_conflicts(path) {
            WorktreeStatus::Conflict
        } else if matches!(resolved_session_type, SessionType::Acp) {
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
            let session_key = session::resolve_session_name(&task.session_name, project, &task.id);
            if session::session_exists(&resolved_session_type, &session_key) {
                WorktreeStatus::Live
            } else {
                WorktreeStatus::Idle
            }
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
            file_changes: FileChanges::default(),
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

    // 确定状态和 commits_behind(一次性计算,避免重复 git 调用)
    let (status, commits_behind) = if !exists {
        (WorktreeStatus::Broken, None)
    } else if is_merging_this_task || git::has_conflicts(path) {
        (WorktreeStatus::Conflict, None)
    } else {
        let commits_behind = git::commits_behind(path, &task.branch, &task.target).ok();
        let commits_behind_count = commits_behind.unwrap_or(0);

        // 只有当有新 commit 且已合并时才算 Merged
        let is_merged = commits_behind_count > 0
            && (git::is_merged(project_path, &task.branch, &task.target).unwrap_or(false)
                || git::is_diff_empty(project_path, &task.branch, &task.target).unwrap_or(false));

        if is_merged {
            (WorktreeStatus::Merged, commits_behind)
        } else {
            // 检查 session 是否运行
            let session_status = if matches!(resolved_session_type, SessionType::Acp) {
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
            };
            (session_status, commits_behind)
        }
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
        file_changes: FileChanges::default(),
        archived: task.status == TaskStatus::Archived,
        path: path.clone(),
        multiplexer: mux_str.to_string(),
        created_at: task.created_at,
        updated_at: task.updated_at,
        created_by: task.created_by.clone(),
        is_local: false,
    }
}
