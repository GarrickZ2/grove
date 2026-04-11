//! Task notes handlers

use axum::{extract::Path, http::StatusCode, Json};

use crate::storage::notes;

use super::crud::find_project_by_id;
use super::types::*;

/// GET /api/v1/projects/{id}/tasks/{taskId}/notes
pub async fn get_notes(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<NotesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let content =
        notes::load_notes(&project_key, &task_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(NotesResponse { content }))
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/notes
pub async fn update_notes(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<UpdateNotesRequest>,
) -> Result<Json<NotesResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    notes::save_notes(&project_key, &task_id, &req.content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(NotesResponse {
        content: req.content,
    }))
}
