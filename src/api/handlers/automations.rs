//! Automation REST API.
//!
//! Endpoints:
//!   GET    /api/v1/projects/{id}/automations                       — list
//!   POST   /api/v1/projects/{id}/automations                       — create
//!   GET    /api/v1/projects/{id}/automations/{aid}                 — get
//!   PUT    /api/v1/projects/{id}/automations/{aid}                 — update
//!   DELETE /api/v1/projects/{id}/automations/{aid}                 — delete
//!   POST   /api/v1/projects/{id}/automations/{aid}/trigger         — run now
//!   GET    /api/v1/projects/{id}/automations/{aid}/runs            — history

use axum::{extract::Path, http::StatusCode, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::automation::cron_util;
use crate::automation::executor;
use crate::storage::automations::{
    self, Automation, AutomationRun, SessionTemplate, TargetMode, TaskTemplate,
};

use super::common::find_project_by_id;

#[derive(Debug, Serialize)]
pub struct AutomationDto {
    pub id: String,
    pub project: String,
    pub name: String,
    pub enabled: bool,
    pub task_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_template: Option<TaskTemplate>,
    pub session_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_template: Option<SessionTemplate>,
    pub prompt: String,
    pub schedule_cron: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<Automation> for AutomationDto {
    fn from(a: Automation) -> Self {
        Self {
            id: a.id,
            project: a.project,
            name: a.name,
            enabled: a.enabled,
            task_mode: target_mode_str(a.task_mode),
            task_id: a.task_id,
            task_template: a.task_template,
            session_mode: target_mode_str(a.session_mode),
            chat_id: a.chat_id,
            session_template: a.session_template,
            prompt: a.prompt,
            schedule_cron: a.schedule_cron,
            last_run_at: a.last_run_at,
            last_run_status: a.last_run_status,
            last_run_error: a.last_run_error,
            next_run_at: a.next_run_at,
            created_at: a.created_at,
            updated_at: a.updated_at,
        }
    }
}

fn target_mode_str(m: TargetMode) -> String {
    match m {
        TargetMode::New => "new".to_string(),
        TargetMode::Existing => "existing".to_string(),
    }
}

fn parse_target_mode(s: &str) -> Result<TargetMode, (StatusCode, String)> {
    match s {
        "new" => Ok(TargetMode::New),
        "existing" => Ok(TargetMode::Existing),
        other => Err((
            StatusCode::BAD_REQUEST,
            format!("invalid mode '{}': expected 'new' or 'existing'", other),
        )),
    }
}

#[derive(Debug, Deserialize)]
pub struct UpsertAutomation {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub task_mode: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub task_template: Option<TaskTemplate>,
    pub session_mode: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub session_template: Option<SessionTemplate>,
    pub prompt: String,
    pub schedule_cron: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct AutomationListResponse {
    pub automations: Vec<AutomationDto>,
}

#[derive(Debug, Serialize)]
pub struct AutomationRunsResponse {
    pub runs: Vec<AutomationRun>,
}

#[derive(Debug, Serialize)]
pub struct TriggerResponse {
    pub run_id: String,
    pub status: String, // 'queued' (running async) | 'failed' (pre-queue)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_chat_id: Option<String>,
}

fn validate_input(
    req: &UpsertAutomation,
) -> Result<(TargetMode, TargetMode), (StatusCode, String)> {
    if req.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".into()));
    }
    if req.prompt.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "prompt is required".into()));
    }
    if let Err(e) = cron_util::validate(&req.schedule_cron) {
        return Err((StatusCode::BAD_REQUEST, e));
    }
    let task_mode = parse_target_mode(&req.task_mode)?;
    let session_mode = parse_target_mode(&req.session_mode)?;
    match task_mode {
        TargetMode::Existing if req.task_id.as_deref().unwrap_or("").is_empty() => {
            return Err((
                StatusCode::BAD_REQUEST,
                "task_id required when task_mode='existing'".into(),
            ))
        }
        TargetMode::New if req.task_template.is_none() => {
            return Err((
                StatusCode::BAD_REQUEST,
                "task_template required when task_mode='new'".into(),
            ))
        }
        _ => {}
    }
    match session_mode {
        TargetMode::Existing if req.chat_id.as_deref().unwrap_or("").is_empty() => {
            return Err((
                StatusCode::BAD_REQUEST,
                "chat_id required when session_mode='existing'".into(),
            ))
        }
        TargetMode::New => {
            let tpl = req.session_template.as_ref().ok_or((
                StatusCode::BAD_REQUEST,
                "session_template required when session_mode='new'".to_string(),
            ))?;
            let agent = tpl.agent.trim();
            if agent.is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "session_template.agent is required".into(),
                ));
            }
            // Resolve aliases (e.g. "claude code" → "claude") and require an
            // installed_agents row exists — otherwise the executor would
            // silently default launch_mode to "acp" at run time, which can
            // mismatch the chat's real launch behaviour (Bug M5).
            let canonical = crate::storage::agent_supplement::resolve_agent_id(agent).into_owned();
            let installed = crate::storage::installed_agents::get(&canonical)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            if installed.is_none() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "agent '{agent}' is not installed — install it first or pick a different one"
                    ),
                ));
            }
        }
        _ => {}
    }
    Ok((task_mode, session_mode))
}

