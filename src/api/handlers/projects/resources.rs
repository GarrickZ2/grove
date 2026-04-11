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

use super::crud::{ensure_link_points_inside, list_resource_files, resolve_studio_dir};
use super::types::*;

/// GET /api/v1/projects/{id}/resource
pub async fn list_resources(
    Path(id): Path<String>,
) -> Result<Json<ResourceListResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let files = list_resource_files(&resource_dir);
    Ok(Json(ResourceListResponse { files }))
}

/// GET /api/v1/projects/{id}/resource/workdir
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
    let link_path = ensure_link_points_inside(&workdir_dir, &query.name)
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

/// POST /api/v1/projects/{id}/resource/workdir/open
pub async fn open_resource_workdir(
    Path(id): Path<String>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let link_path = ensure_link_points_inside(&workdir_dir, &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;
    studio_common::open_in_file_manager(&link_path);
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/resource/upload
pub async fn upload_resource(
    Path(id): Path<String>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<Vec<ResourceFile>>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let uploaded = studio_common::handle_upload(&mut multipart, &resource_dir).await?;
    let files = uploaded
        .into_iter()
        .map(|f| ResourceFile {
            name: f.name,
            path: f.path,
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

fn resolve_resource_file(
    resource_dir: &std::path::Path,
    relative_path: &str,
) -> Result<PathBuf, (StatusCode, Json<ApiError>)> {
    studio_common::validate_path_containment(resource_dir, &resource_dir.join(relative_path))
}
