//! Hooks (notification) API handlers

use axum::{extract::Path, http::HeaderMap, http::StatusCode, Json};
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
    /// None for legacy entries written before hooks tracked chat context.
    /// Frontend falls back to navigating to the task only when null.
    pub chat_id: Option<String>,
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
                chat_id: record.entry.chat_id,
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
            chat_id: record.entry.chat_id,
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

pub async fn clear_all_hooks() -> StatusCode {
    hooks::remove_all_hooks();
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

/// POST /hooks/report — attention-fact intake for same-machine producers.
///
/// The `grove hooks` CLI runs inside a task's tmux session: a short-lived
/// process whose radio publishes die with it. Reporting here hands the fact
/// to the live server process instead, so its `HookAdded` broadcast actually
/// reaches attached frontends.
///
/// Auth model: in no-auth mode the server is loopback-only, so anyone who can
/// reach this could already write `~/.grove` directly. In HMAC (mobile) mode
/// the CLI holds no secret key, so it authenticates with the per-boot
/// local-report token the server writes to `~/.grove/local_report_token`.
/// HMAC mode is FAIL-CLOSED: until a token exists and matches, every report
/// is rejected — a failed token write must never silently open the endpoint.
static LOCAL_REPORT_TOKEN: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();
static LOCAL_REPORT_REQUIRED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn set_local_report_token(token: String) {
    let _ = LOCAL_REPORT_TOKEN.set(token);
}

/// Provision the per-boot local-report token and publish it to the token
/// file for same-machine CLIs. Called at server startup in HMAC mode only.
/// The `required` flag flips BEFORE the file write, so a failed write leaves
/// the endpoint rejecting everything instead of accepting everything.
pub fn provision_local_report_token() -> std::io::Result<()> {
    LOCAL_REPORT_REQUIRED.store(true, std::sync::atomic::Ordering::Relaxed);
    let token = crate::api::auth::generate_secret_key();
    let grove_dir = crate::storage::grove_dir();
    std::fs::create_dir_all(&grove_dir)?;
    let path = grove_dir.join("local_report_token");
    std::fs::write(&path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    set_local_report_token(token);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct HookReportRequest {
    pub project_id: String,
    pub task_id: String,
    pub level: String,
    pub message: Option<String>,
    pub chat_id: Option<String>,
}

pub async fn report_hook(headers: HeaderMap, Json(req): Json<HookReportRequest>) -> StatusCode {
    if LOCAL_REPORT_REQUIRED.load(std::sync::atomic::Ordering::Relaxed) {
        let expected = LOCAL_REPORT_TOKEN.get();
        let presented = headers
            .get("x-grove-local-token")
            .and_then(|v| v.to_str().ok());
        // Fail-closed: unset token (provisioning failed) rejects everything.
        match expected {
            Some(expected) if presented == Some(expected.as_str()) => {}
            _ => return StatusCode::UNAUTHORIZED,
        }
    }
    let level = hooks::level_from_str(&req.level).unwrap_or(NotificationLevel::Notice);
    // 5xx on persistence failure: the CLI treats any non-2xx as "not handed
    // off" and falls back to writing the record itself.
    match hooks::update_hook(
        &req.project_id,
        &req.task_id,
        crate::hooks::HookFact {
            kind: crate::hooks::HookKind::External,
            label: None,
            level: Some(level),
            message: req.message,
            chat_id: req.chat_id,
            permission: None,
        },
    ) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(e) => {
            eprintln!(
                "hooks: report for {}/{} failed to persist: {}",
                req.project_id, req.task_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

fn level_to_string(level: NotificationLevel) -> String {
    match level {
        NotificationLevel::Notice => "notice".to_string(),
        NotificationLevel::Warn => "warn".to_string(),
        NotificationLevel::Critical => "critical".to_string(),
    }
}

use axum::extract::Query;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiOpenTaskQuery {
    pub project_id: String,
    pub task_id: String,
    pub chat_id: Option<String>,
}

/// POST /gui/open-task — banner "Open" click-through. Broadcasts a FocusTask
/// radio event (web pages / phones navigate) and, in GUI builds, surfaces the
/// desktop window. Registered for ALL builds behind the auth layer: a remote
/// GUI reaches it through its signing proxy, non-gui mobile builds still
/// serve the radio half.
pub async fn handle_gui_open_task(Query(q): Query<GuiOpenTaskQuery>) -> StatusCode {
    // 广播 RadioEvent 焦点切换事件，使得所有连接的 Grove Web 网页端以及移动端客户端都能自动完成跳转！
    let target = q
        .chat_id
        .clone()
        .filter(|s| !s.is_empty())
        .map(|chat_id| crate::radio::TargetMode::Chat { chat_id });
    crate::radio::publish(crate::radio::RadioEvent::FocusTask {
        project_id: q.project_id.clone(),
        task_id: q.task_id.clone(),
        target,
    });

    #[cfg(feature = "gui")]
    if let Some(app) = crate::cli::gui::TAURI_APP.get() {
        let _ = crate::tray::tray_open_task(app.clone(), q.project_id, q.task_id, q.chat_id);
    }

    StatusCode::OK
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiResolvePermissionQuery {
    pub project_id: String,
    pub task_id: String,
    pub chat_id: String,
    pub option_id: String,
}

/// POST /gui/resolve-permission — permission response from a native banner's
/// Approve/Deny buttons. Mirrors `walkie_talkie::tray_resolve_permission`:
/// look up the live ACP session by key and respond. Same session handles as
/// the Tauri tray command, but reachable over authenticated HTTP so remote
/// GUI proxies (which sign these) and non-gui builds work too.
pub async fn handle_gui_resolve_permission(
    Query(q): Query<GuiResolvePermissionQuery>,
) -> StatusCode {
    let session_key = format!("{}:{}:{}", q.project_id, q.task_id, q.chat_id);
    match crate::acp::get_session_handle(&session_key) {
        Some(handle) => {
            if handle.respond_permission(q.option_id) {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            }
        }
        None => StatusCode::NOT_FOUND,
    }
}
