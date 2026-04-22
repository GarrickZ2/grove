//! Storage for Studio task Excalidraw sketches.
//!
//! Layout on disk, per task (Studio tasks keep their workdir at
//! `~/.grove/studios/<project_hash>/tasks/<slug>/`):
//!   <task-workdir>/sketch/
//!     ├── index.json
//!     └── sketch-<uuid>.excalidraw
//!
//! Placing sketches under the task workdir (alongside `input/`, `output/`,
//! `resource/`, `scripts/`) makes them directly visible to the user and
//! reachable by any agent that runs with cwd = task workdir.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};
use crate::storage::tasks;

/// Validate that `sketch_id` matches the `sketch-<uuid-v4>` shape so it cannot
/// escape the sketches directory via path separators or `..` components.
fn validate_sketch_id(sketch_id: &str) -> Result<()> {
    // sketch-<uuid-v4>. Parse the UUID strictly so nonsense like
    // "sketch-----------------------------------" (36 dashes, 43 chars) is
    // rejected even though it has no path separators.
    let Some(rest) = sketch_id.strip_prefix("sketch-") else {
        return Err(GroveError::storage("invalid sketch id"));
    };
    if uuid::Uuid::parse_str(rest).is_err() {
        return Err(GroveError::storage("invalid sketch id"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SketchMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SketchIndex {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub sketches: Vec<SketchMeta>,
}

impl Default for SketchIndex {
    fn default() -> Self {
        Self {
            version: default_version(),
            sketches: Vec::new(),
        }
    }
}

fn default_version() -> u32 {
    1
}

/// Resolve the task's working directory (the one the user sees in terminal,
/// containing `input/`, `output/`, etc. for Studio tasks; the git worktree for
/// regular tasks). Returns error if the task doesn't exist.
fn task_workdir(project: &str, task_id: &str) -> Result<PathBuf> {
    let task =
        tasks::get_task(project, task_id)?.ok_or_else(|| GroveError::storage("task not found"))?;
    Ok(PathBuf::from(task.worktree_path))
}

/// Compute the sketches directory path WITHOUT creating it. Use for read paths.
fn sketches_dir(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(task_workdir(project, task_id)?.join("sketch"))
}

/// Compute the sketches directory path and ensure it exists. Use for write paths.
fn sketches_dir_ensure(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = sketches_dir(project, task_id)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn index_path_in(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

/// Per-sketch subdirectory under `sketch/`. Contains `scene.excalidraw` and
/// optionally `thumb.png`. Keeps all files belonging to one sketch together so
/// deletion and enumeration are trivial.
fn sketch_dir_in(dir: &Path, sketch_id: &str) -> PathBuf {
    dir.join(sketch_id)
}

fn sketch_path_in(dir: &Path, sketch_id: &str) -> PathBuf {
    sketch_dir_in(dir, sketch_id).join("scene.excalidraw")
}

fn thumb_png_path_in(dir: &Path, sketch_id: &str) -> PathBuf {
    sketch_dir_in(dir, sketch_id).join("thumb.png")
}

/// Public accessor for the per-sketch working directory. Used by
/// `sketch_checkpoints` so it can colocate each sketch's checkpoint store
/// with the sketch's own files (`scene.excalidraw`, `thumb.png`). Returns
/// error if the task doesn't exist; does not create the directory.
pub fn sketch_subdir(project: &str, task_id: &str, sketch_id: &str) -> Result<PathBuf> {
    validate_sketch_id(sketch_id)?;
    Ok(sketch_dir_in(&sketches_dir(project, task_id)?, sketch_id))
}

static EMPTY_SCENE: Lazy<String> = Lazy::new(|| {
    serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "source": "grove",
        "elements": [],
        "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
        "files": {},
    })
    .to_string()
});

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn create_sketch(project: &str, task_id: &str, name: &str) -> Result<SketchMeta> {
    let id = format!("sketch-{}", uuid::Uuid::new_v4());
    debug_assert!(
        validate_sketch_id(&id).is_ok(),
        "generated id must validate"
    );
    let now = now_iso();
    let meta = SketchMeta {
        id: id.clone(),
        name: name.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    let dir = sketches_dir_ensure(project, task_id)?;
    std::fs::create_dir_all(sketch_dir_in(&dir, &id))?;
    std::fs::write(sketch_path_in(&dir, &id), EMPTY_SCENE.as_str())?;
    let mut index = load_index(project, task_id)?;
    index.sketches.push(meta.clone());
    save_index(project, task_id, &index)?;
    Ok(meta)
}

pub fn load_scene(project: &str, task_id: &str, sketch_id: &str) -> Result<String> {
    validate_sketch_id(sketch_id)?;
    let dir = sketches_dir(project, task_id)?;
    match std::fs::read_to_string(sketch_path_in(&dir, sketch_id)) {
        Ok(content) => Ok(content),
        // Translate "file missing" into a domain error so the REST handler
        // surfaces it as 400 ("sketch scene not found") instead of 500.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(GroveError::storage(format!(
            "sketch '{sketch_id}' scene file not found"
        ))),
        Err(e) => Err(e.into()),
    }
}

/// Persist the scene to disk. Touches `updated_at` in the index. File mtime
/// is the source of truth for "is the thumbnail stale?" — see
/// `load_thumbnail_if_fresh`.
pub fn save_scene(project: &str, task_id: &str, sketch_id: &str, content: &str) -> Result<()> {
    validate_sketch_id(sketch_id)?;
    // Require the sketch to exist in the index so a PUT with a random-but-
    // syntactically-valid uuid can't write an orphan scene file that no
    // listing would ever surface. `create_sketch` seeds the index before any
    // writer calls this, so legitimate flows are unaffected.
    let index = load_index(project, task_id)?;
    if !index.sketches.iter().any(|m| m.id == sketch_id) {
        return Err(GroveError::storage(format!(
            "sketch '{sketch_id}' not found — create it before saving a scene"
        )));
    }
    let dir = sketches_dir_ensure(project, task_id)?;
    std::fs::create_dir_all(sketch_dir_in(&dir, sketch_id))?;
    std::fs::write(sketch_path_in(&dir, sketch_id), content)?;
    touch_index(project, task_id, sketch_id)?;
    Ok(())
}

/// Persist a thumbnail PNG rendered from the scene. No version check — we
/// rely on file mtimes at read time (`load_thumbnail_if_fresh`) to decide
/// whether the thumb is up-to-date with the scene.
pub fn save_thumbnail(
    project: &str,
    task_id: &str,
    sketch_id: &str,
    png_bytes: &[u8],
) -> Result<()> {
    validate_sketch_id(sketch_id)?;
    let dir = sketches_dir_ensure(project, task_id)?;
    std::fs::create_dir_all(sketch_dir_in(&dir, sketch_id))?;
    std::fs::write(thumb_png_path_in(&dir, sketch_id), png_bytes)?;
    Ok(())
}

/// Load the thumbnail PNG, but only if its mtime is newer than (or equal to)
/// the scene file's mtime. Returns `None` when the thumb is missing, or when
/// the scene has been written more recently (stale thumb).
pub fn load_thumbnail_if_fresh(
    project: &str,
    task_id: &str,
    sketch_id: &str,
) -> Result<Option<Vec<u8>>> {
    validate_sketch_id(sketch_id)?;
    let dir = sketches_dir(project, task_id)?;
    let scene_path = sketch_path_in(&dir, sketch_id);
    let png_path = thumb_png_path_in(&dir, sketch_id);
    if !png_path.exists() || !scene_path.exists() {
        return Ok(None);
    }
    let scene_mtime = std::fs::metadata(&scene_path).and_then(|m| m.modified());
    let png_mtime = std::fs::metadata(&png_path).and_then(|m| m.modified());
    // Strict `>` — on filesystems with second-granularity mtimes (many Linux
    // FSes, NFS, SMB), a thumb written in the same second as a later scene
    // write would otherwise be accepted as fresh. `None` here falls back to
    // the grove-web render path on the next read, which is cheap.
    match (scene_mtime, png_mtime) {
        (Ok(s), Ok(p)) if p > s => Ok(Some(std::fs::read(&png_path)?)),
        _ => Ok(None),
    }
}

pub fn rename_sketch(project: &str, task_id: &str, sketch_id: &str, new_name: &str) -> Result<()> {
    validate_sketch_id(sketch_id)?;
    let mut index = load_index(project, task_id)?;
    let item = index
        .sketches
        .iter_mut()
        .find(|m| m.id == sketch_id)
        .ok_or_else(|| crate::error::GroveError::storage("sketch not found"))?;
    item.name = new_name.to_string();
    item.updated_at = now_iso();
    save_index(project, task_id, &index)?;
    Ok(())
}

pub fn delete_sketch(project: &str, task_id: &str, sketch_id: &str) -> Result<()> {
    validate_sketch_id(sketch_id)?;
    let dir = sketches_dir(project, task_id)?;
    let sub = sketch_dir_in(&dir, sketch_id);
    if sub.exists() {
        let _ = std::fs::remove_dir_all(&sub);
    }
    let mut index = load_index(project, task_id)?;
    index.sketches.retain(|m| m.id != sketch_id);
    save_index(project, task_id, &index)?;
    Ok(())
}

fn touch_index(project: &str, task_id: &str, sketch_id: &str) -> Result<()> {
    touch_index_at(project, task_id, sketch_id, &now_iso())
}

/// Internal helper that stamps `updated_at` with an explicit timestamp.
/// Extracted so tests can drive deterministic timestamps without sleeping.
fn touch_index_at(project: &str, task_id: &str, sketch_id: &str, ts: &str) -> Result<()> {
    let mut index = load_index(project, task_id)?;
    if let Some(item) = index.sketches.iter_mut().find(|m| m.id == sketch_id) {
        item.updated_at = ts.to_string();
    }
    save_index(project, task_id, &index)?;
    Ok(())
}

pub fn load_index(project: &str, task_id: &str) -> Result<SketchIndex> {
    let dir = sketches_dir(project, task_id)?;
    let path = index_path_in(&dir);
    if !path.exists() {
        return Ok(SketchIndex::default());
    }
    let content = std::fs::read_to_string(&path)?;
    let index = serde_json::from_str(&content)?;
    Ok(index)
}

pub fn save_index(project: &str, task_id: &str, index: &SketchIndex) -> Result<()> {
    let dir = sketches_dir_ensure(project, task_id)?;
    let path = index_path_in(&dir);
    let content = serde_json::to_string_pretty(index)?;
    std::fs::write(&path, content)?;
    Ok(())
}

/// Apply a patch to an existing Excalidraw scene.
/// `created` is a list of new element objects to append.
/// `updated` is a map of element id → partial patch object (shallow merge).
/// `deleted` is a list of element ids to remove.
pub fn apply_element_patch(
    project: &str,
    task_id: &str,
    sketch_id: &str,
    created: &[serde_json::Value],
    updated: &serde_json::Map<String, serde_json::Value>,
    deleted: &[String],
) -> Result<String> {
    validate_sketch_id(sketch_id)?;

    // Reject empty-string ids in `deleted`. Element `id`/`containerId` fields
    // that fail `.as_str()` default to "" during the retain filter below; an
    // empty string in `deleted` would then match every element with no id /
    // no containerId, wiping the sketch. `apply_draw` guards with
    // `!trimmed.is_empty()`; mirror that here.
    for (i, id) in deleted.iter().enumerate() {
        if id.is_empty() {
            return Err(GroveError::storage(format!(
                "deleted[{i}] is an empty string — every entry must be a real element id"
            )));
        }
    }

    // Validate `created`: each element must have a non-empty string `id`, and
    // ids must be unique within the batch. Mirrors `apply_draw` so the REST
    // PATCH path can't silently create anonymous or colliding elements.
    {
        let mut seen: std::collections::HashSet<&str> = Default::default();
        for (i, el) in created.iter().enumerate() {
            let id = el.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() {
                return Err(GroveError::storage(format!(
                    "created[{i}] is missing the required `id` field"
                )));
            }
            if !seen.insert(id) {
                return Err(GroveError::storage(format!(
                    "duplicate element id '{id}' in `created` — every element must have a unique id"
                )));
            }
        }
    }

    // Validate `updated`: each patch value must be a JSON object. Non-objects
    // would be silently dropped during the shallow merge below, which is a
    // confusing no-op; surface it as an error instead.
    for (id, patch) in updated.iter() {
        if !patch.is_object() {
            return Err(GroveError::storage(format!(
                "updated['{id}'] must be a JSON object, got {}",
                if patch.is_null() {
                    "null"
                } else if patch.is_array() {
                    "array"
                } else if patch.is_string() {
                    "string"
                } else if patch.is_number() {
                    "number"
                } else if patch.is_boolean() {
                    "boolean"
                } else {
                    "non-object"
                }
            )));
        }
    }

    let raw = load_scene(project, task_id, sketch_id)?;
    let mut scene: serde_json::Value = serde_json::from_str(&raw)?;
    let elements = scene
        .get_mut("elements")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| crate::error::GroveError::storage("scene.elements missing"))?;

    // Reject `updated` keys that don't match any existing element — silently
    // no-op'ing on a typo'd id is the worst possible DX (AI gets a 204 and
    // wonders why nothing changed). Check against the full scene ids, NOT
    // the post-delete set: updating and deleting the same id in one patch
    // is nonsensical, so also reject that.
    if !updated.is_empty() {
        let scene_ids: std::collections::HashSet<&str> = elements
            .iter()
            .filter_map(|el| el.get("id").and_then(|v| v.as_str()))
            .collect();
        for id in updated.keys() {
            if !scene_ids.contains(id.as_str()) {
                return Err(GroveError::storage(format!(
                    "updated['{id}'] does not match any element in the scene — check the id or call GET to refresh"
                )));
            }
            if deleted.iter().any(|d| d == id) {
                return Err(GroveError::storage(format!(
                    "id '{id}' appears in both `updated` and `deleted` — pick one"
                )));
            }
        }
    }

    // Reject `created` ids that collide with surviving elements (after deletes).
    {
        let surviving_ids: std::collections::HashSet<&str> = elements
            .iter()
            .filter_map(|el| {
                let id = el.get("id").and_then(|v| v.as_str())?;
                let container_id = el.get("containerId").and_then(|v| v.as_str()).unwrap_or("");
                let will_delete = deleted.iter().any(|d| d == id || d == container_id);
                (!will_delete).then_some(id)
            })
            .collect();
        for el in created.iter() {
            let id = el.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if surviving_ids.contains(id) {
                return Err(GroveError::storage(format!(
                    "created element id '{id}' conflicts with an existing element. Include it in `deleted` first, or pick a fresh id."
                )));
            }
        }
    }

    // Deletes — also strip bound-text elements whose `containerId` matches a
    // deleted id (mirrors `apply_draw`). Without this, deleting a labeled
    // rectangle via patch leaves the label text orphaned on the canvas.
    elements.retain(|el| {
        let id = el
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let container_id = el
            .get("containerId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        !deleted.iter().any(|d| d == id || d == container_id)
    });

    // Updates (shallow merge of provided fields)
    for el in elements.iter_mut() {
        let id = el
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(String::from);
        if let Some(id) = id {
            if let Some(patch) = updated.get(&id) {
                if let (Some(el_obj), Some(patch_obj)) = (el.as_object_mut(), patch.as_object()) {
                    for (k, v) in patch_obj.iter() {
                        el_obj.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }

    // Creates
    for el in created {
        elements.push(el.clone());
    }

    // Backfill `boundElements` on containers referenced by arrow bindings —
    // keeps the patch path consistent with `apply_draw` so arrows stay
    // draggable regardless of which entry point wrote them.
    backfill_bound_elements(elements);

    let out = serde_json::to_string(&scene)?;
    save_scene(project, task_id, sketch_id, &out)?;
    Ok(out)
}

/// Overwrite a sketch's entire scene with the given JSON value. Used only by
/// tests to seed a known starting state; production writes go through
/// `save_scene` (REST) or `apply_draw` (MCP).
#[cfg(test)]
pub fn replace_scene(
    project: &str,
    task_id: &str,
    sketch_id: &str,
    scene: &serde_json::Value,
) -> Result<()> {
    validate_sketch_id(sketch_id)?;
    let body = serde_json::to_string(scene)?;
    save_scene(project, task_id, sketch_id, &body)?;
    Ok(())
}

/// Load a sketch scene as a parsed JSON value.
pub fn load_scene_value(
    project: &str,
    task_id: &str,
    sketch_id: &str,
) -> Result<serde_json::Value> {
    let raw = load_scene(project, task_id, sketch_id)?;
    Ok(serde_json::from_str(&raw)?)
}

/// For every arrow with a `startBinding` / `endBinding`, ensure the bound
/// container's `boundElements` array lists `{id: arrow.id, type: "arrow"}`.
/// Excalidraw needs this reverse index to drag arrows along with shapes;
/// AI-generated scenes routinely omit it, so we fix it up server-side on
/// every save. Idempotent — repeated calls over the same scene leave it
/// unchanged.
fn backfill_bound_elements(elements: &mut [serde_json::Value]) {
    // First pass: collect (container_id → arrow_id) pairs from arrow bindings.
    let mut pairs: Vec<(String, String)> = Vec::new();
    for el in elements.iter() {
        let t = el.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t != "arrow" {
            continue;
        }
        let arrow_id = match el.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        for key in ["startBinding", "endBinding"] {
            if let Some(binding) = el.get(key) {
                if let Some(container_id) = binding.get("elementId").and_then(|v| v.as_str()) {
                    if !container_id.is_empty() {
                        pairs.push((container_id.to_string(), arrow_id.clone()));
                    }
                }
            }
        }
    }
    if pairs.is_empty() {
        return;
    }
    // Second pass: for each container mentioned, ensure its boundElements
    // includes an entry for every arrow that binds to it.
    for el in elements.iter_mut() {
        let Some(id) = el.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
            continue;
        };
        let wanted: Vec<&String> = pairs
            .iter()
            .filter_map(|(cid, aid)| if cid == &id { Some(aid) } else { None })
            .collect();
        if wanted.is_empty() {
            continue;
        }
        let Some(obj) = el.as_object_mut() else {
            continue;
        };
        let arr = obj
            .entry("boundElements".to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if !arr.is_array() {
            *arr = serde_json::Value::Array(Vec::new());
        }
        let arr = arr.as_array_mut().expect("checked above");
        let existing: std::collections::HashSet<String> = arr
            .iter()
            .filter_map(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
            .collect();
        for aid in wanted {
            if !existing.contains(aid) {
                arr.push(serde_json::json!({ "id": aid, "type": "arrow" }));
            }
        }
    }
}

/// Find a sketch by reference (accepts either a sketch id `sketch-<uuid>` or
/// a human-readable name). Returns `None` when nothing matches; errors when a
/// name is ambiguous (multiple sketches share it).
pub fn resolve_sketch_ref(
    project: &str,
    task_id: &str,
    reference: &str,
) -> Result<Option<SketchMeta>> {
    let index = load_index(project, task_id)?;
    if validate_sketch_id(reference).is_ok() {
        if let Some(m) = index.sketches.iter().find(|m| m.id == reference) {
            return Ok(Some(m.clone()));
        }
    }
    let matches: Vec<&SketchMeta> = index
        .sketches
        .iter()
        .filter(|m| m.name == reference)
        .collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0].clone())),
        _ => Err(GroveError::storage(format!(
            "multiple sketches named '{}' — use the sketch id to disambiguate",
            reference
        ))),
    }
}

/// Resolve a sketch by name, or create a new one if it doesn't exist.
pub fn get_or_create_by_name(project: &str, task_id: &str, name: &str) -> Result<SketchMeta> {
    if let Some(m) = resolve_sketch_ref(project, task_id, name)? {
        return Ok(m);
    }
    create_sketch(project, task_id, name)
}

/// Outcome of a successful `apply_draw` call.
#[derive(Debug, Clone)]
pub struct DrawOutcome {
    /// Newly minted checkpoint id — AI should pass this back via
    /// `restoreCheckpoint` on the next draw to continue.
    pub checkpoint_id: String,
    /// The final scene that was written to disk.
    pub scene: serde_json::Value,
    /// Element count after merge.
    pub element_count: usize,
    /// Number of new real elements contributed by this call.
    pub elements_added: usize,
    /// Number of elements removed by `delete` pseudo-elements.
    pub elements_deleted: usize,
    /// Non-fatal warnings (e.g. non-4:3 camera, font size too small).
    pub warnings: Vec<String>,
}

const MAX_DRAW_ELEMENT_COUNT: usize = 10_000;

/// Apply a draw call authored by an AI agent.
///
/// Grammar (inside the `elements` slice):
///   - `{"type":"restoreCheckpoint","id":"<cp>"}` — at most one; resolves base
///     from the checkpoint LRU. Absence = start from empty scene.
///   - `{"type":"delete","ids":"id1,id2"}` — removes ids (and any bound-text
///     whose `containerId` matches) from the base.
///   - `{"type":"cameraUpdate","x","y","width","height"}` — kept for the
///     widget to animate viewport; does not alter element set. Generates a
///     warning if aspect ratio isn't ~4:3.
///   - any other element (`rectangle` / `arrow` / `text` / …) — appended.
///
/// Returns a `DrawOutcome` with the merged scene and new checkpoint id; the
/// scene is already persisted and checkpointed before return.
pub fn apply_draw(
    project: &str,
    task_id: &str,
    sketch_id: &str,
    arr: &[serde_json::Value],
) -> Result<DrawOutcome> {
    validate_sketch_id(sketch_id)?;

    if arr.len() > MAX_DRAW_ELEMENT_COUNT {
        return Err(GroveError::storage(format!(
            "elements array exceeds {MAX_DRAW_ELEMENT_COUNT} item limit"
        )));
    }

    let mut restore_id: Option<String> = None;
    let mut delete_ids: std::collections::HashSet<String> = Default::default();
    let mut last_camera: Option<serde_json::Value> = None;
    let mut new_elements: Vec<serde_json::Value> = Vec::new();

    for (i, el) in arr.iter().enumerate() {
        let t = el.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "restoreCheckpoint" => {
                if restore_id.is_some() {
                    return Err(GroveError::storage(
                        "only one `restoreCheckpoint` pseudo-element is allowed per call",
                    ));
                }
                let id = el
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        GroveError::storage("`restoreCheckpoint` requires an `id` field")
                    })?
                    .to_string();
                restore_id = Some(id);
            }
            "delete" => {
                let ids = el
                    .get("ids")
                    .and_then(|v| v.as_str())
                    .or_else(|| el.get("id").and_then(|v| v.as_str()))
                    .ok_or_else(|| {
                        GroveError::storage(
                            "`delete` pseudo-element requires `ids` (comma-separated string)",
                        )
                    })?;
                for id in ids.split(',') {
                    let trimmed = id.trim();
                    if !trimmed.is_empty() {
                        delete_ids.insert(trimmed.to_string());
                    }
                }
            }
            "cameraUpdate" => {
                last_camera = Some(el.clone());
            }
            "" => {
                return Err(GroveError::storage(format!(
                    "element at index {i} is missing the required `type` field"
                )));
            }
            _ => {
                let id = el.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() {
                    return Err(GroveError::storage(format!(
                        "element at index {i} (type=\"{t}\") is missing the required `id` field"
                    )));
                }
                new_elements.push(el.clone());
            }
        }
    }

    // Reject duplicate ids among the new elements.
    {
        let mut seen: std::collections::HashSet<&str> = Default::default();
        for el in &new_elements {
            let id = el.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !seen.insert(id) {
                return Err(GroveError::storage(format!(
                    "duplicate element id '{id}' in input — every element must have a unique id"
                )));
            }
        }
    }

    // Resolve base scene. Checkpoints are scoped per-sketch — a checkpoint
    // from a different sketch won't resolve here by design, so the AI can't
    // accidentally (or deliberately) restore sketch A's content onto sketch B.
    let base_scene: Option<serde_json::Value> = match &restore_id {
        Some(cp_id) => {
            let loaded =
                crate::storage::sketch_checkpoints::load(project, task_id, sketch_id, cp_id)?;
            Some(loaded.ok_or_else(|| {
                GroveError::storage(format!(
                    "checkpoint '{cp_id}' not found for this sketch (expired, invalid, or belongs to a different sketch). Call grove_sketch_read to get a fresh checkpoint_id, or draw from scratch without `restoreCheckpoint`."
                ))
            })?)
        }
        None => None,
    };

    let base_elements: Vec<serde_json::Value> = base_scene
        .as_ref()
        .and_then(|v| v.get("elements"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let base_count = base_elements.len();

    // Apply `delete` to base.
    let base_after_delete: Vec<serde_json::Value> = base_elements
        .into_iter()
        .filter(|el| {
            let id = el.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let container_id = el.get("containerId").and_then(|v| v.as_str()).unwrap_or("");
            !delete_ids.contains(id) && !delete_ids.contains(container_id)
        })
        .collect();
    let elements_deleted = base_count - base_after_delete.len();

    // Reject id conflicts between surviving base and new elements.
    {
        let base_ids: std::collections::HashSet<&str> = base_after_delete
            .iter()
            .filter_map(|el| el.get("id").and_then(|v| v.as_str()))
            .collect();
        for el in &new_elements {
            let id = el.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if base_ids.contains(id) {
                return Err(GroveError::storage(format!(
                    "element id '{id}' conflicts with an existing element in the base. Include it in a `delete` pseudo-element first, or pick a fresh id."
                )));
            }
        }
    }

    let elements_added = new_elements.len();
    let mut merged: Vec<serde_json::Value> = base_after_delete;
    merged.extend(new_elements);

    // Auto-backfill `boundElements` on every container referenced by an
    // arrow's `startBinding` / `endBinding`. AI callers routinely forget
    // this reverse index even when they set the forward binding, and
    // Excalidraw needs BOTH sides for dragging the shape to move the arrow
    // with it. Running this on every draw (including inherited base
    // elements) keeps the invariant after cross-call edits too.
    backfill_bound_elements(&mut merged);

    // Build the final scene — preserve appState/files from whichever source we
    // have (current on-disk scene as fallback; checkpoint if restoring).
    let mut scene = serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "source": "grove",
        "elements": merged,
        "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
        "files": {},
    });

    // Prefer appState/files from the restored checkpoint if present; else from
    // the existing on-disk scene so user-side viewport/files aren't clobbered.
    let fallback_scene: Option<serde_json::Value> = base_scene
        .clone()
        .or_else(|| load_scene_value(project, task_id, sketch_id).ok());
    if let Some(fb) = fallback_scene {
        if let Some(v) = fb.get("appState") {
            scene["appState"] = v.clone();
        }
        if let Some(v) = fb.get("files") {
            scene["files"] = v.clone();
        }
    }

    // Persist scene to task workdir.
    save_scene(project, task_id, sketch_id, &serde_json::to_string(&scene)?)?;

    // Save a new checkpoint referencing the merged scene. Scoped to this
    // sketch so the History dialog can offer per-sketch restore.
    let checkpoint_id = crate::storage::sketch_checkpoints::generate_id();
    crate::storage::sketch_checkpoints::save(project, task_id, sketch_id, &checkpoint_id, &scene)?;

    // Compute warnings.
    let mut warnings = Vec::new();
    if let Some(cam) = last_camera {
        let w = cam.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let h = cam.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if w > 0.0 && h > 0.0 {
            let ratio = w / h;
            if (ratio - 4.0 / 3.0).abs() > 0.15 {
                warnings.push(format!(
                    "cameraUpdate used {}x{} (ratio {:.2}) — prefer 4:3 (e.g. 400x300, 800x600, 1200x900).",
                    w as i64, h as i64, ratio
                ));
            }
        }
    }

    let element_count = scene
        .get("elements")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(DrawOutcome {
        checkpoint_id,
        scene,
        element_count,
        elements_added,
        elements_deleted,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::grove_dir;
    use crate::storage::tasks::{save_tasks, Task, TaskStatus};
    use chrono::Utc;
    use uuid::Uuid;

    /// RAII guard: cleans up the per-test project dir and fake workdir even on panic.
    struct TestEnv {
        project: String,
        task_id: String,
        workdir: PathBuf,
    }

    impl TestEnv {
        fn new() -> Self {
            let project = format!("test-{}", Uuid::new_v4());
            let task_id = format!("task-{}", Uuid::new_v4());
            // Fake task workdir under the project dir so Drop cleans it too.
            let workdir = grove_dir().join("projects").join(&project).join("workdir");
            std::fs::create_dir_all(&workdir).unwrap();
            // Seed a Task so sketches can resolve worktree_path.
            let now = Utc::now();
            let task = Task {
                id: task_id.clone(),
                name: "test-task".to_string(),
                branch: "main".to_string(),
                target: "main".to_string(),
                worktree_path: workdir.to_string_lossy().to_string(),
                created_at: now,
                updated_at: now,
                status: TaskStatus::Active,
                multiplexer: "tmux".to_string(),
                session_name: String::new(),
                created_by: "user".to_string(),
                archived_at: None,
                code_additions: 0,
                code_deletions: 0,
                files_changed: 0,
                is_local: false,
            };
            save_tasks(&project, &[task]).unwrap();
            Self {
                project,
                task_id,
                workdir,
            }
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(grove_dir().join("projects").join(&self.project));
        }
    }

    #[test]
    fn load_index_returns_empty_when_missing() {
        let env = TestEnv::new();
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert_eq!(index.version, 1);
        assert!(index.sketches.is_empty());
    }

    #[test]
    fn load_index_does_not_create_directory() {
        let env = TestEnv::new();
        let _ = load_index(&env.project, &env.task_id).unwrap();
        let dir = env.workdir.join("sketch");
        assert!(
            !dir.exists(),
            "load_index on nonexistent task must not create sketch dir"
        );
    }

    #[test]
    fn save_then_load_index_roundtrip() {
        let env = TestEnv::new();
        let meta = SketchMeta {
            id: "sketch-abc".to_string(),
            name: "One".to_string(),
            created_at: "2026-04-17T00:00:00Z".to_string(),
            updated_at: "2026-04-17T00:00:00Z".to_string(),
        };
        save_index(
            &env.project,
            &env.task_id,
            &SketchIndex {
                version: 1,
                sketches: vec![meta.clone()],
            },
        )
        .unwrap();
        let loaded = load_index(&env.project, &env.task_id).unwrap();
        assert_eq!(loaded.sketches.len(), 1);
        assert_eq!(loaded.sketches[0].id, meta.id);
    }

    #[test]
    fn create_sketch_writes_empty_scene_and_updates_index() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "My sketch").unwrap();
        assert!(meta.id.starts_with("sketch-"));
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert_eq!(index.sketches.len(), 1);
        let scene = load_scene(&env.project, &env.task_id, &meta.id).unwrap();
        assert!(scene.contains("\"type\""));
        assert!(scene.contains("excalidraw"));
    }

    #[test]
    fn touch_index_at_updates_timestamp_deterministically() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "X").unwrap();
        let ts1 = "2026-04-17T00:00:00Z";
        let ts2 = "2026-04-17T00:00:05Z";
        touch_index_at(&env.project, &env.task_id, &meta.id, ts1).unwrap();
        let after1 = load_index(&env.project, &env.task_id).unwrap().sketches[0]
            .updated_at
            .clone();
        touch_index_at(&env.project, &env.task_id, &meta.id, ts2).unwrap();
        let after2 = load_index(&env.project, &env.task_id).unwrap().sketches[0]
            .updated_at
            .clone();
        assert_eq!(after1, ts1);
        assert_eq!(after2, ts2);
        assert_ne!(after1, after2);
    }

    #[test]
    fn save_scene_updates_index_timestamp() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "X").unwrap();
        save_scene(
            &env.project,
            &env.task_id,
            &meta.id,
            "{\"type\":\"excalidraw\",\"elements\":[]}",
        )
        .unwrap();
        // The public save_scene path should have stamped a non-empty updated_at.
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert!(!index.sketches[0].updated_at.is_empty());
        // Overwriting via the internal helper with a known later timestamp changes it.
        let new_ts = "2099-01-01T00:00:00Z";
        touch_index_at(&env.project, &env.task_id, &meta.id, new_ts).unwrap();
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert_eq!(index.sketches[0].updated_at, new_ts);
        assert_ne!(index.sketches[0].updated_at, meta.updated_at);
    }

    #[test]
    fn delete_sketch_removes_file_and_index_entry() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "gone").unwrap();
        delete_sketch(&env.project, &env.task_id, &meta.id).unwrap();
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert!(index.sketches.is_empty());
        let dir = sketches_dir(&env.project, &env.task_id).unwrap();
        assert!(!sketch_path_in(&dir, &meta.id).exists());
    }

    #[test]
    fn apply_patch_creates_updates_deletes() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "p").unwrap();
        // Seed one element
        let seed = serde_json::json!({
            "type": "excalidraw", "version": 2, "source": "grove",
            "elements": [{"id":"a","type":"rectangle","x":0,"y":0}],
            "appState": {}, "files": {}
        });
        replace_scene(&env.project, &env.task_id, &meta.id, &seed).unwrap();

        let mut updates = serde_json::Map::new();
        updates.insert("a".into(), serde_json::json!({"x": 42}));
        let creates = vec![serde_json::json!({"id":"b","type":"ellipse","x":10,"y":10})];
        let deletes: Vec<String> = vec![];
        apply_element_patch(
            &env.project,
            &env.task_id,
            &meta.id,
            &creates,
            &updates,
            &deletes,
        )
        .unwrap();

        let raw = load_scene(&env.project, &env.task_id, &meta.id).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let els = v["elements"].as_array().unwrap();
        assert_eq!(els.len(), 2);
        assert_eq!(els.iter().find(|e| e["id"] == "a").unwrap()["x"], 42);

        // Also verify deletion works
        let empty_updates = serde_json::Map::new();
        let empty_creates: Vec<serde_json::Value> = vec![];
        let dels = vec!["a".to_string()];
        apply_element_patch(
            &env.project,
            &env.task_id,
            &meta.id,
            &empty_creates,
            &empty_updates,
            &dels,
        )
        .unwrap();
        let raw2 = load_scene(&env.project, &env.task_id, &meta.id).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&raw2).unwrap();
        let els2 = v2["elements"].as_array().unwrap();
        assert_eq!(els2.len(), 1);
        assert_eq!(els2[0]["id"], "b");
    }

    #[test]
    fn load_scene_rejects_path_traversal() {
        let env = TestEnv::new();
        let err = load_scene(&env.project, &env.task_id, "../foo");
        assert!(err.is_err(), "path traversal sketch_id must be rejected");
    }

    #[test]
    fn rename_sketch_updates_index_only() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "Old").unwrap();
        rename_sketch(&env.project, &env.task_id, &meta.id, "New").unwrap();
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert_eq!(index.sketches[0].name, "New");
    }

    #[test]
    fn apply_draw_backfills_bound_elements_on_containers() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "arrows").unwrap();
        // Draw two rects and one arrow that binds to both — but deliberately
        // DO NOT set boundElements on the rects. The server should fill them in.
        let draw = vec![
            serde_json::json!({"type":"rectangle","id":"r1","x":0,"y":0,"width":100,"height":50}),
            serde_json::json!({"type":"rectangle","id":"r2","x":200,"y":0,"width":100,"height":50}),
            serde_json::json!({
                "type":"arrow","id":"a1","x":100,"y":25,"points":[[0,0],[100,0]],
                "startBinding":{"elementId":"r1","focus":0,"gap":1},
                "endBinding":{"elementId":"r2","focus":0,"gap":1},
            }),
        ];
        let outcome = apply_draw(&env.project, &env.task_id, &meta.id, &draw).unwrap();
        let scene = load_scene_value(&env.project, &env.task_id, &meta.id).unwrap();
        let els = scene["elements"].as_array().unwrap();
        let r1 = els.iter().find(|e| e["id"] == "r1").unwrap();
        let r2 = els.iter().find(|e| e["id"] == "r2").unwrap();
        let bound1 = r1["boundElements"].as_array().unwrap();
        let bound2 = r2["boundElements"].as_array().unwrap();
        assert_eq!(bound1.len(), 1);
        assert_eq!(bound1[0]["id"], "a1");
        assert_eq!(bound1[0]["type"], "arrow");
        assert_eq!(bound2.len(), 1);
        assert_eq!(bound2[0]["id"], "a1");

        // Replaying via restoreCheckpoint with no new elements must not
        // duplicate the boundElements entries (idempotent backfill).
        let draw2 = vec![serde_json::json!({
            "type": "restoreCheckpoint",
            "id": outcome.checkpoint_id,
        })];
        apply_draw(&env.project, &env.task_id, &meta.id, &draw2).unwrap();
        let scene = load_scene_value(&env.project, &env.task_id, &meta.id).unwrap();
        let els = scene["elements"].as_array().unwrap();
        let r1 = els.iter().find(|e| e["id"] == "r1").unwrap();
        assert_eq!(r1["boundElements"].as_array().unwrap().len(), 1);
    }
}
