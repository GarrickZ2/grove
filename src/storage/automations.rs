//! Automation persistence layer.
//!
//! An Automation is a scheduled prompt: at each cron tick the scheduler
//! resolves a target Task + ChatSession (creating them if `_mode = "new"`),
//! then injects `prompt` into that chat. The injection itself reuses the
//! agent_graph delivery path — see `src/automation/executor.rs`.
//!
//! `task_template` and `session_template` are JSON blobs only read when the
//! corresponding mode is `new`. They're intentionally opaque at the SQL layer
//! so the schema doesn't have to evolve every time the new-task form gains a
//! field.

use once_cell::sync::Lazy;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};

pub use crate::agent_config::AgentConfigSelection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetMode {
    New,
    Existing,
}

impl TargetMode {
    fn as_str(self) -> &'static str {
        match self {
            TargetMode::New => "new",
            TargetMode::Existing => "existing",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "existing" => TargetMode::Existing,
            _ => TargetMode::New,
        }
    }
}

/// JSON shape stored in `automations.task_template` when `task_mode = "new"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTemplate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// JSON shape stored in `automations.session_template` when `session_mode = "new"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTemplate {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

pub const TASK_PROMPT_HANDLER: &str = "builtin.task_prompt";
pub const MEMORY_ORGANIZATION_HANDLER: &str = "grove.memory.organization";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub project: String,
    pub name: String,
    pub enabled: bool,
    pub handler_key: String,
    #[serde(default)]
    pub agent_config: AgentConfigSelection,
    pub task_mode: TargetMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_template: Option<TaskTemplate>,
    pub session_mode: TargetMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_template: Option<SessionTemplate>,
    pub prompt: String,
    pub schedule_cron: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_triggers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One automation execution. See `database.rs` for the column-level docs.
///
/// `status` follows the state machine:
///   queued/running → waiting ↔ running
///                  → failed  ↔ running
///                  → success | cancelled
///
/// Errors are recorded on the Run without changing its lifecycle state. Only
/// completion or explicit user cancellation makes a persisted Run terminal.
///
/// `queued_at` is NULL until the prompt successfully enters the ACP queue
/// (failures before that point leave it NULL). `completed_at` is NULL until
/// the ACP `Complete` notification arrives or the user cancels the Run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub trigger_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_payload: Option<serde_json::Value>,
    pub prompt_snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_snapshot: Option<String>,
    #[serde(default)]
    pub agent_config_snapshot: AgentConfigSelection,
    #[serde(default)]
    pub input: serde_json::Value,
    pub execution_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_chat_id: Option<String>,
    pub triggered_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_response: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutomationRunUpdate {
    pub project: String,
    pub automation_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<AutomationRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<serde_json::Value>,
}

static RUN_UPDATES: Lazy<tokio::sync::broadcast::Sender<AutomationRunUpdate>> = Lazy::new(|| {
    let (sender, _) = tokio::sync::broadcast::channel(1024);
    sender
});

pub fn subscribe_run_updates() -> tokio::sync::broadcast::Receiver<AutomationRunUpdate> {
    RUN_UPDATES.subscribe()
}

fn publish_run_update(run_id: &str) {
    if let Ok(Some(run)) = get_run(run_id) {
        if let Ok(Some(automation)) = get(&run.automation_id) {
            let _ = RUN_UPDATES.send(AutomationRunUpdate {
                project: automation.project,
                automation_id: run.automation_id.clone(),
                run_id: run.id.clone(),
                run: Some(run),
                event: None,
            });
        }
    }
}

/// Publish one live event for an Automation Run over the same project-scoped
/// WebSocket as status updates. The complete event remains on disk; this copy
/// is bounded so large tool results cannot turn the live channel into a raw
/// transcript transport.
pub fn publish_run_event<T: Serialize>(
    project_id: &str,
    automation_id: &str,
    run_id: &str,
    event: &T,
) {
    let Ok(mut event) = serde_json::to_value(event) else {
        return;
    };
    bound_live_value(&mut event);
    if serde_json::to_vec(&event).is_ok_and(|bytes| bytes.len() > 64 * 1024) {
        if let serde_json::Value::Object(fields) = &mut event {
            for field in ["output", "content", "display_content", "raw_input"] {
                fields.remove(field);
            }
            fields.insert(
                "live_output_truncated".to_string(),
                serde_json::Value::Bool(true),
            );
        }
    }
    let _ = RUN_UPDATES.send(AutomationRunUpdate {
        project: project_id.to_string(),
        automation_id: automation_id.to_string(),
        run_id: run_id.to_string(),
        run: None,
        event: Some(event),
    });
}

fn bound_live_value(value: &mut serde_json::Value) {
    const MAX_STRING_CHARS: usize = 16 * 1024;
    const MAX_ARRAY_ITEMS: usize = 100;

    match value {
        serde_json::Value::String(text) => {
            if text.chars().count() > MAX_STRING_CHARS {
                let mut bounded: String = text.chars().take(MAX_STRING_CHARS).collect();
                bounded.push_str("\n… live output truncated; full output is stored in Run history");
                *text = bounded;
            }
        }
        serde_json::Value::Array(items) => {
            let original_len = items.len();
            items.truncate(MAX_ARRAY_ITEMS);
            for item in items.iter_mut() {
                bound_live_value(item);
            }
            if original_len > MAX_ARRAY_ITEMS {
                items.push(serde_json::Value::String(format!(
                    "… {} additional items hidden from live output",
                    original_len - MAX_ARRAY_ITEMS
                )));
            }
        }
        serde_json::Value::Object(fields) => {
            for item in fields.values_mut() {
                bound_live_value(item);
            }
        }
        _ => {}
    }
}

