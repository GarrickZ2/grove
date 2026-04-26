//! Per-sketch LRU checkpoint store for sketch draws.
//!
//! Each successful `grove_sketch_draw` writes a new checkpoint (UUID) that
//! captures the resolved scene. AI callers can pass the id back via the
//! `restoreCheckpoint` pseudo-element to continue editing from that state
//! without re-sending the whole scene. The History dialog in the web UI
//! reads the same store to offer user-facing restore.
//!
//! Storage is scoped per-sketch so that a busy sketch can't evict another
//! sketch's history, and deleting a sketch cleans up its checkpoints with
//! the rest of its files.
//!
//! Layout:
//!   <task-workdir>/sketch/<sketch-id>/checkpoints/
//!     ├── index.json        # { entries: [{id, ts, element_count?, label?}] }
//!     └── cp-<uuid>.json    # serialized scene value

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};
use crate::storage::sketches;

/// Per-sketch cap. Scoped storage means 50 is plenty for recovery — one
/// sketch can't drown another out. At ~10 KB per checkpoint that's ~500 KB
/// max per sketch.
const MAX_CHECKPOINTS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointEntry {
    pub id: String,
    pub ts: String,
    /// Cheap preview hints so the History dialog can render useful rows
    /// without reading every checkpoint file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CheckpointIndex {
    #[serde(default)]
    pub entries: Vec<CheckpointEntry>,
}

fn base_dir(project: &str, task_id: &str, sketch_id: &str) -> Result<PathBuf> {
    Ok(sketches::sketch_subdir(project, task_id, sketch_id)?.join("checkpoints"))
}

fn index_path(project: &str, task_id: &str, sketch_id: &str) -> Result<PathBuf> {
    Ok(base_dir(project, task_id, sketch_id)?.join("index.json"))
}

fn checkpoint_path(project: &str, task_id: &str, sketch_id: &str, id: &str) -> Result<PathBuf> {
    Ok(base_dir(project, task_id, sketch_id)?.join(format!("{id}.json")))
}

/// Reject ids that could escape the checkpoints dir.
fn validate_id(id: &str) -> Result<()> {
    let ok = (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(GroveError::storage("invalid checkpoint id"));
    }
    Ok(())
}

pub fn generate_id() -> String {
    format!("cp-{}", uuid::Uuid::new_v4().simple())
}

fn load_index(project: &str, task_id: &str, sketch_id: &str) -> Result<CheckpointIndex> {
    let p = index_path(project, task_id, sketch_id)?;
    if !p.exists() {
        return Ok(CheckpointIndex::default());
    }
    let content = std::fs::read_to_string(&p)?;
    match serde_json::from_str::<CheckpointIndex>(&content) {
        Ok(idx) => Ok(idx),
        Err(e) => {
            // A corrupt index would silently lose LRU bookkeeping and leak
            // orphaned `cp-*.json` files forever. Log and rebuild from the
            // directory listing so the cap keeps working.
            eprintln!("[sketch-checkpoints] index is corrupt ({e}); rebuilding from directory");
            Ok(rebuild_index_from_dir(project, task_id, sketch_id).unwrap_or_default())
        }
    }
}

/// Walk a sketch's checkpoints directory and reconstruct an index entry for
/// every `cp-*.json` file, ordered by mtime (oldest first). Called when the
/// stored index fails to parse. Previews are left `None` — the rebuild path
/// is a last-resort recovery; preview-filling can come from the next write.
fn rebuild_index_from_dir(
    project: &str,
    task_id: &str,
    sketch_id: &str,
) -> Result<CheckpointIndex> {
    let dir = base_dir(project, task_id, sketch_id)?;
    if !dir.exists() {
        return Ok(CheckpointIndex::default());
    }
    let mut entries: Vec<(String, std::time::SystemTime)> = Vec::new();
    for ent in std::fs::read_dir(&dir)? {
        let ent = ent?;
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.starts_with("cp-") || !name.ends_with(".json") {
            continue;
        }
        let id = name.trim_end_matches(".json").to_string();
        if validate_id(&id).is_err() {
            continue;
        }
        let mtime = ent
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((id, mtime));
    }
    entries.sort_by_key(|(_, t)| *t);
    let entries = entries
        .into_iter()
        .map(|(id, t)| {
            let ts = chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339();
            CheckpointEntry {
                id,
                ts,
                element_count: None,
                label: None,
            }
        })
        .collect();
    Ok(CheckpointIndex { entries })
}

