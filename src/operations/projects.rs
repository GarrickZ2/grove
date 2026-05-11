//! Project operations - shared business logic layer
//!
//! Used by both the TUI and the Web API so keybinding flows and HTTP handlers
//! operate on identical semantics.

use std::path::Path;
use std::process::Command;

use crate::error::{GroveError, Result};
use crate::git;
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
        let user_name = git::git_user_name(project_path).unwrap_or_else(|| "Grove".to_string());
        let user_email =
            git::git_user_email(project_path).unwrap_or_else(|| "grove@local".to_string());
        let name_arg = format!("user.name={}", user_name);
        let email_arg = format!("user.email={}", user_email);
        let out = Command::new("git")
            .args([
                "-C",
                project_path,
                "-c",
                &name_arg,
                "-c",
                &email_arg,
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

/// Infer a repo name from a git URL.
///
/// Examples:
///   `https://github.com/user/repo.git` → `repo`
///   `git@github.com:user/repo`         → `repo`
fn infer_repo_name(url: &str) -> Result<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or(trimmed);
    let name = last.trim_end_matches(".git");

    // Heuristic: if the inferred name still looks like the URL host (contains
    // a `.` and no other path segment was found), the URL is incomplete
    // (e.g. `https://github.com/`). git would fail with a confusing error,
    // so reject upfront with something readable.
    if name.contains('.') && url.trim().contains("://") {
        let after_scheme = url.trim().split_once("://").map(|(_, r)| r).unwrap_or("");
        let host = after_scheme
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .trim_end_matches('/');
        if host.eq_ignore_ascii_case(name) {
            return Err(crate::error::GroveError::storage(
                "URL appears to be missing a repository path",
            ));
        }
    }

    validate_repo_name(name)?;
    Ok(name.to_string())
}

/// Validate a directory name destined for `~/.grove/cloned/<name>`. Same rules
/// for both auto-inferred names and user-supplied overrides — the destination
/// must be a single path segment with no traversal or control characters.
fn validate_repo_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(crate::error::GroveError::storage(
            "Cannot infer repository name from URL",
        ));
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err(crate::error::GroveError::storage(
            "Invalid project name (no leading dots, '.' or '..')",
        ));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(crate::error::GroveError::storage(
            "Invalid project name (no slashes or NUL bytes)",
        ));
    }
    if name.chars().any(|c| c.is_control() || c == ' ') {
        return Err(crate::error::GroveError::storage(
            "Invalid project name (no whitespace or control characters)",
        ));
    }
    Ok(())
}

/// Maximum wall-clock time allowed for a single `git clone` invocation.
/// Hung clones (DNS, TLS handshake, paused server) get killed instead of
/// blocking the API forever.
const CLONE_TIMEOUT_SECS: u64 = 300;

/// Clone a remote git repository into `~/.grove/cloned/<name>/` and register
/// it with Grove.
///
/// - `url`  — any URL accepted by `git clone` (https, ssh, git://)
/// - `name` — optional override for the local directory name; defaults to the
///   repo name inferred from the URL
///
/// Returns the absolute path of the cloned directory.
///
/// Async because `git clone` shells out and can take minutes; using
/// `tokio::process::Command` keeps the runtime worker free for other requests
/// while the subprocess runs.
pub async fn clone_project(url: &str, name: Option<&str>) -> Result<String> {
    let url = url.trim();
    if url.is_empty() {
        return Err(crate::error::GroveError::storage("Git URL is required"));
    }

    // Reject URLs that would be parsed as `git` options (e.g.
    // `--upload-pack=/tmp/evil.sh`). Combined with the `--` end-of-options
    // marker below, this closes the historical `git clone` option-injection
    // RCE class.
    if url.starts_with('-') {
        return Err(crate::error::GroveError::storage(
            "Git URL cannot start with '-'",
        ));
    }

    let inferred = infer_repo_name(url)?;
    let repo_name = match name {
        Some(n) if !n.trim().is_empty() => n.trim(),
        _ => &inferred,
    };

    validate_repo_name(repo_name)?;

    let cloned_root = crate::storage::grove_dir().join("cloned");
    std::fs::create_dir_all(&cloned_root).map_err(|e| {
        crate::error::GroveError::storage(format!("Failed to create cloned dir: {}", e))
    })?;

    let dest = cloned_root.join(repo_name);
    if dest.exists() {
        return Err(crate::error::GroveError::storage(format!(
            "Destination already exists: {}",
            dest.display()
        )));
    }

    let dest_str = dest.to_string_lossy().to_string();

    // `--` terminates option parsing so `url` and `dest_str` are always
    // treated as positional args even if a future caller skips the
    // `starts_with('-')` guard. `GIT_TERMINAL_PROMPT=0` makes auth failures
    // exit fast instead of hanging on a blocking prompt that nobody can answer.
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["clone", "--", url, &dest_str])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Spawn manually instead of `.output()` so we can explicitly kill + wait
    // on timeout. Without the explicit wait, `kill_on_drop` only sends SIGKILL
    // — the OS may not have reaped the child by the time we try to delete the
    // partial dest dir.
    let child = cmd
        .spawn()
        .map_err(|e| crate::error::GroveError::git(format!("failed to spawn git clone: {}", e)))?;

    let out = match tokio::time::timeout(
        std::time::Duration::from_secs(CLONE_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(res) => {
            res.map_err(|e| crate::error::GroveError::git(format!("git clone wait failed: {}", e)))?
        }
        Err(_) => {
            // `child` was moved into `wait_with_output`, so by the time we get
            // here the future was dropped and `kill_on_drop` SIGKILL'd git.
            // Give the OS a brief moment to reap, then clean up the partial
            // clone tree. On Linux unlink works on open file handles anyway;
            // this is mostly belt-and-braces for non-Linux targets.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = std::fs::remove_dir_all(&dest);
            return Err(crate::error::GroveError::git(format!(
                "git clone timed out after {}s",
                CLONE_TIMEOUT_SECS
            )));
        }
    };

    if !out.status.success() {
        // Clean up partial clone on failure
        let _ = std::fs::remove_dir_all(&dest);
        return Err(crate::error::GroveError::git(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    let resolved_path = dest
        .canonicalize()
        .map_err(|e| {
            crate::error::GroveError::storage(format!("Failed to canonicalize path: {}", e))
        })?
        .to_string_lossy()
        .to_string();

    workspace::add_project(repo_name, &resolved_path)?;

    Ok(resolved_path)
}
