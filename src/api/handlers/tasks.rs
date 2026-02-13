//! Task API handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use std::path::Path as StdPath;

use crate::git;
use crate::hooks;
use crate::model::loader;
use crate::session;
use crate::storage::{self, comments, config::Multiplexer, notes, tasks, workspace};
use crate::watcher;

use super::projects::{CommitResponse, TaskResponse};

// ============================================================================
// Request/Response DTOs
// ============================================================================

/// Task list query parameters
#[derive(Debug, Deserialize)]
pub struct TaskListQuery {
    pub filter: Option<String>, // "active" | "archived"
}

#[derive(Debug, Deserialize)]
pub struct ArchiveQuery {
    /// If true, skip safety checks and archive immediately.
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ArchiveConfirmResponse {
    pub error: String,
    pub code: String,
    pub task_name: String,
    pub branch: String,
    pub target: String,
    pub worktree_dirty: bool,
    pub branch_merged: bool,
    pub dirty_check_failed: bool,
    pub merge_check_failed: bool,
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
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
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

/// Merge request
#[derive(Debug, Deserialize)]
pub struct MergeRequest {
    /// Merge method: "squash" or "merge-commit" (default: auto-select based on commit count)
    #[serde(default)]
    pub method: Option<String>,
}

/// Rebase-to request (change target branch)
#[derive(Debug, Deserialize)]
pub struct RebaseToRequest {
    pub target: String,
}

/// Git operation response
#[derive(Debug, Serialize)]
pub struct GitOperationResponse {
    pub success: bool,
    pub message: String,
}

/// API error response (for returning error details with status codes)
#[derive(Debug, Serialize)]
pub struct ApiErrorResponse {
    pub error: String,
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
    /// Number of leading commits (newest-first) to skip when building version options.
    /// When working tree is clean: equals the count of consecutive commits whose tree
    /// matches HEAD's tree (at least 1, since commits\[0\] IS HEAD).
    /// When working tree is dirty: 0 (all commits become versions, Latest = working tree).
    pub skip_versions: u32,
}

/// Review comment reply entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentReplyEntry {
    pub id: u32,
    pub content: String,
    pub author: String,
    pub timestamp: String,
}

/// Review comment entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentEntry {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_type: Option<String>, // "inline" | "file" | "project" (defaults to "inline" for backward compatibility)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub content: String,
    pub author: String,
    pub timestamp: String,
    pub status: String, // "open" | "resolved" | "outdated"
    pub replies: Vec<ReviewCommentReplyEntry>,
}

/// Review comments response
#[derive(Debug, Serialize)]
pub struct ReviewCommentsResponse {
    pub comments: Vec<ReviewCommentEntry>,
    pub open_count: u32,
    pub resolved_count: u32,
    pub outdated_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_user_name: Option<String>,
}

/// File list response
#[derive(Serialize)]
pub struct FilesResponse {
    pub files: Vec<String>,
}

/// File content response
#[derive(Debug, Serialize)]
pub struct FileContentResponse {
    pub content: String,
    pub path: String,
}

/// Write file request
#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub content: String,
}

/// File path query parameter
#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
}

/// Reply to review comment request
#[derive(Debug, Deserialize)]
pub struct ReplyCommentRequest {
    pub comment_id: u32,
    pub message: String,
    pub author: Option<String>,
}

/// Update review comment status request
#[derive(Debug, Deserialize)]
pub struct UpdateCommentStatusRequest {
    pub status: String, // "open" | "resolved"
}

/// Edit comment content request
#[derive(Debug, Deserialize)]
pub struct EditCommentRequest {
    pub content: String,
}

/// Edit reply content request
#[derive(Debug, Deserialize)]
pub struct EditReplyRequest {
    pub content: String,
}

