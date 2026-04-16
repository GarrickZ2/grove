//! Studio resource handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::fs;
use std::path::PathBuf;

use crate::api::error::ApiError;
use crate::api::handlers::studio_common;
use crate::api::handlers::studio_common::{
    AddWorkDirectoryRequest, WorkDirectoryEntry, WorkDirectoryListResponse, WorkDirectoryQuery,
};

use super::crud::{list_resource_files, resolve_studio_dir};
use super::types::*;

/// Validate that a relative path contains no `..`, root, or prefix components.
fn validate_relative_path(relative: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
    use std::path::Component;
    for component in std::path::Path::new(relative).components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "Invalid path: must be a relative path with no '..' components"
                            .to_string(),
                    }),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

/// GET /api/v1/projects/{id}/resource
pub async fn list_resources(
    Path(id): Path<String>,
    Query(query): Query<ResourceListQuery>,
) -> Result<Json<ResourceListResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let _ = fs::create_dir_all(&resource_dir);

    let list_dir = match &query.path {
        Some(sub) if !sub.is_empty() => {
            validate_relative_path(sub)?;
            resource_dir.join(sub)
        }
        _ => resource_dir.clone(),
    };

    let files = list_resource_files(&list_dir, &resource_dir);
    Ok(Json(ResourceListResponse { files }))
}

/// GET /api/v1/projects/{id}/resource/workdir
///
/// Work-directory symlinks and regular uploaded files share the same `resource/`
/// directory on disk. Symlinks point to external folders; regular files are
/// stored directly. The frontend separates them into two tabs ("Uploads" vs
/// "Work Directory") by calling this endpoint for symlinks and `list_resources`
/// for regular files.
pub async fn list_resource_workdirs(
    Path(id): Path<String>,
) -> Result<Json<WorkDirectoryListResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let entries = studio_common::list_workdir_entries(&workdir_dir);
    Ok(Json(WorkDirectoryListResponse { entries }))
}

/// POST /api/v1/projects/{id}/resource/workdir
pub async fn add_resource_workdir(
    Path(id): Path<String>,
    Json(request): Json<AddWorkDirectoryRequest>,
) -> Result<Json<WorkDirectoryEntry>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    fs::create_dir_all(&workdir_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to create resource directory: {e}"),
            }),
        )
    })?;
    let target = PathBuf::from(request.path.trim());
    let entry = studio_common::create_workdir_symlink(&workdir_dir, &target)?;
    Ok(Json(entry))
}

/// DELETE /api/v1/projects/{id}/resource/workdir
pub async fn delete_resource_workdir(
    Path(id): Path<String>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let link_path = studio_common::validate_symlink_entry(&workdir_dir, &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(ApiError { error: err })))?;
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

/// POST /api/v1/projects/{id}/resource/workdir/open
pub async fn open_resource_workdir(
    Path(id): Path<String>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let link_path = studio_common::validate_symlink_entry(&workdir_dir, &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(ApiError { error: err })))?;
    studio_common::open_in_file_manager(&link_path);
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/resource/upload
pub async fn upload_resource(
    Path(id): Path<String>,
    Query(query): Query<UploadQuery>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<Vec<ResourceFile>>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");

    let upload_dir = match &query.path {
        Some(sub) if !sub.is_empty() => {
            validate_relative_path(sub)?;
            let dir = resource_dir.join(sub);
            fs::create_dir_all(&dir).ok();
            dir
        }
        _ => resource_dir.clone(),
    };

    let uploaded = studio_common::handle_upload(&mut multipart, &upload_dir).await?;

    let path_prefix = match &query.path {
        Some(sub) if !sub.is_empty() => format!("{}/", sub.trim_end_matches('/')),
        _ => String::new(),
    };

    let files = uploaded
        .into_iter()
        .map(|f| ResourceFile {
            name: f.name.clone(),
            path: format!("{}{}", path_prefix, f.name),
            size: f.size,
            modified_at: f.modified_at,
            is_dir: f.is_dir,
        })
        .collect();
    Ok(Json(files))
}

/// DELETE /api/v1/projects/{id}/resource
pub async fn delete_resource(
    Path(id): Path<String>,
    Query(query): Query<ResourceDeleteQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    studio_common::delete_path_contained(&resource_dir, &query.path)?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/resource/preview
pub async fn preview_resource(
    Path(id): Path<String>,
    Query(query): Query<ResourceFileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let canonical_file = resolve_resource_file(&resource_dir, &query.path)?;
    let (content_type, text) = studio_common::preview_file(&canonical_file)?;
    Ok(([("content-type", content_type)], text))
}

/// GET /api/v1/projects/{id}/resource/download
pub async fn download_resource(
    Path(id): Path<String>,
    Query(query): Query<ResourceFileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let canonical_file = resolve_resource_file(&resource_dir, &query.path)?;
    let (headers, content) = studio_common::download_file(&canonical_file)?;
    Ok((headers, content))
}

/// POST /api/v1/projects/{id}/resource/folder
pub async fn create_resource_folder(
    Path(id): Path<String>,
    Json(request): Json<CreateFolderRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    validate_relative_path(&request.path)?;
    let folder_path = resource_dir.join(&request.path);
    fs::create_dir_all(&folder_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to create folder: {e}"),
            }),
        )
    })?;
    Ok(StatusCode::CREATED)
}

/// POST /api/v1/projects/{id}/resource/move
pub async fn move_resource(
    Path(id): Path<String>,
    Json(request): Json<MoveResourceRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");

    let from =
        studio_common::validate_path_containment(&resource_dir, &resource_dir.join(&request.from))?;

    // Build effective destination: optionally replace the final component
    let effective_to = if let Some(rename_to) = &request.rename_to {
        let parent = std::path::Path::new(&request.to)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        if parent.is_empty() {
            rename_to.clone()
        } else {
            format!("{}/{}", parent, rename_to)
        }
    } else {
        request.to.clone()
    };

    validate_relative_path(&effective_to)?;
    let to_path = resource_dir.join(&effective_to);

    // Conflict check: destination exists and caller didn't force-overwrite
    if to_path.exists() && !request.force.unwrap_or(false) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError {
                error: "File already exists".to_string(),
            }),
        ));
    }

    if let Some(parent) = to_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Failed to create target directory: {e}"),
                    }),
                )
            })?;
        }
    }

    fs::rename(&from, &to_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Move failed: {e}"),
            }),
        )
    })?;

    Ok(StatusCode::NO_CONTENT)
}

fn resolve_resource_file(
    resource_dir: &std::path::Path,
    relative_path: &str,
) -> Result<PathBuf, (StatusCode, Json<ApiError>)> {
    studio_common::validate_path_containment(resource_dir, &resource_dir.join(relative_path))
}
