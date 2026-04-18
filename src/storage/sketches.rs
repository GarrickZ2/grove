//! Storage for Studio task Excalidraw sketches.
//!
//! Layout on disk, per task:
//!   <task-data-dir>/sketches/
//!     ├── index.json
//!     └── sketch-<uuid>.excalidraw

// Dead-code is allowed until Milestone B+ wires these into handlers/MCP tools.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use super::{ensure_task_data_dir, grove_dir};
use crate::error::Result;

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

/// Compute the sketches directory path WITHOUT creating it. Use for read paths.
fn sketches_dir(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(grove_dir()
        .join("projects")
        .join(project)
        .join("tasks")
        .join(task_id)
        .join("sketches"))
}

/// Compute the sketches directory path and ensure it exists. Use for write paths.
fn sketches_dir_ensure(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_task_data_dir(project, task_id)?.join("sketches");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn index_path_in(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn sketch_path_in(dir: &Path, sketch_id: &str) -> PathBuf {
    dir.join(format!("{sketch_id}.excalidraw"))
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
    let now = now_iso();
    let meta = SketchMeta {
        id: id.clone(),
        name: name.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    let dir = sketches_dir_ensure(project, task_id)?;
    std::fs::write(sketch_path_in(&dir, &id), EMPTY_SCENE.as_str())?;
    let mut index = load_index(project, task_id)?;
    index.sketches.push(meta.clone());
    save_index(project, task_id, &index)?;
    Ok(meta)
}

pub fn load_scene(project: &str, task_id: &str, sketch_id: &str) -> Result<String> {
    let dir = sketches_dir(project, task_id)?;
    let content = std::fs::read_to_string(sketch_path_in(&dir, sketch_id))?;
    Ok(content)
}

pub fn save_scene(project: &str, task_id: &str, sketch_id: &str, content: &str) -> Result<()> {
    let dir = sketches_dir_ensure(project, task_id)?;
    std::fs::write(sketch_path_in(&dir, sketch_id), content)?;
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
    let dir = sketches_dir(project, task_id)?;
    let path = sketch_path_in(&dir, sketch_id);
    if path.exists() {
        std::fs::remove_file(&path)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::grove_dir;
    use uuid::Uuid;

    /// RAII guard: cleans up the per-test project directory even on panic.
    struct TestEnv {
        project: String,
        task_id: String,
    }

    impl TestEnv {
        fn new() -> Self {
            Self {
                project: format!("test-{}", Uuid::new_v4()),
                task_id: format!("task-{}", Uuid::new_v4()),
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
        let dir = grove_dir()
            .join("projects")
            .join(&env.project)
            .join("tasks")
            .join(&env.task_id)
            .join("sketches");
        assert!(
            !dir.exists(),
            "load_index on nonexistent task must not create sketches dir"
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
    fn rename_sketch_updates_index_only() {
        let env = TestEnv::new();
        let meta = create_sketch(&env.project, &env.task_id, "Old").unwrap();
        rename_sketch(&env.project, &env.task_id, &meta.id, "New").unwrap();
        let index = load_index(&env.project, &env.task_id).unwrap();
        assert_eq!(index.sketches[0].name, "New");
    }
}
