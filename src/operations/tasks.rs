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
use crate::session::SessionType;
use crate::storage::{self, config, notes, tasks, workspace};
use crate::tmux::layout::{parse_custom_layout_tree, CustomLayout, TaskLayout};
use crate::{git, hooks, session, tmux};

/// Result of `create_task_session` — everything the caller needs to attach
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_type: SessionType,
    pub session_name: String,
    pub is_new: bool,
    pub layout_path: Option<String>,
}

/// Create (or find existing) task session.
///
/// This is the single source of truth for session creation, shared by TUI and Web.
/// - Session name is always computed from `project_key + task.id` (deterministic)
/// - First checks if the stored multiplexer's session is still alive → attach
/// - If not alive, reads current config to create a new session
/// - Persists `task.multiplexer` + `task.session_name` back to storage (best effort)
pub fn create_task_session(
    project_key: &str,
    task: &tasks::Task,
    project_path: &str,
) -> Result<SessionInfo> {
    // 1. Compute session name deterministically
    let session_name = session::session_name(project_key, &task.id);

    // 2. Check if stored multiplexer's session is still alive
    let stored_mux = match task.multiplexer.as_str() {
        "tmux" => Some(SessionType::Tmux),
        "zellij" => Some(SessionType::Zellij),
        _ => None,
    };
    if let Some(ref mux) = stored_mux {
        if session::session_exists(mux, &session_name) {
            return Ok(SessionInfo {
                session_type: mux.clone(),
                session_name,
                is_new: false,
                layout_path: None,
            });
        }
    }

    // 3. Stored session not alive → read config to decide what to create
    let cfg = config::load_config();
    let session_type = match cfg.terminal_multiplexer {
        config::TerminalMultiplexer::Tmux => SessionType::Tmux,
        config::TerminalMultiplexer::Zellij => SessionType::Zellij,
    };

    // 4. Build session environment
    let project_name = std::path::Path::new(project_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");

    let session_env = tmux::SessionEnv {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        branch: task.branch.clone(),
        target: task.target.clone(),
        worktree: task.worktree_path.clone(),
        project_name: project_name.to_string(),
        project_path: project_path.to_string(),
    };

    // 5. Create session
    session::create_session(
        &session_type,
        &session_name,
        &task.worktree_path,
        Some(&session_env),
    )?;

    // 6. Apply layout
    let layout = TaskLayout::from_name(&cfg.layout.default).unwrap_or(TaskLayout::Single);
    let agent_cmd = cfg.layout.agent_command.clone().unwrap_or_default();
    let custom_layout = if layout == TaskLayout::Custom {
        cfg.layout.custom.as_ref().and_then(|c| {
            parse_custom_layout_tree(&c.tree, cfg.layout.selected_custom_id.as_deref())
                .map(|root| CustomLayout { root })
        })
    } else {
        None
    };

    let mut layout_path: Option<String> = None;
    match session_type {
        SessionType::Tmux => {
            if layout != TaskLayout::Single {
                if let Err(e) = tmux::layout::apply_layout(
                    &session_name,
                    &task.worktree_path,
                    &layout,
                    &agent_cmd,
                    custom_layout.as_ref(),
                ) {
                    eprintln!("Warning: Failed to apply layout: {}", e);
                }
            }
        }
        SessionType::Zellij => {
            let kdl = crate::zellij::layout::generate_kdl(
                &layout,
                &agent_cmd,
                custom_layout.as_ref(),
                &session_env.shell_export_prefix(),
            );
            match crate::zellij::layout::write_session_layout(&session_name, &kdl) {
                Ok(path) => layout_path = Some(path),
                Err(e) => eprintln!("Warning: Failed to write zellij layout: {}", e),
            }
        }
        SessionType::Acp => {}
    }

    // 7. Persist task session data (best effort)
    persist_task_session(project_key, &task.id, &session_type, &session_name);

    Ok(SessionInfo {
        session_type,
        session_name,
        is_new: true,
        layout_path,
    })
}

/// Best-effort persist of multiplexer + session_name to task storage
fn persist_task_session(
    project_key: &str,
    task_id: &str,
    session_type: &SessionType,
    session_name: &str,
) {
    let mux_str = match session_type {
        SessionType::Tmux => "tmux",
        SessionType::Zellij => "zellij",
        SessionType::Acp => "acp",
    };
    if let Ok(mut all_tasks) = tasks::load_tasks(project_key) {
        if let Some(t) = all_tasks.iter_mut().find(|t| t.id == task_id) {
            t.multiplexer = mux_str.to_string();
            t.session_name = session_name.to_string();
            t.updated_at = chrono::Utc::now();
            let _ = tasks::save_tasks(project_key, &all_tasks);
        }
    }
}

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
    /// Warning message (e.g., failed to checkout back to original branch)
    pub warning: Option<String>,
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

    // Local Task 不支持 merge
    if task.is_local {
        return Err(GroveError::invalid_data("Cannot merge local task"));
    }

    // 2. Check worktree uncommitted
    if git::has_uncommitted_changes(&task.worktree_path)? {
        return Err(GroveError::git(
            "Worktree has uncommitted changes. Please commit or stash first.",
        ));
    }

    // 3. Check main repo uncommitted (can't checkout to target branch if dirty)
    if git::has_uncommitted_changes(repo_path)? {
        return Err(GroveError::git(
            "Cannot merge: the main repository has uncommitted changes. Please commit or stash your changes first.",
        ));
    }

    // 3.5. Check if already merged
    let already_merged = git::is_merged(repo_path, &task.branch, &task.target).unwrap_or(false)
        || git::is_diff_empty(repo_path, &task.branch, &task.target).unwrap_or(false);
    if already_merged {
        return Err(GroveError::git(format!(
            "Branch '{}' has already been merged into '{}'. Nothing to merge.",
            task.branch, task.target
        )));
    }

    // 4. Record original branch and checkout target
    let original_branch = git::current_branch(repo_path)?;
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
        // Checkout back to original branch on error
        let _ = git::checkout(repo_path, &original_branch);
        return Err(e);
    }

    // Checkout back to original branch after successful merge
    let warning = if let Err(e) = git::checkout(repo_path, &original_branch) {
        let msg = format!(
            "Merge succeeded, but failed to switch back to '{}': {}",
            original_branch, e
        );
        eprintln!("Warning: {}", msg);
        Some(msg)
    } else {
        None
    };

    // 7. Update task timestamp
    tasks::touch_task(project_key, task_id)?;

    Ok(MergeResult {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        target_branch: task.target.clone(),
        warning,
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

    // Local Task 不支持 sync
    if task.is_local {
        return Err(GroveError::invalid_data("Cannot sync local task"));
    }

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
    // Local Task 不支持 archive
    if task_id == tasks::LOCAL_TASK_ID {
        return Err(GroveError::invalid_data("Cannot archive local task"));
    }

    // 1. Get task info (before archival)
    let task_info = tasks::get_task(project_key, task_id)?;

    // 2. Snapshot git diff stats before removing worktree
    let (code_additions, code_deletions, files_changed) = if let Some(task) = &task_info {
        if std::path::Path::new(&task.worktree_path).exists() {
            match git::diff_stat(&task.worktree_path, &task.target) {
                Ok(entries) => {
                    let additions: u32 = entries.iter().map(|e| e.additions).sum();
                    let deletions: u32 = entries.iter().map(|e| e.deletions).sum();
                    let files = entries.len() as u32;
                    (additions, deletions, files)
                }
                Err(_) => (0, 0, 0),
            }
        } else {
            (0, 0, 0)
        }
    } else {
        (0, 0, 0)
    };

    // 3. Remove worktree
    if let Some(task) = &task_info {
        if std::path::Path::new(&task.worktree_path).exists() {
            git::remove_worktree(repo_path, &task.worktree_path)?;
        }
    }

    // 4. Move to archived.toml (sets archived_at timestamp)
    tasks::archive_task(project_key, task_id)?;

    // 5. Update code stats on the archived task
    tasks::update_archived_task_code_stats(
        project_key,
        task_id,
        code_additions,
        code_deletions,
        files_changed,
    )?;

    // 6. Remove hook notifications
    hooks::remove_task_hook(project_key, task_id);

    // 7. Kill session
    let task_session_type = session::resolve_session_type(task_multiplexer);
    let session_name = session::resolve_session_name(task_session_name, project_key, task_id);
    let _ = session::kill_session(&task_session_type, &session_name);

    // 8. Remove Zellij layout if applicable
    if matches!(task_session_type, session::SessionType::Zellij) {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    // 9. Return archived task
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
    created_by: &str,
) -> Result<CreateTaskResult> {
    create_task_inner(
        repo_path,
        project_key,
        task_name,
        target_branch,
        session_type,
        autolink_patterns,
        created_by,
        false, // is_studio = false
    )
}

/// Create a Studio task (folder-based, no git worktree)
pub fn create_studio_task(
    project_path: &str,
    project_key: &str,
    task_name: String,
    session_type: &str,
    created_by: &str,
) -> Result<CreateTaskResult> {
    create_task_inner(
        project_path,
        project_key,
        task_name,
        String::new(), // no target branch
        session_type,
        &[], // no autolink
        created_by,
        true, // is_studio = true
    )
}

#[allow(clippy::too_many_arguments)]
fn create_task_inner(
    repo_path: &str,
    project_key: &str,
    task_name: String,
    target_branch: String,
    session_type: &str,
    autolink_patterns: &[String],
    created_by: &str,
    is_studio: bool,
) -> Result<CreateTaskResult> {
    // 1. Generate identifiers
    let slug = tasks::to_slug(&task_name);

    // 禁止创建与 Local Task 冲突的 ID
    if slug == tasks::LOCAL_TASK_ID {
        return Err(GroveError::invalid_data(
            "Task name conflicts with reserved local task ID. Please use a different name.",
        ));
    }

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

    let (task_path_str, branch) = if is_studio {
        // Studio: create folder structure under ~/.grove/studios/{project_key}/tasks/{slug}/
        let studio_dir = workspace::studio_project_dir(repo_path);
        let task_dir = studio_dir.join("tasks").join(&slug);
        std::fs::create_dir_all(task_dir.join("input"))?;
        std::fs::create_dir_all(task_dir.join("output"))?;
        std::fs::create_dir_all(task_dir.join("scripts"))?;

        // Symlink resource/ → project resource/ (read-only)
        let resource_link = task_dir.join("resource");
        let project_resource = studio_dir.join("resource");
        if !resource_link.exists() && project_resource.exists() {
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(&project_resource, &resource_link);
            }
        }

        // Symlink instructions.md → project instructions.md (read-only)
        let instructions_link = task_dir.join("instructions.md");
        let project_instructions = studio_dir.join("instructions.md");
        if !instructions_link.exists() && project_instructions.exists() {
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(&project_instructions, &instructions_link);
            }
        }

        // Generate AGENTS.md
        let agents_md = format!(
            "# Studio Task: {task_name}\n\
             You are an AI agent working inside a Grove Studio task workspace.\n\
             This workspace is isolated for this task only. Follow the rules below carefully.\n\n\
             ## Directory Structure\n\
             \n\
             ```\n\
             ./\n\
             ├── input/           # User-provided input files. Read these to understand your task.\n\
             ├── output/          # Write all your results and deliverables here.\n\
             ├── scripts/         # Place any scripts you create or use here.\n\
             ├── resource/        # Read-only shared project resources (symlink). Do not modify.\n\
             ├── instructions.md  # Read-only project-level instructions (symlink). Read this first.\n\
             └── AGENTS.md        # This file.\n\
             ```\n\
             ## Getting Started\n\
             \n\
             1. Read `instructions.md` for project-level context and guidelines.\n\
             2. Read all files in `input/` to understand what you need to do.\n\
             3. Browse `resource/` if you need shared reference materials.\n\
             4. Write your results to `output/`.\n\
             5. Place any scripts in `scripts/`.\n\
             \n\
             See `instructions.md` for project-level instructions.\n\n\
             ## Rules\n\
             \n\
             - ALWAYS read `instructions.md` before starting work.\n\
             - ALWAYS read everything in `input/` before starting work.\n\
             - ALWAYS write results and deliverables to `output/`.\n\
             - ALWAYS place scripts in `scripts/`.\n\
             - NEVER modify files in `resource/` — it is a read-only symlink to the project vault.\n\
             - NEVER modify files in `input/` unless the user explicitly asks you to.\n\
             - NEVER modify `instructions.md` — it is a read-only symlink.\n\
             - Keep `output/` organized. Use subdirectories if you produce many files.\n\n\
             ## Presentation Guidelines\n\
             \n\
             - **Documentation**: Write in Markdown format.\n\
             - **Diagrams**: Use [Mermaid](https://mermaid.js.org/) syntax for diagrams (flowcharts, sequence diagrams, etc.).\n\
             - **Demos**: Use JSX/React components for interactive demos and visual presentations.\n",
        );
        std::fs::write(task_dir.join("AGENTS.md"), &agents_md)?;

        // Symlink CLAUDE.md and GEMINI.md → AGENTS.md
        #[cfg(unix)]
        {
            let agents_path = task_dir.join("AGENTS.md");
            let claude_md = task_dir.join("CLAUDE.md");
            let gemini_md = task_dir.join("GEMINI.md");
            if !claude_md.exists() {
                let _ = std::os::unix::fs::symlink(&agents_path, &claude_md);
            }
            if !gemini_md.exists() {
                let _ = std::os::unix::fs::symlink(&agents_path, &gemini_md);
            }
        }

        (task_dir.to_string_lossy().to_string(), String::new())
    } else {
        // Repo: create git worktree
        let branch = tasks::generate_branch_name(&task_name);
        let worktree_dir = storage::ensure_worktree_dir(project_key)?;
        let worktree_path = worktree_dir.join(&slug);

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

        // Create AutoLink symlinks
        let main_repo =
            git::get_main_repo_path(repo_path).unwrap_or_else(|_| repo_path.to_string());
        let _ = git::create_worktree_symlinks(
            &worktree_path,
            std::path::Path::new(&main_repo),
            autolink_patterns,
            true,
        );

        (worktree_path.to_string_lossy().to_string(), branch)
    };

    // 6. Create task record (shared for both types)
    let now = chrono::Utc::now();
    let session_name = session::session_name(project_key, &slug);
    let task = tasks::Task {
        id: slug.clone(),
        name: task_name,
        branch,
        target: target_branch,
        worktree_path: task_path_str.clone(),
        created_at: now,
        updated_at: now,
        status: tasks::TaskStatus::Active,
        multiplexer: session_type.to_string(),
        session_name: session_name.clone(),
        created_by: created_by.to_string(),
        archived_at: None,
        code_additions: 0,
        code_deletions: 0,
        files_changed: 0,
        is_local: false,
    };

    tasks::add_task(project_key, task.clone())?;

    Ok(CreateTaskResult {
        task,
        worktree_path: task_path_str,
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
    // Local Task 不支持 reset
    if task_id == tasks::LOCAL_TASK_ID {
        return Err(GroveError::invalid_data("Cannot reset local task"));
    }

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