/// Create review comment request
#[derive(Debug, Deserialize)]
pub struct CreateReviewCommentRequest {
    pub content: String,
    /// Comment type: "inline" | "file" | "project" (defaults to "inline")
    pub comment_type: Option<String>,
    /// 新格式：结构化字段
    pub file_path: Option<String>,
    pub side: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub author: Option<String>,
    /// 旧格式兼容：location string (如 "src/main.rs:42")
    pub location: Option<String>,
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

/// Get git user.name for a task's worktree (used for display purposes in frontend).
fn get_git_user_name(project_key: &str, task_id: &str) -> Option<String> {
    tasks::get_task(project_key, task_id)
        .ok()
        .flatten()
        .and_then(|task| git::git_user_name(&task.worktree_path))
}

/// Convert Worktree to TaskResponse
fn worktree_to_response(wt: &crate::model::Worktree) -> TaskResponse {
    // Get commits
    let commits = git::recent_log(&wt.path, &wt.target, 10)
        .unwrap_or_default()
        .into_iter()
        .map(|log| CommitResponse {
            hash: log.hash,
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

    let mut tasks: Vec<TaskResponse> = if filter == "archived" {
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

    // Sort by updated_at descending (newest first)
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

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
    let global_mux_for_task = storage::config::load_config().multiplexer;
    let sname = crate::session::session_name(&project_key, &task_id);
    let task = tasks::Task {
        id: task_id.clone(),
        name: req.name.clone(),
        branch: branch.clone(),
        target: target.clone(),
        worktree_path: worktree_path.to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
        status: tasks::TaskStatus::Active,
        multiplexer: global_mux_for_task.to_string(),
        session_name: sname,
    };

    // Save task
    tasks::add_task(&project_key, task).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Save notes if provided
    if let Some(ref notes_content) = req.notes {
        if !notes_content.is_empty() {
            let _ = notes::save_notes(&project_key, &task_id, notes_content);
        }
    }

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
/// POST /api/v1/projects/{id}/tasks/{taskId}/archive
/// Archive a task
/// Logic from TUI: app.rs do_archive()
pub async fn archive_task(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ArchiveConfirmResponse>)> {
    let (project, project_key) = find_project_by_id(&id)
        .map_err(|s| {
            (
                s,
                Json(ArchiveConfirmResponse {
                    error: "Project not found".to_string(),
                    code: "PROJECT_NOT_FOUND".to_string(),
                    task_name: task_id.clone(),
                    branch: "".to_string(),
                    target: "".to_string(),
                    worktree_dirty: false,
                    branch_merged: true,
                    dirty_check_failed: true,
                    merge_check_failed: true,
                }),
            )
        })?;

    let force = query.force.unwrap_or(false);

    // Safety checks (GUI needs a confirmation step like TUI)
    if !force {
        let task = match tasks::get_task(&project_key, &task_id).ok().flatten() {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse {
                        error: "Task not found".to_string(),
                        code: "TASK_NOT_FOUND".to_string(),
                        task_name: task_id.clone(),
                        branch: "".to_string(),
                        target: "".to_string(),
                        worktree_dirty: false,
                        branch_merged: true,
                        dirty_check_failed: true,
                        merge_check_failed: true,
                    }),
                ));
            }
        };

        let mut worktree_dirty = false;
        let mut dirty_check_failed = false;
        match git::has_uncommitted_changes(&task.worktree_path) {
            Ok(v) => worktree_dirty = v,
            Err(_) => {
                dirty_check_failed = true;
            }
        }

        let mut branch_merged = true;
        let mut merge_check_failed = false;
        match git::is_merged(&project.path, &task.branch, &task.target) {
            Ok(v) => branch_merged = v,
            Err(_) => {
                merge_check_failed = true;
            }
        }

        let needs_confirm =
            worktree_dirty || !branch_merged || dirty_check_failed || merge_check_failed;
        if needs_confirm {
            return Err((
                StatusCode::CONFLICT,
                Json(ArchiveConfirmResponse {
                    error: "Archive requires confirmation".to_string(),
                    code: "ARCHIVE_CONFIRM_REQUIRED".to_string(),
                    task_name: task.name,
                    branch: task.branch,
                    target: task.target,
                    worktree_dirty,
                    branch_merged,
                    dirty_check_failed,
                    merge_check_failed,
                }),
            ));
        }
    }

    // 1. Get task info (need multiplexer + session_name before archive moves it)
    let global_mux = storage::config::load_config().multiplexer;
    let task_info = tasks::get_task(&project_key, &task_id).ok().flatten();
    let task_mux_str = task_info
        .as_ref()
        .map(|t| t.multiplexer.clone())
        .unwrap_or_default();
    let task_sname = task_info
        .as_ref()
        .map(|t| t.session_name.clone())
        .unwrap_or_default();
    let task_mux = session::resolve_multiplexer(&task_mux_str, &global_mux);

    // 1b. Get worktree path and remove it (TUI: do_archive step 1)
    if let Ok(Some(task)) = tasks::get_task(&project_key, &task_id) {
        if StdPath::new(&task.worktree_path).exists() {
            let _ = git::remove_worktree(&project.path, &task.worktree_path);
        }
    }

    // 2. Move to archived.toml (TUI: do_archive step 2)
    tasks::archive_task(&project_key, &task_id).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ArchiveConfirmResponse {
                error: "Archive failed".to_string(),
                code: "ARCHIVE_FAILED".to_string(),
                task_name: task_id.clone(),
                branch: "".to_string(),
                target: "".to_string(),
                worktree_dirty: false,
                branch_merged: true,
                dirty_check_failed: true,
                merge_check_failed: true,
            }),
        )
    })?;

    // 3. Remove hook notification (TUI: do_archive step 3)
    hooks::remove_task_hook(&project_key, &task_id);

    // 4. Kill session (TUI: do_archive step 4)
    let session_name = session::resolve_session_name(&task_sname, &project_key, &task_id);
    let _ = session::kill_session(&task_mux, &session_name);
    if task_mux == Multiplexer::Zellij {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    // Load the archived task to return
    let archived = loader::load_archived_worktrees(&project.path);
    let task = archived
        .iter()
        .find(|wt| wt.id == task_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ArchiveConfirmResponse {
                    error: "Archived task not found".to_string(),
                    code: "ARCHIVED_TASK_NOT_FOUND".to_string(),
                    task_name: task_id.clone(),
                    branch: "".to_string(),
                    target: "".to_string(),
                    worktree_dirty: false,
                    branch_merged: true,
                    dirty_check_failed: true,
                    merge_check_failed: true,
                }),
            )
        })?;

    Ok(Json(worktree_to_response(task)))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/recover
