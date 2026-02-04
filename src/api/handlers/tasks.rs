//! Task API handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::git;
use crate::model::loader;
use crate::storage::{self, comments, notes, tasks, workspace};

use super::projects::{CommitResponse, TaskResponse};

// ============================================================================
// Request/Response DTOs
// ============================================================================

/// Task list query parameters
#[derive(Debug, Deserialize)]
pub struct TaskListQuery {
    pub filter: Option<String>, // "active" | "archived"
}

/// Task list response
#[derive(Debug, Serialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskResponse>,
}

/// Create task request
#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub name: String,
    pub target: Option<String>,
}

/// Notes response
#[derive(Debug, Serialize)]
pub struct NotesResponse {
    pub content: String,
}

/// Update notes request
#[derive(Debug, Deserialize)]
pub struct UpdateNotesRequest {
    pub content: String,
}

/// Commit request
#[derive(Debug, Deserialize)]
pub struct CommitRequest {
    pub message: String,
}

/// Git operation response
#[derive(Debug, Serialize)]
pub struct GitOperationResponse {
    pub success: bool,
    pub message: String,
}

/// Diff file entry
#[derive(Debug, Serialize)]
pub struct DiffFileEntry {
    pub path: String,
    pub status: String, // "A" | "M" | "D" | "R"
    pub additions: u32,
    pub deletions: u32,
}

/// Diff response
#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub files: Vec<DiffFileEntry>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

/// Commit entry for history
#[derive(Debug, Serialize)]
pub struct CommitEntry {
    pub hash: String,
    pub message: String,
    pub time_ago: String,
}

/// Commits response
#[derive(Debug, Serialize)]
pub struct CommitsResponse {
    pub commits: Vec<CommitEntry>,
    pub total: u32,
}

/// Review comment entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentEntry {
    pub id: u32,
    pub location: String,
    pub content: String,
    pub status: String, // "open" | "resolved" | "not_resolved"
    pub reply: Option<String>,
}

/// Review comments response
#[derive(Debug, Serialize)]
pub struct ReviewCommentsResponse {
    pub comments: Vec<ReviewCommentEntry>,
    pub open_count: u32,
    pub resolved_count: u32,
    pub not_resolved_count: u32,
}

/// Reply to review comment request
#[derive(Debug, Deserialize)]
pub struct ReplyCommentRequest {
    pub comment_id: u32,
    pub status: String, // "resolved" | "not_resolved"
    pub message: String,
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
            hash: String::new(),
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

/// Find project by ID and return (project, project_key)
fn find_project_by_id(id: &str) -> Result<(workspace::RegisteredProject, String), StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let project = projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_key = workspace::project_hash(&project.path);
    Ok((project, project_key))
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/v1/projects/{id}/tasks
/// List tasks for a project
pub async fn list_tasks(
    Path(id): Path<String>,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<TaskListResponse>, StatusCode> {
    let (project, _project_key) = find_project_by_id(&id)?;

    let filter = query.filter.as_deref().unwrap_or("active");

    let tasks = if filter == "archived" {
        // Load archived tasks
        let archived = loader::load_archived_worktrees(&project.path);
        archived.iter().map(worktree_to_response).collect()
    } else {
        // Load active tasks
        let (current, other, _) = loader::load_worktrees(&project.path);
        current
            .iter()
            .chain(other.iter())
            .map(worktree_to_response)
            .collect()
    };

    Ok(Json(TaskListResponse { tasks }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}
/// Get a single task
pub async fn get_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, _project_key) = find_project_by_id(&id)?;

    // Load all worktrees and find the one with matching ID
    let (current, other, _) = loader::load_worktrees(&project.path);

    let task = current
        .iter()
        .chain(other.iter())
        .find(|wt| wt.id == task_id);

    if let Some(wt) = task {
        return Ok(Json(worktree_to_response(wt)));
    }

    // Check archived
    let archived = loader::load_archived_worktrees(&project.path);
    let task = archived.iter().find(|wt| wt.id == task_id);

    if let Some(wt) = task {
        return Ok(Json(worktree_to_response(wt)));
    }

    Err(StatusCode::NOT_FOUND)
}

/// POST /api/v1/projects/{id}/tasks
/// Create a new task
pub async fn create_task(
    Path(id): Path<String>,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Determine target branch
    let target = req.target.unwrap_or_else(|| {
        git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string())
    });

    // Generate branch name
    let branch = tasks::generate_branch_name(&req.name);
    let task_id = tasks::to_slug(&req.name);

    // Determine worktree path
    let worktree_dir = storage::ensure_worktree_dir(&project_key)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let worktree_path = worktree_dir.join(&task_id);

    // Create worktree
    git::create_worktree(&project.path, &branch, &worktree_path, &target)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Create task record
    let now = Utc::now();
    let task = tasks::Task {
        id: task_id.clone(),
        name: req.name.clone(),
        branch: branch.clone(),
        target: target.clone(),
        worktree_path: worktree_path.to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
        status: tasks::TaskStatus::Active,
    };

    // Save task
    tasks::add_task(&project_key, task).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Return task response
    Ok(Json(TaskResponse {
        id: task_id,
        name: req.name,
        branch,
        target,
        status: "idle".to_string(), // New task is idle (no tmux session from web)
        additions: 0,
        deletions: 0,
        files_changed: 0,
        commits: Vec::new(),
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
        path: worktree_path.to_string_lossy().to_string(),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/archive
/// Archive a task
pub async fn archive_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Archive the task
    tasks::archive_task(&project_key, &task_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Load the archived task to return
    let archived = loader::load_archived_worktrees(&project.path);
    let task = archived
        .iter()
        .find(|wt| wt.id == task_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(worktree_to_response(task)))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/recover
/// Recover an archived task
pub async fn recover_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Recover the task
    tasks::recover_task(&project_key, &task_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Load the recovered task to return
    let (current, other, _) = loader::load_worktrees(&project.path);
    let task = current
        .iter()
        .chain(other.iter())
        .find(|wt| wt.id == task_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(worktree_to_response(task)))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}
/// Delete a task (removes worktree and task record)
pub async fn delete_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Get task info first
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    // Remove worktree
    let _ = git::remove_worktree(&project.path, &task.worktree_path);

    // Delete branch
    let _ = git::delete_branch(&project.path, &task.branch);

    // Remove task record (try both active and archived)
    let _ = tasks::remove_task(&project_key, &task_id);
    let _ = tasks::remove_archived_task(&project_key, &task_id);

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/notes
/// Get notes for a task
pub async fn get_notes(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<NotesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let content =
        notes::load_notes(&project_key, &task_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(NotesResponse { content }))
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/notes
/// Update notes for a task
pub async fn update_notes(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<UpdateNotesRequest>,
) -> Result<Json<NotesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    notes::save_notes(&project_key, &task_id, &req.content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(NotesResponse {
        content: req.content,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/sync
/// Sync task: fetch origin and rebase onto target
pub async fn sync_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Fetch origin
    if let Err(e) = git::fetch_origin(&project.path, &task.target) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to fetch: {}", e),
        }));
    }

    // Rebase onto target
    if let Err(e) = git::rebase(&task.worktree_path, &task.target) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Rebase failed: {}", e),
        }));
    }

    // Update task timestamp
    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Synced successfully".to_string(),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/commit
/// Commit changes in task worktree
pub async fn commit_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CommitRequest>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Add all and commit
    if let Err(e) = git::add_and_commit(&task.worktree_path, &req.message) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: e,
        }));
    }

    // Update task timestamp
    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Committed successfully".to_string(),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/merge
