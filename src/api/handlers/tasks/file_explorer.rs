//! Task file explorer handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use std::path::PathBuf;

use crate::api::error::ApiError;
use crate::storage::tasks;

use super::crud::find_project_by_id;
use super::types::*;

/// Resolve a relative path within a worktree, preventing path traversal attacks.
fn resolve_safe_path(
    worktree_path: &str,
    relative_path: &str,
) -> Result<PathBuf, (StatusCode, Json<ApiError>)> {
    if relative_path.contains("..") {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: "Path traversal not allowed".to_string(),
            }),
        ));
    }

    let base = std::fs::canonicalize(worktree_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to resolve worktree path: {}", e),
            }),
        )
    })?;

    let target = base.join(relative_path);

    if target.exists() {
        let canonical = std::fs::canonicalize(&target).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to resolve path: {}", e),
                }),
            )
        })?;
        if !canonical.starts_with(&base) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: "Path traversal not allowed".to_string(),
                }),
            ));
        }
        return Ok(canonical);
    }

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
                Json(ApiError {
                    error: format!("Failed to resolve path: {}", e),
                }),
            )
        })?;
        if !canonical_ancestor.starts_with(&base) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: "Path traversal not allowed".to_string(),
                }),
            ));
        }
    }

    Ok(target)
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

/// GET /api/v1/projects/{id}/tasks/{taskId}/files
pub async fn list_files(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<FilesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let files = match crate::git::list_files(&task.worktree_path) {
        Ok(f) if !f.is_empty() => f,
        _ => list_files_fs(&task.worktree_path),
    };

    Ok(Json(FilesResponse { files }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/file?path=src/main.rs
pub async fn get_file(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<FilePathQuery>,
) -> Result<Json<FileContentResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
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

    let content = crate::git::read_file(&task.worktree_path, &params.path).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
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
pub async fn update_file(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<FilePathQuery>,
    Json(body): Json<WriteFileRequest>,
) -> Result<Json<FileContentResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
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

    crate::git::write_file(&task.worktree_path, &params.path, &body.content).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(Json(FileContentResponse {
        content: body.content,
        path: params.path,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/fs/create-file
pub async fn create_file(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateFileRequest>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
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

    let full_path = resolve_safe_path(&task.worktree_path, &req.path)?;

    if full_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError {
                error: format!("File already exists: {}", req.path),
            }),
        ));
    }

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to create parent directories: {}", e),
                }),
            )
        })?;
    }

    let content = req.content.unwrap_or_default();
    std::fs::write(&full_path, content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
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
pub async fn create_directory(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateDirectoryRequest>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
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

    let full_path = resolve_safe_path(&task.worktree_path, &req.path)?;

    if full_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError {
                error: format!("Directory already exists: {}", req.path),
            }),
        ));
    }

    std::fs::create_dir_all(&full_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
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
pub async fn delete_path(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<DeletePathQuery>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
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

    let full_path = resolve_safe_path(&task.worktree_path, &params.path)?;

    if !full_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Path not found: {}", params.path),
            }),
        ));
    }

    if full_path.is_dir() {
        std::fs::remove_dir_all(&full_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to delete directory: {}", e),
                }),
            )
        })?;
    } else {
        std::fs::remove_file(&full_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
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
pub async fn copy_file(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CopyFileRequest>,
) -> Result<Json<FsOperationResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task = tasks::get_task(&project_key, &task_id)
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

    let source_path = resolve_safe_path(&task.worktree_path, &req.source)?;
    let dest_path = resolve_safe_path(&task.worktree_path, &req.destination)?;

    if !source_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Source file not found: {}", req.source),
            }),
        ));
    }

    if !source_path.is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "Source must be a file, not a directory".to_string(),
            }),
        ));
    }

    if dest_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError {
                error: format!("Destination already exists: {}", req.destination),
            }),
        ));
    }

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to create parent directories: {}", e),
                }),
            )
        })?;
    }

    std::fs::copy(&source_path, &dest_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to copy file: {}", e),
            }),
        )
    })?;

    Ok(Json(FsOperationResponse {
        success: true,
        message: format!("Copied {} to {}", req.source, req.destination),
    }))
}
