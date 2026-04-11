//! Studio instructions and memory handlers

use axum::{extract::Path, http::StatusCode, Json};

use crate::api::error::ApiError;

use super::crud::resolve_studio_dir;
use super::types::*;

/// GET /api/v1/projects/{id}/instructions
pub async fn get_instructions(
    Path(id): Path<String>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("instructions.md");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read instructions: {}", e),
                }),
            ))
        }
    };
    Ok(Json(InstructionsResponse { content }))
}

/// PUT /api/v1/projects/{id}/instructions
pub async fn update_instructions(
    Path(id): Path<String>,
    Json(body): Json<InstructionsUpdateRequest>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("instructions.md");
    std::fs::write(&path, &body.content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to write instructions: {}", e),
            }),
        )
    })?;
    Ok(Json(InstructionsResponse {
        content: body.content,
    }))
}

/// GET /api/v1/projects/{id}/memory
pub async fn get_memory(
    Path(id): Path<String>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("memory.md");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read memory: {}", e),
                }),
            ))
        }
    };
    Ok(Json(InstructionsResponse { content }))
}

/// PUT /api/v1/projects/{id}/memory
pub async fn update_memory(
    Path(id): Path<String>,
    Json(body): Json<InstructionsUpdateRequest>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("memory.md");
    std::fs::write(&path, &body.content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to write memory: {}", e),
            }),
        )
    })?;
    Ok(Json(InstructionsResponse {
        content: body.content,
    }))
}
