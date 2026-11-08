//! The Browser panel's computer tabs: each chat Session's latest screenshot.

use axum::extract::{Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::api::error::ApiError;
use crate::computer;

type TaskPath = Path<(String, String)>;

#[derive(Deserialize)]
pub struct ChatQuery {
    chat: String,
}

/// GET /api/v1/computer/{project}/{task}
pub async fn status(Path((project, task)): TaskPath) -> Json<Vec<computer::Shot>> {
    Json(computer::shots(&project, &task))
}

/// GET /api/v1/computer/{project}/{task}/screenshot?chat=
pub async fn screenshot(
    Path((project, task)): TaskPath,
    Query(query): Query<ChatQuery>,
) -> Response {
    match computer::screenshot(&project, &task, &query.chat) {
        Some((mime_type, bytes)) => (
            [
                (header::CONTENT_TYPE, mime_type),
                (header::CACHE_CONTROL, "no-store".to_string()),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// POST /api/v1/computer/{project}/{task}/close?chat= — stop showing a
/// Session's computer tab.
pub async fn close(
    Path((project, task)): TaskPath,
    Query(query): Query<ChatQuery>,
) -> Json<Vec<computer::Shot>> {
    computer::close(&project, &task, &query.chat);
    Json(computer::shots(&project, &task))
}

/// GET /api/v1/computer-permissions — what macOS lets Computer Use do on this
/// machine, as agent-desktop reports it. `null` elsewhere: other systems ask
/// for no such permissions.
pub async fn permissions(
) -> Result<Json<Option<computer::Permissions>>, (StatusCode, Json<ApiError>)> {
    if !cfg!(target_os = "macos") {
        return Ok(Json(None));
    }
    computer::permissions()
        .await
        .map(|permissions| Json(Some(permissions)))
        .map_err(ApiError::internal)
}

#[derive(Debug, serde::Deserialize)]
pub struct RequestPermission {
    permission: computer::Permission,
}

/// POST /api/v1/computer-permissions/request — ask macOS for one permission
/// and open its page in System Settings.
pub async fn request_permission(
    Json(body): Json<RequestPermission>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    computer::request_permission(body.permission)
        .await
        .map(|_| Json(serde_json::json!({})))
        .map_err(ApiError::internal)
}
