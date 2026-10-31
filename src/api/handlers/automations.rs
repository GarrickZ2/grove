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

use crate::api::device_auth::RevocableWebSocketUpgrade as WebSocketUpgrade;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::automation::cron_util;
use crate::automation::executor;
use crate::storage::automations::{
    self, AgentConfigSelection, Automation, AutomationRun, SessionTemplate, TargetMode,
    TaskTemplate, TASK_PROMPT_HANDLER,
};

use super::common::find_project_by_id;

fn ensure_user_managed(automation: &Automation) -> Result<(), (StatusCode, String)> {
    if automation.handler_key == TASK_PROMPT_HANDLER {
        return Ok(());
    }
    Err((
        StatusCode::CONFLICT,
        "system-managed automation; configure it from the feature that created it".into(),
    ))
}

#[derive(Debug, Serialize)]
pub struct AutomationDto {
    pub id: String,
    pub project: String,
    pub name: String,
    pub enabled: bool,
    pub handler_key: String,
    pub agent_config: AgentConfigSelection,
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
    pub event_triggers: Vec<String>,
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
            handler_key: a.handler_key,
            agent_config: a.agent_config,
            task_mode: target_mode_str(a.task_mode),
            task_id: a.task_id,
            task_template: a.task_template,
            session_mode: target_mode_str(a.session_mode),
            chat_id: a.chat_id,
            session_template: a.session_template,
            prompt: a.prompt,
            schedule_cron: a.schedule_cron,
            event_triggers: a.event_triggers,
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
        TargetMode::BuddyActive => "buddy_active".to_string(),
    }
}

