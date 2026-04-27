//! Hooks (notification) API handlers

use axum::{extract::Path, http::StatusCode, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::hooks::{self, NotificationLevel};
use crate::storage::{tasks, workspace};

// ============================================================================
// Response DTOs
// ============================================================================

#[derive(Debug, Serialize)]
pub struct HookEntryResponse {
    pub task_id: String,
    pub task_name: String,
    pub level: String,
    pub timestamp: DateTime<Utc>,
    pub message: Option<String>,
    pub project_id: String,
    pub project_name: String,
}

#[derive(Debug, Serialize)]
pub struct HooksListResponse {
    pub hooks: Vec<HookEntryResponse>,
    pub total: u32,
}

// ============================================================================
// Handlers
// ============================================================================

/// GET /hooks — list all hook notifications across all projects
pub async fn list_all_hooks() -> Result<Json<HooksListResponse>, StatusCode> {
    let records = hooks::load_all_hooks();
    if records.is_empty() {
        return Ok(Json(HooksListResponse {
            hooks: Vec::new(),
            total: 0,
        }));
    }

    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project_names: HashMap<String, String> = projects
        .iter()
        .map(|project| (workspace::project_hash(&project.path), project.name.clone()))
        .collect();

    let mut all_hooks: Vec<HookEntryResponse> = Vec::new();
    // `None` value means we tried to load this project's tasks and failed —
    // we must NOT treat any of its hooks as stale, otherwise an unrelated IO
    // error would silently destroy valid hook records on disk.
    let mut task_names_by_project: HashMap<String, Option<HashMap<String, String>>> =
        HashMap::new();
    let mut stale_notifications = Vec::new();

    for record in records {
        let Some(project_name) = project_names.get(&record.project_key) else {
            // Project no longer registered — drop the orphan hook so it doesn't
            // sit in the DB forever.
            stale_notifications.push((record.project_key, record.task_id));
            continue;
        };

        let task_names = task_names_by_project
            .entry(record.project_key.clone())
            .or_insert_with(|| {
                let active = tasks::load_tasks(&record.project_key).ok()?;
                let archived = tasks::load_archived_tasks(&record.project_key).ok()?;
                Some(
                    active
                        .iter()
                        .chain(archived.iter())
                        .map(|task| (task.id.clone(), task.name.clone()))
                        .collect(),
                )
            });

        // Load failed → keep the hook visible (with placeholder name) and skip
        // stale cleanup for this project entirely.
        let Some(task_names) = task_names.as_ref() else {
            all_hooks.push(HookEntryResponse {
                task_id: record.task_id,
                task_name: "(unknown task)".to_string(),
                level: level_to_string(record.entry.level),
                timestamp: record.entry.timestamp,
                message: record.entry.message,
                project_id: record.project_key,
                project_name: project_name.clone(),
            });
            continue;
        };

        let Some(task_name) = task_names.get(&record.task_id) else {
            stale_notifications.push((record.project_key, record.task_id));
            continue;
        };

        all_hooks.push(HookEntryResponse {
            task_id: record.task_id,
            task_name: task_name.clone(),
            level: level_to_string(record.entry.level),
            timestamp: record.entry.timestamp,
            message: record.entry.message,
            project_id: record.project_key,
            project_name: project_name.clone(),
        });
    }

    if !stale_notifications.is_empty() {
        let mut seen = HashSet::new();
        for (project_key, task_id) in stale_notifications {
            if seen.insert((project_key.clone(), task_id.clone())) {
                hooks::remove_task_hook(&project_key, &task_id);
            }
        }
    }

    let total = all_hooks.len() as u32;
    Ok(Json(HooksListResponse {
        hooks: all_hooks,
        total,
    }))
}

/// DELETE /projects/{id}/hooks/{taskId} — dismiss a single hook notification
pub async fn dismiss_hook(Path((project_id, task_id)): Path<(String, String)>) -> StatusCode {
    hooks::remove_task_hook(&project_id, &task_id);
    StatusCode::NO_CONTENT
}

#[derive(Debug, Deserialize)]
pub struct PreviewSoundRequest {
    pub sound: String,
}

/// POST /hooks/preview — play a system sound for preview
pub async fn preview_sound(Json(req): Json<PreviewSoundRequest>) -> StatusCode {
    hooks::play_sound(&req.sound);
    StatusCode::NO_CONTENT
}

fn level_to_string(level: NotificationLevel) -> String {
    match level {
        NotificationLevel::Notice => "notice".to_string(),
        NotificationLevel::Warn => "warn".to_string(),
        NotificationLevel::Critical => "critical".to_string(),
    }
}
