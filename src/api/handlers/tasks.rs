//! Task API handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::git;
use crate::hooks;
use crate::model::loader;
use crate::session::{self, SessionType};
use crate::storage::{self, comments, notes, tasks, workspace};

use super::projects::{storage_task_to_response, CommitResponse, TaskResponse};
use super::studio_common::{
    self, AddWorkDirectoryRequest, WorkDirectoryEntry, WorkDirectoryListResponse,
    WorkDirectoryQuery,
};

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

impl ArchiveConfirmResponse {
    /// Create an error response with default/safe values for status fields
    fn error(code: &str, error: &str, task_name: String) -> Self {
        Self {
            error: error.to_string(),
            code: code.to_string(),
            task_name,
            branch: String::new(),
            target: String::new(),
            worktree_dirty: false,
            // Default to merged to avoid false "not merged" warnings
            branch_merged: true,
            // Mark checks as failed to indicate we couldn't verify
            dirty_check_failed: true,
            merge_check_failed: true,
        }
    }

    /// Create a confirmation required response with actual check results
    fn confirm_required(
        task_name: String,
        branch: String,
        target: String,
        worktree_dirty: bool,
        branch_merged: bool,
        dirty_check_failed: bool,
        merge_check_failed: bool,
    ) -> Self {
        Self {
            error: "Archive requires confirmation".to_string(),
            code: "ARCHIVE_CONFIRM_REQUIRED".to_string(),
            task_name,
            branch,
            target,
            worktree_dirty,
            branch_merged,
            dirty_check_failed,
            merge_check_failed,
        }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
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
    pub comment_type: Option<String>, // "inline" | "file" | "project" (defaults to "inline")
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

/// Bulk delete review comments request
#[derive(Debug, Deserialize)]
pub struct BulkDeleteRequest {
    /// Status filter (OR): ["resolved", "outdated", "open"]
    pub statuses: Option<Vec<String>>,
    /// Author filter (OR): ["Claude", "You"]
    pub authors: Option<Vec<String>>,
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
fn worktree_to_response(wt: &crate::model::Worktree, _project_key: &str) -> TaskResponse {
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

    TaskResponse {
        id: wt.id.clone(),
        name: wt.task_name.clone(),
        branch: wt.branch.clone(),
        target: wt.target.clone(),
        status: status_to_string(&wt.status).to_string(),
        additions: 0,
        deletions: 0,
        files_changed: 0,
        commits,
        created_at: wt.created_at.to_rfc3339(),
        updated_at: wt.updated_at.to_rfc3339(),
        path: wt.path.clone(),
        multiplexer: wt.multiplexer.clone(),
        created_by: wt.created_by.clone(),
        is_local: wt.is_local,
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
/// List tasks for a project (worktree tasks only; Local Task is on `ProjectResponse.local_task`)
pub async fn list_tasks(
    Path(id): Path<String>,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<TaskListResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;
    let filter = query.filter.as_deref().unwrap_or("active");

    if project.project_type == workspace::ProjectType::Studio {
        let filter_owned = filter.to_string();
        let pk = project_key.clone();
        let mut tasks: Vec<TaskResponse> = tokio::task::spawn_blocking(move || {
            let stored = if filter_owned == "archived" {
                tasks::load_archived_tasks(&pk).unwrap_or_default()
            } else {
                tasks::load_tasks(&pk).unwrap_or_default()
            };
            stored.iter().map(storage_task_to_response).collect()
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        return Ok(Json(TaskListResponse { tasks }));
    }

    // Heavy git I/O — run on blocking thread pool
    let project_path = project.path.clone();
    let pk = project_key.clone();
    let filter_owned = filter.to_string();
    let mut tasks: Vec<TaskResponse> = tokio::task::spawn_blocking(move || {
        if filter_owned == "archived" {
            let archived = loader::load_archived_worktrees(&project_path);
            archived
                .iter()
                .map(|wt| worktree_to_response(wt, &pk))
                .collect()
        } else {
            // load_worktrees excludes Local Task by design
            let active = loader::load_worktrees(&project_path);
            active
                .iter()
                .map(|wt| worktree_to_response(wt, &pk))
                .collect()
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Sort by updated_at descending (newest first)
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(Json(TaskListResponse { tasks }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}
/// Get a single task. If `taskId` is the Local Task constant, falls back to
/// `loader::load_local_task` since `load_worktrees` no longer includes it.
pub async fn get_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    if project.project_type == workspace::ProjectType::Studio {
        let pk = project_key.clone();
        let tid = task_id.clone();
        let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
            tasks::get_task(&pk, &tid)
                .ok()
                .flatten()
                .or_else(|| tasks::get_archived_task(&pk, &tid).ok().flatten())
                .map(|task| storage_task_to_response(&task))
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return result.map(Json).ok_or(StatusCode::NOT_FOUND);
    }

    // Heavy git I/O — run on blocking thread pool
    let project_path = project.path.clone();
    let pk = project_key.clone();
    let tid = task_id.clone();
    let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
        // Local Task is fetched via the dedicated loader function
        if tid == crate::storage::tasks::LOCAL_TASK_ID {
            return loader::load_local_task(&project_path).map(|wt| worktree_to_response(&wt, &pk));
        }
        let active = loader::load_worktrees(&project_path);
        if let Some(wt) = active.iter().find(|wt| wt.id == tid) {
            return Some(worktree_to_response(wt, &pk));
        }
        let archived = loader::load_archived_worktrees(&project_path);
        archived
            .iter()
            .find(|wt| wt.id == tid)
            .map(|wt| worktree_to_response(wt, &pk))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    result.map(Json).ok_or(StatusCode::NOT_FOUND)
}

/// POST /api/v1/projects/{id}/tasks
/// Create a new task
pub async fn create_task(
    Path(id): Path<String>,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let full_config = storage::config::load_config();
    let is_studio = project.project_type == workspace::ProjectType::Studio;

    // Call shared operation — branch by project type
    let result = if is_studio {
        crate::operations::tasks::create_studio_task(
            &project.path,
            &project_key,
            req.name.clone(),
            &full_config.default_session_type(),
            "user",
        )
    } else {
        // Determine target branch (Repo only)
        let target = req.target.unwrap_or_else(|| {
            git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string())
        });
        let autolink_patterns = &full_config.auto_link.patterns;

        crate::operations::tasks::create_task(
            &project.path,
            &project_key,
            req.name.clone(),
            target,
            &full_config.default_session_type(),
            autolink_patterns,
            "user",
        )
    }
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("already exists") {
            (StatusCode::CONFLICT, Json(ApiErrorResponse { error: msg }))
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse { error: msg }),
            )
        }
    })?;

    // Save notes if provided
    if let Some(ref notes_content) = req.notes {
        if !notes_content.is_empty() {
            let _ = notes::save_notes(&project_key, &result.task.id, notes_content);
        }
    }

    // Auto-assign new task to system groups and notify clients
    let _ = crate::storage::taskgroups::ensure_system_groups();
    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    // Return task response
    Ok(Json(TaskResponse {
        id: result.task.id.clone(),
        name: result.task.name.clone(),
        branch: result.task.branch.clone(),
        target: result.task.target.clone(),
        status: "idle".to_string(), // New task is idle (no session from web)
        additions: 0,
        deletions: 0,
        files_changed: 0,
        commits: Vec::new(),
        created_at: result.task.created_at.to_rfc3339(),
        updated_at: result.task.updated_at.to_rfc3339(),
        path: result.worktree_path.clone(),
        multiplexer: result.task.multiplexer.clone(),
        created_by: result.task.created_by.clone(),
        is_local: false,
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
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ArchiveConfirmResponse::error(
                "PROJECT_NOT_FOUND",
                "Project not found",
                task_id.clone(),
            )),
        )
    })?;

    let force = query.force.unwrap_or(false);

    if project.project_type == workspace::ProjectType::Studio {
        let task = tasks::get_task(&project_key, &task_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_LOAD_FAILED",
                        "Failed to load task",
                        task_id.clone(),
                    )),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                )
            })?;

        if !force {
            let input_dir = std::path::Path::new(&task.worktree_path).join("input");
            let output_dir = std::path::Path::new(&task.worktree_path).join("output");
            let scripts_dir = std::path::Path::new(&task.worktree_path).join("scripts");
            let has_files = [input_dir, output_dir, scripts_dir].iter().any(|dir| {
                fs::read_dir(dir)
                    .map(|mut it| it.next().is_some())
                    .unwrap_or(false)
            });

            if has_files {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ArchiveConfirmResponse::confirm_required(
                        task.name,
                        String::new(),
                        String::new(),
                        true,
                        true,
                        false,
                        false,
                    )),
                ));
            }
        }

        tasks::archive_task(&project_key, &task_id).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ArchiveConfirmResponse::error(
                    "ARCHIVE_FAILED",
                    "Archive failed",
                    task_id.clone(),
                )),
            )
        })?;

        if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::GroupChanged);
        }

        let archived = tasks::get_archived_task(&project_key, &task_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ArchiveConfirmResponse::error(
                        "ARCHIVED_TASK_LOAD_FAILED",
                        "Failed to load archived task",
                        task_id.clone(),
                    )),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "ARCHIVED_TASK_NOT_FOUND",
                        "Archived task not found",
                        task_id.clone(),
                    )),
                )
            })?;

        return Ok(Json(storage_task_to_response(&archived)));
    }

    // Safety checks (GUI needs a confirmation step like TUI)
    if !force {
        let task = match tasks::get_task(&project_key, &task_id).ok().flatten() {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
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
            Ok(v) => {
                // Fallback: if is-ancestor says not merged, check diff for squash merge
                branch_merged = v
                    || git::is_diff_empty(&project.path, &task.branch, &task.target)
                        .unwrap_or(false);
            }
            Err(_) => {
                merge_check_failed = true;
            }
        }

        let needs_confirm =
            worktree_dirty || !branch_merged || dirty_check_failed || merge_check_failed;
        if needs_confirm {
            return Err((
                StatusCode::CONFLICT,
                Json(ArchiveConfirmResponse::confirm_required(
                    task.name,
                    task.branch,
                    task.target,
                    worktree_dirty,
                    branch_merged,
                    dirty_check_failed,
                    merge_check_failed,
                )),
            ));
        }
    }

    // Get task info (need multiplexer + session_name before archive moves it)
    let task_info = tasks::get_task(&project_key, &task_id).ok().flatten();
    let task_mux_str = task_info
        .as_ref()
        .map(|t| t.multiplexer.clone())
        .unwrap_or_default();
    let task_sname = task_info
        .as_ref()
        .map(|t| t.session_name.clone())
        .unwrap_or_default();

    // Call shared operation
    let _ = crate::operations::tasks::archive_task(
        &project.path,
        &project_key,
        &task_id,
        &task_mux_str,
        &task_sname,
    )
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ArchiveConfirmResponse::error(
                "ARCHIVE_FAILED",
                "Archive failed",
                task_id.clone(),
            )),
        )
    })?;

    // Clean up task slot from all groups
    if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    // Load the archived task to return
    let archived = loader::load_archived_worktrees(&project.path);
    let task = archived.iter().find(|wt| wt.id == task_id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ArchiveConfirmResponse::error(
                "ARCHIVED_TASK_NOT_FOUND",
                "Archived task not found",
                task_id.clone(),
            )),
        )
    })?;

    Ok(Json(worktree_to_response(task, &project_key)))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/recover