/// Recover an archived task
/// Logic from TUI: app.rs recover_worktree()
pub async fn recover_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    // 1. Get archived task info (TUI: recover_worktree step 1)
    let task = tasks::get_archived_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load archived task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Archived task not found".to_string(),
                }),
            )
        })?;

    // 2. Check if branch still exists (TUI: recover_worktree step 2)
    if !git::branch_exists(&project.path, &task.branch) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiErrorResponse {
                error: format!(
                    "Branch '{}' no longer exists. Cannot recover task.",
                    task.branch
                ),
            }),
        ));
    }

    // 3. Recreate worktree from existing branch (TUI: recover_worktree step 3)
    let worktree_path = StdPath::new(&task.worktree_path);
    if let Err(e) = git::create_worktree_from_branch(&project.path, &task.branch, worktree_path) {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to recreate worktree: {}", e),
            }),
        ));
    }

    // 4. Move task from archived.toml back to tasks.toml (TUI: recover_worktree step 4)
    tasks::recover_task(&project_key, &task_id).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to recover task record: {}", e),
            }),
        )
    })?;

    // Note: TUI creates tmux session (steps 5-6), but web doesn't auto-create session

    // Load the recovered task to return
    let (current, other, _) = loader::load_worktrees(&project.path);
    let task = current
        .iter()
        .chain(other.iter())
        .find(|wt| wt.id == task_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Failed to find recovered task".to_string(),
                }),
            )
        })?;

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

    // Kill session
    let global_mux = storage::config::load_config().multiplexer;
    let task_mux = session::resolve_multiplexer(&task.multiplexer, &global_mux);
    let session_name = session::resolve_session_name(&task.session_name, &project_key, &task_id);
    let _ = session::kill_session(&task_mux, &session_name);
    if task_mux == Multiplexer::Zellij {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    // Remove worktree
    let _ = git::remove_worktree(&project.path, &task.worktree_path);

    // Delete branch
    let _ = git::delete_branch(&project.path, &task.branch);

    // Remove task record (try both active and archived)
    let _ = tasks::remove_task(&project_key, &task_id);
    let _ = tasks::remove_archived_task(&project_key, &task_id);

    // Clean all associated data
    hooks::remove_task_hook(&project_key, &task_id);
    let _ = notes::delete_notes(&project_key, &task_id);
    let _ = comments::delete_review_data(&project_key, &task_id);
    let _ = watcher::clear_edit_history(&project_key, &task_id);

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
/// POST /api/v1/projects/{id}/tasks/{taskId}/sync
/// Sync task: rebase worktree branch onto target branch
/// Logic from TUI: app.rs do_sync()
pub async fn sync_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Check if worktree has uncommitted changes (TUI: start_sync)
    if git::has_uncommitted_changes(&task.worktree_path).unwrap_or(false) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: "Worktree has uncommitted changes. Please commit or stash first.".to_string(),
        }));
    }

    // Check if target branch (main repo) has uncommitted changes (TUI: check_sync_target)
    if git::has_uncommitted_changes(&project.path).unwrap_or(false) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!(
                "Target branch '{}' has uncommitted changes. Please commit first.",
                task.target
            ),
        }));
    }

    // Execute rebase (TUI: do_sync)
    if let Err(e) = git::rebase(&task.worktree_path, &task.target) {
        let error_msg = e.to_string();
        let message = if error_msg.contains("conflict") || error_msg.contains("CONFLICT") {
            "Conflict detected - please resolve in terminal".to_string()
        } else {
            format!("Sync failed: {}", error_msg)
        };
        return Ok(Json(GitOperationResponse {
            success: false,
            message,
        }));
    }

    // Update task timestamp
    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: format!("Synced with {}", task.target),
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
            message: e.to_string(),
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
/// Merge task branch into target
/// Logic from TUI: app.rs start_merge(), check_merge_target(), open_merge_dialog(), do_merge()
pub async fn merge_task(
    Path((id, task_id)): Path<(String, String)>,
    body: Option<Json<MergeRequest>>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Get task info
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Check if worktree has uncommitted changes (TUI: start_merge)
    if git::has_uncommitted_changes(&task.worktree_path).unwrap_or(false) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: "Worktree has uncommitted changes. Please commit or stash first.".to_string(),
        }));
    }

    // Check if target branch (main repo) has uncommitted changes (TUI: check_merge_target)
    // Git doesn't allow merge with uncommitted changes - must block
    if git::has_uncommitted_changes(&project.path).unwrap_or(false) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!(
                "Cannot merge: '{}' has uncommitted changes. Please commit first.",
                task.target
            ),
        }));
    }

    // Determine merge method (TUI: open_merge_dialog)
    let method = body.as_ref().and_then(|b| b.method.as_deref());
    let use_squash = match method {
        Some("squash") => true,
        Some("merge-commit") => false,
        _ => {
            // Auto-select: if only 1 commit, use merge-commit; otherwise squash
            let commit_count =
                git::commits_behind(&task.worktree_path, &task.branch, &task.target).unwrap_or(0);
            commit_count > 1
        }
    };

    // Checkout target branch in main repo first
    if let Err(e) = git::checkout(&project.path, &task.target) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to checkout {}: {}", task.target, e),
        }));
    }

    // Load notes for commit message (non-fatal)
    let notes_content = notes::load_notes(&project_key, &task_id)
        .ok()
        .filter(|s| !s.trim().is_empty());

    // Execute merge (TUI: do_merge)
    let result = if use_squash {
        // Squash merge + commit; rollback on commit failure
        let msg = git::build_commit_message(&task.name, notes_content.as_deref());
        git::merge_squash(&project.path, &task.branch).and_then(|()| {
            git::commit(&project.path, &msg).inspect_err(|_| {
                let _ = git::reset_merge(&project.path);
            })
        })
    } else {
        // Merge with --no-ff
        let title = format!("Merge: {}", task.name);
        let msg = git::build_commit_message(&title, notes_content.as_deref());
        git::merge_no_ff(&project.path, &task.branch, &msg)
    };

    if let Err(e) = result {
        let _ = git::reset_merge(&project.path);
        return Ok(Json(GitOperationResponse {
            success: false,
            message: e.to_string(),
        }));
    }

    // Update task timestamp
    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: format!("Merged into {}", task.target),
    }))
}

