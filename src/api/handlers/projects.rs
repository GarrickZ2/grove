//! Project API handlers

use axum::{extract::Path, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::git;
use crate::model::loader;
use crate::storage::{tasks, workspace};

// ============================================================================
// Request/Response DTOs
// ============================================================================

/// Project list item (for GET /projects)
#[derive(Debug, Serialize)]
pub struct ProjectListItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub added_at: String,
    pub task_count: u32,
    pub live_count: u32,
}

/// Project list response
#[derive(Debug, Serialize)]
pub struct ProjectListResponse {
    pub projects: Vec<ProjectListItem>,
}

/// Task response (matches frontend Task type)
#[derive(Debug, Serialize)]
pub struct TaskResponse {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub target: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub files_changed: u32,
    pub commits: Vec<CommitResponse>,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
}

/// Commit response
#[derive(Debug, Serialize)]
pub struct CommitResponse {
    pub hash: String,
    pub message: String,
    pub time_ago: String,
}

/// Full project response (for GET /projects/{id})
#[derive(Debug, Serialize)]
pub struct ProjectResponse {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current_branch: String,
    pub tasks: Vec<TaskResponse>,
    pub added_at: String,
}

/// Add project request
#[derive(Debug, Deserialize)]
pub struct AddProjectRequest {
    pub path: String,
    pub name: Option<String>,
}

/// Project stats response
#[derive(Debug, Serialize)]
pub struct ProjectStatsResponse {
    pub total_tasks: u32,
    pub live_tasks: u32,
    pub idle_tasks: u32,
    pub merged_tasks: u32,
    pub archived_tasks: u32,
}

/// Branch info response
#[derive(Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// Branches list response
#[derive(Debug, Serialize)]
pub struct BranchesResponse {
    pub branches: Vec<BranchInfo>,
    pub current: String,
}

// ============================================================================
// Helper functions
// ============================================================================

/// Convert WorktreeStatus to string
fn status_to_string(status: &crate::model::WorktreeStatus) -> &'static str {
    match status {
        crate::model::WorktreeStatus::Live => "live",
        crate::model::WorktreeStatus::Idle => "idle",
        crate::model::WorktreeStatus::Merged => "merged",
        crate::model::WorktreeStatus::Conflict => "conflict",
        crate::model::WorktreeStatus::Broken => "broken",
        crate::model::WorktreeStatus::Error => "broken",
        crate::model::WorktreeStatus::Archived => "archived",
    }
}

/// Convert Worktree to TaskResponse
fn worktree_to_response(wt: &crate::model::Worktree) -> TaskResponse {
    // Get commits
    let commits = git::recent_log(&wt.path, &wt.target, 10)
        .unwrap_or_default()
        .into_iter()
        .map(|log| CommitResponse {
            hash: String::new(), // log doesn't include hash, we can add it later if needed
            message: log.message,
            time_ago: log.time_ago,
        })
        .collect();

    // Count files changed
    let files_changed = git::diff_stat(&wt.path, &wt.target)
        .map(|stats| stats.len() as u32)
        .unwrap_or(0);

    TaskResponse {
        id: wt.id.clone(),
        name: wt.task_name.clone(),
        branch: wt.branch.clone(),
        target: wt.target.clone(),
        status: status_to_string(&wt.status).to_string(),
        additions: wt.file_changes.additions,
        deletions: wt.file_changes.deletions,
        files_changed,
        commits,
        created_at: wt.created_at.to_rfc3339(),
        updated_at: wt.updated_at.to_rfc3339(),
        path: wt.path.clone(),
    }
}

/// Find project by ID (hash)
fn find_project_by_id(id: &str) -> Result<workspace::RegisteredProject, StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Count tasks for a project
fn count_project_tasks(project_key: &str) -> (u32, u32) {
    let active_tasks = tasks::load_tasks(project_key).unwrap_or_default();

    let mut live_count = 0u32;
    let total = active_tasks.len() as u32;

    // Check which tasks have live sessions
    for task in &active_tasks {
        let session = crate::tmux::session_name(project_key, &task.id);
        if crate::tmux::session_exists(&session) {
            live_count += 1;
        }
    }

    (total, live_count)
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/v1/projects
/// List all registered projects
pub async fn list_projects() -> Result<Json<ProjectListResponse>, StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let items: Vec<ProjectListItem> = projects
        .iter()
        .map(|p| {
            let id = workspace::project_hash(&p.path);
            let (task_count, live_count) = count_project_tasks(&id);

            ProjectListItem {
                id,
                name: p.name.clone(),
                path: p.path.clone(),
                added_at: p.added_at.to_rfc3339(),
                task_count,
                live_count,
            }
        })
        .collect();

    Ok(Json(ProjectListResponse { projects: items }))
}

