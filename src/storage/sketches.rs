//! Storage for Studio task Excalidraw sketches.
//!
//! Layout on disk, per task:
//!   <task-data-dir>/sketches/
//!     ├── index.json
//!     └── sketch-<uuid>.excalidraw

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::ensure_task_data_dir;
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SketchMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SketchIndex {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub sketches: Vec<SketchMeta>,
}

fn default_version() -> u32 {
    1
}

#[allow(dead_code)]
fn sketches_dir(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_task_data_dir(project, task_id)?.join("sketches");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn index_path(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(sketches_dir(project, task_id)?.join("index.json"))
}

#[allow(dead_code)]
fn sketch_path(project: &str, task_id: &str, sketch_id: &str) -> Result<PathBuf> {
    Ok(sketches_dir(project, task_id)?.join(format!("{sketch_id}.excalidraw")))
}

pub fn load_index(project: &str, task_id: &str) -> Result<SketchIndex> {
    let path = index_path(project, task_id)?;
    if !path.exists() {
        return Ok(SketchIndex {
            version: 1,
            sketches: Vec::new(),
        });
    }
    let content = std::fs::read_to_string(&path)?;
    let index = serde_json::from_str(&content)?;
    Ok(index)
}

pub fn save_index(project: &str, task_id: &str, index: &SketchIndex) -> Result<()> {
    let path = index_path(project, task_id)?;
    let content = serde_json::to_string_pretty(index)?;
    std::fs::write(&path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::grove_dir;
    use uuid::Uuid;

    fn setup() -> (String, String) {
        let project = format!("test-{}", Uuid::new_v4());
        let task_id = format!("task-{}", Uuid::new_v4());
        (project, task_id)
    }

    fn teardown(project: &str) {
        let _ = std::fs::remove_dir_all(grove_dir().join("projects").join(project));
    }

    #[test]
    fn load_index_returns_empty_when_missing() {
        let (p, t) = setup();
        let index = load_index(&p, &t).unwrap();
        assert_eq!(index.version, 1);
        assert!(index.sketches.is_empty());
        teardown(&p);
    }

    #[test]
    fn save_then_load_index_roundtrip() {
        let (p, t) = setup();
        let meta = SketchMeta {
            id: "sketch-abc".to_string(),
            name: "One".to_string(),
            created_at: "2026-04-17T00:00:00Z".to_string(),
            updated_at: "2026-04-17T00:00:00Z".to_string(),
        };
        save_index(
            &p,
            &t,
            &SketchIndex {
                version: 1,
                sketches: vec![meta.clone()],
            },
        )
        .unwrap();
        let loaded = load_index(&p, &t).unwrap();
        assert_eq!(loaded.sketches.len(), 1);
        assert_eq!(loaded.sketches[0].id, meta.id);
        teardown(&p);
    }
}
