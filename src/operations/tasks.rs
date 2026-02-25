//! Core task operations shared between TUI and Web API
//!
//! This module provides the business logic layer for task operations,
//! eliminating duplication between `src/app.rs` (TUI) and `src/api/handlers/tasks.rs` (Web).
//!
//! ## Design Principles
//!
//! - **Single Responsibility**: Each operation focuses only on business logic orchestration
//! - **Error Handling**: All operations return `Result<T, GroveError>` for uniform error handling
//! - **Separation of Concerns**: UI logic (toast, HTTP response) and session management are caller's responsibility
//! - **Type Safety**: Strongly typed inputs and outputs for compile-time verification
//!
//! ## Architecture
//!
//! ```text
//! TUI (src/app.rs)  ──┐
//!                     ├──> operations::tasks (this module) ──> Infrastructure (git, storage, session, hooks)
//! Web (handlers)  ────┘
//! ```

use crate::error::{GroveError, Result};
use crate::storage::{self, notes, tasks};
use crate::{git, hooks, session};

/// Merge method selection
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMethod {
    /// Squash all commits into one
    Squash,
    /// Create a merge commit (--no-ff)
    MergeCommit,
}

/// Result of merge operation
pub struct MergeResult {
    pub task_id: String,
    pub task_name: String,
    pub target_branch: String,
}

/// Merge a task branch into target
///
/// # Steps
///
/// 1. Load task info
/// 2. Validate: no uncommitted changes in worktree
/// 3. Validate: no uncommitted changes in target branch
/// 4. Checkout target branch
/// 5. Load notes for commit message (non-fatal)
/// 6. Execute merge (squash or merge-commit)
/// 7. Rollback on error
/// 8. Update task timestamp
///
/// # Returns
///
/// `MergeResult` for caller to handle (toast/HTTP response)
///
/// # Example
///
/// ```ignore
/// use crate::operations::tasks::{merge_task, MergeMethod};
///
/// match merge_task(&repo_path, &project_key, &task_id, MergeMethod::Squash) {
///     Ok(result) => println!("Merged into {}", result.target_branch),
///     Err(e) => eprintln!("Merge failed: {}", e),
/// }
/// ```
pub fn merge_task(
    repo_path: &str,
    project_key: &str,
    task_id: &str,
    method: MergeMethod,
) -> Result<MergeResult> {
    // 1. Load task
    let task = tasks::get_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Task not found"))?;

    // 2. Check worktree uncommitted
    if git::has_uncommitted_changes(&task.worktree_path)? {
        return Err(GroveError::git(
            "Worktree has uncommitted changes. Please commit or stash first.",
        ));
    }

    // 3. Check target uncommitted
    if git::has_uncommitted_changes(repo_path)? {
        return Err(GroveError::git(format!(
            "Cannot merge: '{}' has uncommitted changes. Please commit first.",
            task.target
        )));
    }

    // 4. Checkout target
    git::checkout(repo_path, &task.target)?;

    // 5. Load notes (non-fatal)
    let notes_content = notes::load_notes(project_key, task_id)
        .ok()
        .filter(|s| !s.trim().is_empty());

    // 6. Execute merge
    let result = match method {
        MergeMethod::Squash => {
            // Squash merge + commit; rollback on commit failure
            let msg = git::build_commit_message(&task.name, notes_content.as_deref());
            git::merge_squash(repo_path, &task.branch).and_then(|()| {
                git::commit(repo_path, &msg).inspect_err(|_| {
                    let _ = git::reset_merge(repo_path);
                })
            })
        }
        MergeMethod::MergeCommit => {
            // Merge with --no-ff
            let title = format!("Merge: {}", task.name);
            let msg = git::build_commit_message(&title, notes_content.as_deref());
            git::merge_no_ff(repo_path, &task.branch, &msg)
        }
    };

    // Handle error with rollback
    if let Err(e) = result {
        let _ = git::reset_merge(repo_path);
        return Err(e);
    }

    // 7. Update task timestamp
    tasks::touch_task(project_key, task_id)?;

    Ok(MergeResult {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        target_branch: task.target.clone(),
    })
}

/// Sync a task with target branch (rebase)
///
/// # Steps
///
/// 1. Load task info
/// 2. Validate: no uncommitted changes in worktree
/// 3. Validate: no uncommitted changes in target branch
/// 4. Execute rebase
/// 5. Update task timestamp
///
/// # Returns
///
/// Target branch name for caller to display
///
/// # Example
///
/// ```ignore
/// use crate::operations::tasks::sync_task;
///
/// match sync_task(&repo_path, &project_key, &task_id) {
///     Ok(target) => println!("Synced with {}", target),
///     Err(e) => eprintln!("Sync failed: {}", e),
/// }
/// ```
pub fn sync_task(repo_path: &str, project_key: &str, task_id: &str) -> Result<String> {
    // 1. Load task
    let task = tasks::get_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Task not found"))?;

    // 2. Check worktree uncommitted
    if git::has_uncommitted_changes(&task.worktree_path)? {
        return Err(GroveError::git(
            "Worktree has uncommitted changes. Please commit or stash first.",
        ));
    }

    // 3. Check target uncommitted
    if git::has_uncommitted_changes(repo_path)? {
        return Err(GroveError::git(format!(
            "Target branch '{}' has uncommitted changes. Please commit first.",
            task.target
        )));
    }

    // 4. Execute rebase
    git::rebase(&task.worktree_path, &task.target)?;

    // 5. Update task timestamp
    tasks::touch_task(project_key, task_id)?;

    Ok(task.target.clone())
}