/// Recover an archived task
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

    // Call shared operation
    let _result = crate::operations::tasks::recover_task(&project.path, &project_key, &task_id)
        .map_err(|e| {
            let status = if e.to_string().contains("not found") {
                StatusCode::NOT_FOUND
            } else if e.to_string().contains("no longer exists") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (
                status,
                Json(ApiErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;

    // Load the recovered task to return
    let project_path = project.path.clone();
    let pk = project_key.clone();
    let tid = task_id.clone();
    let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
        let active = loader::load_worktrees(&project_path);
        active
            .iter()
            .find(|wt| wt.id == tid)
            .map(|wt| worktree_to_response(wt, &pk))
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    // Re-assign recovered task to appropriate system group
    let _ = crate::storage::taskgroups::ensure_system_groups();
    {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    result.map(Json).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                error: "Failed to find recovered task".to_string(),
            }),
        )
    })
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}
/// Delete a task (removes worktree and task record)
pub async fn delete_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    // Local Task 不允许删除
    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Err(StatusCode::BAD_REQUEST);
    }

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

    if project.project_type == workspace::ProjectType::Studio {
        let task_path = std::path::Path::new(&task.worktree_path);
        // Safety: only delete paths that are provably inside our studio tasks
        // directory.  Guards against corrupted task records pointing elsewhere.
        let expected_prefix = workspace::studio_project_dir(&project.path).join("tasks");
        if task_path.exists() && task_path.starts_with(&expected_prefix) {
            fs::remove_dir_all(task_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }

        let _ = tasks::remove_task(&project_key, &task_id);
        let _ = tasks::remove_archived_task(&project_key, &task_id);
        hooks::remove_task_hook(&project_key, &task_id);
        let _ = storage::delete_task_data(&project_key, &task_id);

        if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::GroupChanged);
        }

        return Ok(StatusCode::NO_CONTENT);
    }

    // Kill session
    let task_session_type = session::resolve_session_type(&task.multiplexer);
    let session_name = session::resolve_session_name(&task.session_name, &project_key, &task_id);
    let _ = session::kill_session(&task_session_type, &session_name);
    if matches!(task_session_type, SessionType::Zellij) {
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
    let _ = storage::delete_task_data(&project_key, &task_id);

    // Clean up task slot from all groups
    if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

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
/// Sync task: rebase worktree branch onto target branch
pub async fn sync_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Call shared operation
    match crate::operations::tasks::sync_task(&project.path, &project_key, &task_id) {
        Ok(target) => Ok(Json(GitOperationResponse {
            success: true,
            message: format!("Synced with {}", target),
            warning: None,
        })),
        Err(e) => {
            let error_msg = e.to_string();
            let message = if error_msg.contains("conflict") || error_msg.contains("CONFLICT") {
                "Conflict detected - please resolve in terminal".to_string()
            } else {
                format!("Sync failed: {}", error_msg)
            };
            Ok(Json(GitOperationResponse {
                success: false,
                message,
                warning: None,
            }))
        }
    }
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
            warning: None,
        }));
    }

    // Update task timestamp
    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Committed successfully".to_string(),
        warning: None,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/merge
