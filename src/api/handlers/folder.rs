//! Folder selection and file reading API handlers

use axum::{extract::Query, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::api::error::ApiError;

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowseFolderResponse {
    pub path: Option<String>,
}

pub async fn browse_folder() -> Json<BrowseFolderResponse> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"Select Git Repository Folder\")")
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(BrowseFolderResponse { path: Some(path) });
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("zenity")
            .args([
                "--file-selection",
                "--directory",
                "--title=Select Git Repository Folder",
            ])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(BrowseFolderResponse { path: Some(path) });
                }
            }
        }

        let output = Command::new("kdialog")
            .args([
                "--getexistingdirectory",
                ".",
                "--title",
                "Select Git Repository Folder",
            ])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(BrowseFolderResponse { path: Some(path) });
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let script = "Add-Type -AssemblyName System.Windows.Forms; \
                      $f = New-Object System.Windows.Forms.FolderBrowserDialog; \
                      $f.Description = 'Select Git Repository Folder'; \
                      if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(BrowseFolderResponse { path: Some(path) });
                }
            }
        }
    }

    Json(BrowseFolderResponse { path: None })
}

// ─── Read File Handler ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ReadFileQuery {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ReadFileResponse {
    pub path: String,
    pub content: String,
}

pub async fn read_file(
    Query(params): Query<ReadFileQuery>,
) -> Result<Json<ReadFileResponse>, (StatusCode, Json<ApiError>)> {
    let path = &params.path;

    if !path.ends_with(".md") {
        return Err(ApiError::bad_request("Only .md files are supported"));
    }

    if !path.starts_with('/') {
        return Err(ApiError::bad_request("Path must be absolute"));
    }

    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Json(ReadFileResponse {
            path: path.clone(),
            content,
        })),
        Err(e) => Err(ApiError::not_found(format!("Failed to read file: {}", e))),
    }
}

// ─── List Folder Handler (web-based picker) ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListFolderQuery {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct FolderEntry {
    pub name: String,
    /// Absolute path of this entry (parent + name, properly joined).
    pub path: String,
    pub is_git_repo: bool,
}

#[derive(Debug, Serialize)]
pub struct ListFolderResponse {
    /// Absolute path that was listed (as supplied by the client; not canonicalized).
    pub path: String,
    /// Parent dir of `path`, or null if at filesystem root.
    pub parent: Option<String>,
    /// Sub-directories under `path`. Files and dotfiles excluded.
    /// Sorted case-insensitively by name.
    pub entries: Vec<FolderEntry>,
    /// User's home dir, for "Home" button convenience.
    pub home: Option<String>,
}

#[derive(Debug)]
pub enum ListFolderError {
    BadRequest(String),
    Forbidden(String),
    NotFound(String),
    Internal(String),
}

impl std::fmt::Display for ListFolderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(m) | Self::Forbidden(m) | Self::NotFound(m) | Self::Internal(m) => {
                f.write_str(m)
            }
        }
    }
}

/// Pure function for unit-testing. The axum handler wraps this with Result→HTTP.
pub fn list_folder_inner(q: ListFolderQuery) -> Result<ListFolderResponse, ListFolderError> {
    let raw = q.path.trim();
    if !raw.starts_with('/') {
        return Err(ListFolderError::BadRequest("path must be absolute".into()));
    }
    // Textual `..` check only — this does NOT defend against symlink-based
    // traversal. The deployment trust model assumes the auth layer (HMAC for
    // `grove mobile`, Cloudflare Access / equivalent for public deploys) gates
    // who can call this endpoint. If you ever expose this without an auth
    // layer in front, add `canonicalize()` + an allowlist-prefix check.
    if raw.split('/').any(|seg| seg == "..") {
        return Err(ListFolderError::BadRequest(
            "path must not contain `..`".into(),
        ));
    }
    let p = std::path::Path::new(raw);
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ListFolderError::NotFound("path not found".into()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(ListFolderError::Forbidden("permission denied".into()))
        }
        Err(e) => return Err(ListFolderError::Internal(format!("stat failed: {}", e))),
    };
    if !meta.is_dir() {
        return Err(ListFolderError::BadRequest(
            "path is not a directory".into(),
        ));
    }
    let read = std::fs::read_dir(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            ListFolderError::Forbidden("permission denied".into())
        }
        _ => ListFolderError::Internal(format!("read_dir failed: {}", e)),
    })?;
    let mut entries: Vec<FolderEntry> = read
        .filter_map(|r| r.ok())
        .filter_map(|de| {
            let name = de.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let ft = de.file_type().ok()?;
            if !ft.is_dir() {
                return None;
            }
            // try_exists distinguishes "doesn't exist" from "couldn't stat" — the
            // latter (permission denied, etc.) shouldn't false-flag as a git repo.
            let is_git_repo = de.path().join(".git").try_exists().unwrap_or(false);
            Some(FolderEntry {
                name,
                path: de.path().to_string_lossy().to_string(),
                is_git_repo,
            })
        })
        .collect();
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(ListFolderResponse {
        path: raw.to_string(),
        parent: p.parent().map(|pp| pp.to_string_lossy().to_string()),
        entries,
        home: std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok(),
    })
}

