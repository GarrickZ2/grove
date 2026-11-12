//! REST handlers for Studio task sketches.

use axum::{
    body::Bytes,
    extract::Path,
    http::{header, HeaderMap, HeaderValue, StatusCode},
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

/// Serve the sketch's PNG render. Returns 404 when no thumbnail has been
/// generated yet (the canvas only uploads on edit, debounced 2s); callers
/// (markdown preview) treat 404 as "fall back to plain text". Slightly stale
/// thumbs are served as-is — visual preview tolerates the lag.
pub async fn get_sketch_thumbnail(
    Path((id, task_id, sketch_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;
    let Some((bytes, mtime)) =
        sketches::load_thumbnail(&project_key, &task_id, &sketch_id).map_err(internal)?
    else {
        return Err(StatusCode::NOT_FOUND);
    };
    // Weak ETag from sketch_id + mtime epoch + length so the browser can
    // 304 between markdown re-renders. Including `sketch_id` prevents the
    // (admittedly unlikely) ETag collision where two sketches happen to
    // share both byte length and mtime second. We propagate mtime errors
    // as 500 instead of silently falling back to UNIX_EPOCH — a clock
    // reading "0" would make every render share an ETag.
    let mtime_secs = mtime
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(internal)?;
    let etag = format!("W/\"{}-{}-{}\"", sketch_id, mtime_secs, bytes.len());
    if let Some(req_etag) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        if req_etag == etag {
            return Ok(StatusCode::NOT_MODIFIED.into_response());
        }
    }
    let mut resp = (StatusCode::OK, bytes).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=0, must-revalidate"),
    );
    Ok(resp)
}

// ── Comments ────────────────────────────────────────────────────────────────
//
// A comment on a sketch is a review comment on `sketch/<sketch-id>`, with the
// element it is on (or the canvas point) kept in `anchor_text`. Replies,
// resolving and `grove_reply_review` work on it as on any review comment.

/// `sketch/<sketch-id>` → the sketch id.
pub fn split_sketch_path(path: &str) -> Option<&str> {
    let id = path.strip_prefix("sketch/")?;
    sketches::is_valid_sketch_id(id).then_some(id)
}

#[derive(Debug, Serialize)]
pub struct SketchCommentReply {
    id: u32,
    author: String,
    content: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct SketchComment {
    id: u32,
    sketch: String,
    /// The element (`element`, its `text`) and the canvas point (`x`, `y`)
    /// the comment is on.
    anchor: serde_json::Value,
    author: String,
    content: String,
    timestamp: String,
    status: &'static str,
    via_share: bool,
    replies: Vec<SketchCommentReply>,
}

impl SketchComment {
    pub fn sketch(&self) -> &str {
        &self.sketch
    }

    pub fn is_open(&self) -> bool {
        self.status == "open"
    }

    /// The comment for an agent: id, who, where on the sketch, what was said.
    pub fn describe(&self) -> String {
        let mut out = format!(
            "- #{} by {} on {}",
            self.id,
            self.author,
            describe_place(&self.anchor)
        );
        out.push_str(&format!(": {}\n", self.content));
        for reply in &self.replies {
            out.push_str(&format!("  - {}: {}\n", reply.author, reply.content));
        }
        out
    }
}

/// Where a comment is, for an agent: its elements by id, type and text, or
/// the area dragged out and what it holds.
fn describe_place(anchor: &serde_json::Value) -> String {
    use serde_json::Value;
    let items: Vec<String> = anchor
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?;
                    let kind = item
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("element");
                    Some(match item.get("text").and_then(Value::as_str) {
                        Some(text) if !text.is_empty() => format!("`{id}` ({kind}, \"{text}\")"),
                        _ => format!("`{id}` ({kind})"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut list = items
        .iter()
        .take(20)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if items.len() > 20 {
        list.push_str(&format!(", and {} more", items.len() - 20));
    }
    let area = anchor.get("area").and_then(Value::as_bool).unwrap_or(false);
    let side = |key: &str| {
        anchor
            .get("box")
            .and_then(|b| b.get(key))
            .and_then(Value::as_f64)
            .map(f64::round)
    };
    if area {
        if let (Some(x), Some(y), Some(w), Some(h)) =
            (side("x"), side("y"), side("width"), side("height"))
        {
            let place = format!("the area x={x} y={y} w={w} h={h}");
            return if items.is_empty() {
                format!("{place}, which is empty")
            } else {
                format!("{place}, which holds {list}")
            };
        }
    }
    match items.len() {
        0 => "the sketch".to_string(),
        1 => format!("the element {list}"),
        _ => format!("the elements {list}"),
    }
}

/// Comments on the task's sketches that still exist, oldest first.
pub fn sketch_comments(project: &str, task_id: &str) -> Result<Vec<SketchComment>, GroveError> {
    use crate::storage::comments;
    let live: std::collections::HashSet<String> = sketches::load_index(project, task_id)?
        .sketches
        .into_iter()
        .map(|meta| meta.id)
        .collect();
    let shared = comments::share_comment_visitors(project, task_id).unwrap_or_default();
    Ok(comments::load_comments(project, task_id)?
        .comments
        .into_iter()
        .filter_map(|comment| {
            let sketch = split_sketch_path(comment.file_path.as_deref()?)?.to_string();
            if !live.contains(&sketch) {
                return None;
            }
            Some(SketchComment {
                id: comment.id,
                sketch,
                anchor: comment
                    .anchor_text
                    .as_deref()
                    .and_then(|text| serde_json::from_str(text).ok())
                    .unwrap_or(serde_json::Value::Null),
                author: comments::build_author(&comment.agent, &comment.role),
                content: comment.content,
                timestamp: comment.timestamp,
                status: match comment.status {
                    comments::CommentStatus::Resolved => "resolved",
                    _ => "open",
                },
                via_share: shared.contains_key(&comment.id),
                replies: comment
                    .replies
                    .into_iter()
                    .map(|reply| SketchCommentReply {
                        id: reply.id,
                        author: comments::build_author(&reply.agent, &reply.role),
                        content: reply.content,
                        timestamp: reply.timestamp,
                    })
                    .collect(),
            })
        })
        .collect())
}

fn sketch_comments_json(
    project: &str,
    task_id: &str,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let list = sketch_comments(project, task_id).map_err(scene_error_response)?;
    Ok(Json(serde_json::json!({
        "comments": list,
        "me": super::crud::get_git_user_name(project, task_id),
    })))
}

/// GET /projects/{id}/tasks/{taskId}/sketches/comments
pub async fn list_sketch_comments(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_project, project_key) = find_project_by_id(&id).map_err(project_err)?;
    sketch_comments_json(&project_key, &task_id)
}

#[derive(Debug, Deserialize)]
pub struct NewSketchComment {
    sketch: String,
    #[serde(default)]
    anchor: serde_json::Value,
    content: String,
}

const SKETCH_COMMENT_LIMIT: usize = 10_000;

/// POST /projects/{id}/tasks/{taskId}/sketches/comments
pub async fn create_sketch_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(request): Json<NewSketchComment>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    use crate::storage::comments;
    let (_project, project_key) = find_project_by_id(&id).map_err(project_err)?;
    let content = request.content.trim();
    if content.is_empty() || content.chars().count() > SKETCH_COMMENT_LIMIT {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("A comment needs 1 to {SKETCH_COMMENT_LIMIT} characters"),
        ));
    }
    if !sketch_exists(&project_key, &task_id, &request.sketch) {
        return Err((StatusCode::NOT_FOUND, "Sketch not found".to_string()));
    }
    let author =
        super::crud::get_git_user_name(&project_key, &task_id).unwrap_or_else(|| "You".to_string());
    let (agent, role) = comments::parse_author_to_agent_role(&author);
    comments::add_comment(
        &project_key,
        &task_id,
        comments::CommentType::File,
        Some(format!("sketch/{}", request.sketch)),
        None,
        None,
        None,
        content,
        &agent,
        "",
        &role,
        super::designs::anchor_text(&request.anchor),
    )
    .map_err(scene_error_response)?;
    sketch_comments_json(&project_key, &task_id)
}

/// Whether the task has a sketch with this id.
pub fn sketch_exists(project: &str, task_id: &str, sketch_id: &str) -> bool {
    sketches::is_valid_sketch_id(sketch_id)
        && sketches::load_index(project, task_id)
            .is_ok_and(|index| index.sketches.iter().any(|meta| meta.id == sketch_id))
}

#[cfg(test)]
mod comment_tests {
    use super::*;

    #[test]
    fn sketch_paths() {
        let id = "sketch-550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(split_sketch_path(&format!("sketch/{id}")), Some(id));
        assert_eq!(split_sketch_path("sketch/../x"), None);
        assert_eq!(split_sketch_path("design/a/b.html"), None);
        assert_eq!(split_sketch_path(&format!("sketch/{id}/scene")), None);
    }

    fn comment(anchor: serde_json::Value) -> SketchComment {
        SketchComment {
            id: 7,
            sketch: "sketch-x".into(),
            anchor,
            author: "Ann".into(),
            content: "Bigger".into(),
            timestamp: String::new(),
            status: "open",
            via_share: false,
            replies: vec![SketchCommentReply {
                id: 1,
                author: "Bob".into(),
                content: "Agree".into(),
                timestamp: String::new(),
            }],
        }
    }

    #[test]
    fn describes_comments_for_the_agent() {
        let on_elements = comment(serde_json::json!({
            "items": [{"id": "r1", "type": "rectangle", "text": "Sign in"}, {"id": "a1", "type": "arrow"}],
            "box": {"x": 0, "y": 0, "width": 10, "height": 10},
        }));
        assert_eq!(
            on_elements.describe(),
            "- #7 by Ann on the elements `r1` (rectangle, \"Sign in\"), `a1` (arrow): Bigger\n  - Bob: Agree\n"
        );
        let area = comment(serde_json::json!({
            "items": [], "area": true, "box": {"x": 10.4, "y": -3.6, "width": 200, "height": 80},
        }));
        assert!(area
            .describe()
            .starts_with("- #7 by Ann on the area x=10 y=-4 w=200 h=80, which is empty: Bigger"));
        assert!(comment(serde_json::Value::Null)
            .describe()
            .contains(" on the sketch: "));
    }
}