/// Merge task branch into target
pub async fn merge_task(
    Path((id, task_id)): Path<(String, String)>,
    body: Option<Json<MergeRequest>>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    // Determine merge method
    let method_str = body.as_ref().and_then(|b| b.method.as_deref());
    let method = match method_str {
        Some("squash") => crate::operations::tasks::MergeMethod::Squash,
        Some("merge-commit") => crate::operations::tasks::MergeMethod::MergeCommit,
        _ => {
            // Auto-select: if only 1 commit, use merge-commit; otherwise squash
            let task = tasks::get_task(&project_key, &task_id)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .ok_or(StatusCode::NOT_FOUND)?;
            let count =
                git::commits_behind(&task.worktree_path, &task.branch, &task.target).unwrap_or(0);
            if count > 1 {
                crate::operations::tasks::MergeMethod::Squash
            } else {
                crate::operations::tasks::MergeMethod::MergeCommit
            }
        }
    };

    // Call shared operation
    match crate::operations::tasks::merge_task(&project.path, &project_key, &task_id, method) {
        Ok(result) => Ok(Json(GitOperationResponse {
            success: true,
            message: format!("Merged into {}", result.target_branch),
            warning: result.warning,
        })),
        Err(e) => Ok(Json(GitOperationResponse {
            success: false,
            message: e.to_string(),
            warning: None,
        })),
    }
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
        // Return summary format
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

    // Get task info before reset
    let task_info = tasks::get_task(&project_key, &task_id)
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

    // Call shared operation
    match crate::operations::tasks::reset_task(
        &project.path,
        &project_key,
        &task_id,
        &task_info.multiplexer,
        &task_info.session_name,
    ) {
        Ok(_) => Ok(Json(GitOperationResponse {
            success: true,
            message: "Task reset successfully".to_string(),
            warning: None,
        })),
        Err(e) => Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to reset task: {}", e),
            warning: None,
        })),
    }
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/rebase-to
/// Change task's target branch
/// Logic from TUI: app.rs open_branch_selector(), storage::tasks::update_task_target()
pub async fn rebase_to_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<RebaseToRequest>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    // Local Task 不支持 rebase
    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: "Cannot rebase local task".to_string(),
            }),
        ));
    }

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
        warning: None,
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

    // Try git first; fall back to filesystem walk for non-git directories
    let files = match git::list_files(&task.worktree_path) {
        Ok(f) if !f.is_empty() => f,
        _ => list_files_fs(&task.worktree_path),
    };

    Ok(Json(FilesResponse { files }))
}