const COLUMNS: &str = "id, project, name, enabled, handler_key, agent_config_json,
     task_mode, task_id, task_template, session_mode, chat_id, session_template, prompt, schedule_cron,
     event_triggers_json,
     last_run_at, last_run_status, last_run_error, next_run_at, created_at, updated_at";

fn row_to_automation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let agent_config_json: String = row.get(5)?;
    let task_template: Option<String> = row.get(8)?;
    let session_template: Option<String> = row.get(11)?;
    let event_triggers_json: String = row.get(14)?;
    let enabled: i64 = row.get(3)?;
    let task_mode: String = row.get(6)?;
    let session_mode: String = row.get(9)?;
    Ok(Automation {
        id: row.get(0)?,
        project: row.get(1)?,
        name: row.get(2)?,
        enabled: enabled != 0,
        handler_key: row.get(4)?,
        agent_config: serde_json::from_str(&agent_config_json).unwrap_or_default(),
        task_mode: TargetMode::parse(&task_mode),
        task_id: row.get(7)?,
        task_template: task_template
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        session_mode: TargetMode::parse(&session_mode),
        chat_id: row.get(10)?,
        session_template: session_template
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        prompt: row.get(12)?,
        schedule_cron: row.get(13)?,
        event_triggers: serde_json::from_str(&event_triggers_json).unwrap_or_default(),
        last_run_at: row.get(15)?,
        last_run_status: row.get(16)?,
        last_run_error: row.get(17)?,
        next_run_at: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

pub fn list_by_project(project: &str) -> Result<Vec<Automation>> {
    let conn = super::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM automations WHERE project = ?1 ORDER BY updated_at DESC"
    ))?;
    let rows = stmt
        .query_map(params![project], row_to_automation)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(id: &str) -> Result<Option<Automation>> {
    let conn = super::database::connection();
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM automations WHERE id = ?1"),
            params![id],
            row_to_automation,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(a: &Automation) -> Result<()> {
    let conn = super::database::connection();
    insert_on(&conn, a)
}

pub(crate) fn insert_on(conn: &rusqlite::Connection, a: &Automation) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO automations ({COLUMNS})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)"
        ),
        params![
            a.id,
            a.project,
            a.name,
            a.enabled as i64,
            a.handler_key,
            serde_json::to_string(&a.agent_config)?,
            a.task_mode.as_str(),
            a.task_id,
            a.task_template
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_default()),
            a.session_mode.as_str(),
            a.chat_id,
            a.session_template
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_default()),
            a.prompt,
            a.schedule_cron,
            serde_json::to_string(&a.event_triggers)?,
            a.last_run_at,
            a.last_run_status,
            a.last_run_error,
            a.next_run_at,
            a.created_at,
            a.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update(a: &Automation) -> Result<()> {
    let conn = super::database::connection();
    update_on(&conn, a)
}

pub(crate) fn update_on(conn: &rusqlite::Connection, a: &Automation) -> Result<()> {
    conn.execute(
        "UPDATE automations SET
            name=?1, enabled=?2, handler_key=?3, agent_config_json=?4,
            task_mode=?5, task_id=?6, task_template=?7,
            session_mode=?8, chat_id=?9, session_template=?10, prompt=?11,
            schedule_cron=?12, event_triggers_json=?13, next_run_at=?14, updated_at=?15
         WHERE id=?16",
        params![
            a.name,
            a.enabled as i64,
            a.handler_key,
            serde_json::to_string(&a.agent_config)?,
            a.task_mode.as_str(),
            a.task_id,
            a.task_template
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_default()),
            a.session_mode.as_str(),
            a.chat_id,
            a.session_template
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_default()),
            a.prompt,
            a.schedule_cron,
            serde_json::to_string(&a.event_triggers)?,
            a.next_run_at,
            a.updated_at,
            a.id,
        ],
    )?;
    Ok(())
}

pub fn delete(id: &str) -> Result<()> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    let artifacts = collect_run_artifacts(&tx, id, false)?;
    tx.execute(
        "DELETE FROM automation_runs WHERE automation_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM automations WHERE id = ?1", params![id])?;
    tx.commit()?;
    drop(conn);
    cleanup_run_artifacts(artifacts);
    Ok(())
}

/// Scheduler hot path: fetch all due-and-enabled automations and atomically
/// advance their `next_run_at`. Returning the post-update row guarantees that
/// concurrent ticks can't double-fire the same automation — the second tick
/// would see the already-advanced timestamp and skip.
///
/// `now`, `next_runs` are unix seconds.
pub fn claim_due(now: i64, next_runs: &[(&str, i64)]) -> Result<()> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    for (id, next) in next_runs {
        tx.execute(
            "UPDATE automations SET next_run_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![next, now, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Disable an automation whose cron has no future occurrences. Clears
/// `next_run_at` (so `load_due` stops returning it) and stamps
/// `last_run_error` so the UI explains why it stopped. Used by the
/// scheduler when `advance_next_run` returns `None` — without this the
/// row would otherwise keep firing every tick because `next_run_at`
/// stays at the original past value.
pub fn disable_with_error(id: &str, reason: &str) -> Result<()> {
    let conn = super::database::connection();
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE automations
         SET enabled = 0, next_run_at = NULL, last_run_error = ?1, updated_at = ?2
         WHERE id = ?3",
        params![reason, now, id],
    )?;
    Ok(())
}

pub fn load_due(now: i64) -> Result<Vec<Automation>> {
    let conn = super::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM automations
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
         ORDER BY next_run_at ASC"
    ))?;
    let rows = stmt
        .query_map(params![now], row_to_automation)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Recompute the derived next-fire timestamp for every persisted automation.
