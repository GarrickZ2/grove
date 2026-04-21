//! REST handlers for Studio task sketches.

use axum::{
    body::Bytes,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::error::GroveError;
use crate::storage::sketches;

use super::super::common::find_project_by_id;
use super::sketch_events::{broadcast_sketch_event, SketchEvent, SketchEventSource};

/// Map a storage error from a scene write / patch into an HTTP response that
/// preserves the detailed message. `GroveError::Storage(_)` values are all
/// produced by our own validation paths (bad sketch id, missing/duplicate
/// element id, non-object update, empty-string delete, id conflict, scene
/// missing elements) and are client bugs → 400 with the message so the AI
/// agent / UI can self-correct. Everything else (I/O, JSON serde on disk
/// contents) is a real server failure → 500 without leaking internals.
fn scene_error_response(e: GroveError) -> (StatusCode, String) {
    match e {
        GroveError::Storage(msg) => (StatusCode::BAD_REQUEST, msg),
        other => {
            eprintln!("[sketches] server-side scene error: {other}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal server error".to_string(),
            )
        }
    }
}

/// Project lookup helper that attaches a default body message so 404/5xx
/// responses carry something more useful than an empty payload. Without this
/// the frontend's `extractErrorPayload` falls back to the bare status line.
fn project_err(status: StatusCode) -> (StatusCode, String) {
    (
        status,
        status
            .canonical_reason()
            .unwrap_or("request failed")
            .to_string(),
    )
}

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
) -> Result<StatusCode, (StatusCode, String)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(project_err)?;
    // Require an object scene with an `elements` array. Arbitrary JSON values
    // (null / numbers / bare arrays) would pass through raw and blow up on the
    // next read.
    if !req.scene.is_object()
        || req
            .scene
            .get("elements")
            .and_then(|v| v.as_array())
            .is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "scene must be a JSON object with an `elements` array".to_string(),
        ));
    }
    let body =
        serde_json::to_string(&req.scene).map_err(|e| scene_error_response(GroveError::from(e)))?;
    sketches::save_scene(&project_key, &task_id, &sketch_id, &body)
        .map_err(scene_error_response)?;
    broadcast_sketch_event(SketchEvent::SketchUpdated {
        project: project_key,
        task_id,
        sketch_id,
        source: SketchEventSource::User,
        scene: req.scene,
    });
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Default)]
pub struct PatchSceneRequest {
    #[serde(default)]
    pub created: Vec<serde_json::Value>,
    #[serde(default)]
    pub updated: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub deleted: Vec<String>,
}

pub async fn patch_scene(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
    Json(req): Json<PatchSceneRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(project_err)?;
    let body = sketches::apply_element_patch(
        &project_key,
        &task_id,
        &sketch_id,
        &req.created,
        &req.updated,
        &req.deleted,
    )
    // Client-side validation errors (missing id, duplicate id, non-object
    // update, id collision, empty-string delete) are `GroveError::Storage` →
    // 400 with message. Real server failures (I/O, on-disk JSON corruption)
    // stay 500.
    .map_err(scene_error_response)?;
    let scene: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| scene_error_response(GroveError::from(e)))?;
    broadcast_sketch_event(SketchEvent::SketchUpdated {
        project: project_key,
        task_id,
        sketch_id,
        source: SketchEventSource::User,
        scene,
    });
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
pub struct SketchHistoryEntry {
    pub id: String,
    pub ts: String,
    pub element_count: Option<usize>,
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SketchHistoryResponse {
    pub entries: Vec<SketchHistoryEntry>,
}

pub async fn list_sketch_history(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
) -> Result<Json<SketchHistoryResponse>, (StatusCode, String)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(project_err)?;
    let entries =
        crate::storage::sketch_checkpoints::list_entries(&project_key, &task_id, &sketch_id)
            .map_err(scene_error_response)?
            .into_iter()
            .map(|e| SketchHistoryEntry {
                id: e.id,
                ts: e.ts,
                element_count: e.element_count,
                label: e.label,
            })
            .collect();
    Ok(Json(SketchHistoryResponse { entries }))
}

#[derive(Debug, Deserialize)]
pub struct RestoreCheckpointRequest {
    pub checkpoint_id: String,
}

pub async fn restore_sketch_checkpoint(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
    Json(req): Json<RestoreCheckpointRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(project_err)?;
    let scene = crate::storage::sketch_checkpoints::load(
        &project_key,
        &task_id,
        &sketch_id,
        &req.checkpoint_id,
    )
    .map_err(scene_error_response)?
    .ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("checkpoint '{}' not found", req.checkpoint_id),
        )
    })?;
    if !scene.is_object() || scene.get("elements").and_then(|v| v.as_array()).is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "checkpoint payload is not a valid scene (missing `elements` array)".to_string(),
        ));
    }
    let body =
        serde_json::to_string(&scene).map_err(|e| scene_error_response(GroveError::from(e)))?;
    sketches::save_scene(&project_key, &task_id, &sketch_id, &body)
        .map_err(scene_error_response)?;
    // Broadcast as an agent-sourced update so connected clients hard-reload
    // the scene (matching AI-write behavior).
    broadcast_sketch_event(SketchEvent::SketchUpdated {
        project: project_key,
        task_id,
        sketch_id,
        source: SketchEventSource::Agent,
        scene,
    });
    Ok(StatusCode::NO_CONTENT)
}

/// PNG file signature (first 8 bytes). Rejecting non-PNG uploads prevents a
/// compromised client from storing arbitrary bytes that MCP would later hand
/// to the model as `image/png`.
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Accept a PNG thumbnail rendered by the web client. Staleness is detected
/// at MCP-read time via file mtime comparison (see `load_thumbnail_if_fresh`),
/// so we just write unconditionally here.
pub async fn upload_sketch_thumbnail(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    if body.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.len() < PNG_SIGNATURE.len() || body[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err(StatusCode::BAD_REQUEST);
    }
    sketches::save_thumbnail(&project_key, &task_id, &sketch_id, &body).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
