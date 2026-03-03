//! Update check API handler

use axum::Json;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::Mutex;

use crate::storage::config::{load_config, save_config};
use crate::update::{check_for_updates, UpdateInfo as InternalUpdateInfo};

#[derive(Serialize)]
pub struct UpdateCheckResponse {
    /// Current version
    pub current_version: String,
    /// Latest available version (None if check failed)
    pub latest_version: Option<String>,
    /// Whether an update is available
    pub has_update: bool,
    /// Installation method
    pub install_method: String,
    /// Update command to run
    pub update_command: String,
    /// When the check was performed (RFC 3339 format)
    pub check_time: Option<String>,
}

impl From<InternalUpdateInfo> for UpdateCheckResponse {
    fn from(info: InternalUpdateInfo) -> Self {
        Self {
            current_version: info.current_version.clone(),
            latest_version: info.latest_version.clone(),
            has_update: info.has_update(),
            install_method: format!("{:?}", info.install_method),
            update_command: info.update_command().to_string(),
            check_time: info
                .check_time
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        }
    }
}

/// GET /api/v1/update-check
///
/// Check for available updates.
/// - Uses 24-hour cache to avoid frequent API calls
/// - Returns current version, latest version, and update instructions
pub async fn check_update() -> Json<UpdateCheckResponse> {
    // Read cached update info from config
    let config = load_config();
    let cached_version = config.update.latest_version.as_deref();
    let last_check = config.update.last_check.as_deref();

    // Perform update check (with caching)
    let update_info = check_for_updates(cached_version, last_check);

    // Update config cache if we performed a fresh check
    if let (Some(latest), Some(check_time)) = (&update_info.latest_version, &update_info.check_time)
    {
        let mut config = load_config();
        config.update.latest_version = Some(latest.clone());
        config.update.last_check =
            Some(check_time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        let _ = save_config(&config);
    }

    Json(update_info.into())
}

// ── In-app update (AppBundle mode only) ──────────────────────────────────────

/// Download/install stage for in-app updates
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateStage {
    Idle,
    Downloading,
    Ready,
    Installing,
    Error,
}

/// Global progress state for in-app downloads
#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateProgress {
    pub stage: AppUpdateStage,
    pub downloaded: u64,
    pub total: u64,
    pub version: Option<String>,
    pub error: Option<String>,
}

impl Default for AppUpdateProgress {
    fn default() -> Self {
        Self {
            stage: AppUpdateStage::Idle,
            downloaded: 0,
            total: 0,
            version: None,
            error: None,
        }
    }
}

static UPDATE_PROGRESS: Lazy<Mutex<AppUpdateProgress>> =
    Lazy::new(|| Mutex::new(AppUpdateProgress::default()));

/// GitHub Release asset entry
#[derive(serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// GitHub Release API response (with assets)
#[derive(serde::Deserialize)]
struct GitHubReleaseWithAssets {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

/// Download the update binary in a blocking thread, tracking progress.
/// Returns the version tag on success.
fn fetch_and_download_update() -> Result<String, String> {
    const GITHUB_API_URL: &str = "https://api.github.com/repos/GarrickZ2/grove/releases/latest";

    let response = ureq::get(GITHUB_API_URL)
        .set("User-Agent", "grove-rs")
        .set("Accept", "application/vnd.github.v3+json")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("Failed to fetch release info: {e}"))?;

    let release: GitHubReleaseWithAssets = response
        .into_json()
        .map_err(|e| format!("Failed to parse release info: {e}"))?;

    let arch_str = match std::env::consts::ARCH {
        "aarch64" => "aarch64-apple-darwin",
        "x86_64" => "x86_64-apple-darwin",
        other => return Err(format!("Unsupported architecture: {other}")),
    };

    let asset = release
        .assets
        .iter()
        .find(|a| a.name.contains(arch_str) && a.name.ends_with(".tar.gz"))
        .ok_or_else(|| format!("No asset found for arch: {arch_str}"))?;

    let download_url = asset.browser_download_url.clone();
    let version = release.tag_name.clone();

    // Seed version into progress before download starts
    {
        let mut prog = UPDATE_PROGRESS.lock().unwrap();
        prog.version = Some(version.clone());
    }

    let dl_response = ureq::get(&download_url)
        .set("User-Agent", "grove-rs")
        .call()
        .map_err(|e| format!("Failed to start download: {e}"))?;

    let total = dl_response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    {
        let mut prog = UPDATE_PROGRESS.lock().unwrap();
        prog.total = total;
    }

    let mut reader = dl_response.into_reader();
    let mut file = std::fs::File::create("/tmp/grove-update.tar.gz")
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut buf = [0u8; 16384];
    let mut downloaded = 0u64;

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Download error: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Write error: {e}"))?;
        downloaded += n as u64;
        UPDATE_PROGRESS.lock().unwrap().downloaded = downloaded;
    }

    Ok(version)
}