///
/// `schedule_cron` is intentionally left untouched: it stores standard
/// 5-field cron, while `cron_util` adapts that public format to the backend
/// parser. This is used by the v2.8 migration to correct timestamps that were
/// previously calculated with the parser's different weekday numbering.
pub fn recompute_all_next_runs() -> Result<usize> {
    let conn = super::database::connection();
    recompute_all_next_runs_on(&conn)
}

fn recompute_all_next_runs_on(conn: &rusqlite::Connection) -> Result<usize> {
    let schedules = {
        let mut stmt = conn.prepare("SELECT id, schedule_cron FROM automations")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    let mut next_runs = Vec::with_capacity(schedules.len());
    for (id, schedule) in schedules {
        let next = crate::automation::cron_util::next_unix(&schedule).map_err(|error| {
            GroveError::storage(format!(
                "invalid persisted automation cron for {id}: {error}"
            ))
        })?;
        next_runs.push((id, next));
    }

    let tx = conn.unchecked_transaction()?;
    for (id, next_run_at) in &next_runs {
        tx.execute(
            "UPDATE automations SET next_run_at = ?1 WHERE id = ?2",
            params![next_run_at, id],
        )?;
    }
    tx.commit()?;
    Ok(next_runs.len())
}

/// Maximum agent_response length stored per run. Anything longer is
/// truncated with a `... [N more bytes]` marker so callers can still tell
/// the response was clipped without pulling chat history.
pub const AGENT_RESPONSE_MAX_BYTES: usize = 16 * 1024;

const RUN_COLUMNS: &str = "id, automation_id, trigger_kind, trigger_payload_json,
     prompt_snapshot, agent_snapshot, agent_config_snapshot_json, input_json, execution_scope,
     resolved_task_id, resolved_chat_id, triggered_at, queued_at, started_at, completed_at,
     status, phase, error, agent_response, result_json";

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    let trigger_payload: Option<String> = row.get(3)?;
    let agent_config_json: String = row.get(6)?;
    let input_json: String = row.get(7)?;
    let result_json: Option<String> = row.get(19)?;
    let status: String = row.get(15)?;
    Ok(AutomationRun {
        id: row.get(0)?,
        automation_id: row.get(1)?,
        trigger_kind: row.get(2)?,
        trigger_payload: trigger_payload.and_then(|value| serde_json::from_str(&value).ok()),
        prompt_snapshot: row.get(4)?,
        agent_snapshot: row.get(5)?,
        agent_config_snapshot: serde_json::from_str(&agent_config_json).unwrap_or_default(),
        input: serde_json::from_str(&input_json).unwrap_or_else(|_| serde_json::json!({})),
        execution_scope: row.get(8)?,
        resolved_task_id: row.get(9)?,
        resolved_chat_id: row.get(10)?,
        triggered_at: row.get(11)?,
        queued_at: row.get(12)?,
        started_at: row.get(13)?,
        completed_at: row.get(14)?,
        status: match status.as_str() {
            "timeout" | "interrupted" => "failed".to_string(),
            _ => status,
        },
        phase: row.get(16)?,
        error: row.get(17)?,
        agent_response: row.get(18)?,
        result: result_json.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

#[derive(Debug, Clone)]
pub enum RunClaim {
    Created(String),
    Existing(Box<AutomationRun>),
}

/// Atomically claim one Automation execution.
///
/// SQLite access is serialized through Grove's shared connection, and the
/// occupied-run lookup plus insert live in one transaction. `single_flight`
/// therefore prevents manual, scheduled and event triggers from starting the
/// same Automation concurrently while an attempt is queued, running, waiting,
/// or cancelling. A failed attempt remains recoverable in its own Session, but
/// does not reserve the execution slot for every future trigger.
#[allow(clippy::too_many_arguments)]
pub fn claim_run(
    automation_id: &str,
    trigger_kind: &str,
    trigger_payload: Option<&serde_json::Value>,
    prompt_snapshot: &str,
    agent_snapshot: Option<&str>,
    agent_config_snapshot: &AgentConfigSelection,
    input: &serde_json::Value,
    execution_scope: &str,
    triggered_at: i64,
    single_flight: bool,
) -> Result<RunClaim> {
    let id = format!("arun-{}", uuid::Uuid::new_v4().simple());
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    if single_flight {
        let existing = tx
            .query_row(
                &format!(
                    "SELECT {RUN_COLUMNS} FROM automation_runs
                     WHERE automation_id = ?1 AND status IN ('queued','running','waiting','cancelling')
                     ORDER BY triggered_at DESC LIMIT 1"
                ),
                params![automation_id],
                row_to_run,
            )
            .optional()?;
        if let Some(existing) = existing {
            tx.commit()?;
            return Ok(RunClaim::Existing(Box::new(existing)));
        }
    }
    tx.execute(
        "INSERT INTO automation_runs
         (id, automation_id, trigger_kind, trigger_payload_json,
          prompt_snapshot, agent_snapshot, agent_config_snapshot_json, input_json, execution_scope,
          resolved_task_id, resolved_chat_id, triggered_at, queued_at, started_at, completed_at,
          status, phase, error, agent_response, result_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, NULL, NULL, ?10, NULL, NULL, NULL,
                 'queued', NULL, NULL, NULL, NULL)",
        params![
            id,
            automation_id,
            trigger_kind,
            trigger_payload.map(serde_json::to_string).transpose()?,
            prompt_snapshot,
            agent_snapshot,
            serde_json::to_string(agent_config_snapshot)?,
            serde_json::to_string(input)?,
            execution_scope,
            triggered_at,
        ],
    )?;
    tx.commit()?;
    drop(conn);
    publish_run_update(&id);
    Ok(RunClaim::Created(id))
}

pub fn update_run_input(run_id: &str, input: &serde_json::Value) -> Result<bool> {
    let conn = super::database::connection();
    let changed = conn.execute(
        "UPDATE automation_runs SET input_json = ?1
         WHERE id = ?2 AND status NOT IN ('success','cancelled','cancelling')",
        params![serde_json::to_string(input)?, run_id],
    )? > 0;
    drop(conn);
    if changed {
        publish_run_update(run_id);
    }
    Ok(changed)
}

/// Insert a fresh run in `queued` state. Done before queue_message so the
/// subscribe-on-Complete path has a row to update. `queued_at` is filled in
/// later by `mark_run_queued` once the prompt is actually in the ACP queue.
#[allow(clippy::too_many_arguments)]
pub fn insert_run(
    automation_id: &str,
    trigger_kind: &str,
    trigger_payload: Option<&serde_json::Value>,
    prompt_snapshot: &str,
    agent_snapshot: Option<&str>,
    agent_config_snapshot: &AgentConfigSelection,
    input: &serde_json::Value,
    execution_scope: &str,
    triggered_at: i64,
) -> Result<String> {
    let id = format!("arun-{}", uuid::Uuid::new_v4().simple());
    let conn = super::database::connection();
    conn.execute(
        "INSERT INTO automation_runs
         (id, automation_id, trigger_kind, trigger_payload_json,
          prompt_snapshot, agent_snapshot, agent_config_snapshot_json, input_json, execution_scope,
          resolved_task_id, resolved_chat_id, triggered_at, queued_at, started_at, completed_at,
          status, phase, error, agent_response, result_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, NULL, NULL, ?10, NULL, NULL, NULL,
                 'queued', NULL, NULL, NULL, NULL)",
        params![
            id,
            automation_id,
            trigger_kind,
            trigger_payload.map(serde_json::to_string).transpose()?,
            prompt_snapshot,
            agent_snapshot,
            serde_json::to_string(agent_config_snapshot)?,
            serde_json::to_string(input)?,
            execution_scope,
            triggered_at,
        ],
    )?;
    drop(conn);
    publish_run_update(&id);
    Ok(id)
}

/// Stamp the resolved task + chat ids on the run row as soon as we know
/// them — **before** the prompt is handed to ACP. The cancel handler
/// needs these ids to look up the ACP handle and fire the right
/// side-effect (dequeue or `cancel turn`); writing them after `send_prompt`
/// left a window where the prompt was already executing but the cancel
/// handler couldn't find the handle, so the run row went to `cancelled`
/// while the agent kept working (Bug H2).
pub fn mark_run_resolved(
    run_id: &str,
    resolved_task_id: &str,
    resolved_chat_id: &str,
) -> Result<()> {
    let conn = super::database::connection();
    conn.execute(
        "UPDATE automation_runs
         SET resolved_task_id = ?1, resolved_chat_id = ?2
         WHERE id = ?3",
        params![resolved_task_id, resolved_chat_id, run_id],
    )?;
    drop(conn);
    publish_run_update(run_id);
    Ok(())
}

/// Stamp `queued_at` once the prompt has successfully entered the ACP
/// queue (or been sent directly via `send_prompt`). Ids are stamped
/// separately by [`mark_run_resolved`] earlier in the pipeline.
///
/// Guarded on the active states so a row that's been cancelled in the
/// micro-window between `send_prompt` and this write doesn't get an
/// (informational-but-misleading) `queued_at` stamp added.
pub fn mark_run_queued(run_id: &str, queued_at: i64) -> Result<()> {
    let conn = super::database::connection();
    conn.execute(
        "UPDATE automation_runs SET queued_at = ?1
         WHERE id = ?2 AND status NOT IN ('success','cancelled','cancelling')",
        params![queued_at, run_id],
    )?;
    drop(conn);
    publish_run_update(run_id);
    Ok(())
}

/// Mid-state transition: agent dequeued the prompt and started processing.
/// Conditional update — only flips `queued` → `running` so a concurrent
/// cancel can't be clobbered.
pub fn mark_run_running(run_id: &str) -> Result<()> {
    let conn = super::database::connection();
    conn.execute(
        "UPDATE automation_runs
         SET status = 'running', started_at = COALESCE(started_at, ?2),
             completed_at = NULL, phase = NULL, error = NULL
         WHERE id = ?1 AND status NOT IN ('success','cancelled','cancelling')",
        params![run_id, chrono::Utc::now().timestamp()],
    )?;
    drop(conn);
    publish_run_update(run_id);
    Ok(())
}

/// The current Agent turn is no longer executing, but the Run remains open
/// for user input and can return to `running` on the next message.
pub fn mark_run_waiting(run_id: &str) -> Result<()> {
    let conn = super::database::connection();
    conn.execute(
        "UPDATE automation_runs
         SET status = 'waiting', completed_at = NULL, phase = NULL, error = NULL
         WHERE id = ?1 AND status NOT IN ('success','cancelled','cancelling')",
        params![run_id],
    )?;
    drop(conn);
    publish_run_update(run_id);
    Ok(())
}

pub fn complete_consumer_run<T, F>(run_id: &str, completed_at: i64, publish: F) -> Result<Option<T>>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(T, serde_json::Value)>,
{
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM automation_runs
                       WHERE id = ?1 AND status NOT IN ('success','cancelled','cancelling'))",
        params![run_id],
        |row| row.get(0),
    )?;
    if !active {
        tx.commit()?;
        return Ok(None);
    }
    let (value, result) = publish(&tx)?;
    let changed = tx.execute(
        "UPDATE automation_runs
         SET completed_at = ?1, status = 'success', result_json = ?2
         WHERE id = ?3 AND status NOT IN ('success','cancelled','cancelling')",
        params![completed_at, serde_json::to_string(&result)?, run_id],
    )?;
    let trimmed = if changed > 0 {
        refresh_last_run_from(&tx, run_id)?;
        trim_history(&tx, run_id)?
    } else {
        Vec::new()
    };
    tx.commit()?;
    drop(conn);
    cleanup_run_artifacts(trimmed);
    if changed > 0 {
        publish_run_update(run_id);
    }
    Ok((changed > 0).then_some(value))
}

/// Terminal success — agent completed the prompt. `agent_response` is the
/// truncated `last_assistant_text` snapshot; pass `None` when the agent
/// produced no text (tool-only turn).
///
/// All terminal writers use a conditional UPDATE keyed on the active
/// states (`queued` / `running`) so they can't overwrite a `cancelled`
/// row that was set by the cancel API path while the watcher was still
/// in flight.
pub fn mark_run_completed(
    run_id: &str,
    completed_at: i64,
    agent_response: Option<&str>,
) -> Result<()> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE automation_runs
         SET completed_at = ?1, status = 'success', agent_response = ?2
         WHERE id = ?3 AND status NOT IN ('success','cancelled','cancelling')",
        params![completed_at, agent_response, run_id],
    )?;
    refresh_last_run_from(&tx, run_id)?;
    let trimmed = trim_history(&tx, run_id)?;
    tx.commit()?;
    drop(conn);
    cleanup_run_artifacts(trimmed);
    publish_run_update(run_id);
    Ok(())
}

