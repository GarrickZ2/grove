//! Git API handlers for project-level git operations

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::git;
use crate::storage::{tasks, workspace};

// ============================================================================
// Request/Response DTOs
// ============================================================================

/// Repository status response
#[derive(Debug, Serialize)]
pub struct RepoStatusResponse {
    pub current_branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub uncommitted: u32,
    pub stash_count: u32,
    pub has_conflicts: bool,
    /// Whether the current branch has an upstream tracking ref on origin
    pub has_origin: bool,
    /// Whether the repository has an `origin` remote configured at all
    pub has_remote: bool,
}

#[derive(Debug, Serialize)]
pub struct BranchDetailInfo {
    pub name: String,
    pub is_local: bool,
    pub is_current: bool,
}

/// Branches list response
#[derive(Debug, Serialize)]
pub struct BranchesDetailResponse {
    pub branches: Vec<BranchDetailInfo>,
    pub current: String,
}

/// Commit entry for recent commits
#[derive(Debug, Serialize)]
pub struct RepoCommitEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time_ago: String,
}

/// Recent commits response
#[derive(Debug, Serialize)]
pub struct RepoCommitsResponse {
    pub commits: Vec<RepoCommitEntry>,
}

/// Checkout request
#[derive(Debug, Deserialize)]
pub struct CheckoutRequest {
    pub branch: String,
}

/// Git operation response
#[derive(Debug, Serialize)]
pub struct GitOpResponse {
    pub success: bool,
    pub message: String,
}

/// Stash request
#[derive(Debug, Deserialize)]
pub struct StashRequest {
    #[serde(default)]
    pub pop: bool,
}

/// Commit request
#[derive(Debug, Deserialize)]
pub struct CommitRequest {
    pub message: String,
}

/// Create branch request
#[derive(Debug, Deserialize)]
pub struct CreateBranchRequest {
    pub name: String,
    pub base: Option<String>,
    #[serde(default)]
    pub checkout: bool,
}

// ============================================================================
// Helper functions
// ============================================================================

/// Find project by ID (hash)
fn find_project_path(id: &str) -> Result<String, StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .map(|p| p.path)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Execute git command and return result
fn git_cmd(path: &str, args: &[&str]) -> crate::error::Result<String> {
    use std::process::{Command, Stdio};

    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| crate::error::GroveError::git(format!("Failed to execute git: {}", e)))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(crate::error::GroveError::git(stderr.trim().to_string()))
    }
}

/// Get commits ahead/behind for a branch relative to origin in a single git call.
///
/// Uses `git rev-list --left-right --count branch...origin/branch` which returns
/// "<ahead>\t<behind>" in one fork. Returns (None, None) if origin/branch is missing
/// or branch is unknown.
fn get_ahead_behind(path: &str, branch: &str) -> (Option<u32>, Option<u32>) {
    if branch == "unknown" || branch.is_empty() {
        return (None, None);
    }
    let spec = format!("{}...origin/{}", branch, branch);
    let output = match git_cmd(path, &["rev-list", "--left-right", "--count", &spec]) {
        Ok(s) => s,
        Err(_) => return (None, None),
    };
    let mut parts = output.split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok());
    let behind = parts.next().and_then(|s| s.parse().ok());
    (ahead, behind)
}

/// Single `git status --porcelain` call → both uncommitted count and conflict flag.
fn uncommitted_and_conflicts(path: &str) -> (u32, bool) {
    let output = match git_cmd(path, &["status", "--porcelain"]) {
        Ok(s) => s,
        Err(_) => return (0, false),
    };
    let mut count: u32 = 0;
    let mut conflict = false;
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        count += 1;
        if !conflict {
            let bytes = line.as_bytes();
            if bytes.len() >= 2 {
                let x = bytes[0];
                let y = bytes[1];
                if matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D')) {
                    conflict = true;
                }
            }
        }
    }
    (count, conflict)
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/v1/projects/{id}/git/status
/// Get repository git status
#[cfg_attr(
    feature = "perf-monitor",
    tracing::instrument(skip_all, fields(project_id = %id))
)]
pub async fn get_status(Path(id): Path<String>) -> Result<Json<RepoStatusResponse>, StatusCode> {
    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("find_project_path").entered();
    let project_path = find_project_path(&id)?;
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    // Open gix repo once — shared by current_branch / has_remote / stash_count.
    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("gix_open").entered();
    let gix_repo = gix::open(&project_path).ok();
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("current_branch").entered();
    let current_branch = gix_repo
        .as_ref()
        .and_then(git::gix_current_branch)
        .unwrap_or_else(|| "unknown".to_string());
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("remote_get_url").entered();
    let has_remote = gix_repo.as_ref().map(git::gix_has_origin).unwrap_or(false);
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("stash_count").entered();
    let stash_count = gix_repo.as_ref().map(git::gix_stash_count).unwrap_or(0) as u32;
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    // Single rev-list call gives ahead + behind + has_origin in one fork.
    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("ahead_behind").entered();
    let (ahead_opt, behind_opt) = get_ahead_behind(&project_path, &current_branch);
    let has_origin = ahead_opt.is_some() || behind_opt.is_some();
    let ahead = ahead_opt.unwrap_or(0);
    let behind = behind_opt.unwrap_or(0);
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    // Single `git status --porcelain` call gives uncommitted + has_conflicts.
    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("status_porcelain").entered();
    let (uncommitted, has_conflicts) = uncommitted_and_conflicts(&project_path);
    #[cfg(feature = "perf-monitor")]
    drop(_s);

    Ok(Json(RepoStatusResponse {
        current_branch,
        ahead,
        behind,
        uncommitted,
        stash_count,
        has_conflicts,
        has_origin,
        has_remote,
    }))
}

