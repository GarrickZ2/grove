//! Folder selection and file reading API handlers

use axum::{extract::Query, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::api::error::ApiError;

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowseFolderResponse {
    pub path: Option<String>,
}

/// GET /api/v1/browse-folder - Open system folder picker dialog
pub async fn browse_folder() -> Json<BrowseFolderResponse> {
    // Use AppleScript on macOS to show folder picker
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

    // On Linux, try zenity or kdialog
    #[cfg(target_os = "linux")]
    {
        // Try zenity first
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

        // Try kdialog if zenity failed
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

    // User cancelled or command failed
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
