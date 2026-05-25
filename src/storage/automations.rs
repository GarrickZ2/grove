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

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub project: String,
    pub name: String,
    pub enabled: bool,
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
///   queued → running → success | failed | timeout | cancelled | interrupted
///
/// `running` is skipped for pre-pickup terminal transitions (cancel before
/// the agent took our prompt, or a `resolve_*` / `spawn_acp` failure).
///
/// `queued_at` is NULL until the prompt successfully enters the ACP queue
/// (failures before that point leave it NULL). `completed_at` is NULL until
/// the ACP `Complete` notification arrives — never arrives in `interrupted`
/// (Grove restarted) or `timeout` cases.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub trigger_kind: String,
    pub prompt_snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_chat_id: Option<String>,
    pub triggered_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_response: Option<String>,
}

const COLUMNS: &str = "id, project, name, enabled, task_mode, task_id, task_template,
     session_mode, chat_id, session_template, prompt, schedule_cron,
     last_run_at, last_run_status, last_run_error, next_run_at, created_at, updated_at";

fn row_to_automation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let task_template: Option<String> = row.get(6)?;
    let session_template: Option<String> = row.get(9)?;
    let enabled: i64 = row.get(3)?;
    let task_mode: String = row.get(4)?;
    let session_mode: String = row.get(7)?;
    Ok(Automation {
        id: row.get(0)?,
        project: row.get(1)?,
        name: row.get(2)?,
        enabled: enabled != 0,
        task_mode: TargetMode::parse(&task_mode),
        task_id: row.get(5)?,
        task_template: task_template
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        session_mode: TargetMode::parse(&session_mode),
        chat_id: row.get(8)?,
        session_template: session_template
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        prompt: row.get(10)?,
        schedule_cron: row.get(11)?,
        last_run_at: row.get(12)?,
        last_run_status: row.get(13)?,
        last_run_error: row.get(14)?,
        next_run_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
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
    conn.execute(
        &format!(
            "INSERT INTO automations ({COLUMNS})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)"
        ),
        params![
            a.id,
            a.project,
            a.name,
            a.enabled as i64,
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
    conn.execute(
        "UPDATE automations SET
            name=?1, enabled=?2, task_mode=?3, task_id=?4, task_template=?5,
            session_mode=?6, chat_id=?7, session_template=?8, prompt=?9,
            schedule_cron=?10, next_run_at=?11, updated_at=?12
         WHERE id=?13",
        params![
            a.name,
            a.enabled as i64,
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
    tx.execute(
        "DELETE FROM automation_runs WHERE automation_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM automations WHERE id = ?1", params![id])?;
    tx.commit()?;
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

/// Maximum agent_response length stored per run. Anything longer is
/// truncated with a `... [N more bytes]` marker so callers can still tell
/// the response was clipped without pulling chat history.
pub const AGENT_RESPONSE_MAX_BYTES: usize = 16 * 1024;

const RUN_COLUMNS: &str = "id, automation_id, trigger_kind, prompt_snapshot, agent_snapshot,
     resolved_task_id, resolved_chat_id, triggered_at, queued_at, completed_at,
     status, phase, error, agent_response";

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        id: row.get(0)?,
        automation_id: row.get(1)?,
        trigger_kind: row.get(2)?,
        prompt_snapshot: row.get(3)?,
        agent_snapshot: row.get(4)?,
        resolved_task_id: row.get(5)?,
        resolved_chat_id: row.get(6)?,
        triggered_at: row.get(7)?,
        queued_at: row.get(8)?,
        completed_at: row.get(9)?,
        status: row.get(10)?,
        phase: row.get(11)?,
        error: row.get(12)?,
        agent_response: row.get(13)?,
    })
}

/// Insert a fresh run in `queued` state. Done before queue_message so the
/// subscribe-on-Complete path has a row to update. `queued_at` is filled in
/// later by `mark_run_queued` once the prompt is actually in the ACP queue.
#[allow(clippy::too_many_arguments)]
pub fn insert_run(
    automation_id: &str,
    trigger_kind: &str,
    prompt_snapshot: &str,
    agent_snapshot: Option<&str>,
    triggered_at: i64,
) -> Result<String> {
    let id = format!("arun-{}", uuid::Uuid::new_v4().simple());
    let conn = super::database::connection();
    conn.execute(
        "INSERT INTO automation_runs
         (id, automation_id, trigger_kind, prompt_snapshot, agent_snapshot,
          resolved_task_id, resolved_chat_id, triggered_at, queued_at, completed_at,
          status, phase, error, agent_response)
         VALUES (?1,?2,?3,?4,?5, NULL, NULL, ?6, NULL, NULL, 'queued', NULL, NULL, NULL)",
        params![
            id,
            automation_id,
            trigger_kind,
            prompt_snapshot,
            agent_snapshot,
            triggered_at,
        ],
    )?;
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
         WHERE id = ?2 AND status IN ('queued','running')",
        params![queued_at, run_id],
    )?;
    Ok(())
}

/// Mid-state transition: agent dequeued the prompt and started processing.
/// Conditional update — only flips `queued` → `running` so a concurrent
/// cancel can't be clobbered.
pub fn mark_run_running(run_id: &str) -> Result<()> {
    let conn = super::database::connection();
    conn.execute(
        "UPDATE automation_runs SET status = 'running'
         WHERE id = ?1 AND status = 'queued'",
        params![run_id],
    )?;
    Ok(())
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
         WHERE id = ?3 AND status IN ('queued','running')",
        params![completed_at, agent_response, run_id],
    )?;
    refresh_last_run_from(&tx, run_id)?;
    trim_history(&tx, run_id)?;
    tx.commit()?;
    Ok(())
}

/// User-initiated cancel. Stamps `completed_at` and `error` (so the UI can
/// show a reason — "removed from queue" vs "in-flight cancelled") and
/// flips status to `cancelled`. Idempotent against terminal states.
///
/// Same TOCTOU-safe pattern as the watcher's terminal writers, but the
/// caller usually wants to know the *prior* status to decide which ACP
/// side-effect to fire (dequeue vs cancel). Prefer [`claim_cancel`] in
/// that case — it returns the prior status atomically.
pub fn mark_run_cancelled(run_id: &str, completed_at: i64, reason: &str) -> Result<()> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE automation_runs
         SET status = 'cancelled', completed_at = ?1, error = ?2
         WHERE id = ?3 AND status IN ('queued','running')",
        params![completed_at, reason, run_id],
    )?;
    refresh_last_run_from(&tx, run_id)?;
    trim_history(&tx, run_id)?;
    tx.commit()?;
    Ok(())
}

