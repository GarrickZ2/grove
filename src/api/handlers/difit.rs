//! Difit (Code Review) API handlers

use axum::{extract::Path, http::StatusCode, Json};
use serde::Serialize;

use crate::difit::{self, DifitAvailability};
use crate::storage::{comments, difit_session, tasks, workspace};

// ============================================================================
// Request/Response DTOs
// ============================================================================

/// Difit status response
#[derive(Debug, Serialize)]
pub struct DifitStatusResponse {
    /// Status: "starting" | "running" | "completed" | "no_diff" | "not_available"
    pub status: String,
    /// Difit server URL (e.g., "http://localhost:4968")
    pub url: Option<String>,
    /// Difit process PID
    pub pid: Option<u32>,
}

/// Stop difit response
#[derive(Debug, Serialize)]
pub struct StopDifitResponse {
    pub stopped: bool,
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

/// POST /api/v1/projects/{id}/tasks/{taskId}/difit
/// Start difit or return existing session status
pub async fn start_difit(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<DifitStatusResponse>, StatusCode> {
    // 1. Check difit availability
    let availability = difit::check_available();
    if matches!(availability, DifitAvailability::NotAvailable) {
        return Ok(Json(DifitStatusResponse {
            status: "not_available".to_string(),
            url: None,
            pid: None,
        }));
    }

    // 2. Find project and task
    let (_project, project_key) = find_project_by_id(&id)?;
    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // 3. Check for existing session
    if let Some(session) = difit_session::load_session(&project_key, &task_id) {
        if session.is_difit_alive() {
            return Ok(Json(DifitStatusResponse {
                status: if session.url.is_some() {
                    "running"
                } else {
                    "starting"
                }
                .to_string(),
                url: session.url,
                pid: Some(session.pid),
            }));
        }
        // Clean up dead session
        difit_session::remove_session(&project_key, &task_id);
    }

    // 4. Spawn new difit process (with --no-open for web)
    let handle = difit::spawn_difit(&task.worktree_path, &task.target, &availability, true)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let pid = handle.child_pid;

    // 5. Save session (set monitor_pid to web server PID so TUI doesn't try to reattach)
    let session = difit_session::DifitSession {
        pid,
        task_id: task_id.clone(),
        project_key: project_key.clone(),
        url: None,
        temp_file: handle.temp_file_path.clone(),
        monitor_pid: Some(std::process::id()), // Prevent TUI from reattaching
    };
    difit_session::save_session(&project_key, &task_id, &session)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 6. Spawn background watcher thread
    spawn_difit_watcher(project_key, task_id, handle);

    Ok(Json(DifitStatusResponse {
        status: "starting".to_string(),
        url: None,
        pid: Some(pid),
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/difit
/// Get current difit status
pub async fn get_difit_status(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<DifitStatusResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    match difit_session::load_session(&project_key, &task_id) {
        Some(session) if session.is_difit_alive() => Ok(Json(DifitStatusResponse {
            status: if session.url.is_some() {
                "running"
            } else {
                "starting"
            }
            .to_string(),
            url: session.url,
            pid: Some(session.pid),
        })),
        Some(_) => {
            // Process is dead, clean up
            difit_session::remove_session(&project_key, &task_id);
            Ok(Json(DifitStatusResponse {
                status: "completed".to_string(),
                url: None,
                pid: None,
            }))
        }
        None => Ok(Json(DifitStatusResponse {
            status: "completed".to_string(),
            url: None,
            pid: None,
        })),
    }
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/difit
/// Stop difit process gracefully (sends SIGINT so difit outputs comments)
pub async fn stop_difit(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<StopDifitResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    if let Some(session) = difit_session::load_session(&project_key, &task_id) {
        if session.is_difit_alive() {
            // Send SIGINT (like Ctrl+C) so difit outputs comments before exiting
            let _ = std::process::Command::new("kill")
                .args(["-INT", &session.pid.to_string()])
                .status();

            // Wait a bit for difit to process and output comments
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        // Note: Don't remove session here - let the watcher thread do it after saving comments
    }

    Ok(Json(StopDifitResponse { stopped: true }))
}

/// Background thread: poll difit output and update session URL
fn spawn_difit_watcher(project_key: String, task_id: String, mut handle: difit::DifitHandle) {
    std::thread::spawn(move || {
        // Create URL callback that updates session
        let pk = project_key.clone();
        let tid = task_id.clone();
        let on_url: Box<dyn FnOnce(String) + Send> = Box::new(move |url| {
            if let Some(mut session) = difit_session::load_session(&pk, &tid) {
                session.url = Some(url);
                let _ = difit_session::save_session(&pk, &tid, &session);
            }
        });

        // Wait for difit to complete (this handles URL detection, no-diff, etc.)
        if let Ok(output) = difit::wait_for_completion(&mut handle, Some(on_url)) {
            // Parse and save comments
            let (comments_text, _count) = difit::parse_comments(&output);
            if !comments_text.is_empty() {
                let _ = comments::save_diff_comments(&project_key, &task_id, &comments_text);
            }
        }

        // Clean up session
        difit_session::remove_session(&project_key, &task_id);
    });
}
