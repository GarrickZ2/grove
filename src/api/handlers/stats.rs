//! Stats API handlers

use axum::{extract::Path, http::StatusCode, Json};
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;

use crate::storage::workspace;
use crate::watcher;

// ============================================================================
// Response DTOs
// ============================================================================

/// File edit entry
#[derive(Debug, Serialize)]
pub struct FileEditEntry {
    pub path: String,
    pub edit_count: u32,
    pub last_edited: String, // ISO 8601
}

/// Activity entry (hourly with minute-level buckets)
#[derive(Debug, Serialize)]
pub struct ActivityEntry {
    pub hour: String,      // ISO 8601 hour (e.g., "2024-01-15T14:00:00Z")
    pub buckets: Vec<u32>, // 60 minute buckets (index 0 = minute 00, index 59 = minute 59)
    pub total: u32,        // Total edits in this hour
}

/// Task stats response
#[derive(Debug, Serialize)]
pub struct TaskStatsResponse {
    /// Total file edits
    pub total_edits: u32,
    /// Files touched count
    pub files_touched: u32,
    /// Last activity time (ISO 8601)
    pub last_activity: Option<String>,
    /// Top files by edit count
    pub file_edits: Vec<FileEditEntry>,
    /// Hourly activity (last 24 hours)
    pub hourly_activity: Vec<ActivityEntry>,
}

// ============================================================================
// Helper functions
// ============================================================================

/// Find project by ID and return (project, project_key)
fn find_project_by_id(id: &str) -> Result<(workspace::RegisteredProject, String), StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let project = projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_key = workspace::project_hash(&project.path);
    Ok((project, project_key))
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/v1/projects/{id}/tasks/{taskId}/stats
/// Get task-level statistics (file edits, activity)
pub async fn get_task_stats(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskStatsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    // Load edit history
    let events = watcher::load_edit_history(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if events.is_empty() {
        return Ok(Json(TaskStatsResponse {
            total_edits: 0,
            files_touched: 0,
            last_activity: None,
            file_edits: Vec::new(),
            hourly_activity: Vec::new(),
        }));
    }

    // Calculate file counts
    let mut file_counts: HashMap<String, (u32, chrono::DateTime<Utc>)> = HashMap::new();
    let mut last_activity = events[0].timestamp;

    for event in &events {
        let path = event.file.to_string_lossy().to_string();
        let entry = file_counts.entry(path).or_insert((0, event.timestamp));
        entry.0 += 1;
        if event.timestamp > entry.1 {
            entry.1 = event.timestamp;
        }
        if event.timestamp > last_activity {
            last_activity = event.timestamp;
        }
    }

    // Count total unique files
    let total_files_touched = file_counts.len() as u32;

    // Sort by count descending
    let mut file_edits: Vec<FileEditEntry> = file_counts
        .into_iter()
        .map(|(path, (count, last))| FileEditEntry {
            path,
            edit_count: count,
            last_edited: last.to_rfc3339(),
        })
        .collect();
    file_edits.sort_by(|a, b| b.edit_count.cmp(&a.edit_count));
    file_edits.truncate(10); // Top 10

    // Calculate hourly activity with minute-level buckets (last 7 days)
    let now = Utc::now();
    let cutoff = now - chrono::Duration::days(7);

    // HashMap: hour_key -> [60 minute buckets]
    let mut hourly: HashMap<String, [u32; 60]> = HashMap::new();

    for event in &events {
        if event.timestamp >= cutoff {
            let hour = event.timestamp.format("%Y-%m-%dT%H:00:00Z").to_string();
            let minute = event
                .timestamp
                .format("%M")
                .to_string()
                .parse::<usize>()
                .unwrap_or(0);
            let buckets = hourly.entry(hour).or_insert([0; 60]);
            if minute < 60 {
                buckets[minute] += 1;
            }
        }
    }

    let mut hourly_activity: Vec<ActivityEntry> = hourly
        .into_iter()
        .map(|(hour, buckets)| {
            let total: u32 = buckets.iter().sum();
            ActivityEntry {
                hour,
                buckets: buckets.to_vec(),
                total,
            }
        })
        .collect();
    hourly_activity.sort_by(|a, b| b.hour.cmp(&a.hour)); // Most recent first

    Ok(Json(TaskStatsResponse {
        total_edits: events.len() as u32,
        files_touched: total_files_touched,
        last_activity: Some(last_activity.to_rfc3339()),
        file_edits,
        hourly_activity,
    }))
}
