//! Update check API handler

use axum::Json;
use serde::Serialize;

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