/// Archive a task (remove worktree, move to archived, cleanup)
///
/// # Steps
///
/// 1. Get task info (before archival)
/// 2. Remove worktree if exists
/// 3. Move to archived.toml
/// 4. Remove hook notifications
/// 5. Kill session
/// 6. Remove Zellij layout if applicable
///
/// # Returns
///
/// Archived task for caller to display
///
/// # Example
///
/// ```ignore
/// use crate::operations::tasks::archive_task;
///
/// match archive_task(&repo_path, &project_key, &task_id, &task_mux_str, &task_session_name, &global_mux) {
///     Ok(task) => println!("Archived: {}", task.name),
///     Err(e) => eprintln!("Archive failed: {}", e),
/// }
/// ```
pub fn archive_task(
    repo_path: &str,
    project_key: &str,
    task_id: &str,
    task_multiplexer: &str,
    task_session_name: &str,
) -> Result<tasks::Task> {
    // 1. Get task info (before archival)
    let task_info = tasks::get_task(project_key, task_id)?;

    // 2. Remove worktree
    if let Some(task) = &task_info {
        if std::path::Path::new(&task.worktree_path).exists() {
            git::remove_worktree(repo_path, &task.worktree_path)?;
        }
    }

    // 3. Move to archived.toml
    tasks::archive_task(project_key, task_id)?;

    // 4. Remove hook notifications
    hooks::remove_task_hook(project_key, task_id);

    // 5. Kill session
    let task_session_type = session::resolve_session_type(task_multiplexer);
    let session_name = session::resolve_session_name(task_session_name, project_key, task_id);
    let _ = session::kill_session(&task_session_type, &session_name);

    // 6. Remove Zellij layout if applicable
    if matches!(task_session_type, session::SessionType::Zellij) {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    // 7. Return archived task
    tasks::get_archived_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Archived task not found"))
}

/// Result of create_task operation
pub struct CreateTaskResult {
    pub task: tasks::Task,
    pub worktree_path: String,
}

/// Create a new task (worktree + branch + metadata)
///
/// # Steps
///
/// 1. Generate identifiers (slug, branch name)
/// 2. Check for duplicate task ID (active + archived)
/// 3. Ensure worktree directory
/// 4. Create git worktree
/// 5. Create AutoLink symlinks
/// 6. Create task record
///
/// # Note
///
/// Session creation is NOT included - caller must handle it.
/// TUI creates session after this; Web doesn't.
///
/// # Returns
///
/// `CreateTaskResult` containing task info
///
/// # Example
///
/// ```ignore
/// use crate::operations::tasks::create_task;
///
/// match create_task(&repo_path, &project_key, name, target, &mux, &autolink_patterns) {
///     Ok(result) => {
///         println!("Task created: {}", result.task.name);
///         // TUI: now create session
///         // Web: done
///     }
///     Err(e) => eprintln!("Failed: {}", e),
/// }
/// ```
pub fn create_task(
    repo_path: &str,
    project_key: &str,
    task_name: String,
    target_branch: String,
    session_type: &str,
    autolink_patterns: &[String],
) -> Result<CreateTaskResult> {
    // 1. Generate identifiers
    let slug = tasks::to_slug(&task_name);

    // 2. Check for duplicate task ID (active + archived)
    let active_tasks = tasks::load_tasks(project_key).unwrap_or_default();
    let archived_tasks = tasks::load_archived_tasks(project_key).unwrap_or_default();
    if let Some(existing) = active_tasks.iter().find(|t| t.id == slug) {
        return Err(GroveError::invalid_data(format!(
            "Task '{}' (active) already exists. Please use a different name.",
            existing.name
        )));
    }
    if let Some(existing) = archived_tasks.iter().find(|t| t.id == slug) {
        return Err(GroveError::invalid_data(format!(
            "Task '{}' (archived) already exists. Please use a different name.",
            existing.name
        )));
    }

    let branch = tasks::generate_branch_name(&task_name);

    // 3. Ensure worktree directory
    let worktree_dir = storage::ensure_worktree_dir(project_key)?;
    let worktree_path = worktree_dir.join(&slug);

    // 4. Create git worktree
    git::create_worktree(repo_path, &branch, &worktree_path, &target_branch).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("invalid reference") || msg.contains("not a valid object name") {
            GroveError::git(format!(
                "Branch '{}' does not exist. The repository may have no commits yet — \
                 please create an initial commit first.",
                target_branch
            ))
        } else {
            e
        }
    })?;

    // 5. Create AutoLink symlinks
    let main_repo = git::get_main_repo_path(repo_path).unwrap_or_else(|_| repo_path.to_string());
    let _ = git::create_worktree_symlinks(
        &worktree_path,
        std::path::Path::new(&main_repo),
        autolink_patterns,
        true, // always check gitignore
    );

    // 6. Create task record
    let now = chrono::Utc::now();
    let session_name = session::session_name(project_key, &slug);
    let task = tasks::Task {
        id: slug.clone(),
        name: task_name,
        branch: branch.clone(),
        target: target_branch,
        worktree_path: worktree_path.to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
        status: tasks::TaskStatus::Active,
        multiplexer: session_type.to_string(),
        session_name: session_name.clone(),
    };

    tasks::add_task(project_key, task.clone())?;

    Ok(CreateTaskResult {
        task,
        worktree_path: worktree_path.to_string_lossy().to_string(),
    })
}

