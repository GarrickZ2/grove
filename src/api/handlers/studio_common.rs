//! Shared types and helpers for Studio project API handlers.
//!
//! Both `projects/` and `tasks/` deal with work-directory symlinks and
//! file uploads for Studio projects.  This module keeps the shared logic in
//! one place to avoid duplication.

use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Per-file upload size limit (100 MiB).
pub const MAX_UPLOAD_SIZE: usize = 100 * 1024 * 1024;

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct WorkDirectoryEntry {
    pub name: String,
    pub target_path: String,
    pub exists: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkDirectoryListResponse {
    pub entries: Vec<WorkDirectoryEntry>,
}

#[derive(Debug, Deserialize)]
pub struct AddWorkDirectoryRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct WorkDirectoryQuery {
    pub name: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// List all symlink entries inside `dir`.
pub fn list_workdir_entries(dir: &std::path::Path) -> Vec<WorkDirectoryEntry> {
    let mut entries_out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return entries_out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        let target = match fs::read_link(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        entries_out.push(WorkDirectoryEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            target_path: target.to_string_lossy().to_string(),
            exists: target.exists(),
        });
    }
    entries_out.sort_by(|a, b| a.name.cmp(&b.name));
    entries_out
}

/// Replace characters that are unsafe in symlink names.
pub fn sanitize_symlink_name(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

/// Derive a unique symlink name inside `dir` based on the file name of
/// `target_path`, appending a numeric suffix if necessary.
pub fn create_unique_symlink_name(dir: &std::path::Path, target_path: &std::path::Path) -> String {
    let fallback = "folder".to_string();
    let base = target_path
        .file_name()
        .map(|n| sanitize_symlink_name(&n.to_string_lossy()))
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback);

    if !dir.join(&base).exists() && !dir.join(&base).is_symlink() {
        return base;
    }
    for idx in 2..1000 {
        let candidate = format!("{base}-{idx}");
        if !dir.join(&candidate).exists() && !dir.join(&candidate).is_symlink() {
            return candidate;
        }
    }
    format!("{base}-{}", Utc::now().timestamp())
}

/// Validate that `name` refers to a symlink that lives directly inside `dir`
/// (no path traversal).  Returns the full `PathBuf` on success, or an error
/// message string on failure.
pub fn validate_symlink_entry(dir: &std::path::Path, name: &str) -> Result<PathBuf, String> {
    let path = dir.join(name);
    // If the base directory doesn't exist yet, the path can't be valid.
    let canonical_base = dir
        .canonicalize()
        .map_err(|e| format!("Base directory does not exist or is not accessible: {e}"))?;
    let canonical_parent = path
        .parent()
        .map(|p| {
            p.canonicalize()
                .map_err(|e| format!("Parent path not accessible: {e}"))
        })
        .transpose()?
        .unwrap_or_else(|| canonical_base.clone());
    if !canonical_parent.starts_with(&canonical_base) {
        return Err("Access denied".to_string());
    }
    let meta = fs::symlink_metadata(&path).map_err(|_| "Work Directory not found".to_string())?;
    if !meta.file_type().is_symlink() {
        return Err("Entry is not a symlink".to_string());
    }
    Ok(path)
}

/// Returns `true` when `id` is a safe Studio task ID segment (only
/// alphanumeric characters, `-`, and `_`).
pub fn is_studio_id_segment(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// Format a file's modification time as an RFC-3339 string.
/// Returns an empty string if the metadata is unavailable.
pub fn format_modified_time(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| {
            chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                .map(|dt| dt.to_rfc3339())
        })
        .unwrap_or_default()
}

/// Sanitize a filename for use in a `Content-Disposition` header value.
/// Strips characters that could break out of the quoted string (`"`, `\`)
/// or inject additional headers (`\r`, `\n`).
pub fn sanitize_filename_for_header(name: &str) -> String {
    name.chars()
        .filter(|&c| c != '"' && c != '\\' && c != '\r' && c != '\n')
        .collect()
}

/// Decode raw bytes to a String, trying UTF-8 first and falling back to GBK
/// for CJK text files.
pub fn decode_text_bytes(content: &[u8]) -> String {
    match String::from_utf8(content.to_vec()) {
        Ok(s) => s,
        Err(_) => encoding_rs::GBK.decode(content).0.into_owned(),
    }
}

/// Guess the MIME `Content-Type` from a file extension.
/// Returns `"application/octet-stream"` for unknown extensions.
pub fn guess_content_type(extension: Option<&str>) -> &'static str {
    match extension {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("md" | "txt" | "log") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ── Flow-level operations (shared between artifacts & resources) ─────────────

use crate::api::error::ApiError;

pub type ApiErr = (StatusCode, Json<ApiError>);

/// Canonicalize both paths and verify `file_path` stays within `base_dir`.
/// Returns the canonical file path on success.
pub fn validate_path_containment(base_dir: &Path, file_path: &Path) -> Result<PathBuf, ApiErr> {
    let canonical_base = base_dir.canonicalize().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Base directory not accessible: {e}"),
            }),
        )
    })?;
    let canonical_file = file_path.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "File not found".to_string(),
            }),
        )
    })?;
    if !canonical_file.starts_with(&canonical_base) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: "Access denied".to_string(),
            }),
        ));
    }
    Ok(canonical_file)
}