/// POST /api/v1/app-update/start
///
/// Begin downloading the latest Grove release in the background.
/// Only applicable when running as a macOS .app bundle.
pub async fn start_app_update() -> Json<serde_json::Value> {
    // Reject if already downloading
    {
        let prog = UPDATE_PROGRESS.lock().unwrap();
        if prog.stage == AppUpdateStage::Downloading {
            return Json(serde_json::json!({"ok": false, "error": "Download already in progress"}));
        }
    }

    // Reset progress and mark as downloading
    *UPDATE_PROGRESS.lock().unwrap() = AppUpdateProgress {
        stage: AppUpdateStage::Downloading,
        ..Default::default()
    };

    // Spawn blocking download task
    tokio::task::spawn_blocking(|| match fetch_and_download_update() {
        Ok(version) => {
            let mut prog = UPDATE_PROGRESS.lock().unwrap();
            prog.stage = AppUpdateStage::Ready;
            prog.version = Some(version);
        }
        Err(e) => {
            let mut prog = UPDATE_PROGRESS.lock().unwrap();
            prog.stage = AppUpdateStage::Error;
            prog.error = Some(e);
        }
    });

    Json(serde_json::json!({"ok": true}))
}

/// GET /api/v1/app-update/progress
///
/// Return current download/install progress.
pub async fn get_app_update_progress() -> Json<AppUpdateProgress> {
    Json(UPDATE_PROGRESS.lock().unwrap().clone())
}

/// POST /api/v1/app-update/install
///
/// Extract the downloaded binary, write a helper script, and restart the app.
/// The process exits after spawning the helper script.
pub async fn install_app_update() -> Json<serde_json::Value> {
    // Verify the download is ready
    {
        let prog = UPDATE_PROGRESS.lock().unwrap();
        if prog.stage != AppUpdateStage::Ready {
            return Json(serde_json::json!({"ok": false, "error": "Update not ready"}));
        }
    }

    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            let mut prog = UPDATE_PROGRESS.lock().unwrap();
            prog.stage = AppUpdateStage::Error;
            prog.error = Some(format!("Cannot determine executable path: {e}"));
            return Json(
                serde_json::json!({"ok": false, "error": "Cannot determine executable path"}),
            );
        }
    };
    let current_exe_str = current_exe.to_string_lossy().to_string();

    UPDATE_PROGRESS.lock().unwrap().stage = AppUpdateStage::Installing;

    // Extract the archive to a temp directory
    let _ = std::fs::create_dir_all("/tmp/grove-update-extract");
    let extract_out = std::process::Command::new("tar")
        .args([
            "-xzf",
            "/tmp/grove-update.tar.gz",
            "-C",
            "/tmp/grove-update-extract",
            "--strip-components=1",
        ])
        .output();

    match extract_out {
        Err(e) => {
            let mut prog = UPDATE_PROGRESS.lock().unwrap();
            prog.stage = AppUpdateStage::Error;
            prog.error = Some(format!("Extraction failed: {e}"));
            return Json(serde_json::json!({"ok": false, "error": "Extraction failed"}));
        }
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let mut prog = UPDATE_PROGRESS.lock().unwrap();
            prog.stage = AppUpdateStage::Error;
            prog.error = Some(format!("Extraction error: {stderr}"));
            return Json(serde_json::json!({"ok": false, "error": "Extraction failed"}));
        }
        _ => {}
    }

    if let Err(e) = std::fs::copy(
        "/tmp/grove-update-extract/grove",
        "/tmp/grove-update-binary",
    ) {
        let mut prog = UPDATE_PROGRESS.lock().unwrap();
        prog.stage = AppUpdateStage::Error;
        prog.error = Some(format!("Failed to copy binary: {e}"));
        return Json(serde_json::json!({"ok": false, "error": "Failed to copy binary"}));
    }

    // Write the helper script that replaces the binary and re-opens the app
    let script = format!(
        "#!/bin/bash\n\
         sleep 1\n\
         cp /tmp/grove-update-binary {exe}\n\
         chmod +x {exe}\n\
         open /Applications/Grove.app\n\
         rm -rf /tmp/grove-update-binary /tmp/grove-update.tar.gz /tmp/grove-update-extract\n\
         rm -f \"$0\"\n",
        exe = current_exe_str
    );

    if let Err(e) = std::fs::write("/tmp/grove-updater.sh", &script) {
        let mut prog = UPDATE_PROGRESS.lock().unwrap();
        prog.stage = AppUpdateStage::Error;
        prog.error = Some(format!("Failed to write updater script: {e}"));
        return Json(serde_json::json!({"ok": false, "error": "Failed to write updater script"}));
    }

    let _ = std::process::Command::new("chmod")
        .args(["+x", "/tmp/grove-updater.sh"])
        .output();

    let _ = std::process::Command::new("bash")
        .arg("/tmp/grove-updater.sh")
        .spawn();

    // Give the HTTP response time to reach the client before we exit
    tokio::spawn(async {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        std::process::exit(0);
    });

    Json(serde_json::json!({"ok": true}))
}
