//! REST handlers for Studio task sketches.

use axum::{extract::Path, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::storage::sketches;

use super::super::common::find_project_by_id;
use super::sketch_events::{broadcast_sketch_event, SketchEvent};

#[derive(Debug, Serialize)]
pub struct SketchListResponse {
    pub sketches: Vec<sketches::SketchMeta>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSketchRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameSketchRequest {
    pub name: String,
}

fn internal<E: std::fmt::Display>(_e: E) -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
}

pub async fn list_sketches(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<SketchListResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    let index = sketches::load_index(&project_key, &task_id).map_err(internal)?;
    Ok(Json(SketchListResponse {
        sketches: index.sketches,
    }))
}

pub async fn create_sketch(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateSketchRequest>,
) -> Result<Json<sketches::SketchMeta>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    let meta = sketches::create_sketch(&project_key, &task_id, &req.name).map_err(internal)?;
    broadcast_sketch_event(SketchEvent::IndexChanged {
        project: project_key,
        task_id,
    });
    Ok(Json(meta))
}

pub async fn delete_sketch(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
) -> Result<StatusCode, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    sketches::delete_sketch(&project_key, &task_id, &sketch_id).map_err(internal)?;
    broadcast_sketch_event(SketchEvent::IndexChanged {
        project: project_key,
        task_id,
    });
    Ok(StatusCode::NO_CONTENT)
}

pub async fn rename_sketch(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
    Json(req): Json<RenameSketchRequest>,
) -> Result<StatusCode, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    sketches::rename_sketch(&project_key, &task_id, &sketch_id, &req.name).map_err(internal)?;
    broadcast_sketch_event(SketchEvent::IndexChanged {
        project: project_key,
        task_id,
    });
    Ok(StatusCode::NO_CONTENT)
}