/// Result of recover_task operation
pub struct RecoverTaskResult {
    pub task: tasks::Task,
}

/// Recover an archived task (recreate worktree, move back to active)
///
/// # Steps
///
/// 1. Get archived task info
/// 2. Check if branch still exists
/// 3. Recreate worktree from existing branch
/// 4. Move task from archived.toml back to tasks.toml
///
/// # Note
///
/// Session creation is NOT included - caller must handle it.
/// TUI creates session after this; Web doesn't.
///
/// # Returns
///
/// `RecoverTaskResult` containing recovered task info
///
/// # Example
///
/// ```ignore
/// use crate::operations::tasks::recover_task;
///
/// match recover_task(&repo_path, &project_key, &task_id) {
///     Ok(result) => {
///         println!("Task recovered: {}", result.task.name);
///         // TUI: now create session
///     }
///     Err(e) => eprintln!("Failed: {}", e),
/// }
/// ```
pub fn recover_task(
    repo_path: &str,
    project_key: &str,
    task_id: &str,
) -> Result<RecoverTaskResult> {
    // 1. Get archived task info
    let task = tasks::get_archived_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Archived task not found"))?;

    // 2. Check if branch still exists
    if !git::branch_exists(repo_path, &task.branch) {
        return Err(GroveError::git(format!(
            "Branch '{}' no longer exists. Cannot recover task.",
            task.branch
        )));
    }

    // 3. Recreate worktree from existing branch
    let worktree_path = std::path::Path::new(&task.worktree_path);
    git::create_worktree_from_branch(repo_path, &task.branch, worktree_path)?;

    // 4. Move task from archived.toml back to tasks.toml
    tasks::recover_task(project_key, task_id)?;

    // 5. Return recovered task
    let recovered_task = tasks::get_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Failed to find recovered task"))?;

    Ok(RecoverTaskResult {
        task: recovered_task,
    })
}

/// Result of reset_task operation
pub struct ResetTaskResult {
    pub task: tasks::Task,
}

/// Reset a task (delete everything, recreate from target)
///
/// # Steps
///
/// 1. Get task info
/// 2. Kill session
/// 3. Remove worktree if exists
/// 4. Delete branch if exists
/// 5. Clear all task-related data (notes, review data, edit history)
/// 6. Recreate branch and worktree from target
/// 7. Update task timestamp
///
/// # Note
///
/// Session creation is NOT included - caller must handle it.
/// TUI creates session after this; Web doesn't.
///
/// # Returns
///
/// `ResetTaskResult` containing task info
///
/// # Example
///
/// ```ignore
/// use crate::operations::tasks::reset_task;
///
/// match reset_task(&repo_path, &project_key, &task_id, &task_mux_str, &task_session_name, &global_mux) {
///     Ok(result) => {
///         println!("Task reset: {}", result.task.name);
///         // TUI: now create session
///     }
///     Err(e) => eprintln!("Failed: {}", e),
/// }
/// ```
pub fn reset_task(
    repo_path: &str,
    project_key: &str,
    task_id: &str,
    task_multiplexer: &str,
    task_session_name: &str,
) -> Result<ResetTaskResult> {
    // 1. Get task info
    let task = tasks::get_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Task not found"))?;

    // 2. Kill session
    let task_session_type = session::resolve_session_type(task_multiplexer);
    let session_name = session::resolve_session_name(task_session_name, project_key, task_id);
    let _ = session::kill_session(&task_session_type, &session_name);
    if matches!(task_session_type, session::SessionType::Zellij) {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    // 3. Remove worktree if exists
    if std::path::Path::new(&task.worktree_path).exists() {
        let _ = git::remove_worktree(repo_path, &task.worktree_path);
    }

    // 4. Delete branch if exists
    if git::branch_exists(repo_path, &task.branch) {
        let _ = git::delete_branch(repo_path, &task.branch);
    }

    // 5. Clear all task-related data
    let _ = storage::delete_task_data(project_key, task_id);

    // 6. Recreate branch and worktree from target
    let worktree_path = std::path::Path::new(&task.worktree_path);
    git::create_worktree(repo_path, &task.branch, worktree_path, &task.target)?;

    // 7. Update task timestamp
    tasks::touch_task(project_key, task_id)?;

    // 8. Return task
    let updated_task = tasks::get_task(project_key, task_id)?
        .ok_or_else(|| GroveError::not_found("Task not found after reset"))?;

    Ok(ResetTaskResult { task: updated_task })
}
