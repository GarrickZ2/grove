//! Version API handler

use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct VersionResponse {
    pub version: String,
    /// Whether THIS backend process renders OS notifications (sound + banner)
    /// for a human at its own machine. Headless serving surfaces (`grove
    /// mobile`) report `false` so attached frontends — GUI remote window,
    /// browser tab — render notifications client-side instead, per the
    /// "notifications render where the human is" contract.
    pub renders_os_notifications: bool,
}

/// GET /api/v1/version
pub async fn get_version() -> Json<VersionResponse> {
    Json(VersionResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        renders_os_notifications: !crate::hooks::os_render_disabled(),
    })
}