pub async fn list(
    Path(project_id): Path<String>,
) -> Result<Json<AutomationListResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let items = automations::list_by_project(&project_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(AutomationListResponse {
        automations: items.into_iter().map(Into::into).collect(),
    }))
}

pub async fn create(
    Path(project_id): Path<String>,
    Json(req): Json<UpsertAutomation>,
) -> Result<(StatusCode, Json<AutomationDto>), (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let (task_mode, session_mode) = validate_input(&req)?;

    let now = Utc::now().timestamp();
    let next_run_at =
        cron_util::next_unix(&req.schedule_cron).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let automation = Automation {
        id: automations::generate_id(),
        project: project_key,
        name: req.name,
        enabled: req.enabled,
        task_mode,
        task_id: req.task_id,
        task_template: req.task_template,
        session_mode,
        chat_id: req.chat_id,
        session_template: req.session_template,
        prompt: req.prompt,
        schedule_cron: req.schedule_cron,
        last_run_at: None,
        last_run_status: None,
        last_run_error: None,
        next_run_at,
        created_at: now,
        updated_at: now,
    };
    automations::insert(&automation)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(automation.into())))
}

pub async fn get(
    Path((project_id, id)): Path<(String, String)>,
) -> Result<Json<AutomationDto>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let automation = automations::get(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "automation not found".into()))?;
    if automation.project != project_key {
        return Err((StatusCode::NOT_FOUND, "automation not found".into()));
    }
    Ok(Json(automation.into()))
}

pub async fn update(
    Path((project_id, id)): Path<(String, String)>,
    Json(req): Json<UpsertAutomation>,
) -> Result<Json<AutomationDto>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let mut existing = automations::get(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "automation not found".into()))?;
    if existing.project != project_key {
        return Err((StatusCode::NOT_FOUND, "automation not found".into()));
    }
    let (task_mode, session_mode) = validate_input(&req)?;

    let cron_changed = existing.schedule_cron != req.schedule_cron;
    // Re-enabling an automation the scheduler previously system-disabled
    // (cron with no future occurrence → `disable_with_error` cleared
    // next_run_at) should re-advance the schedule. Without this, the toggle
    // flips back to "on" but `load_due` never picks the row up again because
    // next_run_at stays NULL forever.
    let needs_revival = existing.next_run_at.is_none() && req.enabled;
    existing.name = req.name;
    existing.enabled = req.enabled;
    existing.task_mode = task_mode;
    existing.task_id = req.task_id;
    existing.task_template = req.task_template;
    existing.session_mode = session_mode;
    existing.chat_id = req.chat_id;
    existing.session_template = req.session_template;
    existing.prompt = req.prompt;
    existing.schedule_cron = req.schedule_cron;
    existing.updated_at = Utc::now().timestamp();
    if cron_changed || needs_revival {
        existing.next_run_at = cron_util::next_unix(&existing.schedule_cron)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        // Clear the stale "disabled because cron has no future" error so
        // the UI stops showing it once we've successfully re-advanced.
        if needs_revival && existing.next_run_at.is_some() {
            existing.last_run_error = None;
        }
    }
    automations::update(&existing)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(existing.into()))
}

