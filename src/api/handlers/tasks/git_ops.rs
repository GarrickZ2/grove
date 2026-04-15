//! Task git operation handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use crate::api::error::ApiError;
use crate::git;
use crate::storage::tasks;

use super::super::common::find_project_by_id;
use super::types::*;

/// POST /api/v1/projects/{id}/tasks/{taskId}/sync
pub async fn sync_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

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
pub async fn commit_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CommitRequest>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    if let Err(e) = git::add_and_commit(&task.worktree_path, &req.message) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: e.to_string(),
            warning: None,
        }));
    }

    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Committed successfully".to_string(),
        warning: None,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/merge
pub async fn merge_task(
    Path((id, task_id)): Path<(String, String)>,
    body: Option<Json<MergeRequest>>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    let method_str = body.as_ref().and_then(|b| b.method.as_deref());
    let method = match method_str {
        Some("squash") => crate::operations::tasks::MergeMethod::Squash,
        Some("merge-commit") => crate::operations::tasks::MergeMethod::MergeCommit,
        _ => {
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

/// POST /api/v1/projects/{id}/tasks/{taskId}/reset
pub async fn reset_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiError>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task_info = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

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
pub async fn rebase_to_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<RebaseToRequest>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiError>)> {
    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "Cannot rebase local task".to_string(),
            }),
        ));
    }

    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let _task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    if !git::branch_exists(&project.path, &req.target) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("Branch '{}' does not exist", req.target),
            }),
        ));
    }

    tasks::update_task_target(&project_key, &task_id, &req.target).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
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

/// GET /api/v1/projects/{id}/tasks/{taskId}/diff
pub async fn get_diff(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<DiffResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    let diff_entries = if let Some(to_ref) = query.to_ref.as_deref() {
        let from = query.from_ref.as_deref().unwrap_or(&task.target);
        git::diff_stat_range(&task.worktree_path, from, to_ref).unwrap_or_default()
    } else {
        let target = query.from_ref.as_deref().unwrap_or(&task.target);
        git::diff_stat(&task.worktree_path, target).unwrap_or_default()
    };

    let mut total_additions = 0u32;
    let mut total_deletions = 0u32;

    let files: Vec<DiffFileEntry> = diff_entries
        .into_iter()
        .filter(|entry| entry.additions > 0 || entry.deletions > 0 || entry.is_binary)
        .map(|entry| {
            total_additions += entry.additions;
            total_deletions += entry.deletions;

            let status = match entry.status {
                'A' => DiffStatus::Added,
                'D' => DiffStatus::Deleted,
                'R' => DiffStatus::Renamed,
                'U' => DiffStatus::Untracked,
                _ => DiffStatus::Modified,
            };

            DiffFileEntry {
                path: entry.path,
                status,
                additions: entry.additions,
                deletions: entry.deletions,
                is_binary: entry.is_binary,
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
pub async fn get_commits(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<CommitsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

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
        1
    };

    Ok(Json(CommitsResponse {
        commits,
        total,
        skip_versions,
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/diff/file?path=...&from_ref=...&to_ref=...
pub async fn get_single_file_diff(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<SingleFileDiffQuery>,
) -> Result<axum::response::Response, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    let from_ref = query.from_ref.as_deref().or(Some(&task.target));
    let to_ref = query.to_ref.as_deref();

    let result =
        crate::diff::get_single_file_diff(&task.worktree_path, &query.path, from_ref, to_ref)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(result).into_response())
}
