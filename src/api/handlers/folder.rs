//! Folder selection API handler

use axum::Json;
use serde::{Deserialize, Serialize};
use std::process::Command;

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
