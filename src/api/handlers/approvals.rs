//! A chat Session waiting for the user to let it use their browser or computer.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::api::error::ApiError;
use crate::session_approval::{self, Capability, Pending};

type TaskPath = Path<(String, String)>;

/// GET /api/v1/approvals/{project}/{task}
pub async fn pending(Path((project, task)): TaskPath) -> Json<Vec<Pending>> {
    Json(session_approval::pending(&project, &task))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideRequest {
    chat_id: String,
    capability: Capability,
    allow: bool,
}

/// POST /api/v1/approvals/{project}/{task}
pub async fn decide(
    Path((project, task)): TaskPath,
    Json(request): Json<DecideRequest>,
) -> Result<Json<Vec<Pending>>, (StatusCode, Json<ApiError>)> {
    session_approval::decide(
        &project,
        &task,
        &request.chat_id,
        request.capability,
        request.allow,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(session_approval::pending(&project, &task)))
}