/// Query parameters for branch listing
#[derive(Debug, Deserialize)]
pub struct BranchQueryParams {
    /// Remote name to fetch branches from
    /// - "local" or empty: only local branches (default)
    /// - "origin": origin remote branches
    /// - "upstream": upstream remote branches
    /// - any other remote name
    #[serde(default)]
    pub remote: String,
}

impl Default for BranchQueryParams {
    fn default() -> Self {
        Self {
            remote: "local".to_string(),
        }
    }
}

/// GET /api/v1/projects/{id}/git/branches?remote=local|origin|upstream|...
/// Get branches with details
///
/// Examples:
/// - `/branches` or `/branches?remote=local` - only local branches
/// - `/branches?remote=origin` - only origin/* branches
/// - `/branches?remote=upstream` - only upstream/* branches
pub async fn get_branches(
    Path(id): Path<String>,
    Query(params): Query<BranchQueryParams>,
) -> Result<Json<BranchesDetailResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    let current_branch = git::current_branch(&project_path).unwrap_or_else(|_| "main".to_string());

    // Get Grove-managed branches from tasks (to filter them out)
    let project_key = workspace::project_hash(&project_path);
    let mut grove_branches = HashSet::new();

    // Collect branches from active tasks
    if let Ok(active_tasks) = tasks::load_tasks(&project_key) {
        for task in active_tasks {
            grove_branches.insert(task.branch);
        }
    }

    // Collect branches from archived tasks
    if let Ok(archived_tasks) = tasks::load_archived_tasks(&project_key) {
        for task in archived_tasks {
            grove_branches.insert(task.branch);
        }
    }

    let mut branches: Vec<BranchDetailInfo> = Vec::new();

    // Determine what to fetch based on remote parameter
    let remote = if params.remote.is_empty() {
        "local"
    } else {
        &params.remote
    };

    if remote == "local" {
        let local_branches =
            git::list_branches(&project_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        for name in &local_branches {
            if grove_branches.contains(name) {
                continue;
            }
            branches.push(BranchDetailInfo {
                name: name.clone(),
                is_local: true,
                is_current: name == &current_branch,
            });
        }
    } else {
        let remote_output = git_cmd(
            &project_path,
            &[
                "branch",
                "-r",
                "--format=%(refname:short)",
                "--list",
                &format!("{}/*", remote),
            ],
        )
        .unwrap_or_default();

        let remote_branches: Vec<String> = remote_output
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && !s.contains("HEAD"))
            .collect();

        let local_branches = git::list_branches(&project_path).unwrap_or_default();

        for name in &remote_branches {
            let local_name = name.strip_prefix(&format!("{}/", remote)).unwrap_or(name);
            if local_branches.contains(&local_name.to_string()) {
                continue;
            }
            branches.push(BranchDetailInfo {
                name: name.clone(),
                is_local: false,
                is_current: false,
            });
        }
    }

    Ok(Json(BranchesDetailResponse {
        branches,
        current: current_branch,
    }))
}

/// Remotes list response
#[derive(Debug, Serialize)]
pub struct RemotesResponse {
    pub remotes: Vec<String>,
}

/// GET /api/v1/projects/{id}/git/remotes
/// Get all remote names
pub async fn get_remotes(Path(id): Path<String>) -> Result<Json<RemotesResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    let remotes =
        git::list_remotes(&project_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(RemotesResponse { remotes }))
}

/// GET /api/v1/projects/{id}/git/commits
/// Get recent commits for the repository
#[derive(Deserialize)]
pub struct CommitQueryParams {
    /// Optional: only return commits since this date (e.g. "1 week ago", "2024-01-01")
    pub since: Option<String>,
    /// Max number of commits to return (default: 20)
    pub limit: Option<usize>,
}

