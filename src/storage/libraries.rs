//! Global Excalidraw library storage.
//!
//! One file at `~/.grove/library.excalidrawlib`, shared across all projects,
//! tasks and sketches. Format is the standard Excalidraw library JSON
//! (`type: "excalidrawlib"`, `version: 2`, `libraryItems: [...]`).
//!
//! Writes are upsert-by-id: incoming items overwrite items with the same `id`
//! and new ids are appended. Items are never implicitly removed by absence.
//! Removal is via `reset` (wipe everything) — there is no single-item delete
//! by design, matching the Excalidraw library UX where "reset library" is the
//! delete primitive.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};
use crate::storage::grove_dir;

/// Serializes all read-modify-write operations on the single library file so
/// concurrent PUT requests don't lose each other's upserts.
static LIBRARY_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryItem {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub elements: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Pass-through for any extra fields Excalidraw adds in the future.
    /// `#[serde(flatten)]` on a `BTreeMap` swallows every unknown key on
    /// deserialize and re-emits it on serialize, so future Excalidraw schema
    /// additions are round-tripped silently — there is no `#[deny_unknown]`
    /// guard here, and we will not warn if Excalidraw introduces a field that
    /// needs first-class handling. Audit periodically against upstream.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryFile {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, rename = "libraryItems")]
    pub library_items: Vec<LibraryItem>,
}

impl Default for LibraryFile {
    fn default() -> Self {
        Self {
            kind: "excalidrawlib".to_string(),
            version: 2,
            source: Some("grove".to_string()),
            library_items: Vec::new(),
        }
    }
}

pub fn library_path() -> PathBuf {
    grove_dir().join("library.excalidrawlib")
}

/// Load the library from disk. Returns an empty library if the file doesn't
/// exist (first run / never installed anything). Tolerates a concurrent
/// `reset()` happening between the existence check and the read: a NotFound
/// error from the read is mapped back to the empty default rather than
/// surfacing as a 500 to the caller.
///
/// Also migrates Excalidraw v1 library files (`{ library: [[el,...], ...] }`)
/// to v2 (`{ libraryItems: [...] }`) on the fly so an old user-supplied file
/// doesn't appear as an empty library and doesn't get silently overwritten on
/// the next upsert. The install path always writes v2, so v1 files are only
/// possible from manual user placement or from a pre-feature legacy artifact.
pub fn load() -> Result<LibraryFile> {
    let path = library_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LibraryFile::default());
        }
        Err(e) => return Err(e.into()),
    };
    // First try the v2 shape. If `libraryItems` is missing AND the JSON has
    // a `library: [[...], ...]` array, fall back to v1→v2 migration.
    let mut file: LibraryFile = serde_json::from_str(&content)?;
    if file.library_items.is_empty() {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(v1) = raw.get("library").and_then(|v| v.as_array()) {
                file.library_items = v1
                    .iter()
                    .enumerate()
                    .filter_map(|(idx, elements)| {
                        let elements = elements.as_array()?.clone();
                        Some(LibraryItem {
                            id: format!("v1-disk-{idx}"),
                            status: Some("published".to_string()),
                            elements,
                            created: None,
                            // No name available — agent listing will mark as
                            // <unnamed>, matching the source format's reality.
                            name: None,
                            extra: Default::default(),
                        })
                    })
                    .collect();
                file.version = 2;
            }
        }
    }
    Ok(file)
}