/// Walk a directory tree and return relative paths (non-git fallback)
fn list_files_fs(root: &str) -> Vec<String> {
    let root_path = std::path::Path::new(root);
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root_path)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Ok(rel) = entry.path().strip_prefix(root_path) {
                files.push(rel.to_string_lossy().to_string());
            }
        }
    }
    files.sort();
    files
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
        _ => comments::CommentType::Inline, // default to inline
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
            let (file_path, side, start_line, end_line) = if let Some(ref fp) = req.file_path {
                let side = req.side.as_deref().unwrap_or("ADD");
                let start = req.start_line.unwrap_or(1);
                let end = req.end_line.unwrap_or(start);
                (fp.clone(), side.to_string(), start, end)
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

/// POST /api/v1/projects/{id}/tasks/{taskId}/review/bulk-delete
/// Bulk delete review comments by status and/or author filters
pub async fn bulk_delete_review_comments(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<BulkDeleteRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Parse status strings to CommentStatus enums (case-insensitive)
    let raw_statuses = req.statuses.unwrap_or_default();
    let statuses: Vec<comments::CommentStatus> = raw_statuses
        .iter()
        .filter_map(|s| match s.to_lowercase().as_str() {
            "open" => Some(comments::CommentStatus::Open),
            "resolved" => Some(comments::CommentStatus::Resolved),
            "outdated" => Some(comments::CommentStatus::Outdated),
            _ => None,
        })
        .collect();

    // If caller provided statuses but none were valid, reject to prevent accidental full-delete
    if !raw_statuses.is_empty() && statuses.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let authors = req.authors.unwrap_or_default();

    comments::bulk_delete_comments(&project_key, &task_id, &statuses, &authors)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

/// Resolve a relative path within a worktree, preventing path traversal attacks.
/// Returns the full canonicalized path, or an error if the path escapes the worktree.
fn resolve_safe_path(
    worktree_path: &str,
    relative_path: &str,
) -> Result<PathBuf, (StatusCode, Json<ApiErrorResponse>)> {
    // Quick reject: paths containing ".."
    if relative_path.contains("..") {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiErrorResponse {
                error: "Path traversal not allowed".to_string(),
            }),
        ));
    }

    let base = std::fs::canonicalize(worktree_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to resolve worktree path: {}", e),
            }),
        )
    })?;

    let target = base.join(relative_path);

    // If target exists, canonicalize and check prefix
    if target.exists() {
        let canonical = std::fs::canonicalize(&target).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to resolve path: {}", e),
                }),
            )
        })?;
        if !canonical.starts_with(&base) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiErrorResponse {
                    error: "Path traversal not allowed".to_string(),
                }),
            ));
        }
        return Ok(canonical);
    }

    // Target doesn't exist yet (create operations):
    // Canonicalize the nearest existing ancestor and verify it's inside base.
    let mut ancestor = target.clone();
    while !ancestor.exists() {
        if !ancestor.pop() {
            break;
        }
    }
    if ancestor.exists() {
        let canonical_ancestor = std::fs::canonicalize(&ancestor).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to resolve path: {}", e),
                }),
            )
        })?;
        if !canonical_ancestor.starts_with(&base) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiErrorResponse {
                    error: "Path traversal not allowed".to_string(),
                }),
            ));
        }
    }

    Ok(target)
}

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

    // Resolve and validate path (prevents path traversal)
    let full_path = resolve_safe_path(&task.worktree_path, &req.path)?;

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

    // Resolve and validate path (prevents path traversal)
    let full_path = resolve_safe_path(&task.worktree_path, &req.path)?;

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

    // Resolve and validate path (prevents path traversal)
    let full_path = resolve_safe_path(&task.worktree_path, &params.path)?;

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

    // Resolve and validate paths (prevents path traversal)
    let source_path = resolve_safe_path(&task.worktree_path, &req.source)?;
    let dest_path = resolve_safe_path(&task.worktree_path, &req.destination)?;

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

