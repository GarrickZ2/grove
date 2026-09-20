//! Version API handler

use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationOwner {
    /// The backend process shares the user's machine and renders natively.
    Backend,
    /// The backend is headless; the attached GUI/browser renders locally.
    Client,
}

#[derive(Serialize)]
pub struct VersionResponse {
    pub version: String,
    /// Whether THIS backend process renders OS notifications (sound + banner)
    /// for a human at its own machine. Headless serving surfaces (`grove
    /// mobile`) report `false` so attached frontends — GUI remote window,
    /// browser tab — render notifications client-side instead, per the
    /// "notifications render where the human is" contract.
    pub renders_os_notifications: bool,
    /// Explicit notification ownership for new clients. The boolean above is
    /// retained for older frontends.
    pub notification_owner: NotificationOwner,
}

/// GET /api/v1/version
pub async fn get_version() -> Json<VersionResponse> {
    let renders_os_notifications = !crate::hooks::os_render_disabled();
    Json(VersionResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        renders_os_notifications,
        notification_owner: if renders_os_notifications {
            NotificationOwner::Backend
        } else {
            NotificationOwner::Client
        },
    })
}