/// Atomically reserve cancellation. Returns the prior active status and moves
/// the row to `cancelling`, which remains part of the Single Flight window.
/// The caller performs ACP cancellation and handler cleanup, then calls
/// [`finish_cancel`] to release the flight by making the row terminal.
pub fn claim_cancel(run_id: &str, reason: &str) -> Result<Option<String>> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    let prior: Option<String> = tx
        .query_row(
            "SELECT status FROM automation_runs
             WHERE id = ?1 AND status NOT IN ('success','cancelled','cancelling')",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    if prior.is_some() {
        tx.execute(
            "UPDATE automation_runs
             SET status = 'cancelling', error = ?1
             WHERE id = ?2 AND status NOT IN ('success','cancelled','cancelling')",
            params![reason, run_id],
        )?;
    }
    tx.commit()?;
    Ok(prior)
}

/// Complete a previously claimed cancellation after ACP and business abort
/// cleanup have both finished. This is the point where Single Flight is
/// released and another trigger may start a new execution.
pub fn finish_cancel(run_id: &str, completed_at: i64, reason: &str) -> Result<bool> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE automation_runs
         SET status = 'cancelled', completed_at = ?1, error = ?2
         WHERE id = ?3 AND status = 'cancelling'",
        params![completed_at, reason, run_id],
    )? > 0;
    let trimmed = if changed {
        refresh_last_run_from(&tx, run_id)?;
        trim_history(&tx, run_id)?
    } else {
        Vec::new()
    };
    tx.commit()?;
    drop(conn);
    cleanup_run_artifacts(trimmed);
    if changed {
        publish_run_update(run_id);
    }
    Ok(changed)
}