/// GET /api/v1/projects/{id}
/// Get a single project with its tasks
pub async fn get_project(Path(id): Path<String>) -> Result<Json<ProjectResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;

    // Load worktrees with status
    let (current, other, _archived) = loader::load_worktrees(&project.path);

    // Combine current and other branch tasks
    let mut all_tasks: Vec<TaskResponse> = Vec::new();
    for wt in current.iter().chain(other.iter()) {
        all_tasks.push(worktree_to_response(wt));
    }

    // Get current branch
    let current_branch = git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string());

    Ok(Json(ProjectResponse {
        id,
        name: project.name,
        path: project.path,
        current_branch,
        tasks: all_tasks,
        added_at: project.added_at.to_rfc3339(),
    }))
}

/// POST /api/v1/projects
/// Add a new project
pub async fn add_project(
    Json(req): Json<AddProjectRequest>,
) -> Result<Json<ProjectResponse>, StatusCode> {
    // Validate path exists and is a git repo
    if !std::path::Path::new(&req.path).exists() {
        return Err(StatusCode::BAD_REQUEST);
    }

    if !git::is_git_repo(&req.path) {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Get repo root (normalize path)
    let repo_path = git::repo_root(&req.path).map_err(|_| StatusCode::BAD_REQUEST)?;

    // Determine name
    let name = req.name.unwrap_or_else(|| {
        std::path::Path::new(&repo_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    // Add project
    workspace::add_project(&name, &repo_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            StatusCode::CONFLICT
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    })?;

    // Return the new project
    let id = workspace::project_hash(&repo_path);
    let current_branch = git::current_branch(&repo_path).unwrap_or_else(|_| "main".to_string());

    Ok(Json(ProjectResponse {
        id,
        name,
        path: repo_path,
        current_branch,
        tasks: Vec::new(),
        added_at: chrono::Utc::now().to_rfc3339(),
    }))
}

/// DELETE /api/v1/projects/{id}
/// Delete a project (removes metadata only, not actual git repo)
pub async fn delete_project(Path(id): Path<String>) -> Result<StatusCode, StatusCode> {
    let project = find_project_by_id(&id)?;

    workspace::remove_project(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/stats
/// Get project statistics
pub async fn get_stats(Path(id): Path<String>) -> Result<Json<ProjectStatsResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;

    // Load all worktrees
    let (current, other, _) = loader::load_worktrees(&project.path);
    let archived = loader::load_archived_worktrees(&project.path);

    let mut live_tasks = 0u32;
    let mut idle_tasks = 0u32;
    let mut merged_tasks = 0u32;

    for wt in current.iter().chain(other.iter()) {
        match wt.status {
            crate::model::WorktreeStatus::Live => live_tasks += 1,
            crate::model::WorktreeStatus::Idle => idle_tasks += 1,
            crate::model::WorktreeStatus::Merged => merged_tasks += 1,
            _ => idle_tasks += 1, // Count conflict/broken as idle for stats
        }
    }

    let total_tasks = current.len() as u32 + other.len() as u32;
    let archived_tasks = archived.len() as u32;

    Ok(Json(ProjectStatsResponse {
        total_tasks,
        live_tasks,
        idle_tasks,
        merged_tasks,
        archived_tasks,
    }))
}

/// GET /api/v1/projects/{id}/branches
/// Get list of branches for a project
pub async fn get_branches(Path(id): Path<String>) -> Result<Json<BranchesResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;

    // Get current branch
    let current = git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string());

    // Get all local branches
    let branch_names =
        git::list_branches(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let branches: Vec<BranchInfo> = branch_names
        .into_iter()
        .map(|name| {
            let is_current = name == current;
            BranchInfo { name, is_current }
        })
        .collect();

    Ok(Json(BranchesResponse { branches, current }))
}
