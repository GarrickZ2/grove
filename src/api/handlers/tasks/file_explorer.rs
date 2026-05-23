//! Task file explorer handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::api::error::ApiError;
use crate::storage::tasks;

use super::super::common::find_project_by_id;
use super::types::*;

#[derive(Debug, Deserialize)]
pub struct DirEntriesQuery {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct DirEntryItem {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct DirEntriesResponse {
    pub entries: Vec<DirEntryItem>,
}

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

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".hg",
    ".svn",
    "target",
    "__pycache__",
    ".DS_Store",
    ".Trash",
    ".cache",
    ".npm",
    ".pnpm-store",
    ".yarn",
    ".turbo",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".build",
    "vendor",
    "Pods",
    ".gradle",
    ".idea",
    ".vscode",
];

/// Check if a path component represents a direct child of `input/`.
/// Directories whose direct children should be treated as opaque when they
/// are symlinks (recorded as directory entries, not recursed into).
const SYMLINK_OPAQUE_PARENTS: &[&str] = &["input", "resource"];

fn is_symlink_dir_child(entry: &walkdir::DirEntry, root: &std::path::Path) -> bool {
    if !entry.path().is_symlink() {
        return false;
    }
    if let Ok(rel) = entry.path().strip_prefix(root) {
        let count = rel.components().count();
        if count == 2 {
            let mut comps = rel.components();
            if let Some(std::path::Component::Normal(parent)) = comps.next() {
                if let Some(parent_str) = parent.to_str() {
                    return SYMLINK_OPAQUE_PARENTS.contains(&parent_str);
                }
            }
        }
    }
    false
}

/// Walk a directory tree and return relative paths (non-git fallback).
///
/// `follow_links(true)` is required for Studio tasks: their `resource/`
/// entry is a symlink into the Studio-wide shared assets directory, and
/// without link-following walkdir would report the symlink itself as a
/// non-file and skip all of its contents — so `@` mentions would never
/// surface resource files. Using `entry.path().is_file()` (instead of
/// `file_type().is_file()`) also resolves through symlinks correctly.
///
/// Symlinks under `input/` and `resource/` that point to directories (working
/// directory links) are recorded as directory-level entries with a trailing `/`
/// suffix and NOT recursed into — avoids enumerating `.git`,
/// `node_modules` etc. from large git repos.
fn list_files_fs(root: &str) -> Vec<String> {
    let root_path = std::path::Path::new(root);
    let mut files = Vec::new();
    let mut symlink_dirs: Vec<String> = Vec::new();

    let mut it = walkdir::WalkDir::new(root_path)
        .min_depth(1)
        .max_depth(64)
        .follow_links(true)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() > 0 {
                if let Some(name) = entry.file_name().to_str() {
                    if IGNORED_DIRS.contains(&name) && !entry.file_type().is_symlink() {
                        return false;
                    }
                }
            }
            true
        });

    while let Some(Ok(entry)) = it.next() {
        if is_symlink_dir_child(&entry, root_path) {
            if let Ok(rel) = entry.path().strip_prefix(root_path) {
                let rel_str = rel.to_string_lossy().to_string();
                symlink_dirs.push(format!("{}/", rel_str));
            }
            it.skip_current_dir();
            continue;
        }
        if entry.path().is_file() {
            if let Ok(rel) = entry.path().strip_prefix(root_path) {
                files.push(rel.to_string_lossy().to_string());
            }
        }
    }

    files.extend(symlink_dirs);
    files.sort();
    files
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/dir-entries?path=...
pub async fn dir_entries(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<DirEntriesQuery>,
) -> Result<Json<DirEntriesResponse>, (StatusCode, Json<ApiError>)> {
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

    if params.path.contains("..") {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: "Path traversal not allowed".to_string(),
            }),
        ));
    }

    let base = std::fs::canonicalize(&task.worktree_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to resolve worktree path: {}", e),
            }),
        )
    })?;

    let trimmed = params.path.trim_matches('/');
    let target_dir = if trimmed.is_empty() {
        base.clone()
    } else {
        let target = base.join(trimmed);
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
            canonical
        } else {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "Directory not found".to_string(),
                }),
            ));
        }
    };

    if !target_dir.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Directory not found".to_string(),
            }),
        ));
    }

    let read_dir = std::fs::read_dir(&target_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to read directory: {}", e),
            }),
        )
    })?;

    let mut entries: Vec<DirEntryItem> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Only hide .git — everything else (dotfiles, node_modules, etc.) is shown
        if name == ".git" {
            continue;
        }

        // Use entry.path().is_dir() instead of file_type().is_dir() so that
        // symlinks pointing to directories are treated as directories.
        let is_dir = entry.path().is_dir();
        let rel_path = if trimmed.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", trimmed, name)
        };

        entries.push(DirEntryItem {
            path: rel_path,
            is_dir,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });

    Ok(Json(DirEntriesResponse { entries }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/files
pub async fn list_files(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<FilesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Only fall back to fs listing for non-git repos (Err).
    // An empty Ok result means a new/empty git repo — return empty, don't walkdir.
    let files = match crate::git::list_files(&task.worktree_path) {
        Ok(f) => f,
        Err(_) => list_files_fs(&task.worktree_path),
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

/// GET /api/v1/projects/{id}/tasks/{taskId}/file/raw?path=...
///
/// Streams the raw bytes of a file with a Content-Type derived from the
/// file extension. Unlike `get_file`, this serves binary assets (images,
/// PDFs, etc.) for embedding via `<img src>` and similar.
///
/// Path resolution: relative paths resolve against the task's worktree
/// directory; absolute paths are used as-is. No containment check is
/// performed — Grove is a local desktop tool and the user explicitly
/// opted in to unrestricted local file access for embedded media.
pub async fn get_file_raw(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<FilePathQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
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

    let requested = PathBuf::from(&params.path);
    let abs_path = if requested.is_absolute() {
        requested
    } else {
        PathBuf::from(&task.worktree_path).join(&requested)
    };

    let bytes = std::fs::read(&abs_path).map_err(|e| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Failed to read {}: {}", abs_path.display(), e),
            }),
        )
    })?;

    let mime = mime_guess::from_path(&abs_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    Ok(([("content-type", mime)], bytes))
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

/// POST /api/v1/projects/{id}/tasks/{taskId}/fs/move
pub async fn move_file(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<MoveFileRequest>,
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
                error: format!("Source file or directory not found: {}", req.source),
            }),
        ));
    }

    if source_path == dest_path {
        return Ok(Json(FsOperationResponse {
            success: true,
            message: format!("Source and destination are identical: {}", req.source),
        }));
    }

    if dest_path.starts_with(&source_path) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "Cannot move a directory into itself or its subdirectories".to_string(),
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

    std::fs::rename(&source_path, &dest_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to move file/directory: {}", e),
            }),
        )
    })?;

    Ok(Json(FsOperationResponse {
        success: true,
        message: format!("Moved {} to {}", req.source, req.destination),
    }))
}