pub async fn get_commits(
    Path(id): Path<String>,
    Query(params): Query<CommitQueryParams>,
) -> Result<Json<RepoCommitsResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;
    let limit = params.limit.unwrap_or(20).min(100);

    // Convert frontend's "1 week ago"-style strings to a Unix-timestamp cutoff.
    // Unrecognized formats fall through to no filter (matches the previous
    // behavior of silently dropping invalid `since`).
    let min_committer_time = params
        .since
        .as_deref()
        .and_then(parse_relative_since)
        .map(|secs| chrono::Utc::now().timestamp() - secs);

    let Ok(mut repo) = gix::open(&project_path) else {
        return Ok(Json(RepoCommitsResponse {
            commits: Vec::new(),
        }));
    };
    // 64 MiB object cache 让连续 commit decode 命中已解压数据。
    repo.object_cache_size_if_unset(64 * 1024 * 1024);

    let entries = git::gix_recent_log(&repo, limit, min_committer_time).unwrap_or_default();

    let commits: Vec<RepoCommitEntry> = entries
        .into_iter()
        .map(|e| RepoCommitEntry {
            hash: e.hash,
            message: e.message,
            author: e.author,
            time_ago: e.time_ago,
        })
        .collect();

    Ok(Json(RepoCommitsResponse { commits }))
}

/// Parse strings like "1 week ago", "2 days ago", "3 months ago" into a
/// duration-in-seconds offset. Returns None on anything unrecognized.
///
/// Only the subset of git's `--since` syntax that the frontend actually emits.
/// We deliberately keep this small: the previous shell-out variant accepted
/// almost anything and let git complain or silently no-op; matching that
/// behavior is good enough.
fn parse_relative_since(s: &str) -> Option<i64> {
    use chrono::Months;
    let s = s.trim().to_ascii_lowercase();
    let s = s.strip_suffix(" ago").unwrap_or(&s);
    let mut parts = s.split_whitespace();
    let n: i64 = parts.next()?.parse().ok()?;
    if n < 0 {
        return None;
    }
    let unit = parts.next()?;
    match unit.trim_end_matches('s') {
        "second" => Some(n),
        "minute" | "min" => n.checked_mul(60),
        "hour" => n.checked_mul(3600),
        "day" => n.checked_mul(86_400),
        "week" => n.checked_mul(7 * 86_400),
        // Month/year: use calendar-aware subtraction so the cutoff matches the
        // user's intent (e.g. "1 month ago" on March 31 → Feb 28/29, not -30d).
        "month" => {
            let now = chrono::Utc::now();
            now.checked_sub_months(Months::new(n.try_into().ok()?))
                .map(|then| (now - then).num_seconds())
        }
        "year" => {
            let months = n.checked_mul(12)?;
            let now = chrono::Utc::now();
            now.checked_sub_months(Months::new(months.try_into().ok()?))
                .map(|then| (now - then).num_seconds())
        }
        _ => None,
    }
}

/// POST /api/v1/projects/{id}/git/checkout
/// Checkout a branch
pub async fn checkout(
    Path(id): Path<String>,
    Json(req): Json<CheckoutRequest>,
) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    match git::checkout(&project_path, &req.branch) {
        Ok(()) => Ok(Json(GitOpResponse {
            success: true,
            message: format!("Switched to branch '{}'", req.branch),
        })),
        Err(e) => Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        })),
    }
}

/// POST /api/v1/projects/{id}/git/pull
/// Pull from remote
pub async fn pull(Path(id): Path<String>) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    // Get current branch name
    let current_branch = match git::current_branch(&project_path) {
        Ok(branch) => branch,
        Err(e) => {
            return Ok(Json(GitOpResponse {
                success: false,
                message: format!("Failed to get current branch: {}", e),
            }));
        }
    };

    // Pull with explicit remote and branch: git pull origin <current_branch>
    match git_cmd(&project_path, &["pull", "origin", &current_branch]) {
        Ok(output) => Ok(Json(GitOpResponse {
            success: true,
            message: if output.is_empty() {
                "Already up to date".to_string()
            } else {
                output
            },
        })),
        Err(e) => Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        })),
    }
}

/// POST /api/v1/projects/{id}/git/push
/// Push to remote
pub async fn push(Path(id): Path<String>) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    // Get current branch name
    let current_branch = match git::current_branch(&project_path) {
        Ok(branch) => branch,
        Err(e) => {
            return Ok(Json(GitOpResponse {
                success: false,
                message: format!("Failed to get current branch: {}", e),
            }));
        }
    };

    // Push with explicit branch and --set-upstream to handle new branches
    // This is equivalent to: git push origin $(git_current_branch)
    match git_cmd(&project_path, &["push", "-u", "origin", &current_branch]) {
        Ok(output) => Ok(Json(GitOpResponse {
            success: true,
            message: if output.is_empty() {
                "Pushed successfully".to_string()
            } else {
                output
            },
        })),
        Err(e) => Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        })),
    }
}