/// Merge task branch into target (squash merge)
pub async fn merge_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Check for uncommitted changes
    if git::has_uncommitted_changes(&task.worktree_path).unwrap_or(false) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: "Please commit or stash changes before merging".to_string(),
        }));
    }

    // Checkout target branch in main repo
    if let Err(e) = git::checkout(&project.path, &task.target) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to checkout {}: {}", task.target, e),
        }));
    }

    // Squash merge
    if let Err(e) = git::merge_squash(&project.path, &task.branch) {
        // Try to abort if merge failed
        let _ = git::reset_merge(&project.path);
        return Ok(Json(GitOperationResponse {
            success: false,
            message: e,
        }));
    }

    // Commit the squash merge
    let commit_message = format!("Merge task: {}", task.name);
    if let Err(e) = git::commit(&project.path, &commit_message) {
        let _ = git::reset_merge(&project.path);
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to commit merge: {}", e),
        }));
    }

    // Update task timestamp
    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Merged successfully".to_string(),
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/diff
/// Get changed files for a task
pub async fn get_diff(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<DiffResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Get diff stats
    let diff_entries = git::diff_stat(&task.worktree_path, &task.target).unwrap_or_default();

    let mut total_additions = 0u32;
    let mut total_deletions = 0u32;

    let files: Vec<DiffFileEntry> = diff_entries
        .into_iter()
        .map(|entry| {
            total_additions += entry.additions;
            total_deletions += entry.deletions;

            let status = match entry.status {
                'A' => "A",
                'D' => "D",
                'R' => "R",
                _ => "M",
            }
            .to_string();

            DiffFileEntry {
                path: entry.path,
                status,
                additions: entry.additions,
                deletions: entry.deletions,
            }
        })
        .collect();

    Ok(Json(DiffResponse {
        files,
        total_additions,
        total_deletions,
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/commits
/// Get commit history for a task
pub async fn get_commits(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<CommitsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Get recent commits
    let log_entries = git::recent_log(&task.worktree_path, &task.target, 50).unwrap_or_default();

    let total = log_entries.len() as u32;

    let commits: Vec<CommitEntry> = log_entries
        .into_iter()
        .map(|entry| CommitEntry {
            hash: String::new(), // We don't have hash in LogEntry, could add later
            message: entry.message,
            time_ago: entry.time_ago,
        })
        .collect();

    Ok(Json(CommitsResponse { commits, total }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/review
/// Get review comments for a task
pub async fn get_review_comments(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Load comments
    let data = comments::load_comments(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let (open, resolved, not_resolved) = data.count_by_status();

    let comment_entries: Vec<ReviewCommentEntry> = data
        .comments
        .into_iter()
        .map(|c| {
            let status = match c.status {
                comments::CommentStatus::Open => "open",
                comments::CommentStatus::Resolved => "resolved",
                comments::CommentStatus::NotResolved => "not_resolved",
            }
            .to_string();

            ReviewCommentEntry {
                id: c.id,
                location: c.location,
                content: c.content,
                status,
                reply: c.reply,
            }
        })
        .collect();

    Ok(Json(ReviewCommentsResponse {
        comments: comment_entries,
        open_count: open as u32,
        resolved_count: resolved as u32,
        not_resolved_count: not_resolved as u32,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/review
/// Reply to a review comment
pub async fn reply_review_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<ReplyCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Parse status
    let status = match req.status.as_str() {
        "resolved" => comments::CommentStatus::Resolved,
        "not_resolved" => comments::CommentStatus::NotResolved,
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    // Reply to comment
    comments::reply_comment(&project_key, &task_id, req.comment_id, status, &req.message)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Return updated comments
    get_review_comments(Path((id, task_id))).await
}