/// Preview a text file: read + size check + encoding decode.
/// Returns `(content_type_header, decoded_text)`.
pub fn preview_file(canonical_path: &Path) -> Result<(&'static str, String), ApiErr> {
    const MAX_PREVIEW_SIZE: u64 = 10 * 1024 * 1024;
    let file_size = std::fs::metadata(canonical_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if file_size > MAX_PREVIEW_SIZE {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ApiError {
                error: format!("File too large to preview ({file_size} bytes, max 10 MB)"),
            }),
        ));
    }

    let content = std::fs::read(canonical_path).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Failed to read file".to_string(),
            }),
        )
    })?;

    Ok(("text/plain; charset=utf-8", decode_text_bytes(&content)))
}

/// Read a file and build a download response (content-type + disposition header).
/// Returns `((content_type, content_disposition), bytes)`.
#[allow(clippy::type_complexity)]
pub fn download_file(canonical_path: &Path) -> Result<([(String, String); 2], Vec<u8>), ApiErr> {
    let content = std::fs::read(canonical_path).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Failed to read file".to_string(),
            }),
        )
    })?;
    let filename = sanitize_filename_for_header(
        &canonical_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string()),
    );
    let ext = canonical_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string());
    let content_type = guess_content_type(ext.as_deref());
    let headers = [
        ("content-type".to_string(), content_type.to_string()),
        (
            "content-disposition".to_string(),
            format!("attachment; filename=\"{}\"", filename),
        ),
    ];
    Ok((headers, content))
}

/// Process a multipart upload into `dest_dir`.
/// Returns a list of uploaded file metadata.
pub async fn handle_upload(
    multipart: &mut axum::extract::Multipart,
    dest_dir: &Path,
) -> Result<Vec<UploadedFile>, ApiErr> {
    fs::create_dir_all(dest_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to create directory: {e}"),
            }),
        )
    })?;

    let mut uploaded = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field.file_name().unwrap_or("upload").to_string();
        let safe_name = filename.replace(['/', '\\'], "_");
        if safe_name.is_empty() || safe_name.starts_with('.') {
            continue;
        }

        let data = field.bytes().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!("Failed to read upload: {e}"),
                }),
            )
        })?;

        if data.len() > MAX_UPLOAD_SIZE {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiError {
                    error: format!(
                        "File '{}' too large ({} bytes, max 100 MB)",
                        safe_name,
                        data.len()
                    ),
                }),
            ));
        }

        let file_path = dest_dir.join(&safe_name);
        fs::write(&file_path, &data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to write file: {e}"),
                }),
            )
        })?;

        let meta = fs::metadata(&file_path).ok();
        uploaded.push(UploadedFile {
            name: safe_name.clone(),
            path: safe_name,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(data.len() as u64),
            modified_at: Utc::now().to_rfc3339(),
            is_dir: false,
        });
    }
    Ok(uploaded)
}

/// Generic uploaded file entry — used by both artifact and resource upload responses.
#[derive(Debug, Clone, serde::Serialize)]
pub struct UploadedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: String,
    pub is_dir: bool,
}

/// Validate `target_path` is an absolute, existing directory and create a
/// symlink to it inside `workdir_dir`. Returns the new entry.
pub fn create_workdir_symlink(
    workdir_dir: &Path,
    target_path: &Path,
) -> Result<WorkDirectoryEntry, ApiErr> {
    let target = PathBuf::from(target_path.to_string_lossy().to_string().trim());
    if !target.is_absolute() {
        return Err(ApiError::bad_request("Path must be absolute"));
    }
    if !target.exists() || !target.is_dir() {
        return Err(ApiError::bad_request(
            "Selected path must be an existing directory",
        ));
    }

    let link_name = create_unique_symlink_name(workdir_dir, &target);
    let link_path = workdir_dir.join(&link_name);

    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to create symlink: {e}"),
            }),
        )
    })?;

    #[cfg(not(unix))]
    {
        return Err(ApiError::not_implemented(
            "Work Directory is currently only supported on Unix-like systems",
        ));
    }

    Ok(WorkDirectoryEntry {
        name: link_name,
        target_path: target.to_string_lossy().to_string(),
        exists: true,
    })
}

/// Open a path in the system file manager (macOS `open` / Linux `xdg-open`).
pub fn open_in_file_manager(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

/// Delete a file or directory at `path`, which must reside inside `base_dir`.
pub fn delete_path_contained(base_dir: &Path, relative_path: &str) -> Result<(), ApiErr> {
    let file_path = base_dir.join(relative_path);
    let canonical_file = validate_path_containment(base_dir, &file_path)?;

    if canonical_file.is_dir() {
        fs::remove_dir_all(&canonical_file)
    } else {
        fs::remove_file(&canonical_file)
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to delete: {e}"),
            }),
        )
    })?;
    Ok(())
}