pub async fn delete(
    Path((project_id, id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let automation =
        automations::get(&id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match automation {
        Some(a) if a.project == project_key => {
            automations::delete(&id)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(StatusCode::NO_CONTENT)
        }
        _ => Err((StatusCode::NOT_FOUND, "automation not found".into())),
    }
}

pub async fn trigger(
    Path((project_id, id)): Path<(String, String)>,
) -> Result<Json<TriggerResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let automation = automations::get(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "automation not found".into()))?;
    if automation.project != project_key {
        return Err((StatusCode::NOT_FOUND, "automation not found".into()));
    }

    let outcome = executor::run(&automation, "manual").await;

    Ok(Json(TriggerResponse {
        run_id: outcome.run_id,
        status: outcome.status,
        error: outcome.error,
        resolved_task_id: outcome.resolved_task_id,
        resolved_chat_id: outcome.resolved_chat_id,
    }))
}

#[derive(Debug, Serialize)]
pub struct CancelRunResponse {
    pub status: String, // 'cancelled' | 'noop'
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// POST /api/v1/projects/{id}/automations/{aid}/runs/{run_id}/cancel
///
/// User-initiated cancel of an in-flight or queued automation run.
///
/// We claim the terminal state in one atomic transaction (`claim_cancel`),
/// then dispatch the ACP side-effect based on the **prior** status we won
/// the row from:
///   queued  → drop every pending ACP message tagged `automation:<run_id>`,
///             then emit `QueueUpdate` so the chat-session UI refreshes.
///   running → fire ACP `Cancel` to abort the current agent turn.
///
/// Doing the DB transition first closes the read→write TOCTOU window where
/// the watcher could otherwise promote the row queued→running between our
/// status check and our dequeue call (Bug H2). The watcher's own terminal
/// writes are conditional on `queued`/`running`, so once we've marked the
/// row `cancelled` they become no-ops.
pub async fn cancel_run(
    Path((project_id, _automation_id, run_id)): Path<(String, String, String)>,
) -> Result<Json<CancelRunResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;

    let initial_run = automations::get_run(&run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "run not found".into()))?;

    // Cross-check ownership through the parent automation — the run row
    // carries automation_id but not project.
    let parent = automations::get(&initial_run.automation_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "automation not found".into()))?;
    if parent.project != project_key {
        return Err((StatusCode::NOT_FOUND, "run not found".into()));
    }

    // Claim the cancellation atomically. Whoever wins this race owns the
    // ACP side-effects — the watcher's UPDATE will no-op against the
    // resulting `cancelled` status.
    let prior_status =
        automations::claim_cancel(&run_id, Utc::now().timestamp(), "Cancelled by user")
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let prior_status = match prior_status {
        Some(s) => s,
        None => {
            return Ok(Json(CancelRunResponse {
                status: "noop".into(),
                message: Some(format!("run is already {}", initial_run.status)),
            }))
        }
    };

    // Re-read so we pick up `resolved_task_id` / `resolved_chat_id` that
    // the executor may have stamped via `mark_run_resolved` between our
    // initial read and `claim_cancel`. Without this re-read, a cancel
    // racing the executor's resolve step would skip the ACP side-effect
    // entirely (the agent would keep running while the DB showed
    // "cancelled") — Bugs H2 / M5.
    let run = automations::get_run(&run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .unwrap_or(initial_run);

    // Best-effort ACP side-effect. We don't surface failures because the
    // DB row is already `cancelled` — telling the client the cancel failed
    // would lie about visible state.
    if let (Some(task_id), Some(chat_id)) = (
        run.resolved_task_id.as_deref(),
        run.resolved_chat_id.as_deref(),
    ) {
        let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
        let sender_tag = format!("automation:{}", run_id);
        if let Some(handle) = crate::acp::get_session_handle(&session_key) {
            if prior_status == "queued" {
                let removed = handle.dequeue_messages_by_sender(&sender_tag);
                if removed > 0 {
                    // Mirror dequeue_message_by_id callers elsewhere:
                    // broadcast the new queue so pending-message UI in
                    // the chat session refreshes in real time.
                    handle.emit(crate::acp::AcpUpdate::QueueUpdate {
                        messages: handle.get_queue(),
                    });
                }
                // If `removed == 0` the prompt isn't in the pending queue.
                // Two scenarios collide here:
                //   (A) Watcher-side broadcast lag has left the row stuck
                //       in DB-`queued` even though the agent already
                //       completed our turn and cmd_loop has since moved
                //       on to a *different* prompt. Sending `cancel` now
                //       would abort the innocent in-flight turn.
                //   (B) CAS-win path: executor sent the prompt directly,
                //       so it never queued; the agent is currently
                //       running it.
                // We can't distinguish (A) from (B) at this layer, and
                // (A)'s collateral damage (aborting an unrelated turn) is
                // strictly worse than (B)'s leak (one orphan turn finishes
                // and its result is discarded because the row is already
                // `cancelled`). So we do nothing — the row stays
                // cancelled, the watcher's conditional writes stay no-ops.
            } else {
                // running: ask ACP to abort the current turn.
                let _ = handle.cancel().await;
            }
        }
    }

    Ok(Json(CancelRunResponse {
        status: "cancelled".into(),
        message: None,
    }))
}

pub async fn list_runs(
    Path((project_id, id)): Path<(String, String)>,
) -> Result<Json<AutomationRunsResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let automation = automations::get(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "automation not found".into()))?;
    if automation.project != project_key {
        return Err((StatusCode::NOT_FOUND, "automation not found".into()));
    }
    let runs = automations::list_runs(&id, 50)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(AutomationRunsResponse { runs }))
}
