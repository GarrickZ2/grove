//! Studio task artifact handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::fs;
use std::path::PathBuf;

use crate::api::error::ApiError;
use crate::storage::{tasks, workspace};

use super::super::studio_common;
use super::super::studio_common::{
    AddWorkDirectoryRequest, WorkDirectoryEntry, WorkDirectoryListResponse, WorkDirectoryQuery,
};
use super::crud::find_project_by_id;
use super::types::*;

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
            files.push(ArtifactFile {
                name: name.clone(),
                path: rel_str.clone(),
                directory: category.to_string(),
                size: 0,
                modified_at: studio_common::format_modified_time(&meta),
                is_dir: true,
            });
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

fn ensure_workdir_symlink(dir: &std::path::Path, name: &str) -> Result<PathBuf, ApiError> {
    studio_common::validate_symlink_entry(dir, name).map_err(|err| ApiError { error: err })
}

type ApiErr = (StatusCode, Json<ApiError>);

fn task_not_found() -> ApiErr {
    (
        StatusCode::NOT_FOUND,
        Json(ApiError {
            error: "Task not found".to_string(),
        }),
    )
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts
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
) -> Result<Json<WorkDirectoryListResponse>, ApiErr> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or_else(task_not_found)?;
    let entries = studio_common::list_workdir_entries(&artifact_workdir_dir(&task_dir));
    Ok(Json(WorkDirectoryListResponse { entries }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/artifacts/workdir
pub async fn add_artifact_workdir(
    Path((id, task_id)): Path<(String, String)>,
    Json(request): Json<AddWorkDirectoryRequest>,
) -> Result<Json<WorkDirectoryEntry>, ApiErr> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or_else(task_not_found)?;
    let workdir_dir = artifact_workdir_dir(&task_dir);
    let target = PathBuf::from(request.path.trim());
    let entry = studio_common::create_workdir_symlink(&workdir_dir, &target)?;
    Ok(Json(entry))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/artifacts/workdir
pub async fn delete_artifact_workdir(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, ApiErr> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or_else(task_not_found)?;
    let link_path = ensure_workdir_symlink(&artifact_workdir_dir(&task_dir), &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;
    fs::remove_file(link_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
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
) -> Result<StatusCode, ApiErr> {
    let (project, _) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &id, &task_id).ok_or_else(task_not_found)?;
    let link_path = ensure_workdir_symlink(&artifact_workdir_dir(&task_dir), &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;
    studio_common::open_in_file_manager(&link_path);
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/preview
pub async fn preview_artifact(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<impl IntoResponse, ApiErr> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &project_key, &task_id).ok_or_else(task_not_found)?;
    let file_path = task_dir.join(&query.dir).join(&query.path);
    let canonical_file = studio_common::validate_path_containment(&task_dir, &file_path)?;
    let (content_type, text) = studio_common::preview_file(&canonical_file)?;
    Ok(([("content-type", content_type)], text))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/download
pub async fn download_artifact(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;
    let task_dir =
        resolve_task_dir(&project, &project_key, &task_id).ok_or(StatusCode::NOT_FOUND)?;
    let file_path = task_dir.join(&query.dir).join(&query.path);
    let canonical_task = task_dir.canonicalize().unwrap_or(task_dir);
    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !canonical_file.starts_with(&canonical_task) {
        return Err(StatusCode::FORBIDDEN);
    }
    let (headers, content) =
        studio_common::download_file(&canonical_file).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((headers, content))
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/artifacts
pub async fn delete_artifact(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<StatusCode, ApiErr> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    if query.dir != "input" {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: "Can only delete files from input/ directory".to_string(),
            }),
        ));
    }

    let task_dir = resolve_task_dir(&project, &project_key, &task_id).ok_or_else(task_not_found)?;
    let input_dir = task_dir.join("input");
    studio_common::delete_path_contained(&input_dir, &query.path)?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/artifacts/upload
pub async fn upload_artifact(
    Path((id, task_id)): Path<(String, String)>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<Vec<ArtifactFile>>, ApiErr> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    let task_dir = resolve_task_dir(&project, &project_key, &task_id).ok_or_else(task_not_found)?;
    let input_dir = task_dir.join("input");
    let uploaded = studio_common::handle_upload(&mut multipart, &input_dir).await?;
    let files = uploaded
        .into_iter()
        .map(|f| ArtifactFile {
            name: f.name,
            path: f.path,
            directory: "input".to_string(),
            size: f.size,
            modified_at: f.modified_at,
            is_dir: f.is_dir,
        })
        .collect();
    Ok(Json(files))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/open-folder
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
    studio_common::open_in_file_manager(&folder);
    Ok(StatusCode::NO_CONTENT)
}
