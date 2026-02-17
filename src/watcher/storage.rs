//! Persistence layer for edit history.
//!
//! Stores edit events in JSONL format (one JSON object per line) for
//! efficient append-only writes and streaming reads.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::storage::ensure_task_data_dir;

/// A single file edit event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditEvent {
    /// When the edit occurred
    #[serde(with = "chrono::serde::ts_seconds")]
    pub timestamp: DateTime<Utc>,
    /// Relative path to the edited file
    pub file: PathBuf,
}

/// activity.jsonl 路径: tasks/<task-id>/activity.jsonl
fn edits_file_path(project_key: &str, task_id: &str) -> Result<PathBuf> {
    Ok(ensure_task_data_dir(project_key, task_id)?.join("activity.jsonl"))
}

/// Load all edit events for a task
pub fn load_edit_history(project_key: &str, task_id: &str) -> Result<Vec<EditEvent>> {
    let path = edits_file_path(project_key, task_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

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
