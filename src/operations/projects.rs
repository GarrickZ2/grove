//! Project operations - shared business logic layer
//!
//! Used by both the TUI and the Web API so keybinding flows and HTTP handlers
//! operate on identical semantics.

use std::path::Path;
use std::process::Command;

use crate::error::{GroveError, Result};
use crate::storage::workspace;

/// Ensure the given directory is a Git repository with at least one commit.
///
/// Idempotent:
/// - `git init` is always safe to re-run (no data loss on an existing repo).
/// - A first empty commit is only created if the repo currently has no HEAD
///   (i.e. it's a fresh init or an earlier attempt left it unborn).
///
/// After success, updates Grove's stored `is_git_repo` flag to `true` so the
/// UI shows the project as a git project without a full refresh cycle.
pub fn init_git_repo(project_path: &str) -> Result<()> {
    if !Path::new(project_path).exists() {
        return Err(GroveError::storage(format!(
            "Project path does not exist: {}",
            project_path
        )));
    }

    // 1. git init (idempotent)
    let out = Command::new("git")
        .args(["-C", project_path, "init"])
        .output()
        .map_err(|e| GroveError::git(format!("failed to spawn git init: {}", e)))?;
    if !out.status.success() {
        return Err(GroveError::git(format!(
            "git init failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    // 2. Check whether HEAD resolves to a real commit. Exit 0 means yes.
    let head_check = Command::new("git")
        .args(["-C", project_path, "rev-parse", "--verify", "HEAD"])
        .output()
        .map_err(|e| GroveError::git(format!("failed to spawn git rev-parse: {}", e)))?;

    // 3. No commits yet → create an empty initial commit so HEAD is valid.
    if !head_check.status.success() {
        let out = Command::new("git")
            .args([
                "-C",
                project_path,
                "-c",
                "user.name=Grove",
                "-c",
                "user.email=grove@local",
                "commit",
                "--allow-empty",
                "-m",
                "Initial commit",
            ])
            .output()
            .map_err(|e| GroveError::git(format!("failed to spawn git commit: {}", e)))?;
        if !out.status.success() {
            return Err(GroveError::git(format!(
                "git commit failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
    }

    // 4. Sync Grove metadata
    workspace::set_is_git_repo(project_path, true)?;
    Ok(())
}

/// Create a new project directory and register it with Grove.
///
/// Steps:
/// 1. Validate `parent_dir` exists and is a directory.
/// 2. Validate `name` (no slashes, no leading dot, non-empty).
/// 3. Ensure `parent_dir/name` does NOT already exist.
/// 4. `mkdir` the target directory.
/// 5. If `init_git`, run [`init_git_repo`] on the new dir.
/// 6. Register with Grove via `workspace::add_project`.
///
/// Returns the canonicalized path of the created project. No rollback on
/// partial failure — the caller sees a clear error pinpointing which step.
pub fn create_new_project(parent_dir: &str, name: &str, init_git: bool) -> Result<String> {
    // Validate name
    let name = name.trim();
    if name.is_empty() {
        return Err(GroveError::storage("Project name is required"));
    }
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(GroveError::storage(
            "Invalid project name (no slashes or leading dots)",
        ));
    }

    // Expand ~/... before validating (TUI + Web 都允许用户输入 ~/...)
    let parent_dir = workspace::expand_tilde(parent_dir);

    // Validate parent dir
    let parent = Path::new(&parent_dir);
    if !parent.exists() {
        return Err(GroveError::storage("Parent directory does not exist"));
    }
    if !parent.is_dir() {
        return Err(GroveError::storage("Parent path is not a directory"));
    }

    // Target path must not exist
    let target = parent.join(name);
    if target.exists() {
        return Err(GroveError::storage(
            "A file or directory with that name already exists",
        ));
    }

    // mkdir
    std::fs::create_dir(&target)
        .map_err(|e| GroveError::storage(format!("Failed to create directory: {}", e)))?;

    // Canonicalize
    let resolved_path = target
        .canonicalize()
        .map_err(|e| GroveError::storage(format!("Failed to canonicalize path: {}", e)))?
        .to_string_lossy()
        .to_string();

    // Optionally init git (reuses the idempotent logic)
    if init_git {
        init_git_repo(&resolved_path)?;
    }

    // Register with Grove
    workspace::add_project(name, &resolved_path)?;

    Ok(resolved_path)
}