/// Writes already-serialized JSON bytes. Caller serializes once so we don't
/// double-serialize (`to_vec_pretty` for size check, then `to_string_pretty`
/// here) which doubled CPU + memory on large libraries.
fn write_bytes(bytes: &[u8]) -> Result<()> {
    let path = library_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic-ish write: write to temp then rename so a crash mid-write
    // leaves either the old file or the new file, never a half-written one.
    let tmp = path.with_extension("excalidrawlib.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Flush kernel buffers to disk before the rename so a power loss
        // between rename and writeback can't leave a zero-byte file in place
        // of the previous good library.
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Merge incoming items into the stored library. Items with an existing `id`
/// overwrite the prior copy; new ids are appended. Items NOT in the incoming
/// payload are preserved (no implicit deletion).
pub fn upsert(incoming: Vec<LibraryItem>) -> Result<LibraryFile> {
    /// Per-item upper bound on `elements`. A real Excalidraw item is dozens
    /// of shapes at most; anything larger is either malformed or hostile
    /// (a single library item could otherwise inflate every agent prompt).
    const MAX_ELEMENTS_PER_ITEM: usize = 500;
    /// Cap total stored library items. The "Add to Excalidraw" install flow
    /// is auth-gated but on LAN (`grove mobile`) a malicious peer could
    /// otherwise inflate the file unboundedly.
    const MAX_TOTAL_ITEMS: usize = 10_000;
    /// Cap total serialized byte size of the resulting library so a single
    /// PUT cannot OOM the process or balloon disk usage.
    const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

    let _guard = LIBRARY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load()?;
    // O(1) id lookup so batch upsert is O(n_incoming) instead of O(n_total *
    // n_incoming). Rebuilt before each upsert call — the lock above ensures
    // `file.library_items` doesn't shift under us.
    let mut id_index: std::collections::HashMap<String, usize> = file
        .library_items
        .iter()
        .enumerate()
        .map(|(i, item)| (item.id.clone(), i))
        .collect();
    for mut item in incoming {
        if item.elements.len() > MAX_ELEMENTS_PER_ITEM {
            return Err(GroveError::storage_tagged(
                "library_validation",
                format!(
                    "library item '{}' has {} elements, exceeding the per-item cap of {}",
                    item.id,
                    item.elements.len(),
                    MAX_ELEMENTS_PER_ITEM
                ),
            ));
        }
        // Defensive: shrink any oversized name early so disk + listing stay
        // bounded regardless of future readers.
        if let Some(name) = item.name.as_mut() {
            if name.chars().count() > 1000 {
                *name = name.chars().take(1000).collect();
            }
        }
        match id_index.get(&item.id).copied() {
            Some(idx) => file.library_items[idx] = item,
            None => {
                id_index.insert(item.id.clone(), file.library_items.len());
                file.library_items.push(item);
            }
        }
    }
    if file.library_items.len() > MAX_TOTAL_ITEMS {
        return Err(GroveError::storage_tagged(
            "library_validation",
            format!(
                "library would have {} items, exceeding the cap of {}",
                file.library_items.len(),
                MAX_TOTAL_ITEMS
            ),
        ));
    }
    // Serialize once (pretty for human-readable on-disk format), check size,
    // reuse the same bytes for the actual write.
    let bytes = serde_json::to_vec_pretty(&file)?;
    if bytes.len() > MAX_TOTAL_BYTES {
        return Err(GroveError::storage_tagged(
            "library_validation",
            format!(
                "library would be {} bytes, exceeding the cap of {}",
                bytes.len(),
                MAX_TOTAL_BYTES
            ),
        ));
    }
    write_bytes(&bytes)?;
    Ok(file)
}

/// Wipe the entire library. Matches the Excalidraw "reset library" UX.
pub fn reset() -> Result<()> {
    let _guard = LIBRARY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = library_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Look up a single item by id. Used by `grove_sketch_draw` to expand
/// `libraryItem` pseudo-elements into base Excalidraw elements.
pub fn get_item(id: &str) -> Result<Option<LibraryItem>> {
    let file = load()?;
    Ok(file.library_items.into_iter().find(|x| x.id == id))
}

/// Expand a library item into Excalidraw elements positioned at `(target_x,
/// target_y)` (interpreted as the top-left of the item's bounding box).
///
/// Internal cross-references (`containerId`, `startBinding.elementId`,
/// `endBinding.elementId`, `boundElements[*].id`) are rewritten so each
/// instantiation has fresh, non-colliding element ids. `groupIds` are also
/// rewritten per-instance (each unique source group id is mapped to a fresh
/// suffixed id) so two instantiations of the same library item do NOT share
/// group membership.
pub fn expand(id: &str, target_x: f64, target_y: f64) -> Result<Vec<serde_json::Value>> {
    let item = get_item(id)?.ok_or_else(|| {
        GroveError::storage(format!(
            "library item '{id}' not found — call grove_sketch_read_me to see the available list"
        ))
    })?;

    // Anchor item at top-left: shift everything so the bbox.min becomes (0,0)
    // and then add the caller's target.
    let (min_x, min_y) = bbox_min(&item.elements);
    let dx = target_x - min_x;
    let dy = target_y - min_y;

    // Generate fresh ids for every element so multiple instantiations don't
    // collide. Use short prefixes to keep scene JSON readable.
    let mut id_map: HashMap<String, String> = HashMap::new();
    for el in &item.elements {
        if let Some(old) = el.get("id").and_then(|v| v.as_str()) {
            let new_id = format!("li-{}", uuid::Uuid::new_v4().simple());
            id_map.insert(old.to_string(), new_id);
        }
    }

    // Per-instance suffix for groupIds: each unique source group id in this
    // item gets the same fresh suffix, so within one instantiation the
    // grouping is preserved, but two instantiations no longer collide on
    // group membership.
    let group_suffix = uuid::Uuid::new_v4().simple().to_string();
    let mut group_id_map: HashMap<String, String> = HashMap::new();
    for el in &item.elements {
        if let Some(arr) = el.get("groupIds").and_then(|v| v.as_array()) {
            for gid in arr {
                if let Some(s) = gid.as_str() {
                    group_id_map
                        .entry(s.to_string())
                        .or_insert_with(|| format!("{s}-{group_suffix}"));
                }
            }
        }
    }

    let mut out = Vec::with_capacity(item.elements.len());
    for el in &item.elements {
        let mut cloned = el.clone();
        rewrite_element(&mut cloned, &id_map, &group_id_map, dx, dy);
        out.push(cloned);
    }
    Ok(out)
}

fn bbox_min(elements: &[serde_json::Value]) -> (f64, f64) {
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    for el in elements {
        let x = el.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = el.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
    }
    if min_x.is_finite() {
        (min_x, min_y)
    } else {
        (0.0, 0.0)
    }
}

fn rewrite_element(
    el: &mut serde_json::Value,
    id_map: &HashMap<String, String>,
    group_id_map: &HashMap<String, String>,
    dx: f64,
    dy: f64,
) {
    let Some(obj) = el.as_object_mut() else {
        return;
    };
    // groupIds: rewrite each entry through `group_id_map` so this
    // instantiation has its own group identity.
    if let Some(arr) = obj.get_mut("groupIds").and_then(|v| v.as_array_mut()) {
        for gid in arr.iter_mut() {
            if let Some(s) = gid.as_str() {
                if let Some(new_gid) = group_id_map.get(s) {
                    *gid = serde_json::Value::String(new_gid.clone());
                }
            }
        }
    }
    // id
    if let Some(old) = obj.get("id").and_then(|v| v.as_str()).map(String::from) {
        if let Some(new_id) = id_map.get(&old) {
            obj.insert("id".to_string(), serde_json::Value::String(new_id.clone()));
        }
    }
    // x, y offset
    if let Some(v) = obj.get("x").and_then(|v| v.as_f64()) {
        obj.insert("x".to_string(), serde_json::json!(v + dx));
    }
    if let Some(v) = obj.get("y").and_then(|v| v.as_f64()) {
        obj.insert("y".to_string(), serde_json::json!(v + dy));
    }
    // containerId
    if let Some(old) = obj
        .get("containerId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        if let Some(new_id) = id_map.get(&old) {
            obj.insert(
                "containerId".to_string(),
                serde_json::Value::String(new_id.clone()),
            );
        }
    }
    // startBinding.elementId, endBinding.elementId
    for key in ["startBinding", "endBinding"] {
        if let Some(binding) = obj.get_mut(key).and_then(|v| v.as_object_mut()) {
            if let Some(old) = binding
                .get("elementId")
                .and_then(|v| v.as_str())
                .map(String::from)
            {
                if let Some(new_id) = id_map.get(&old) {
                    binding.insert(
                        "elementId".to_string(),
                        serde_json::Value::String(new_id.clone()),
                    );
                }
            }
        }
    }
    // boundElements: [{id, type}]
    if let Some(bound) = obj.get_mut("boundElements").and_then(|v| v.as_array_mut()) {
        for entry in bound {
            if let Some(entry_obj) = entry.as_object_mut() {
                if let Some(old) = entry_obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                {
                    if let Some(new_id) = id_map.get(&old) {
                        entry_obj
                            .insert("id".to_string(), serde_json::Value::String(new_id.clone()));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::set_grove_dir_override;
    use serde_json::json;

    fn item(id: &str, name: &str) -> LibraryItem {
        LibraryItem {
            id: id.to_string(),
            status: Some("published".to_string()),
            elements: vec![
                json!({ "type": "rectangle", "id": "r1", "x": 0, "y": 0, "width": 100, "height": 50 }),
            ],
            created: Some(1_700_000_000),
            name: Some(name.to_string()),
            extra: Default::default(),
        }
    }

    #[test]
    fn load_returns_empty_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        set_grove_dir_override(Some(tmp.path().to_path_buf()));
        let file = load().unwrap();
        assert_eq!(file.library_items.len(), 0);
        assert_eq!(file.kind, "excalidrawlib");
        set_grove_dir_override(None);
    }

    #[test]
    fn upsert_appends_new_and_updates_existing() {
        let tmp = tempfile::tempdir().unwrap();
        set_grove_dir_override(Some(tmp.path().to_path_buf()));

        upsert(vec![item("a", "alpha"), item("b", "beta")]).unwrap();
        let after_first = load().unwrap();
        assert_eq!(after_first.library_items.len(), 2);

        // Update "a" name + add "c" — "b" must be preserved.
        upsert(vec![item("a", "ALPHA-V2"), item("c", "gamma")]).unwrap();
        let after_second = load().unwrap();
        assert_eq!(after_second.library_items.len(), 3);
        let a = after_second
            .library_items
            .iter()
            .find(|x| x.id == "a")
            .unwrap();
        assert_eq!(a.name.as_deref(), Some("ALPHA-V2"));
        assert!(after_second.library_items.iter().any(|x| x.id == "b"));
        assert!(after_second.library_items.iter().any(|x| x.id == "c"));

        set_grove_dir_override(None);
    }

    #[test]
    fn reset_clears_file() {
        let tmp = tempfile::tempdir().unwrap();
        set_grove_dir_override(Some(tmp.path().to_path_buf()));
        upsert(vec![item("a", "alpha")]).unwrap();
        assert!(library_path().exists());
        reset().unwrap();
        assert!(!library_path().exists());
        let after = load().unwrap();
        assert_eq!(after.library_items.len(), 0);
        set_grove_dir_override(None);
    }

    #[test]
    fn expand_offsets_and_rewrites_ids() {
        let tmp = tempfile::tempdir().unwrap();
        set_grove_dir_override(Some(tmp.path().to_path_buf()));

        // A two-element item: container shape "C" + label text "L" with containerId=C.
        let item = LibraryItem {
            id: "lib-database".to_string(),
            status: Some("published".to_string()),
            elements: vec![
                json!({
                    "type": "rectangle", "id": "C", "x": 100.0, "y": 50.0,
                    "width": 80.0, "height": 40.0,
                    "boundElements": [{"id": "L", "type": "text"}]
                }),
                json!({
                    "type": "text", "id": "L", "x": 110.0, "y": 60.0,
                    "width": 60.0, "height": 20.0, "text": "DB",
                    "containerId": "C"
                }),
            ],
            created: Some(1),
            name: Some("database".to_string()),
            extra: Default::default(),
        };
        upsert(vec![item]).unwrap();

        let expanded = expand("lib-database", 500.0, 300.0).unwrap();
        assert_eq!(expanded.len(), 2);

        let rect = &expanded[0];
        let text = &expanded[1];

        // Top-left anchored at (500, 300): bbox min was (100, 50), so rect (was 100,50) becomes (500,300).
        assert_eq!(rect.get("x").unwrap().as_f64().unwrap(), 500.0);
        assert_eq!(rect.get("y").unwrap().as_f64().unwrap(), 300.0);
        // Text was (110, 60) → (510, 310).
        assert_eq!(text.get("x").unwrap().as_f64().unwrap(), 510.0);
        assert_eq!(text.get("y").unwrap().as_f64().unwrap(), 310.0);

        // Ids must be rewritten (not "C" / "L" anymore) and consistent across
        // containerId / boundElements references.
        let new_rect_id = rect.get("id").unwrap().as_str().unwrap();
        let new_text_id = text.get("id").unwrap().as_str().unwrap();
        assert_ne!(new_rect_id, "C");
        assert_ne!(new_text_id, "L");
        assert_eq!(
            text.get("containerId").unwrap().as_str().unwrap(),
            new_rect_id
        );
        let bound = rect.get("boundElements").unwrap().as_array().unwrap();
        assert_eq!(bound[0].get("id").unwrap().as_str().unwrap(), new_text_id);

        // Two instantiations must not collide.
        let again = expand("lib-database", 0.0, 0.0).unwrap();
        let another_rect_id = again[0].get("id").unwrap().as_str().unwrap();
        assert_ne!(another_rect_id, new_rect_id);

        set_grove_dir_override(None);
    }

    #[test]
    fn expand_errors_on_unknown_id() {
        let tmp = tempfile::tempdir().unwrap();
        set_grove_dir_override(Some(tmp.path().to_path_buf()));
        let err = expand("does-not-exist", 0.0, 0.0).unwrap_err();
        assert!(err.to_string().contains("not found"));
        set_grove_dir_override(None);
    }

    #[test]
    fn get_item_finds_by_id() {
        let tmp = tempfile::tempdir().unwrap();
        set_grove_dir_override(Some(tmp.path().to_path_buf()));
        upsert(vec![item("a", "alpha")]).unwrap();
        let it = get_item("a").unwrap().unwrap();
        assert_eq!(it.name.as_deref(), Some("alpha"));
        assert!(get_item("nope").unwrap().is_none());
        set_grove_dir_override(None);
    }
}