// ============================================================================
// Studio Artifacts API
// ============================================================================

#[derive(Debug, Serialize)]
pub struct ArtifactFile {
    pub name: String,
    pub path: String,
    pub directory: String,
    pub size: u64,
    pub modified_at: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct ArtifactsResponse {
    pub input: Vec<ArtifactFile>,
    pub output: Vec<ArtifactFile>,
}

/// Recursively list files in a directory
fn list_dir_recursive(
    base: &std::path::Path,
    dir: &std::path::Path,
    category: &str,
) -> Vec<ArtifactFile> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return files,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let link_meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if link_meta.file_type().is_symlink() {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let rel_path = path.strip_prefix(base).unwrap_or(&path);
        let rel_str = rel_path.to_string_lossy().to_string();
        let name = entry.file_name().to_string_lossy().to_string();

        if meta.is_dir() {
            // Add directory entry
            files.push(ArtifactFile {
                name: name.clone(),
                path: rel_str.clone(),
                directory: category.to_string(),
                size: 0,
                modified_at: studio_common::format_modified_time(&meta),
                is_dir: true,
            });
            // Recurse into subdirectory
            files.extend(list_dir_recursive(base, &path, category));
        } else {
            files.push(ArtifactFile {
                name,
                path: rel_str,
                directory: category.to_string(),
                size: meta.len(),
                modified_at: studio_common::format_modified_time(&meta),
                is_dir: false,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

fn resolve_task_dir(
    project: &workspace::RegisteredProject,
    project_id: &str,
    task_id: &str,
) -> Option<PathBuf> {
    if project.project_type == workspace::ProjectType::Studio {
        // Guard against path traversal via crafted task_id values.
        if !studio_common::is_studio_id_segment(task_id) {
            return None;
        }
        Some(
            workspace::studio_project_dir(&project.path)
                .join("tasks")
                .join(task_id),
        )
    } else {
        let tasks_list = tasks::load_tasks(project_id).unwrap_or_default();
        tasks_list
            .iter()
            .find(|t| t.id == task_id)
            .map(|t| PathBuf::from(&t.worktree_path))
    }
}

fn artifact_workdir_dir(task_dir: &std::path::Path) -> PathBuf {
    task_dir.join("input")
}

fn ensure_workdir_symlink(dir: &std::path::Path, name: &str) -> Result<PathBuf, ApiErrorResponse> {
    studio_common::validate_symlink_entry(dir, name).map_err(|err| ApiErrorResponse { error: err })
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts
/// List all files in input/ and output/ directories of a Studio task
pub async fn list_artifacts(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<ArtifactsResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    let task_dir =
        resolve_task_dir(&project, &project_key, &task_id).ok_or(StatusCode::NOT_FOUND)?;

    if !task_dir.exists() {
        return Err(StatusCode::NOT_FOUND);
    }

    let input_dir = task_dir.join("input");
    let output_dir = task_dir.join("output");

    let input_files = list_dir_recursive(&input_dir, &input_dir, "input");
    let output_files = list_dir_recursive(&output_dir, &output_dir, "output");

    Ok(Json(ArtifactsResponse {
        input: input_files,
        output: output_files,
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/workdir
pub async fn list_artifact_workdirs(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<WorkDirectoryListResponse>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;
    let entries = studio_common::list_workdir_entries(&artifact_workdir_dir(&task_dir));
    Ok(Json(WorkDirectoryListResponse { entries }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/artifacts/workdir
pub async fn add_artifact_workdir(
    Path((id, task_id)): Path<(String, String)>,
    Json(request): Json<AddWorkDirectoryRequest>,
) -> Result<Json<WorkDirectoryEntry>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;
    let workdir_dir = artifact_workdir_dir(&task_dir);
    fs::create_dir_all(&workdir_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to create input directory: {e}"),
            }),
        )
    })?;

    let target = PathBuf::from(request.path.trim());
    if !target.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: "Path must be absolute".to_string(),
            }),
        ));
    }
    if !target.exists() || !target.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                error: "Selected path must be an existing directory".to_string(),
            }),
        ));
    }

    let link_name = studio_common::create_unique_symlink_name(&workdir_dir, &target);
    let link_path = workdir_dir.join(&link_name);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to create symlink: {e}"),
            }),
        )
    })?;

    #[cfg(not(unix))]
    {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(ApiErrorResponse {
                error: "Work Directory is currently only supported on Unix-like systems"
                    .to_string(),
            }),
        ));
    }

    Ok(Json(WorkDirectoryEntry {
        name: link_name,
        target_path: target.to_string_lossy().to_string(),
        exists: true,
    }))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/artifacts/workdir
