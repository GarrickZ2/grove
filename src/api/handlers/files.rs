//! Unified read-only file serving for project, task, and resource roots.

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    Json,
};
use serde::Deserialize;
use std::path::{Path as FsPath, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::api::error::ApiError;
use crate::api::handlers::common::find_project_by_id;
use crate::api::handlers::studio_common;
use crate::storage::{tasks, workspace};

type ApiErr = (StatusCode, Json<ApiError>);

#[derive(Debug, Deserialize)]
pub struct RawFileQuery {
    pub path: String,
    #[serde(default)]
    pub disposition: Disposition,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Disposition {
    #[default]
    Inline,
    Attachment,
}

pub(crate) enum FileRoot {
    Project,
    Resource,
    Task(String),
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiErr {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn project_root(project: &workspace::RegisteredProject) -> PathBuf {
    if project.project_type == workspace::ProjectType::Studio {
        workspace::studio_project_dir(&project.path)
    } else {
        PathBuf::from(&project.path)
    }
}

fn task_root(
    project: &workspace::RegisteredProject,
    project_key: &str,
    task_id: &str,
) -> Result<PathBuf, ApiErr> {
    if project.project_type == workspace::ProjectType::Studio {
        if !studio_common::is_studio_id_segment(task_id) {
            return Err(error(StatusCode::BAD_REQUEST, "Invalid task ID"));
        }
        Ok(workspace::studio_project_dir(&project.path)
            .join("tasks")
            .join(task_id))
    } else {
        tasks::get_task(project_key, task_id)
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map(|task| PathBuf::from(task.worktree_path))
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "Task not found"))
    }
}

fn add_canonical_root(roots: &mut Vec<PathBuf>, path: &FsPath) {
    if let Ok(path) = path.canonicalize() {
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
}

fn add_link_targets(roots: &mut Vec<PathBuf>, directory: &FsPath) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if crate::fs_link::is_link(&path) {
            add_canonical_root(roots, &path);
        }
    }
}

/// A repo project can itself point at a directory inside a Studio task (for
/// example `output/deliverables`). Include that owning task root so sibling
/// input/output/internal references remain available without granting access
/// to unrelated Studio tasks.
fn add_owning_studio_task_root(roots: &mut Vec<PathBuf>, base: &FsPath) {
    let Ok(projects) = workspace::load_projects() else {
        return;
    };
    let Ok(canonical_base) = base.canonicalize() else {
        return;
    };
    for project in projects {
        if project.project_type != workspace::ProjectType::Studio {
            continue;
        }
        let tasks_dir = workspace::studio_project_dir(&project.path).join("tasks");
        let Ok(entries) = std::fs::read_dir(tasks_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let task_dir = entry.path();
            let Ok(canonical_task) = task_dir.canonicalize() else {
                continue;
            };
            if canonical_base.starts_with(&canonical_task) {
                add_canonical_root(roots, &canonical_task);
            }
        }
    }
}

fn resolve_file(
    base: &FsPath,
    extra_roots: &[PathBuf],
    requested: &str,
) -> Result<PathBuf, ApiErr> {
    if requested.trim().is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "File path is required"));
    }
    let requested = PathBuf::from(requested);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        base.join(requested)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|_| error(StatusCode::NOT_FOUND, "File not found"))?;
    if !canonical.is_file() {
        return Err(error(StatusCode::BAD_REQUEST, "Path is not a file"));
    }

    let mut allowed_roots = Vec::new();
    add_canonical_root(&mut allowed_roots, base);
    for root in extra_roots {
        add_canonical_root(&mut allowed_roots, root);
    }
    add_owning_studio_task_root(&mut allowed_roots, base);
    add_link_targets(&mut allowed_roots, base);
    add_link_targets(&mut allowed_roots, &base.join("input"));
    add_link_targets(&mut allowed_roots, &base.join("resource"));

    if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(error(StatusCode::FORBIDDEN, "Access denied"));
    }
    Ok(canonical)
}

fn parse_range(value: &str, file_size: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || file_size == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let length = suffix.min(file_size);
        return Some((file_size - length, file_size - 1));
    }
    let start: u64 = start.parse().ok()?;
    if start >= file_size {
        return None;
    }
    let end = if end.is_empty() {
        file_size - 1
    } else {
        end.parse::<u64>().ok()?.min(file_size - 1)
    };
    (start <= end).then_some((start, end))
}

