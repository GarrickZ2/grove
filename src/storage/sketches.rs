//! Storage for Studio task Excalidraw sketches.
//!
//! Layout on disk, per task:
//!   <task-data-dir>/sketches/
//!     ├── index.json
//!     └── sketch-<uuid>.excalidraw

// Dead-code is allowed until Milestone B+ wires these into handlers/MCP tools.
#![allow(dead_code)]

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

fn sketches_dir(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_task_data_dir(project, task_id)?.join("sketches");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn index_path(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(sketches_dir(project, task_id)?.join("index.json"))
}

fn sketch_path(project: &str, task_id: &str, sketch_id: &str) -> Result<PathBuf> {
    Ok(sketches_dir(project, task_id)?.join(format!("{sketch_id}.excalidraw")))
}

const EMPTY_SCENE: &str = r##"{
  "type": "excalidraw",
  "version": 2,
  "source": "grove",
  "elements": [],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": {}
}"##;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn create_sketch(project: &str, task_id: &str, name: &str) -> Result<SketchMeta> {
    let id = format!("sketch-{}", uuid::Uuid::new_v4());
    let now = now_iso();
    let meta = SketchMeta {
        id: id.clone(),
        name: name.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    std::fs::write(sketch_path(project, task_id, &id)?, EMPTY_SCENE)?;
    let mut index = load_index(project, task_id)?;
    index.sketches.push(meta.clone());
    save_index(project, task_id, &index)?;
    Ok(meta)
}

pub fn load_scene(project: &str, task_id: &str, sketch_id: &str) -> Result<String> {
    let content = std::fs::read_to_string(sketch_path(project, task_id, sketch_id)?)?;
    Ok(content)
}

pub fn save_scene(project: &str, task_id: &str, sketch_id: &str, content: &str) -> Result<()> {
    std::fs::write(sketch_path(project, task_id, sketch_id)?, content)?;
    touch_index(project, task_id, sketch_id)?;
    Ok(())
}

pub fn rename_sketch(project: &str, task_id: &str, sketch_id: &str, new_name: &str) -> Result<()> {
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
    let path = sketch_path(project, task_id, sketch_id)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let mut index = load_index(project, task_id)?;
    index.sketches.retain(|m| m.id != sketch_id);
    save_index(project, task_id, &index)?;
    Ok(())
}

fn touch_index(project: &str, task_id: &str, sketch_id: &str) -> Result<()> {
    let mut index = load_index(project, task_id)?;
    if let Some(item) = index.sketches.iter_mut().find(|m| m.id == sketch_id) {
        item.updated_at = now_iso();
    }
    save_index(project, task_id, &index)?;
    Ok(())
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

    #[test]
    fn create_sketch_writes_empty_scene_and_updates_index() {
        let (p, t) = setup();
        let meta = create_sketch(&p, &t, "My sketch").unwrap();
        assert!(meta.id.starts_with("sketch-"));
        let index = load_index(&p, &t).unwrap();
        assert_eq!(index.sketches.len(), 1);
        let scene = load_scene(&p, &t, &meta.id).unwrap();
        assert!(scene.contains("\"type\": \"excalidraw\""));
        teardown(&p);
    }

    #[test]
    fn save_scene_updates_index_timestamp() {
        let (p, t) = setup();
        let meta = create_sketch(&p, &t, "X").unwrap();
        let original = meta.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        save_scene(
            &p,
            &t,
            &meta.id,
            "{\"type\":\"excalidraw\",\"elements\":[]}",
        )
        .unwrap();
        let index = load_index(&p, &t).unwrap();
        assert_ne!(index.sketches[0].updated_at, original);
        teardown(&p);
    }

    #[test]
    fn delete_sketch_removes_file_and_index_entry() {
        let (p, t) = setup();
        let meta = create_sketch(&p, &t, "gone").unwrap();
        delete_sketch(&p, &t, &meta.id).unwrap();
        let index = load_index(&p, &t).unwrap();
        assert!(index.sketches.is_empty());
        assert!(!sketch_path(&p, &t, &meta.id).unwrap().exists());
        teardown(&p);
    }

    #[test]
    fn rename_sketch_updates_index_only() {
        let (p, t) = setup();
        let meta = create_sketch(&p, &t, "Old").unwrap();
        rename_sketch(&p, &t, &meta.id, "New").unwrap();
        let index = load_index(&p, &t).unwrap();
        assert_eq!(index.sketches[0].name, "New");
        teardown(&p);
    }
}