pub async fn delete_artifact_workdir(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;
    let link_path = ensure_workdir_symlink(&artifact_workdir_dir(&task_dir), &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;
    fs::remove_file(link_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to remove symlink: {e}"),
            }),
        )
    })?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/artifacts/workdir/open
pub async fn open_artifact_workdir(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;
    let link_path = ensure_workdir_symlink(&artifact_workdir_dir(&task_dir), &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;

    // Open the symlink path directly — the OS will follow the link.
    // This avoids a TOCTOU race that would occur if we read_link() and then
    // passed the raw target string to `open`.
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&link_path).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(&link_path).spawn();

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ArtifactQuery {
    pub path: String,
    pub dir: String,
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/preview
/// Preview file content (text files with proper encoding)
pub async fn preview_artifact(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task_dir = resolve_task_dir(&project, &project_key, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;

    let file_path = task_dir.join(&query.dir).join(&query.path);

    // Security: ensure file_path is within task_dir
    let canonical_task = task_dir.canonicalize().unwrap_or(task_dir.clone());
    let canonical_file = file_path.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                error: "File not found".to_string(),
            }),
        )
    })?;
    if !canonical_file.starts_with(&canonical_task) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiErrorResponse {
                error: "Access denied".to_string(),
            }),
        ));
    }

    // Enforce preview size limit to avoid loading huge files into memory.
    const MAX_PREVIEW_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
    let file_size = std::fs::metadata(&canonical_file)
        .map(|m| m.len())
        .unwrap_or(0);
    if file_size > MAX_PREVIEW_SIZE {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ApiErrorResponse {
                error: format!("File too large to preview ({file_size} bytes, max 10 MB)"),
            }),
        ));
    }

    let content = std::fs::read(&canonical_file).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                error: "Failed to read file".to_string(),
            }),
        )
    })?;

    // Try UTF-8 first, then attempt other encodings for CJK text
    let text = studio_common::decode_text_bytes(&content);

    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        text,
    ))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/download
