//! First-run setup: the tools Grove needs from this computer.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::setup_tools::{self, InstallError, Tool, ToolStatus};

#[derive(Debug, Serialize)]
pub struct ToolsResponse {
    pub tools: Vec<ToolStatus>,
}

/// GET /api/v1/setup/tools
pub async fn tools() -> Result<Json<ToolsResponse>, StatusCode> {
    let tools = tokio::task::spawn_blocking(setup_tools::status)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ToolsResponse { tools }))
}

/// POST /api/v1/setup/tools/{id}/install — start the install; poll `tools` for how it goes.
pub async fn install(Path(id): Path<String>) -> StatusCode {
    let Some(tool) = Tool::parse(&id) else {
        return StatusCode::NOT_FOUND;
    };
    match tokio::task::spawn_blocking(move || setup_tools::install(tool)).await {
        Ok(Ok(())) => StatusCode::ACCEPTED,
        Ok(Err(InstallError::NotRunnable)) => StatusCode::CONFLICT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
