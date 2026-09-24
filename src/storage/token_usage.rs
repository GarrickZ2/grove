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
    pub task_id: Option<&'a str>,
    pub chat_id: Option<&'a str>,
    pub automation_run_id: Option<&'a str>,
    pub agent: &'a str,
    pub model: Option<&'a str>,
    pub input_tokens: u64,
    pub cached_read_tokens: Option<u64>,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub cost_amount: Option<f64>,
    pub cost_currency: Option<&'a str>,
}

/// Insert a per-turn token usage row. Best-effort — errors are logged at
/// the call site but do not fail the turn.
pub fn insert(rec: &TokenUsageRecord<'_>) -> Result<()> {
    let conn = database::connection();
    conn.execute(
        "INSERT INTO chat_token_usage (
            project_key, task_id, chat_id, automation_run_id, agent, model,
            input_tokens, cached_read_tokens, output_tokens, total_tokens,
            start_ts, end_ts, cost_amount, cost_currency
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            rec.project_key,
            rec.task_id,
            rec.chat_id,
            rec.automation_run_id,
            rec.agent,
            rec.model,
            rec.input_tokens as i64,
            rec.cached_read_tokens.map(|v| v as i64),
            rec.output_tokens as i64,
            rec.total_tokens as i64,
            rec.start_ts,
            rec.end_ts,
            rec.cost_amount,
            rec.cost_currency,
        ],
    )?;
    Ok(())
}

/// Recorded token usage in a half-open Unix-second interval.
pub fn total_tokens(from_ts: i64, to_ts: i64) -> Result<u64> {
    let conn = database::connection();
    total_tokens_in(&conn, from_ts, to_ts)
}

fn total_tokens_in(conn: &rusqlite::Connection, from_ts: i64, to_ts: i64) -> Result<u64> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(total_tokens), 0)
         FROM chat_token_usage WHERE end_ts >= ?1 AND end_ts < ?2",
        rusqlite::params![from_ts, to_ts],
        |row| row.get(0),
    )?;
    Ok(total.max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_recorded_turns_in_half_open_interval() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE chat_token_usage (end_ts INTEGER, total_tokens INTEGER);")
            .unwrap();
        conn.execute("INSERT INTO chat_token_usage VALUES (10, 120)", [])
            .unwrap();
        conn.execute("INSERT INTO chat_token_usage VALUES (20, 30)", [])
            .unwrap();
        assert_eq!(total_tokens_in(&conn, 0, 20).unwrap(), 120);
        assert_eq!(total_tokens_in(&conn, 10, 21).unwrap(), 150);
    }
}