/// Download a file
pub async fn download_artifact(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    let task_dir =
        resolve_task_dir(&project, &project_key, &task_id).ok_or(StatusCode::NOT_FOUND)?;

    let file_path = task_dir.join(&query.dir).join(&query.path);

    // Security check
    let canonical_task = task_dir.canonicalize().unwrap_or(task_dir.clone());
    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !canonical_file.starts_with(&canonical_task) {
        return Err(StatusCode::FORBIDDEN);
    }

    let content = std::fs::read(&canonical_file).map_err(|_| StatusCode::NOT_FOUND)?;
    let filename = studio_common::sanitize_filename_for_header(
        &canonical_file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string()),
    );

    let content_type =
        studio_common::guess_content_type(file_path.extension().and_then(|e| e.to_str()));

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, content_type.to_string()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", filename),
            ),
        ],
        content,
    ))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/artifacts
/// Delete a file from input/ directory only
pub async fn delete_artifact(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    // Only allow deletion from input/
    if query.dir != "input" {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiErrorResponse {
                error: "Can only delete files from input/ directory".to_string(),
            }),
        ));
    }

    let task_dir = resolve_task_dir(&project, &project_key, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;

    let input_dir = task_dir.join("input");
    let file_path = input_dir.join(&query.path);

    // Security check: ensure the resolved path stays inside input/
    let canonical_input = input_dir.canonicalize().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: "input/ directory not accessible".to_string(),
            }),
        )
    })?;
    let canonical_file = file_path.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                error: "File not found".to_string(),
            }),
        )
    })?;
    if !canonical_file.starts_with(&canonical_input) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiErrorResponse {
                error: "Access denied: path escapes input/ directory".to_string(),
            }),
        ));
    }

    if canonical_file.is_dir() {
        std::fs::remove_dir_all(&canonical_file).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to delete: {}", e),
                }),
            )
        })?;
    } else {
        std::fs::remove_file(&canonical_file).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to delete: {}", e),
                }),
            )
        })?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/artifacts/upload