/// Diff query parameters
#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    /// When true, return full parsed diff with hunks and lines
    pub full: Option<bool>,
    /// Start ref (defaults to task.target)
    pub from_ref: Option<String>,
    /// End ref: commit hash or omit for working tree (latest)
    pub to_ref: Option<String>,
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/diff
/// Get changed files for a task.
/// With `?full=true`, returns full parsed diff (hunks + lines).
pub async fn get_diff(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<DiffQuery>,
) -> Result<axum::response::Response, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Get task info (try active tasks first, then archived)
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    if query.full.unwrap_or(false) {
        // Determine from/to refs
        let from_ref = query.from_ref.as_deref().unwrap_or(&task.target);
        let to_ref = match query.to_ref.as_deref() {
            None | Some("latest") | Some("") => None, // working tree diff
            Some(hash) => Some(hash),
        };

        // Return full parsed diff
        let result = crate::diff::get_diff_range(&task.worktree_path, from_ref, to_ref)
            .unwrap_or_else(|_| crate::diff::DiffResult {
                files: Vec::new(),
                total_additions: 0,
                total_deletions: 0,
            });
        Ok(Json(result).into_response())
    } else {
        // Return summary format (backward compatible)
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
        })
        .into_response())
    }
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/commits
/// Get commit history for a task
pub async fn get_commits(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<CommitsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Get task info (try active tasks first, then archived)
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    // Get recent commits
    let log_entries = git::recent_log(&task.worktree_path, &task.target, 50).unwrap_or_default();

    let total = log_entries.len() as u32;

    let commits: Vec<CommitEntry> = log_entries
        .into_iter()
        .map(|entry| CommitEntry {
            hash: entry.hash,
            message: entry.message,
            time_ago: entry.time_ago,
        })
        .collect();

    // Compute how many leading commits to skip for version display.
    // When working tree is dirty: 0 (Latest = working tree, all commits are distinct versions).
    // When clean: skip consecutive commits whose tree matches HEAD's tree.
    let dirty = git::has_uncommitted_changes(&task.worktree_path).unwrap_or(false);
    let skip_versions = if dirty {
        0u32
    } else if let Ok(head_tree) = git::tree_hash(&task.worktree_path, "HEAD") {
        commits
            .iter()
            .take_while(|c| {
                git::tree_hash(&task.worktree_path, &c.hash).ok().as_ref() == Some(&head_tree)
            })
            .count() as u32
    } else {
        1 // fallback: at least skip commits[0] which IS HEAD
    };

    Ok(Json(CommitsResponse {
        commits,
        total,
        skip_versions,
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/review
/// Get review comments for a task
pub async fn get_review_comments(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Load comments
    let mut data = comments::load_comments(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 动态检测 outdated 并修正行号
    if let Ok(Some(task)) = tasks::get_task(&project_key, &task_id) {
        let wt_path = task.worktree_path.clone();
        let target = task.target.clone();
        let changed = comments::apply_outdated_detection(&mut data, |file_path, side| {
            if side == "DELETE" {
                git::show_file(&wt_path, &target, file_path).ok()
            } else {
                git::read_file(&wt_path, file_path).ok()
            }
        });
        if changed {
            let _ = comments::save_comments(&project_key, &task_id, &data);
        }
    }

    let (open, resolved, outdated) = data.count_by_status();

    let comment_entries: Vec<ReviewCommentEntry> = data
        .comments
        .into_iter()
        .map(|c| {
            let status = match c.status {
                comments::CommentStatus::Open => "open",
                comments::CommentStatus::Resolved => "resolved",
                comments::CommentStatus::Outdated => "outdated",
            }
            .to_string();

            let replies = c
                .replies
                .into_iter()
                .map(|r| ReviewCommentReplyEntry {
                    id: r.id,
                    content: r.content,
                    author: r.author,
                    timestamp: r.timestamp,
                })
                .collect();

            ReviewCommentEntry {
                id: c.id,
                comment_type: Some(match c.comment_type {
                    comments::CommentType::Inline => "inline".to_string(),
                    comments::CommentType::File => "file".to_string(),
                    comments::CommentType::Project => "project".to_string(),
                }),
                file_path: c.file_path,
                side: c.side,
                start_line: c.start_line,
                end_line: c.end_line,
                content: c.content,
                author: c.author,
                timestamp: c.timestamp,
                status,
                replies,
            }
        })
        .collect();

    Ok(Json(ReviewCommentsResponse {
        comments: comment_entries,
        open_count: open as u32,
        resolved_count: resolved as u32,
        outdated_count: outdated as u32,
        git_user_name: get_git_user_name(&project_key, &task_id),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/review
/// Reply to a review comment (no status change)
pub async fn reply_review_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<ReplyCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let default_name = get_git_user_name(&project_key, &task_id);
    let author = req
        .author
        .as_deref()
        .or(default_name.as_deref())
        .unwrap_or("You");

    // Reply to comment (no status change)
    comments::reply_comment(&project_key, &task_id, req.comment_id, &req.message, author)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Return updated comments
    get_review_comments(Path((id, task_id))).await
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/status
/// Update a review comment's status (open/resolved)
pub async fn update_review_comment_status(
    Path((id, task_id, comment_id)): Path<(String, String, u32)>,
    Json(req): Json<UpdateCommentStatusRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Parse status — only open/resolved allowed; outdated is auto-detected
    let status = match req.status.as_str() {
        "open" => comments::CommentStatus::Open,
        "resolved" => comments::CommentStatus::Resolved,
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    comments::update_comment_status(&project_key, &task_id, comment_id, status)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Return updated comments
    get_review_comments(Path((id, task_id))).await
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/reset
/// Reset a task: remove worktree and branch, recreate from target
/// Logic from TUI: app.rs do_reset()
/// This should be able to fix Broken tasks by recreating everything from scratch
pub async fn reset_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    // 1. Get task info (TUI: do_reset step 1)
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    // 2. Kill session (TUI: do_reset step 2)
    let global_mux = storage::config::load_config().multiplexer;
    let task_mux = session::resolve_multiplexer(&task.multiplexer, &global_mux);
    let session = session::resolve_session_name(&task.session_name, &project_key, &task_id);
    let _ = session::kill_session(&task_mux, &session);
    if task_mux == Multiplexer::Zellij {
        crate::zellij::layout::remove_session_layout(&session);
    }

    // 3. Remove worktree if exists (TUI: do_reset step 3)
    // For broken tasks, worktree might not exist - that's OK
    if StdPath::new(&task.worktree_path).exists() {
        // Ignore errors - we're resetting anyway
        let _ = git::remove_worktree(&project.path, &task.worktree_path);
    }

    // 4. Delete branch if exists (TUI: do_reset step 4)
    // For broken tasks, branch might not exist - that's OK, we'll recreate it
    if git::branch_exists(&project.path, &task.branch) {
        // Ignore errors - we're recreating anyway
        let _ = git::delete_branch(&project.path, &task.branch);
    }

    // 4.5 Clear all task-related data (Notes, AI data, Stats)
    // This ensures a completely fresh start
    let _ = notes::delete_notes(&project_key, &task_id);
    let _ = comments::delete_review_data(&project_key, &task_id);
    let _ = watcher::clear_edit_history(&project_key, &task_id);

    // 5. Recreate branch and worktree from target (TUI: do_reset step 5)
    // This is the critical step that fixes broken tasks
    let worktree_path = StdPath::new(&task.worktree_path);
    if let Err(e) = git::create_worktree(&project.path, &task.branch, worktree_path, &task.target) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to recreate worktree: {}", e),
        }));
    }

    // 6. Update task timestamp (TUI: do_reset step 6)
    let _ = tasks::touch_task(&project_key, &task_id);

    // Note: TUI creates a new tmux session and auto-attaches (steps 7-9)
    // In web, we don't auto-create session - user can enter terminal to start one

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Task reset successfully".to_string(),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/rebase-to
/// Change task's target branch
/// Logic from TUI: app.rs open_branch_selector(), storage::tasks::update_task_target()
pub async fn rebase_to_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<RebaseToRequest>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    // Verify task exists
    let _task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    // Verify target branch exists
    if !git::branch_exists(&project.path, &req.target) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: format!("Branch '{}' does not exist", req.target),
            }),
        ));
    }

    // Update task target (TUI: storage::tasks::update_task_target)
    tasks::update_task_target(&project_key, &task_id, &req.target).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to update task target: {}", e),
            }),
        )
    })?;

    Ok(Json(GitOperationResponse {
        success: true,
        message: format!("Target branch changed to '{}'", req.target),
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/files
/// List all git-tracked files in a task's worktree
pub async fn list_files(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<FilesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let files = git::list_files(&task.worktree_path).unwrap_or_default();

    Ok(Json(FilesResponse { files }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/file?path=src/main.rs
/// Read a file from a task's worktree
pub async fn get_file(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<FilePathQuery>,
) -> Result<Json<FileContentResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    let content = git::read_file(&task.worktree_path, &params.path).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(Json(FileContentResponse {
        content,
        path: params.path,
    }))
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/file?path=src/main.rs
/// Write a file in a task's worktree
pub async fn update_file(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<FilePathQuery>,
    Json(body): Json<WriteFileRequest>,
) -> Result<Json<FileContentResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    git::write_file(&task.worktree_path, &params.path, &body.content).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(Json(FileContentResponse {
        content: body.content,
        path: params.path,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/review/comments
/// Create a new review comment
pub async fn create_review_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateReviewCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Parse comment type
    let comment_type = match req.comment_type.as_deref() {
        Some("file") => comments::CommentType::File,
        Some("project") => comments::CommentType::Project,
        _ => comments::CommentType::Inline, // default to inline for backward compatibility
    };

    let default_name = get_git_user_name(&project_key, &task_id);
    let author = req
        .author
        .as_deref()
        .or(default_name.as_deref())
        .unwrap_or("You");

    // Process based on comment type
    match comment_type {
        comments::CommentType::Inline => {
            // Parse file_path, side, lines (fallback to location string for backward compat)
            let (file_path, side, start_line, end_line) = if let Some(ref fp) = req.file_path {
                let side = req.side.as_deref().unwrap_or("ADD");
                let start = req.start_line.unwrap_or(1);
                let end = req.end_line.unwrap_or(start);
                (fp.clone(), side.to_string(), start, end)
            } else if let Some(ref loc) = req.location {
                let (fp, (start, end)) = comments::parse_location(loc);
                (fp, "ADD".to_string(), start, end)
            } else {
                return Err(StatusCode::BAD_REQUEST);
            };

            // 计算 anchor_text: 读取对应 side 的文件并提取锚定行
            let anchor_text = tasks::get_task(&project_key, &task_id)
                .ok()
                .flatten()
                .and_then(|task| {
                    let content = if side == "DELETE" {
                        git::show_file(&task.worktree_path, &task.target, &file_path).ok()
                    } else {
                        git::read_file(&task.worktree_path, &file_path).ok()
                    };
                    content.and_then(|c| comments::extract_lines(&c, start_line, end_line))
                });

            comments::add_comment(
                &project_key,
                &task_id,
                comment_type,
                Some(file_path),
                Some(side),
                Some(start_line),
                Some(end_line),
                &req.content,
                author,
                anchor_text,
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        comments::CommentType::File => {
            // File comment requires file_path
            let file_path = req.file_path.ok_or(StatusCode::BAD_REQUEST)?;

            comments::add_comment(
                &project_key,
                &task_id,
                comment_type,
                Some(file_path),
                None, // no side
                None, // no start_line
                None, // no end_line
                &req.content,
                author,
                None, // no anchor_text
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        comments::CommentType::Project => {
            // Project comment requires no file_path
            comments::add_comment(
                &project_key,
                &task_id,
                comment_type,
                None, // no file_path
                None, // no side
                None, // no start_line
                None, // no end_line
                &req.content,
                author,
                None, // no anchor_text
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
    }

    // Return updated comments
    get_review_comments(Path((id, task_id))).await
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}
/// Delete a review comment
pub async fn delete_review_comment(
    Path((id, task_id, comment_id)): Path<(String, String, u32)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Delete comment
    let deleted = comments::delete_comment(&project_key, &task_id, comment_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !deleted {
        return Err(StatusCode::NOT_FOUND);
    }

    // Return updated comments
    get_review_comments(Path((id, task_id))).await
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/content
/// Edit a review comment's content
pub async fn edit_review_comment(
    Path((id, task_id, comment_id)): Path<(String, String, u32)>,
    Json(req): Json<EditCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let edited = comments::edit_comment(&project_key, &task_id, comment_id, &req.content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !edited {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/replies/{replyId}
/// Edit a review reply's content
pub async fn edit_review_reply(
    Path((id, task_id, comment_id, reply_id)): Path<(String, String, u32, u32)>,
    Json(req): Json<EditReplyRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let edited = comments::edit_reply(&project_key, &task_id, comment_id, reply_id, &req.content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !edited {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/replies/{replyId}
/// Delete a review reply
pub async fn delete_review_reply(
    Path((id, task_id, comment_id, reply_id)): Path<(String, String, u32, u32)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let deleted = comments::delete_reply(&project_key, &task_id, comment_id, reply_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !deleted {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

// ============================================================================
// File System Operations API
// ============================================================================

/// Create file request
#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
}

/// Create directory request
#[derive(Debug, Deserialize)]
pub struct CreateDirectoryRequest {
    pub path: String,
}

/// Delete file/directory request (via query param)
#[derive(Debug, Deserialize)]
pub struct DeletePathQuery {
    pub path: String,
}

/// Copy file request
#[derive(Debug, Deserialize)]
pub struct CopyFileRequest {
    pub source: String,
    pub destination: String,
}

/// File system operation response
#[derive(Debug, Serialize)]
pub struct FsOperationResponse {
    pub success: bool,
    pub message: String,
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/fs/create-file
/// Create a new file in the task's worktree
pub async fn create_file(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateFileRequest>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    // Construct full path in worktree
    let full_path = StdPath::new(&task.worktree_path).join(&req.path);

    // Check if file already exists
    if full_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiErrorResponse {
                error: format!("File already exists: {}", req.path),
            }),
        ));
    }

    // Create parent directories if needed
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to create parent directories: {}", e),
                }),
            )
        })?;
    }

    // Write content to file
    let content = req.content.unwrap_or_default();
    std::fs::write(&full_path, content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to create file: {}", e),
            }),
        )
    })?;

    Ok(Json(FsOperationResponse {
        success: true,
        message: format!("File created: {}", req.path),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/fs/create-dir
/// Create a new directory in the task's worktree
pub async fn create_directory(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateDirectoryRequest>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    // Construct full path in worktree
    let full_path = StdPath::new(&task.worktree_path).join(&req.path);

    // Check if directory already exists
    if full_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiErrorResponse {
                error: format!("Directory already exists: {}", req.path),
            }),
        ));
    }

    // Create directory
    std::fs::create_dir_all(&full_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to create directory: {}", e),
            }),
        )
    })?;

    Ok(Json(FsOperationResponse {
        success: true,
        message: format!("Directory created: {}", req.path),
    }))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/fs/delete?path=...
/// Delete a file or directory in the task's worktree
pub async fn delete_path(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<DeletePathQuery>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    // Construct full path in worktree
    let full_path = StdPath::new(&task.worktree_path).join(&params.path);

    // Check if path exists
    if !full_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                error: format!("Path not found: {}", params.path),
            }),
        ));
    }

    // Delete file or directory
    if full_path.is_dir() {
        std::fs::remove_dir_all(&full_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to delete directory: {}", e),
                }),
            )
        })?;
    } else {
        std::fs::remove_file(&full_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to delete file: {}", e),
                }),
            )
        })?;
    }

    Ok(Json(FsOperationResponse {
        success: true,
        message: format!("Deleted: {}", params.path),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/fs/copy
/// Copy a file in the task's worktree
pub async fn copy_file(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CopyFileRequest>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    // Construct full paths
    let source_path = StdPath::new(&task.worktree_path).join(&req.source);
    let dest_path = StdPath::new(&task.worktree_path).join(&req.destination);

    // Check if source exists and is a file
    if !source_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                error: format!("Source file not found: {}", req.source),
            }),
        ));
    }

    if !source_path.is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: "Source must be a file, not a directory".to_string(),
            }),
        ));
    }

    // Check if destination already exists
    if dest_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiErrorResponse {
                error: format!("Destination already exists: {}", req.destination),
            }),
        ));
    }

    // Create parent directories for destination if needed
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to create parent directories: {}", e),
                }),
            )
        })?;
    }

    // Copy file
    std::fs::copy(&source_path, &dest_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to copy file: {}", e),
            }),
        )
    })?;

    Ok(Json(FsOperationResponse {
        success: true,
        message: format!("Copied {} to {}", req.source, req.destination),
    }))
}
