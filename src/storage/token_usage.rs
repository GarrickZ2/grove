//! Per-turn token usage persistence (Layer A).
//!
//! One row per agent prompt response — written from
//! `acp::handle_session_notification` at `Complete` emit time. Backed by the
//! `chat_token_usage` table (see `database::create_schema`). Append-only;
//! the only consumer today is the future Statistics aggregation.

use super::database;
use crate::error::Result;

/// One per-turn record. `model` may be `None` when the agent did not report
/// a current model id by the time the turn ended. `cached_read_tokens` is
/// agent-dependent (Claude reports it; some others don't).
#[derive(Debug, Clone)]
pub struct TokenUsageRecord<'a> {
    pub project_key: &'a str,
    pub task_id: &'a str,
    pub chat_id: &'a str,
    pub agent: &'a str,
    pub model: Option<&'a str>,
    pub input_tokens: u64,
    pub cached_read_tokens: Option<u64>,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

/// Insert a per-turn token usage row. Best-effort — errors are logged at
/// the call site but do not fail the turn.
pub fn insert(rec: &TokenUsageRecord<'_>) -> Result<()> {
    let conn = database::connection();
    conn.execute(
        "INSERT INTO chat_token_usage (
            project_key, task_id, chat_id, agent, model,
            input_tokens, cached_read_tokens, output_tokens, total_tokens,
            start_ts, end_ts
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            rec.project_key,
            rec.task_id,
            rec.chat_id,
            rec.agent,
            rec.model,
            rec.input_tokens as i64,
            rec.cached_read_tokens.map(|v| v as i64),
            rec.output_tokens as i64,
            rec.total_tokens as i64,
            rec.start_ts,
            rec.end_ts,
        ],
    )?;
    Ok(())
}
