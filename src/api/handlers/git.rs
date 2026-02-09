//! Git API handlers for project-level git operations

use axum::{extract::Path, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::git;
use crate::storage::workspace;

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
    /// Whether the repo has an origin remote for the current branch
    pub has_origin: bool,
}

/// Branch info with ahead/behind
#[derive(Debug, Serialize)]
pub struct BranchDetailInfo {
    pub name: String,
    pub is_local: bool,
    pub is_current: bool,
    pub last_commit: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
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

/// Get commits ahead/behind for a branch relative to origin
fn get_ahead_behind(path: &str, branch: &str) -> (Option<u32>, Option<u32>) {
    let origin_ref = format!("origin/{}", branch);

    // Check if origin ref exists
    if git_cmd(path, &["rev-parse", "--verify", &origin_ref]).is_err() {
        return (None, None);
    }

    // Get ahead count
    let ahead = git_cmd(
        path,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", origin_ref, branch),
        ],
    )
    .ok()
    .and_then(|s| s.parse().ok());

    // Get behind count
    let behind = git_cmd(
        path,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", branch, origin_ref),
        ],
    )
    .ok()
    .and_then(|s| s.parse().ok());

    (ahead, behind)
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/v1/projects/{id}/git/status
/// Get repository git status
pub async fn get_status(Path(id): Path<String>) -> Result<Json<RepoStatusResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    let current_branch =
        git::current_branch(&project_path).unwrap_or_else(|_| "unknown".to_string());

    // Get ahead/behind from origin
    let (ahead, behind) = get_ahead_behind(&project_path, &current_branch);

    // Determine if origin exists for this branch
    let has_origin = ahead.is_some() || behind.is_some();

    // Get uncommitted count
    let uncommitted = git::uncommitted_count(&project_path).unwrap_or(0) as u32;

    // Get stash count
    let stash_count = git::stash_count(&project_path).unwrap_or(0) as u32;

    // Check for conflicts
    let has_conflicts = git::has_conflicts(&project_path);

    Ok(Json(RepoStatusResponse {
        current_branch,
        ahead: ahead.unwrap_or(0),
        behind: behind.unwrap_or(0),
        uncommitted,
        stash_count,
        has_conflicts,
        has_origin,
    }))
}

/// GET /api/v1/projects/{id}/git/branches
/// Get all branches with details
pub async fn get_branches(
    Path(id): Path<String>,
) -> Result<Json<BranchesDetailResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    let current_branch = git::current_branch(&project_path).unwrap_or_else(|_| "main".to_string());

    // Get local branches
    let local_branches =
        git::list_branches(&project_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Get remote branches
    let remote_output = git_cmd(
        &project_path,
        &["branch", "-r", "--format=%(refname:short)"],
    )
    .unwrap_or_default();
    let remote_branches: Vec<String> = remote_output
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| {
            !s.is_empty() && !s.contains("HEAD") && s.contains('/') // Must have format "remote/branch", filter out bare remote names like "origin"
        })
        .collect();

    let mut branches: Vec<BranchDetailInfo> = Vec::new();

    // Add local branches
    for name in &local_branches {
        let is_current = name == &current_branch;
        let last_commit = git_cmd(&project_path, &["rev-parse", "--short", name]).ok();
        let (ahead, behind) = get_ahead_behind(&project_path, name);

        branches.push(BranchDetailInfo {
            name: name.clone(),
            is_local: true,
            is_current,
            last_commit,
            ahead,
            behind,
        });
    }

    // Add remote branches (skip those that have local counterparts)
    for name in &remote_branches {
        // Check if local version exists
        let local_name = name.strip_prefix("origin/").unwrap_or(name);
        if local_branches.contains(&local_name.to_string()) {
            continue;
        }

        let last_commit = git_cmd(&project_path, &["rev-parse", "--short", name]).ok();

        branches.push(BranchDetailInfo {
            name: name.clone(),
            is_local: false,
            is_current: false,
            last_commit,
            ahead: None,
            behind: None,
        });
    }

    Ok(Json(BranchesDetailResponse {
        branches,
        current: current_branch,
    }))
}

/// GET /api/v1/projects/{id}/git/commits
/// Get recent commits for the repository
pub async fn get_commits(Path(id): Path<String>) -> Result<Json<RepoCommitsResponse>, StatusCode> {
    let project_path = find_project_path(&id)?;

    // Get recent commits with hash, message, author, and time
    let output =
        git_cmd(&project_path, &["log", "-20", "--format=%H\t%s\t%an\t%cr"]).unwrap_or_default();

    let commits: Vec<RepoCommitEntry> = output
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\t').collect();
            if parts.len() >= 4 {
                Some(RepoCommitEntry {
                    hash: parts[0].to_string(),
                    message: parts[1].to_string(),
                    author: parts[2].to_string(),
                    time_ago: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(Json(RepoCommitsResponse { commits }))
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

    match git_cmd(&project_path, &["pull"]) {
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

    match git_cmd(&project_path, &["push"]) {
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
