//! Hooks (notification) API handlers

use axum::{extract::Path, http::StatusCode, Json};
use chrono::{DateTime, Utc};
use serde::Serialize;

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
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut all_hooks: Vec<HookEntryResponse> = Vec::new();

    for project in &projects {
        let project_key = workspace::project_hash(&project.path);
        let hooks_file = hooks::load_hooks_with_cleanup(&project.path);

        if hooks_file.tasks.is_empty() {
            continue;
        }

        // Load task data to get task names
        let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();
        let archived_tasks = tasks::load_archived_tasks(&project_key).unwrap_or_default();

        for (task_id, entry) in &hooks_file.tasks {
            // Find task name
            let task_name = active_tasks
                .iter()
                .chain(archived_tasks.iter())
                .find(|t| t.id == *task_id)
                .map(|t| t.name.clone())
                .unwrap_or_else(|| task_id.clone());

            all_hooks.push(HookEntryResponse {
                task_id: task_id.clone(),
                task_name,
                level: level_to_string(entry.level),
                timestamp: entry.timestamp,
                message: entry.message.clone(),
                project_id: project_key.clone(),
                project_name: project.name.clone(),
            });
        }
    }

    // Sort by timestamp descending (newest first)
    all_hooks.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

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

fn level_to_string(level: NotificationLevel) -> String {
    match level {
        NotificationLevel::Notice => "notice".to_string(),
        NotificationLevel::Warn => "warn".to_string(),
        NotificationLevel::Critical => "critical".to_string(),
    }
}