/// Upload file(s) to input/ directory (multipart)
pub async fn upload_artifact(
    Path((id, task_id)): Path<(String, String)>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<Vec<ArtifactFile>>, (StatusCode, Json<ApiErrorResponse>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiErrorResponse {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task_dir = resolve_task_dir(&project, &project_key, &task_id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            error: "Task not found".to_string(),
        }),
    ))?;

    let input_dir = task_dir.join("input");
    std::fs::create_dir_all(&input_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorResponse {
                error: format!("Failed to create input directory: {}", e),
            }),
        )
    })?;

    let mut uploaded = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field.file_name().unwrap_or("upload").to_string();

        // Security: strip path separators from filename
        let safe_name = filename.replace(['/', '\\'], "_");
        if safe_name.is_empty() || safe_name.starts_with('.') {
            continue;
        }

        let data = field.bytes().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ApiErrorResponse {
                    error: format!("Failed to read upload: {}", e),
                }),
            )
        })?;

        // Guard against memory exhaustion from arbitrarily large uploads.
        if data.len() > studio_common::MAX_UPLOAD_SIZE {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiErrorResponse {
                    error: format!(
                        "File '{}' too large ({} bytes, max 100 MB)",
                        safe_name,
                        data.len()
                    ),
                }),
            ));
        }

        let file_path = input_dir.join(&safe_name);
        std::fs::write(&file_path, &data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorResponse {
                    error: format!("Failed to write file: {}", e),
                }),
            )
        })?;

        let meta = std::fs::metadata(&file_path).ok();
        uploaded.push(ArtifactFile {
            name: safe_name.clone(),
            path: safe_name,
            directory: "input".to_string(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(data.len() as u64),
            modified_at: chrono::Utc::now().to_rfc3339(),
            is_dir: false,
        });
    }

    Ok(Json(uploaded))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/open-folder
/// Open a task subdirectory in the system file manager
pub async fn open_folder(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<StatusCode, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    let task_dir =
        resolve_task_dir(&project, &project_key, &task_id).ok_or(StatusCode::NOT_FOUND)?;

    let folder = task_dir.join(&query.dir);
    if !folder.exists() {
        return Err(StatusCode::NOT_FOUND);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&folder).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&folder).spawn();
    }

    Ok(StatusCode::NO_CONTENT)
}
