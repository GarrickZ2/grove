//! REST handlers for Studio task sketches.

use axum::{
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::storage::sketches;

use super::super::common::find_project_by_id;
use super::sketch_events::{broadcast_sketch_event, SketchEvent, SketchEventSource};

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

#[derive(Debug, Deserialize)]
pub struct UpdateSceneRequest {
    /// Full Excalidraw scene JSON. Must be a JSON object.
    pub scene: serde_json::Value,
}

pub async fn get_scene(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
) -> Result<Response, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    let body = sketches::load_scene(&project_key, &task_id, &sketch_id)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response())
}

pub async fn put_scene(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
    Json(req): Json<UpdateSceneRequest>,
) -> Result<StatusCode, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    let body = serde_json::to_string(&req.scene).map_err(internal)?;
    sketches::save_scene(&project_key, &task_id, &sketch_id, &body).map_err(internal)?;
    broadcast_sketch_event(SketchEvent::SketchUpdated {
        project: project_key,
        task_id,
        sketch_id,
        source: SketchEventSource::User,
    });
    Ok(StatusCode::NO_CONTENT)
}