fn save_index(project: &str, task_id: &str, sketch_id: &str, idx: &CheckpointIndex) -> Result<()> {
    let dir = base_dir(project, task_id, sketch_id)?;
    std::fs::create_dir_all(&dir)?;
    let content = serde_json::to_string_pretty(idx)?;
    std::fs::write(index_path(project, task_id, sketch_id)?, content)?;
    Ok(())
}

/// Derive the cheap preview the History dialog renders for each row:
/// total element count + a breakdown by element type (e.g.
/// "2 rectangle · 1 arrow"). Type breakdown is more useful than "first
/// text" for spotting structural changes across checkpoints — adding or
/// removing a shape immediately shows up. Bound-text children (elements
/// with a `containerId`) are folded into their parent's type so they
/// don't inflate the count with noise from labeled shapes.
fn compute_preview(scene: &serde_json::Value) -> (Option<usize>, Option<String>) {
    let Some(elements) = scene.get("elements").and_then(|v| v.as_array()) else {
        return (None, None);
    };
    // Count visible top-level elements only — skip bound-text children that
    // exist purely to back a container's `label`, so a `labeled rectangle`
    // reads as "1 rectangle", not "1 rectangle · 1 text".
    let visible: Vec<&serde_json::Value> = elements
        .iter()
        .filter(|el| {
            let is_bound_text = el
                .get("containerId")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            !is_bound_text
        })
        .collect();
    let count = visible.len();
    if count == 0 {
        return (Some(0), None);
    }
    let mut by_type: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for el in &visible {
        let t = el
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("element")
            .to_string();
        *by_type.entry(t).or_default() += 1;
    }
    // Sort by count desc, then by type name for determinism.
    let mut pairs: Vec<(String, usize)> = by_type.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let summary = pairs
        .into_iter()
        .map(|(t, n)| format!("{n} {t}"))
        .collect::<Vec<_>>()
        .join(" · ");
    (Some(count), Some(summary))
}

pub fn save(
    project: &str,
    task_id: &str,
    sketch_id: &str,
    id: &str,
    scene: &serde_json::Value,
) -> Result<()> {
    validate_id(id)?;
    let dir = base_dir(project, task_id, sketch_id)?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        checkpoint_path(project, task_id, sketch_id, id)?,
        serde_json::to_string(scene)?,
    )?;

    let (element_count, label) = compute_preview(scene);

    let mut idx = load_index(project, task_id, sketch_id)?;
    idx.entries.retain(|e| e.id != id);
    idx.entries.push(CheckpointEntry {
        id: id.to_string(),
        ts: chrono::Utc::now().to_rfc3339(),
        element_count,
        label,
    });
    while idx.entries.len() > MAX_CHECKPOINTS {
        let old = idx.entries.remove(0);
        if let Ok(p) = checkpoint_path(project, task_id, sketch_id, &old.id) {
            let _ = std::fs::remove_file(p);
        }
    }
    save_index(project, task_id, sketch_id, &idx)?;
    Ok(())
}

pub fn load(
    project: &str,
    task_id: &str,
    sketch_id: &str,
    id: &str,
) -> Result<Option<serde_json::Value>> {
    validate_id(id)?;
    let p = checkpoint_path(project, task_id, sketch_id, id)?;
    if !p.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&p)?;
    Ok(Some(serde_json::from_str(&content)?))
}