/// Atomic claim-and-cancel. Returns the *prior* status (`"queued"` or
/// `"running"`) if this call was the one that transitioned the row to
/// `cancelled`, or `None` if the row was already terminal (or didn't
/// exist). Caller uses the prior status to decide which ACP side-effect
/// to fire — dequeue (queued) vs cancel turn (running) — without a TOCTOU
/// window between the read and write.
pub fn claim_cancel(run_id: &str, completed_at: i64, reason: &str) -> Result<Option<String>> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    let prior: Option<String> = tx
        .query_row(
            "SELECT status FROM automation_runs
             WHERE id = ?1 AND status IN ('queued','running')",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    if prior.is_some() {
        tx.execute(
            "UPDATE automation_runs
             SET status = 'cancelled', completed_at = ?1, error = ?2
             WHERE id = ?3",
            params![completed_at, reason, run_id],
        )?;
        refresh_last_run_from(&tx, run_id)?;
        trim_history(&tx, run_id)?;
    }
    tx.commit()?;
    Ok(prior)
}

/// Terminal failure — set status, phase, and error. `completed_at` is filled
/// even if the run never reached the queue; downstream consumers use it to
/// compute total duration. Use `phase` to surface where in the pipeline the
/// failure occurred (resolve_task / resolve_session / spawn_acp / queue / agent_run).
pub fn mark_run_failed(run_id: &str, completed_at: i64, phase: &str, error: &str) -> Result<()> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE automation_runs
         SET completed_at = ?1, status = 'failed', phase = ?2, error = ?3
         WHERE id = ?4 AND status IN ('queued','running')",
        params![completed_at, phase, error, run_id],
    )?;
    refresh_last_run_from(&tx, run_id)?;
    trim_history(&tx, run_id)?;
    tx.commit()?;
    Ok(())
}

/// Terminal timeout — subscriber gave up waiting for `Complete`. agent_response
/// captures whatever `last_assistant_text` had accumulated so partial output
/// isn't lost.
pub fn mark_run_timeout(
    run_id: &str,
    completed_at: i64,
    agent_response: Option<&str>,
) -> Result<()> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE automation_runs
         SET completed_at = ?1, status = 'timeout', agent_response = ?2,
             error = 'agent did not report completion within the timeout window'
         WHERE id = ?3 AND status IN ('queued','running')",
        params![completed_at, agent_response, run_id],
    )?;
    refresh_last_run_from(&tx, run_id)?;
    trim_history(&tx, run_id)?;
    tx.commit()?;
    Ok(())
}

/// Startup sweep: any row stuck in `queued` **or `running`** belongs to a
/// previous Grove process that died with the watcher subscriber still in
/// flight. We can't recover that subscriber, so mark the row `interrupted`
/// and propagate to the parent automation's `last_run_*` columns so the
/// list view doesn't keep showing it as "queued" / "running" forever.
/// Returns the number of swept rows for the log line.
pub fn sweep_interrupted_runs(now: i64) -> Result<usize> {
    let conn = super::database::connection();
    let tx = conn.unchecked_transaction()?;

    // Capture the affected run_ids first so we can refresh each parent's
    // last_run snapshot after the bulk UPDATE. SQLite can't `RETURNING` in
    // older versions and the rusqlite API we use here is simpler with a
    // pre-scan.
    let ids: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT id FROM automation_runs WHERE status IN ('queued','running')")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    if ids.is_empty() {
        tx.commit()?;
        return Ok(0);
    }

    tx.execute(
        "UPDATE automation_runs
         SET status = 'interrupted', completed_at = COALESCE(completed_at, ?1),
             error = 'Grove process exited before agent reported completion'
         WHERE status IN ('queued','running')",
        params![now],
    )?;

    // Propagate to each affected parent. Without this, an automation that
    // died mid-run keeps its parent's `last_run_status` at the stale
    // `queued` / `running` value until the next run completes.
    for id in &ids {
        refresh_last_run_from(&tx, id)?;
    }

    tx.commit()?;
    Ok(ids.len())
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
fn trim_history(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM automation_runs
         WHERE automation_id = (SELECT automation_id FROM automation_runs WHERE id = ?1)
           AND id NOT IN (
               SELECT id FROM automation_runs
               WHERE automation_id = (SELECT automation_id FROM automation_runs WHERE id = ?1)
               ORDER BY triggered_at DESC LIMIT 100
           )",
        params![run_id],
    )?;
    Ok(())
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
