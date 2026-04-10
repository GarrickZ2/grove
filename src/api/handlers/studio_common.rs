//! Shared types and helpers for Studio project API handlers.
//!
//! Both `projects.rs` and `tasks.rs` deal with work-directory symlinks and
//! file uploads for Studio projects.  This module keeps the shared logic in
//! one place to avoid duplication.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