pub async fn list_folder(
    Query(q): Query<ListFolderQuery>,
) -> Result<Json<ListFolderResponse>, (StatusCode, Json<ApiError>)> {
    match list_folder_inner(q) {
        Ok(r) => Ok(Json(r)),
        Err(ListFolderError::BadRequest(msg)) => Err(ApiError::bad_request(&msg)),
        Err(ListFolderError::Forbidden(msg)) => Err(ApiError::forbidden(&msg)),
        Err(ListFolderError::NotFound(msg)) => Err(ApiError::not_found(&msg)),
        Err(ListFolderError::Internal(msg)) => Err(ApiError::internal(&msg)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_tree(td: &TempDir) {
        let root = td.path();
        fs::create_dir(root.join("repo-a")).unwrap();
        fs::create_dir(root.join("repo-a/.git")).unwrap();
        fs::create_dir(root.join("plain-dir")).unwrap();
        fs::write(root.join("note.md"), "x").unwrap();
        fs::write(root.join(".hidden"), "x").unwrap();
    }

    #[test]
    fn list_folder_returns_entries_with_git_flag() {
        let td = TempDir::new().unwrap();
        setup_tree(&td);
        let q = ListFolderQuery {
            path: td.path().to_string_lossy().into(),
        };
        let resp = list_folder_inner(q).expect("ok");
        let names: Vec<_> = resp.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"repo-a"));
        assert!(names.contains(&"plain-dir"));
        assert!(
            !names.contains(&"note.md"),
            "files should not appear (dirs only)"
        );
        assert!(!names.contains(&".hidden"), "dotfiles hidden by default");
        let repo_a = resp.entries.iter().find(|e| e.name == "repo-a").unwrap();
        assert!(repo_a.is_git_repo);
        assert_eq!(repo_a.path, td.path().join("repo-a").to_string_lossy());
        let plain = resp.entries.iter().find(|e| e.name == "plain-dir").unwrap();
        assert!(!plain.is_git_repo);
        assert_eq!(resp.path, td.path().to_string_lossy());
        assert_eq!(
            resp.parent.as_deref(),
            td.path().parent().map(|p| p.to_str().unwrap())
        );
    }

    #[test]
    fn list_folder_rejects_relative_path() {
        let q = ListFolderQuery {
            path: "relative/path".into(),
        };
        let err = list_folder_inner(q).unwrap_err();
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn list_folder_rejects_traversal() {
        let q = ListFolderQuery {
            path: "/etc/../etc".into(),
        };
        let err = list_folder_inner(q).unwrap_err();
        assert!(err.to_string().contains(".."));
    }

    #[test]
    fn list_folder_404_on_missing() {
        let q = ListFolderQuery {
            path: "/no/such/path/xyz123".into(),
        };
        let err = list_folder_inner(q).unwrap_err();
        let s = err.to_string();
        assert!(s.contains("not found") || s.contains("No such"));
    }

    #[test]
    fn list_folder_rejects_file_path() {
        let td = TempDir::new().unwrap();
        let file = td.path().join("a.txt");
        fs::write(&file, "x").unwrap();
        let q = ListFolderQuery {
            path: file.to_string_lossy().into(),
        };
        let err = list_folder_inner(q).unwrap_err();
        assert!(err.to_string().contains("not a directory"));
    }
}