fn parse_target_mode(s: &str) -> Result<TargetMode, (StatusCode, String)> {
    match s {
        "new" => Ok(TargetMode::New),
        "existing" => Ok(TargetMode::Existing),
        "buddy_active" => Ok(TargetMode::BuddyActive),
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
    #[serde(default)]
    pub agent_config: Option<AgentConfigSelection>,
    #[serde(default)]
    pub event_triggers: Vec<String>,
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

/// Generic live Automation Run stream. Memory and future consumers share the
/// same event rather than creating domain-specific Run channels.
pub async fn run_updates_ws(ws: WebSocketUpgrade, Path(id): Path<String>) -> Response {
    let project_key = match find_project_by_id(&id) {
        Ok((_project, key)) => key,
        Err(status) => return status.into_response(),
    };
    ws.on_upgrade(move |socket| stream_run_updates(socket, project_key))
}

async fn stream_run_updates(mut socket: WebSocket, project_key: String) {
    let mut updates = automations::subscribe_run_updates();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    loop {
        tokio::select! {
            update = updates.recv() => match update {
                Ok(update) if update.project == project_key => {
                    if let Ok(text) = serde_json::to_string(&update) {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
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
    if task_mode == TargetMode::BuddyActive {
        return Err((
            StatusCode::BAD_REQUEST,
            "buddy_active is only a session_mode".into(),
        ));
    }
    if session_mode == TargetMode::BuddyActive
        && (task_mode != TargetMode::Existing
            || req.task_id.as_deref() != Some(crate::storage::tasks::LOCAL_TASK_ID)
            || req.chat_id.is_some()
            || req.session_template.is_some()
            || req.task_template.is_some())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "buddy_active requires the Buddy Local Task without a fixed Session".into(),
        ));
    }

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
            // Canonicalize to match what `executor::run` does downstream —
            // a legacy id (`claude`, `gh-copilot`, …) was previously
            // rejected here even though execution would resolve fine.
            let canonical = crate::storage::installed_agents::canonicalize_agent_id(agent);
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
    if session_mode == TargetMode::BuddyActive
        && crate::storage::buddies::get_by_project(
            &crate::storage::database::connection(),
            &project_key,
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "buddy_active requires a Buddy Project".into(),
        ));
    }

    let now = Utc::now().timestamp();
    let next_run_at =
        cron_util::next_unix(&req.schedule_cron).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let automation = Automation {
        id: automations::generate_id(),
        project: project_key,
        name: req.name,
        enabled: req.enabled,
        handler_key: TASK_PROMPT_HANDLER.to_string(),
        agent_config: req
            .agent_config
            .unwrap_or_else(|| AgentConfigSelection::Default {
                agent_id: req
                    .session_template
                    .as_ref()
                    .map(|template| template.agent.clone()),
            })
            .reconciled_with_installed_snapshot()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
        task_mode,
        task_id: req.task_id,
        task_template: req.task_template,
        session_mode,
        chat_id: req.chat_id,
        session_template: req.session_template,
        prompt: req.prompt,
        schedule_cron: req.schedule_cron,
        event_triggers: req.event_triggers,
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
    ensure_user_managed(&existing)?;
    let (task_mode, session_mode) = validate_input(&req)?;
    if session_mode == TargetMode::BuddyActive
        && crate::storage::buddies::get_by_project(
            &crate::storage::database::connection(),
            &project_key,
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "buddy_active requires a Buddy Project".into(),
        ));
    }

    let cron_changed = existing.schedule_cron != req.schedule_cron;
    // Re-enabling an automation the scheduler previously system-disabled
    // (cron with no future occurrence → `disable_with_error` cleared
    // next_run_at) should re-advance the schedule. Without this, the toggle
    // flips back to "on" but `load_due` never picks the row up again because
    // next_run_at stays NULL forever.
    let needs_revival = existing.next_run_at.is_none() && req.enabled;
    existing.name = req.name;
    existing.enabled = req.enabled;
    if let Some(agent_config) = req.agent_config {
        existing.agent_config = agent_config
            .reconciled_with_installed_snapshot()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }
    existing.task_mode = task_mode;
    existing.task_id = req.task_id;
    existing.task_template = req.task_template;
    existing.session_mode = session_mode;
    existing.chat_id = req.chat_id;
    existing.session_template = req.session_template;
    existing.prompt = req.prompt;
    existing.schedule_cron = req.schedule_cron;
    existing.event_triggers = req.event_triggers;
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
            ensure_user_managed(&a)?;
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

#[derive(Debug, Serialize)]
pub struct FinishRunResponse {
    pub status: String,
}

/// Ask the existing ordinary Chat Session to finish the Memory organization.
/// The Agent remains responsible for calling memory_mark_organization_finished;
/// that MCP call completes the business Run without ending the Chat Session.
pub async fn finish_run(
    Path((project_id, automation_id, run_id)): Path<(String, String, String)>,
) -> Result<Json<FinishRunResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|s| (s, "project not found".to_string()))?;
    let run = automations::get_run(&run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .filter(|run| run.automation_id == automation_id)
        .ok_or((StatusCode::NOT_FOUND, "run not found".into()))?;
    let parent = automations::get(&automation_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .filter(|automation| automation.project == project_key)
        .ok_or((StatusCode::NOT_FOUND, "run not found".into()))?;
    if parent.handler_key != automations::MEMORY_ORGANIZATION_HANDLER {
        return Err((
            StatusCode::BAD_REQUEST,
            "run does not support Finish".into(),
        ));
    }
    if matches!(run.status.as_str(), "success" | "cancelled" | "cancelling") {
        return Err((
            StatusCode::CONFLICT,
            format!("run is already {}", run.status),
        ));
    }
    let (Some(task_id), Some(chat_id)) = (
        run.resolved_task_id.as_deref(),
        run.resolved_chat_id.as_deref(),
    ) else {
        return Err((StatusCode::CONFLICT, "run session is not ready".into()));
    };
    let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
    let handle = crate::acp::get_session_handle(&session_key)
        .ok_or((StatusCode::CONFLICT, "run session is offline".into()))?;
    automations::mark_run_running(&run_id)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if let Err(error) = handle
        .send_prompt(
            "Finish this Memory organization now. Complete any remaining checks, then call memory_mark_organization_finished exactly once with the final summary and Entity base scores.".to_string(),
            Vec::new(),
            None,
            false,
            None,
        )
        .await
    {
        let message = error.to_string();
        let _ = automations::mark_run_failed(&run_id, "queue", &message);
        return Err((StatusCode::CONFLICT, message));
    }
    Ok(Json(FinishRunResponse {
        status: "finishing".to_string(),
    }))
}

/// POST /api/v1/projects/{id}/automations/{aid}/runs/{run_id}/cancel
///
/// User-initiated cancel of an in-flight or queued automation run.
///
/// We first claim a non-terminal `cancelling` state in one atomic transaction,
/// then dispatch the ACP side-effect based on the **prior** status we won the
/// row from:
///   queued  → drop every pending ACP message tagged `automation:<run_id>`,
///             then emit `QueueUpdate` so the chat-session UI refreshes.
///   running → fire ACP `Cancel` to abort the current agent turn.
///
/// The intermediate state closes the read→write TOCTOU window where
/// the watcher could otherwise promote the row queued→running between our
/// status check and our dequeue call. It also remains active for Single Flight
/// until ACP cancellation and the business handler's abort cleanup are done.
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

    let _buddy_run_gate = if parent.session_mode == TargetMode::BuddyActive {
        Some(crate::buddy::lock(&format!("routine-run:{run_id}")).await)
    } else {
        None
    };

    // Claim the cancellation atomically. Whoever wins this race owns the
    // ACP side-effects — the watcher's UPDATE will no-op against the
    // resulting `cancelled` status.
    let prior_status = automations::claim_cancel(&run_id, "Cancelled by user")
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
    // entirely (the agent would keep running while the DB showed an active
    // cancellation) — Bugs H2 / M5.
    let run = automations::get_run(&run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .unwrap_or(initial_run);

    // Best-effort ACP side-effect. The DB remains in `cancelling` until both
    // this and the handler abort hook have had a chance to clean up.
    if run.execution_scope == "project_run" {
        // Cancelling the business Run does not end its ordinary Chat Session.
        // Abort only the current Agent turn, if one is active; the Chat remains
        // available through the same TaskChat lifecycle afterwards.
        if let (Some(task_id), Some(chat_id)) = (
            run.resolved_task_id.as_deref(),
            run.resolved_chat_id.as_deref(),
        ) {
            let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
            if let Some(handle) = crate::acp::get_session_handle(&session_key) {
                let _ = handle.cancel().await;
            }
        }
    } else if let (Some(task_id), Some(chat_id)) = (
        run.resolved_task_id.as_deref(),
        run.resolved_chat_id.as_deref(),
    ) {
        let session_key = format!("{}:{}:{}", project_key, task_id, chat_id);
        let sender_tag = format!("automation:{}", run_id);
        if let Some(handle) = crate::acp::get_session_handle(&session_key) {
            if parent.session_mode == TargetMode::BuddyActive {
                handle.dequeue_messages_by_sender(&sender_tag);
                handle.emit(crate::acp::AcpUpdate::QueueUpdate {
                    messages: handle.get_queue(),
                });
                let _ = handle.cancel_prompts(vec![sender_tag]).await;
            } else if prior_status == "queued" {
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

    if let Some(handler) = crate::automation::consumer::get(&parent.handler_key) {
        if let Err(error) = handler.abort(crate::automation::consumer::AbortContext {
            automation: &parent,
            run: &run,
            reason: "Cancelled by user",
        }) {
            crate::automation::awarn!("abort handler for cancelled run {run_id}: {error}");
        }
    }

    automations::finish_cancel(&run_id, Utc::now().timestamp(), "Cancelled by user")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
