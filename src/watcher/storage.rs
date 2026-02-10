//! Persistence layer for edit history.
//!
//! Stores edit events in JSONL format (one JSON object per line) for
//! efficient append-only writes and streaming reads.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::storage::ensure_project_dir;

/// A single file edit event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditEvent {
    /// When the edit occurred
    #[serde(with = "chrono::serde::ts_seconds")]
    pub timestamp: DateTime<Utc>,
    /// Relative path to the edited file
    pub file: PathBuf,
}

/// 新路径: activity/<task-id>.jsonl (扁平化)
fn edits_file_path(project_key: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_project_dir(project_key)?.join("activity");
    fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.jsonl", task_id)))
}

/// 旧路径: activity/<task-id>/edits.jsonl (仅用于 fallback 读取)
fn legacy_edits_file_path(project_key: &str, task_id: &str) -> Result<PathBuf> {
    Ok(ensure_project_dir(project_key)?
        .join("activity")
        .join(task_id)
        .join("edits.jsonl"))
}

/// Load all edit events for a task
///
/// 先查新路径 `activity/<task-id>.jsonl`，fallback 旧路径 `activity/<task-id>/edits.jsonl`
pub fn load_edit_history(project_key: &str, task_id: &str) -> Result<Vec<EditEvent>> {
    let new_path = edits_file_path(project_key, task_id)?;
    let path = if new_path.exists() {
        new_path
    } else {
        let legacy = legacy_edits_file_path(project_key, task_id)?;
        if !legacy.exists() {
            return Ok(Vec::new());
        }
        legacy
    };

    let file = File::open(&path)?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<EditEvent>(&line) {
            events.push(event);
        }
    }

    Ok(events)
}

/// Append new edit events to the history file
pub fn save_edit_history(project_key: &str, task_id: &str, events: &[EditEvent]) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }

    let path = edits_file_path(project_key, task_id)?;

    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;

    for event in events {
        if let Ok(json) = serde_json::to_string(event) {
            writeln!(file, "{}", json)?;
        }
    }

    file.flush()?;
    Ok(())
}

/// Clear all edit history for a task (新旧路径都清理)
pub fn clear_edit_history(project_key: &str, task_id: &str) -> Result<()> {
    // 新路径: activity/<task-id>.jsonl
    let new_path = edits_file_path(project_key, task_id)?;
    if new_path.exists() {
        fs::remove_file(&new_path)?;
    }

    // 旧路径: activity/<task-id>/ (整个目录)
    let legacy_dir = ensure_project_dir(project_key)?
        .join("activity")
        .join(task_id);
    if legacy_dir.exists() {
        fs::remove_dir_all(&legacy_dir)?;
    }
    Ok(())
}