pub(crate) async fn serve(
    project_id: String,
    root: FileRoot,
    query: RawFileQuery,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiErr> {
    let (project, project_key) =
        find_project_by_id(&project_id).map_err(|status| error(status, "Project not found"))?;
    let project_base = project_root(&project);
    let (base, extra_roots) = match root {
        FileRoot::Project => (project_base.clone(), Vec::new()),
        FileRoot::Resource => {
            if project.project_type != workspace::ProjectType::Studio {
                return Err(error(StatusCode::NOT_FOUND, "Resource root not found"));
            }
            (project_base.join("resource"), Vec::new())
        }
        FileRoot::Task(task_id) => {
            let base = task_root(&project, &project_key, &task_id)?;
            let extras = if project.project_type == workspace::ProjectType::Studio {
                vec![project_base.join("resource")]
            } else {
                vec![project_base.clone()]
            };
            (base, extras)
        }
    };
    let canonical = resolve_file(&base, &extra_roots, &query.path)?;
    let mut file = tokio::fs::File::open(&canonical)
        .await
        .map_err(|_| error(StatusCode::NOT_FOUND, "Failed to read file"))?;
    let file_size = file
        .metadata()
        .await
        .map_err(|_| error(StatusCode::NOT_FOUND, "Failed to read file metadata"))?
        .len();
    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    let filename = studio_common::sanitize_filename_for_header(
        &canonical
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string()),
    );
    let disposition = match query.disposition {
        Disposition::Inline => format!("inline; filename=\"{filename}\""),
        Disposition::Attachment => format!("attachment; filename=\"{filename}\""),
    };

    let requested_range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let range = requested_range.and_then(|value| parse_range(value, file_size));
    if requested_range.is_some() && range.is_none() {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{file_size}"))
            .body(Body::empty())
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    let (status, content_length, content_range, body) = if let Some((start, end)) = range {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to seek file"))?;
        let length = end - start + 1;
        (
            StatusCode::PARTIAL_CONTENT,
            length,
            Some(format!("bytes {start}-{end}/{file_size}")),
            Body::from_stream(ReaderStream::new(file.take(length))),
        )
    } else {
        (
            StatusCode::OK,
            file_size,
            None,
            Body::from_stream(ReaderStream::new(file)),
        )
    };

    let mut response = Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(mime.essence_str()).unwrap(),
        )
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH, content_length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-content-type-options", "nosniff")
        .body(body)
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(content_range) = content_range {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&content_range)
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        );
    }
    Ok(response)
}

pub async fn project_file(
    Path(project_id): Path<String>,
    Query(query): Query<RawFileQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiErr> {
    serve(project_id, FileRoot::Project, query, headers).await
}

pub async fn resource_file(
    Path(project_id): Path<String>,
    Query(query): Query<RawFileQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiErr> {
    serve(project_id, FileRoot::Resource, query, headers).await
}

pub async fn task_file(
    Path((project_id, task_id)): Path<(String, String)>,
    Query(query): Query<RawFileQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiErr> {
    serve(project_id, FileRoot::Task(task_id), query, headers).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cross_directory_files_within_an_allowed_root() {
        let temp = tempfile::tempdir().unwrap();
        let task = temp.path().join("task");
        std::fs::create_dir_all(task.join("output")).unwrap();
        std::fs::create_dir_all(task.join("input")).unwrap();
        std::fs::write(task.join("input/source.png"), b"png").unwrap();

        let resolved = resolve_file(&task, &[], "output/../input/source.png").unwrap();
        assert_eq!(
            resolved,
            task.join("input/source.png").canonicalize().unwrap()
        );
    }

    #[test]
    fn allows_explicit_additional_roots() {
        let temp = tempfile::tempdir().unwrap();
        let task = temp.path().join("task");
        let resource = temp.path().join("resource");
        std::fs::create_dir_all(&task).unwrap();
        std::fs::create_dir_all(&resource).unwrap();
        std::fs::write(resource.join("logo.svg"), b"svg").unwrap();

        let resolved = resolve_file(
            &task,
            std::slice::from_ref(&resource),
            "../resource/logo.svg",
        )
        .unwrap();
        assert_eq!(resolved, resource.join("logo.svg").canonicalize().unwrap());
    }

    #[test]
    fn denies_files_outside_all_allowed_roots() {
        let temp = tempfile::tempdir().unwrap();
        let task = temp.path().join("task");
        let private = temp.path().join("private.txt");
        std::fs::create_dir_all(&task).unwrap();
        std::fs::write(&private, b"private").unwrap();

        let error = resolve_file(&task, &[], "../private.txt").unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn parses_standard_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 100), None);
    }
}