/// Return all checkpoint entries for this sketch, newest first. Used by the
/// History dialog.
pub fn list_entries(project: &str, task_id: &str, sketch_id: &str) -> Result<Vec<CheckpointEntry>> {
    let mut idx = load_index(project, task_id, sketch_id)?;
    idx.entries.reverse();
    Ok(idx.entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::grove_dir;
    use crate::storage::tasks::{save_tasks, Task, TaskStatus};
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    struct Env {
        project: String,
        task_id: String,
        sketch_id: String,
    }

    impl Env {
        fn new() -> Self {
            let _lock = crate::storage::database::test_lock().blocking_lock();
            let project = format!("test-{}", Uuid::new_v4());
            let task_id = format!("task-{}", Uuid::new_v4());
            let workdir = grove_dir().join("projects").join(&project).join("workdir");
            std::fs::create_dir_all(&workdir).unwrap();
            let now = Utc::now();
            let task = Task {
                id: task_id.clone(),
                name: "t".to_string(),
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
            let sketch_id = format!("sketch-{}", Uuid::new_v4());
            Self {
                project,
                task_id,
                sketch_id,
            }
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(grove_dir().join("projects").join(&self.project));
        }
    }

    #[test]
    fn save_and_load_roundtrip() {
        let env = Env::new();
        let id = generate_id();
        let scene = json!({
            "elements": [
                {"type": "rectangle", "id": "r1", "text": "Hello"}
            ]
        });
        save(&env.project, &env.task_id, &env.sketch_id, &id, &scene).unwrap();
        let loaded = load(&env.project, &env.task_id, &env.sketch_id, &id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded, scene);
    }

    #[test]
    fn list_entries_preserves_preview() {
        let env = Env::new();
        let id = generate_id();
        let scene = json!({
            "elements": [
                {"type": "rectangle", "id": "r1"},
                {"type": "rectangle", "id": "r2"},
                {"type": "arrow", "id": "a1"},
                // Bound-text children shouldn't inflate the summary.
                {"type": "text", "id": "t_r1", "text": "A", "containerId": "r1"},
            ]
        });
        save(&env.project, &env.task_id, &env.sketch_id, &id, &scene).unwrap();
        let list = list_entries(&env.project, &env.task_id, &env.sketch_id).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].element_count, Some(3));
        assert_eq!(list[0].label.as_deref(), Some("2 rectangle · 1 arrow"));
    }

    #[test]
    fn load_missing_returns_none() {
        let env = Env::new();
        let id = generate_id();
        assert!(load(&env.project, &env.task_id, &env.sketch_id, &id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn invalid_id_rejected() {
        let env = Env::new();
        assert!(load(&env.project, &env.task_id, &env.sketch_id, "../etc/passwd").is_err());
        assert!(save(&env.project, &env.task_id, &env.sketch_id, "a", &json!({})).is_err());
    }

    #[test]
    fn lru_evicts_over_cap() {
        let env = Env::new();
        for i in 0..MAX_CHECKPOINTS + 5 {
            let id = generate_id();
            let scene = json!({ "elements": [{"type":"rectangle","id": format!("r{i}")}] });
            save(&env.project, &env.task_id, &env.sketch_id, &id, &scene).unwrap();
        }
        let list = list_entries(&env.project, &env.task_id, &env.sketch_id).unwrap();
        assert_eq!(list.len(), MAX_CHECKPOINTS);
    }

    #[test]
    fn different_sketches_are_isolated() {
        let env = Env::new();
        let other_sketch = format!("sketch-{}", Uuid::new_v4());
        let id_a = generate_id();
        let id_b = generate_id();
        save(
            &env.project,
            &env.task_id,
            &env.sketch_id,
            &id_a,
            &json!({ "elements": [] }),
        )
        .unwrap();
        save(
            &env.project,
            &env.task_id,
            &other_sketch,
            &id_b,
            &json!({ "elements": [] }),
        )
        .unwrap();
        let list_a = list_entries(&env.project, &env.task_id, &env.sketch_id).unwrap();
        let list_b = list_entries(&env.project, &env.task_id, &other_sketch).unwrap();
        assert_eq!(list_a.len(), 1);
        assert_eq!(list_b.len(), 1);
        assert_eq!(list_a[0].id, id_a);
        assert_eq!(list_b[0].id, id_b);
        // Cross-sketch load must return None, not surface the other sketch's
        // checkpoint — prevents cross-sketch restore via stale ids.
        assert!(load(&env.project, &env.task_id, &env.sketch_id, &id_b)
            .unwrap()
            .is_none());
    }
}