/// POST /api/v1/projects/{id}/git/fetch
/// Fetch from remote
pub async fn fetch(Path(id): Path<String>) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    match git_cmd(&project_path, &["fetch", "--all", "--prune"]) {
        Ok(_) => Ok(Json(GitOpResponse {
            success: true,
            message: "Fetched from all remotes".to_string(),
        })),
        Err(e) => Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        })),
    }
}

/// POST /api/v1/projects/{id}/git/stash
/// Stash or pop changes
pub async fn stash(
    Path(id): Path<String>,
    Json(req): Json<StashRequest>,
) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    let args = if req.pop {
        vec!["stash", "pop"]
    } else {
        vec!["stash", "push", "-m", "Stash from Grove Web"]
    };

    match git_cmd(&project_path, &args) {
        Ok(output) => Ok(Json(GitOpResponse {
            success: true,
            message: if output.is_empty() {
                if req.pop {
                    "Stash popped".to_string()
                } else {
                    "Changes stashed".to_string()
                }
            } else {
                output
            },
        })),
        Err(e) => Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        })),
    }
}

/// POST /api/v1/projects/{id}/git/branches
/// Create a new branch
pub async fn create_branch(
    Path(id): Path<String>,
    Json(req): Json<CreateBranchRequest>,
) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    let base = req.base.unwrap_or_else(|| {
        git::current_branch(&project_path).unwrap_or_else(|_| "HEAD".to_string())
    });

    // Create branch
    if let Err(e) = git_cmd(&project_path, &["branch", &req.name, &base]) {
        return Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        }));
    }

    // Checkout if requested
    if req.checkout {
        if let Err(e) = git::checkout(&project_path, &req.name) {
            return Ok(Json(GitOpResponse {
                success: false,
                message: format!("Branch created but checkout failed: {}", e),
            }));
        }
    }

    Ok(Json(GitOpResponse {
        success: true,
        message: format!(
            "Branch '{}' created{}",
            req.name,
            if req.checkout { " and checked out" } else { "" }
        ),
    }))
}

/// DELETE /api/v1/projects/{id}/git/branches/{name}
/// Delete a branch
pub async fn delete_branch(
    Path((id, branch_name)): Path<(String, String)>,
) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    // Use -d (safe delete) by default
    match git_cmd(&project_path, &["branch", "-d", &branch_name]) {
        Ok(_) => Ok(Json(GitOpResponse {
            success: true,
            message: format!("Branch '{}' deleted", branch_name),
        })),
        Err(e) => {
            // If it fails because not fully merged, suggest force delete
            let error_msg = e.to_string();
            if error_msg.contains("not fully merged") {
                Ok(Json(GitOpResponse {
                    success: false,
                    message: format!(
                        "Branch '{}' is not fully merged. Use force delete if sure.",
                        branch_name
                    ),
                }))
            } else {
                Ok(Json(GitOpResponse {
                    success: false,
                    message: error_msg,
                }))
            }
        }
    }
}

/// POST /api/v1/projects/{id}/git/commit
/// Commit changes
pub async fn commit(
    Path(id): Path<String>,
    Json(req): Json<CommitRequest>,
) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    // Add all changes first
    if let Err(e) = git_cmd(&project_path, &["add", "-A"]) {
        return Ok(Json(GitOpResponse {
            success: false,
            message: format!("Failed to stage changes: {}", e),
        }));
    }

    // Commit with the provided message
    match git_cmd(&project_path, &["commit", "-m", &req.message]) {
        Ok(output) => Ok(Json(GitOpResponse {
            success: true,
            message: if output.is_empty() {
                "Changes committed".to_string()
            } else {
                output
            },
        })),
        Err(e) => {
            let error_msg = e.to_string();
            // Handle "nothing to commit" case
            if error_msg.contains("nothing to commit") {
                Ok(Json(GitOpResponse {
                    success: false,
                    message: "No changes to commit".to_string(),
                }))
            } else {
                Ok(Json(GitOpResponse {
                    success: false,
                    message: error_msg,
                }))
            }
        }
    }
}

/// POST /api/v1/projects/{id}/git/branches/{name}/rename
/// Rename a branch
#[derive(Debug, Deserialize)]
pub struct RenameBranchRequest {
    pub new_name: String,
}

pub async fn rename_branch(
    Path((id, branch_name)): Path<(String, String)>,
    Json(req): Json<RenameBranchRequest>,
) -> Result<Json<GitOpResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    match git_cmd(
        &project_path,
        &["branch", "-m", &branch_name, &req.new_name],
    ) {
        Ok(_) => Ok(Json(GitOpResponse {
            success: true,
            message: format!("Branch '{}' renamed to '{}'", branch_name, req.new_name),
        })),
        Err(e) => Ok(Json(GitOpResponse {
            success: false,
            message: e.to_string(),
        })),
    }
}
