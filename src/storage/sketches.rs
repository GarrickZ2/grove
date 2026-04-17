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

#[allow(dead_code)]
fn index_path(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(sketches_dir(project, task_id)?.join("index.json"))
}

#[allow(dead_code)]
fn sketch_path(project: &str, task_id: &str, sketch_id: &str) -> Result<PathBuf> {
    Ok(sketches_dir(project, task_id)?.join(format!("{sketch_id}.excalidraw")))
}
