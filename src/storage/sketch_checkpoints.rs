//! Global LRU checkpoint store for sketch draws.
//!
//! Each successful `grove_sketch_draw` produces a new checkpoint (UUID) that
//! captures the resolved scene. AI callers can pass a checkpoint id back via
//! the `restoreCheckpoint` pseudo-element to continue editing from that state
//! without re-sending the whole scene. The store is capped at
//! `MAX_CHECKPOINTS` entries (LRU by write time), shared across all tasks and
//! sketches — UUIDs don't collide.
//!
//! Layout:
//!   ~/.grove/sketch-checkpoints/
//!     ├── index.json        # { entries: [{id, ts}], oldest first }
//!     └── <id>.json         # serialized scene value

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};
use crate::storage::grove_dir;

const MAX_CHECKPOINTS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointEntry {
    pub id: String,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CheckpointIndex {
    #[serde(default)]
    pub entries: Vec<CheckpointEntry>,
}

fn base_dir() -> PathBuf {
    grove_dir().join("sketch-checkpoints")
}

fn index_path() -> PathBuf {
    base_dir().join("index.json")
}

fn checkpoint_path(id: &str) -> PathBuf {
    base_dir().join(format!("{id}.json"))
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

fn load_index() -> Result<CheckpointIndex> {
    let p = index_path();
    if !p.exists() {
        return Ok(CheckpointIndex::default());
    }
    let content = std::fs::read_to_string(&p)?;
    match serde_json::from_str::<CheckpointIndex>(&content) {
        Ok(idx) => Ok(idx),
        Err(e) => {
            // Corrupt index would silently lose LRU bookkeeping, leaking
            // orphaned `cp-*.json` files forever. Log and rebuild from the
            // directory listing so the cap keeps working.
            eprintln!("[sketch-checkpoints] index is corrupt ({e}); rebuilding from directory");
            Ok(rebuild_index_from_dir().unwrap_or_default())
        }
    }
}

/// Walk the checkpoints directory and reconstruct an index entry for every
/// `cp-*.json` file, ordered by mtime (oldest first). Called when the stored
/// index fails to parse.
fn rebuild_index_from_dir() -> Result<CheckpointIndex> {
    let dir = base_dir();
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
            CheckpointEntry { id, ts }
        })
        .collect();
    Ok(CheckpointIndex { entries })
}

fn save_index(idx: &CheckpointIndex) -> Result<()> {
    std::fs::create_dir_all(base_dir())?;
    let content = serde_json::to_string_pretty(idx)?;
    std::fs::write(index_path(), content)?;
    Ok(())
}

pub fn save(id: &str, scene: &serde_json::Value) -> Result<()> {
    validate_id(id)?;
    std::fs::create_dir_all(base_dir())?;
    std::fs::write(checkpoint_path(id), serde_json::to_string(scene)?)?;

    let mut idx = load_index()?;
    idx.entries.retain(|e| e.id != id);
    idx.entries.push(CheckpointEntry {
        id: id.to_string(),
        ts: chrono::Utc::now().to_rfc3339(),
    });
    while idx.entries.len() > MAX_CHECKPOINTS {
        let old = idx.entries.remove(0);
        let _ = std::fs::remove_file(checkpoint_path(&old.id));
    }
    save_index(&idx)?;
    Ok(())
}

pub fn load(id: &str) -> Result<Option<serde_json::Value>> {
    validate_id(id)?;
    let p = checkpoint_path(id);
    if !p.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&p)?;
    Ok(Some(serde_json::from_str(&content)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_and_load_roundtrip() {
        let id = generate_id();
        let scene = json!({ "elements": [{"type":"rectangle","id":"r1"}] });
        save(&id, &scene).unwrap();
        let loaded = load(&id).unwrap().unwrap();
        assert_eq!(loaded, scene);
        let _ = std::fs::remove_file(checkpoint_path(&id));
    }

    #[test]
    fn load_missing_returns_none() {
        let id = generate_id();
        assert!(load(&id).unwrap().is_none());
    }

    #[test]
    fn invalid_id_rejected() {
        assert!(load("../etc/passwd").is_err());
        assert!(save("a", &json!({})).is_err());
    }
}