/// Mark the current Agent attempt failed without making the Run terminal. The
/// user may retry in the same conversation, which moves it back to `running`.
pub fn mark_run_failed(run_id: &str, phase: &str, error: &str) -> Result<()> {
    let conn = super::database::connection();
    conn.execute(
        "UPDATE automation_runs
         SET status = 'failed', completed_at = NULL, phase = ?1, error = ?2
         WHERE id = ?3 AND status NOT IN ('success','cancelled')",
        params![phase, error, run_id],
    )?;
    drop(conn);
    publish_run_update(run_id);
    Ok(())
}

/// Reflect the **latest** run's status / time onto the parent automation row
/// so list views can show "last run: ✓ success" without joining. Reads the
/// newest run by `triggered_at` (tie-broken by `rowid DESC` — two rows can
/// share a one-second `triggered_at` when a manual trigger lands during
/// the same second as a cron tick, so without the tiebreak SQLite's
/// LIMIT 1 is non-deterministic and the parent's `last_run_status` can
/// flip between them as each terminal writer runs. `rowid DESC` reflects
/// SQLite's insertion order, so the run that landed in the DB *last*
/// wins — which matches user intent for "most recent").
fn refresh_last_run_from(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<()> {
    tx.execute(
        "UPDATE automations
         SET last_run_at = (
                 SELECT COALESCE(completed_at, queued_at, triggered_at)
                 FROM automation_runs
                 WHERE automation_id = automations.id
                 ORDER BY triggered_at DESC, rowid DESC LIMIT 1
             ),
             last_run_status = (
                 SELECT status FROM automation_runs
                 WHERE automation_id = automations.id
                 ORDER BY triggered_at DESC, rowid DESC LIMIT 1
             ),
             last_run_error = (
                 SELECT error FROM automation_runs
                 WHERE automation_id = automations.id
                 ORDER BY triggered_at DESC, rowid DESC LIMIT 1
             ),
             updated_at = strftime('%s','now')
         WHERE id = (SELECT automation_id FROM automation_runs WHERE id = ?1)",
        params![run_id],
    )?;
    Ok(())
}

/// Keep at most 100 rows per automation. Runs older than the cutoff are
/// dropped. Called from every terminal-state writer so the table never
/// grows unbounded for a project that runs an hourly automation for years.
#[derive(Debug)]
struct RunArtifact {
    run_id: String,
    project_id: String,
    handler_key: String,
    resolved_task_id: Option<String>,
    resolved_chat_id: Option<String>,
}

fn collect_run_artifacts(
    tx: &rusqlite::Transaction<'_>,
    automation_id: &str,
    only_trimmed: bool,
) -> Result<Vec<RunArtifact>> {
    let mut sql = "SELECT r.id, a.project, a.handler_key,
                          r.resolved_task_id, r.resolved_chat_id
                   FROM automation_runs r
                   JOIN automations a ON a.id = r.automation_id
                   WHERE r.automation_id = ?1"
        .to_string();
    if only_trimmed {
        sql.push_str(
            " AND r.status IN ('success','cancelled')
              AND r.id NOT IN (
                SELECT id FROM automation_runs
                WHERE automation_id = ?1 AND status IN ('success','cancelled')
                ORDER BY triggered_at DESC, rowid DESC LIMIT 100
              )",
        );
    }
    let mut stmt = tx.prepare(&sql)?;
    let rows = stmt.query_map(params![automation_id], |row| {
        Ok(RunArtifact {
            run_id: row.get(0)?,
            project_id: row.get(1)?,
            handler_key: row.get(2)?,
            resolved_task_id: row.get(3)?,
            resolved_chat_id: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn cleanup_run_artifacts(artifacts: Vec<RunArtifact>) {
    for artifact in artifacts {
        if let Err(error) = crate::automation::consumer::remove_run_artifacts(
            &artifact.handler_key,
            &artifact.project_id,
            &artifact.run_id,
            artifact.resolved_task_id.as_deref(),
            artifact.resolved_chat_id.as_deref(),
        ) {
            crate::automation::awarn!(
                "remove artifacts for Automation Run {}: {}",
                artifact.run_id,
                error
            );
        }
    }
}

fn trim_history(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<Vec<RunArtifact>> {
    let automation_id: String = tx.query_row(
        "SELECT automation_id FROM automation_runs WHERE id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    trim_automation_history(tx, &automation_id)
}

fn trim_automation_history(
    tx: &rusqlite::Transaction<'_>,
    automation_id: &str,
) -> Result<Vec<RunArtifact>> {
    let artifacts = collect_run_artifacts(tx, automation_id, true)?;
    tx.execute(
        "DELETE FROM automation_runs
         WHERE automation_id = ?1
           AND status IN ('success','cancelled')
           AND id NOT IN (
               SELECT id FROM automation_runs
               WHERE automation_id = ?1 AND status IN ('success','cancelled')
               ORDER BY triggered_at DESC, rowid DESC LIMIT 100
           )",
        params![automation_id],
    )?;
    Ok(artifacts)
}

pub fn get_run(run_id: &str) -> Result<Option<AutomationRun>> {
    let conn = super::database::connection();
    let row = conn
        .query_row(
            &format!("SELECT {RUN_COLUMNS} FROM automation_runs WHERE id = ?1"),
            params![run_id],
            row_to_run,
        )
        .optional()?;
    Ok(row)
}

pub fn nonterminal_run_id_for_chat(
    project_id: &str,
    task_id: &str,
    chat_id: &str,
) -> Result<Option<String>> {
    let conn = super::database::connection();
    Ok(conn
        .query_row(
            "SELECT r.id
             FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE a.project = ?1 AND r.resolved_task_id = ?2
               AND r.resolved_chat_id = ?3
               AND r.status NOT IN ('success','cancelled')
             ORDER BY r.triggered_at DESC, r.rowid DESC
             LIMIT 1",
            params![project_id, task_id, chat_id],
            |row| row.get(0),
        )
        .optional()?)
}

#[derive(Debug, PartialEq, Eq)]
enum ChatRunTransition<'a> {
    InProgress,
    Waiting,
    Failed(&'a str),
    TurnComplete,
    None,
}

fn chat_run_transition(update: &crate::acp::AcpUpdate) -> ChatRunTransition<'_> {
    match update {
        crate::acp::AcpUpdate::UserMessage { .. }
        | crate::acp::AcpUpdate::PermissionResponse { .. }
        | crate::acp::AcpUpdate::ElicitationResolved { .. }
        | crate::acp::AcpUpdate::AuthSucceeded => ChatRunTransition::InProgress,
        crate::acp::AcpUpdate::PermissionRequest { .. }
        | crate::acp::AcpUpdate::ElicitationRequest { .. }
        | crate::acp::AcpUpdate::AskForm { .. }
        | crate::acp::AcpUpdate::AuthRequired { .. }
        | crate::acp::AcpUpdate::AuthFailed { .. } => ChatRunTransition::Waiting,
        crate::acp::AcpUpdate::Error { message } => ChatRunTransition::Failed(message),
        crate::acp::AcpUpdate::SessionEnded => {
            ChatRunTransition::Failed("Agent Session ended before the Run completed")
        }
        crate::acp::AcpUpdate::Complete { .. } => ChatRunTransition::TurnComplete,
        _ => ChatRunTransition::None,
    }
}

/// Keep a recoverable Run's user-facing state in sync with its ordinary
/// TaskChat Session. This also covers Sessions reattached after the original
/// executor watcher has gone away.
pub fn sync_run_state_for_chat_event(
    project_id: &str,
    task_id: &str,
    chat_id: &str,
    update: &crate::acp::AcpUpdate,
) {
    let Ok(Some(run_id)) = nonterminal_run_id_for_chat(project_id, task_id, chat_id) else {
        return;
    };
    match chat_run_transition(update) {
        ChatRunTransition::InProgress => {
            let _ = mark_run_running(&run_id);
        }
        ChatRunTransition::Waiting => {
            let _ = mark_run_waiting(&run_id);
        }
        ChatRunTransition::Failed(message) => {
            let _ = mark_run_failed(&run_id, "agent_run", message);
        }
        ChatRunTransition::TurnComplete => {
            let is_project_run = get_run(&run_id)
                .ok()
                .flatten()
                .is_some_and(|run| run.execution_scope == "project_run");
            if is_project_run {
                let _ = mark_run_waiting(&run_id);
            }
        }
        ChatRunTransition::None => {}
    }
}

pub fn list_runs(automation_id: &str, limit: usize) -> Result<Vec<AutomationRun>> {
    let conn = super::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM automation_runs
         WHERE automation_id = ?1
         ORDER BY triggered_at DESC LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![automation_id, limit as i64], row_to_run)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn has_active_run(automation_id: &str) -> Result<bool> {
    let conn = super::database::connection();
    Ok(conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM automation_runs
            WHERE automation_id = ?1 AND status IN ('queued','running','waiting','cancelling')
         )",
        params![automation_id],
        |row| row.get(0),
    )?)
}

/// Delete one terminal Automation Run and its usage/artifacts. Active runs
/// must go through cancellation so their executor cannot write into a row
/// that disappeared underneath it.
pub fn delete_finished_run(automation_id: &str, run_id: &str) -> Result<bool> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    let artifact = tx
        .query_row(
            "SELECT r.id, a.project, a.handler_key, r.resolved_task_id,
                    r.resolved_chat_id, r.status
             FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.automation_id = ?1 AND r.id = ?2",
            params![automation_id, run_id],
            |row| {
                Ok((
                    RunArtifact {
                        run_id: row.get(0)?,
                        project_id: row.get(1)?,
                        handler_key: row.get(2)?,
                        resolved_task_id: row.get(3)?,
                        resolved_chat_id: row.get(4)?,
                    },
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((artifact, status)) = artifact else {
        return Ok(false);
    };
    if !matches!(status.as_str(), "success" | "cancelled") {
        return Err(crate::error::GroveError::invalid_data(
            "active Automation Runs must be cancelled before deletion",
        ));
    }

    // Older databases derived the Memory input checkpoint from the latest
    // successful Run. Preserve that durable cursor before allowing history
    // deletion, otherwise removing the newest success could replay old chats.
    let checkpoint_input: Option<String> = tx
        .query_row(
            "SELECT input_json FROM automation_runs
             WHERE automation_id = ?1 AND execution_scope = 'project_run'
               AND status = 'success'
             ORDER BY completed_at DESC, triggered_at DESC, rowid DESC LIMIT 1",
            params![automation_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(input_through_at) = checkpoint_input
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| {
            value
                .get("input_through_at")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
    {
        tx.execute(
            "UPDATE memory_project_configs
             SET last_input_through_at = COALESCE(last_input_through_at, ?1),
                 updated_at = ?2
             WHERE organization_automation_id = ?3
               AND last_input_through_at IS NULL",
            params![
                input_through_at,
                chrono::Utc::now().to_rfc3339(),
                automation_id
            ],
        )?;
    }

    tx.execute(
        "DELETE FROM chat_token_usage WHERE automation_run_id = ?1",
        params![run_id],
    )?;
    tx.execute(
        "DELETE FROM automation_runs WHERE automation_id = ?1 AND id = ?2",
        params![automation_id, run_id],
    )?;
    tx.execute(
        "UPDATE automations
         SET last_run_at = (
                 SELECT COALESCE(completed_at, queued_at, triggered_at)
                 FROM automation_runs
                 WHERE automation_id = ?1
                 ORDER BY triggered_at DESC, rowid DESC LIMIT 1
             ),
             last_run_status = (
                 SELECT status FROM automation_runs
                 WHERE automation_id = ?1
                 ORDER BY triggered_at DESC, rowid DESC LIMIT 1
             ),
             last_run_error = (
                 SELECT error FROM automation_runs
                 WHERE automation_id = ?1
                 ORDER BY triggered_at DESC, rowid DESC LIMIT 1
             ),
             updated_at = strftime('%s','now')
         WHERE id = ?1",
        params![automation_id],
    )?;
    tx.commit()?;
    drop(conn);
    cleanup_run_artifacts(vec![artifact]);
    Ok(true)
}

/// Input upper-bound from the latest successfully published project Run.
/// Consumers use this as the next Run's exclusive lower-bound; Runs that did
/// not complete successfully never advance the input window.
pub fn latest_successful_input_through(automation_id: &str) -> Result<Option<String>> {
    let conn = super::database::connection();
    let raw: Option<String> = conn
        .query_row(
            "SELECT input_json FROM automation_runs
             WHERE automation_id = ?1 AND execution_scope = 'project_run'
               AND status = 'success'
             ORDER BY completed_at DESC, triggered_at DESC LIMIT 1",
            params![automation_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| {
            value
                .get("input_through_at")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        }))
}

pub fn generate_id() -> String {
    format!("autom-{}", uuid::Uuid::new_v4().simple())
}

/// Truncate text to `AGENT_RESPONSE_MAX_BYTES`, appending a `... [N more bytes]`
/// marker when clipped. Handles multi-byte UTF-8 safely by snapping back to
/// the previous char boundary, then nudges further back to the last newline
/// (when within the same ballpark) so the cut lands at a paragraph break
/// instead of mid-sentence.
pub fn truncate_agent_response(text: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.len() <= AGENT_RESPONSE_MAX_BYTES {
        return text.to_string();
    }
    let mut cutoff = AGENT_RESPONSE_MAX_BYTES;
    while cutoff > 0 && !text.is_char_boundary(cutoff) {
        cutoff -= 1;
    }
    // Snap to the last newline within the kept slice, but only if it's
    // close to the cap AND would still leave a non-trivial body — otherwise
    // a single huge first line would collapse to an empty "snippet" plus
    // the truncation marker.
    if let Some(nl) = text[..cutoff].rfind('\n') {
        if cutoff - nl < AGENT_RESPONSE_MAX_BYTES / 4 && nl > AGENT_RESPONSE_MAX_BYTES / 2 {
            cutoff = nl;
        }
    }
    let remaining = bytes.len() - cutoff;
    format!("{}\n... [{} more bytes]", &text[..cutoff], remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Local, TimeZone, Timelike, Weekday};

    #[test]
    fn recompute_next_runs_corrects_persisted_standard_weekday() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::super::database::create_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (
                id, project, name, enabled, task_mode, session_mode, prompt,
                schedule_cron, next_run_at, created_at, updated_at
             ) VALUES ('test', 'project', 'Tuesday', 1, 'new', 'new', 'prompt',
                       '10 10 * * 2', 1, 1, 1)",
            [],
        )
        .unwrap();

        assert_eq!(recompute_all_next_runs_on(&conn).unwrap(), 1);
        let next_run_at: i64 = conn
            .query_row(
                "SELECT next_run_at FROM automations WHERE id = 'test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let next = Local.timestamp_opt(next_run_at, 0).single().unwrap();
        assert_eq!(next.weekday(), Weekday::Tue);
        assert_eq!((next.hour(), next.minute()), (10, 10));
    }

    #[test]
    fn chat_events_map_to_the_five_state_machine() {
        let user_message = crate::acp::AcpUpdate::UserMessage {
            text: "continue".to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            sender: None,
            terminal: false,
        };
        assert_eq!(
            chat_run_transition(&user_message),
            ChatRunTransition::InProgress
        );

        let permission = crate::acp::AcpUpdate::PermissionRequest {
            id: "permission-1".to_string(),
            description: "Allow access?".to_string(),
            options: Vec::new(),
        };
        assert_eq!(chat_run_transition(&permission), ChatRunTransition::Waiting);

        let error = crate::acp::AcpUpdate::Error {
            message: "agent failed".to_string(),
        };
        assert_eq!(
            chat_run_transition(&error),
            ChatRunTransition::Failed("agent failed")
        );

        let complete = crate::acp::AcpUpdate::Complete {
            stop_reason: "end_turn".to_string(),
            usage: None,
            start_ts: None,
            end_ts: None,
            cost: None,
        };
        assert_eq!(
            chat_run_transition(&complete),
            ChatRunTransition::TurnComplete
        );
    }

    #[test]
    fn failed_run_does_not_reserve_single_flight_slot() {
        let _lock = super::super::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        super::super::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let automation_id = format!("auto-{}", uuid::Uuid::new_v4().simple());
        let project_id = format!("project-{}", uuid::Uuid::new_v4().simple());
        let now = chrono::Utc::now().timestamp();
        let agent_config = AgentConfigSelection::default();
        let automation = Automation {
            id: automation_id.clone(),
            project: project_id.clone(),
            name: "Memory organization".to_string(),
            enabled: true,
            handler_key: MEMORY_ORGANIZATION_HANDLER.to_string(),
            agent_config: agent_config.clone(),
            task_mode: TargetMode::New,
            task_id: None,
            task_template: None,
            session_mode: TargetMode::New,
            chat_id: None,
            session_template: None,
            prompt: "Organize Memory".to_string(),
            schedule_cron: "0 2 * * *".to_string(),
            event_triggers: Vec::new(),
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
        };
        insert(&automation).unwrap();

        let first_run_id = match claim_run(
            &automation_id,
            "manual",
            None,
            &automation.prompt,
            None,
            &agent_config,
            &serde_json::json!({}),
            "project_run",
            now,
            true,
        )
        .unwrap()
        {
            RunClaim::Created(run_id) => run_id,
            RunClaim::Existing(_) => panic!("unexpected existing run"),
        };
        mark_run_failed(&first_run_id, "agent_run", "failed").unwrap();
        assert!(!has_active_run(&automation_id).unwrap());
        let failed_overview =
            super::super::memory::get_overview(&project_id, &automation_id).unwrap();
        assert_eq!(failed_overview.failed_run_count, 1);
        assert_eq!(failed_overview.active_run_count, 0);

        let second_run_id = match claim_run(
            &automation_id,
            "manual",
            None,
            &automation.prompt,
            None,
            &agent_config,
            &serde_json::json!({}),
            "project_run",
            now + 1,
            true,
        )
        .unwrap()
        {
            RunClaim::Created(run_id) => run_id,
            RunClaim::Existing(_) => panic!("failed run should not occupy single-flight slot"),
        };
        assert_ne!(second_run_id, first_run_id);
        assert!(has_active_run(&automation_id).unwrap());
        let running_overview =
            super::super::memory::get_overview(&project_id, &automation_id).unwrap();
        assert_eq!(running_overview.failed_run_count, 1);
        assert_eq!(running_overview.active_run_count, 1);

        super::super::set_grove_dir_override(None);
    }
}
