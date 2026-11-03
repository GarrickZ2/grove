//! Statistics aggregation over `chat_token_usage`.
//!
//! All metrics derive from a single table — per-turn token + duration rows.
//! Two scopes:
//!   * Global: across all projects
//!   * Project: a single project
//!   * Task: a single task (top entries are its sessions)
//!
//! Each request returns the current period plus a "previous" period of equal
//! length (used by the frontend to render Δ deltas on KPIs).

use rusqlite::{params, params_from_iter};
use serde::Serialize;

use crate::storage::database;

// ── Public response type ────────────────────────────────────────────────

#[derive(Debug, Serialize, Default, Clone)]
pub struct StatisticsResponse {
    pub current: PeriodData,
    pub previous: PreviousPeriodData,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct PeriodData {
    pub kpi: KpiData,
    pub timeseries: Vec<TimeseriesBucket>,
    pub agent_share: Vec<AgentShareItem>,
    pub models: Vec<ModelItem>,
    pub top: Vec<TopItem>,
    pub heatmap: Vec<HeatmapCell>,
}

/// Previous-period only carries KPI for delta computation; the frontend
/// doesn't render charts for it.
#[derive(Debug, Serialize, Default, Clone)]
pub struct PreviousPeriodData {
    pub kpi: KpiData,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct KpiData {
    pub turns: u64,
    pub tokens_total: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_cached: u64,
    /// Sum of (end_ts - start_ts) across all turns, in seconds.
    pub agent_compute_secs: u64,
    pub avg_tokens_per_turn: u64,
    pub avg_duration_secs: f64,
    pub p50_duration_secs: f64,
    pub cost_total: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct TimeseriesBucket {
    /// Bucket start, Unix seconds.
    pub bucket_start: i64,
    pub turns: u64,
    pub tokens_in: u64,
    pub tokens_cached: u64,
    pub tokens_out: u64,
    pub per_agent: Vec<AgentBucket>,
    pub cost_total: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AgentBucket {
    pub agent: String,
    pub tokens: u64,
    pub turns: u64,
    pub cost: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AgentShareItem {
    pub agent: String,
    pub turns: u64,
    pub tokens: u64,
    pub percent: f64,
    pub cost: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModelItem {
    pub model: String,
    pub agent: String,
    pub tokens: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub turns: u64,
    pub cost: f64,
}

/// Top entity in the period — projects (Global scope), tasks (Project scope)
/// or sessions (Task scope). `id` is project_key, task_id or chat_id; `name`
/// is human label.
#[derive(Debug, Serialize, Clone)]
pub struct TopItem {
    pub id: String,
    pub name: String,
    pub turns: u64,
    pub tokens: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub agent_split: Vec<AgentBucket>,
    pub cost: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct HeatmapCell {
    pub weekday: u8, // 0=Sun..6=Sat
    pub hour: u8,    // 0..23
    pub turns: u64,
}

// ── Bucket granularity ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum Bucket {
    Hourly,
    Daily,
    Weekly,
    Monthly,
}

impl Bucket {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "hourly" | "hour" => Bucket::Hourly,
            "weekly" | "week" => Bucket::Weekly,
            "monthly" | "month" => Bucket::Monthly,
            _ => Bucket::Daily,
        }
    }

    /// SQLite strftime format that floors a timestamp into a bucket key.
    fn strftime_key(self) -> &'static str {
        match self {
            Bucket::Hourly => "%Y-%m-%d %H",
            Bucket::Daily => "%Y-%m-%d",
            Bucket::Weekly => "%Y-%W",
            Bucket::Monthly => "%Y-%m",
        }
    }
}

// ── Query scope ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Scope {
    /// Aggregate across every project.
    Global,
    /// Restrict to one project_key.
    Project(String),
    /// Restrict to one task of a project.
    Task {
        project_key: String,
        task_id: String,
    },
}

// ── Public entry point ──────────────────────────────────────────────────

pub fn aggregate(scope: &Scope, from_ts: i64, to_ts: i64, bucket: Bucket) -> StatisticsResponse {
    let span = (to_ts - from_ts).max(1);
    let prev_to = from_ts - 1;
    let prev_from = prev_to - span;

    let current = build_period(scope, from_ts, to_ts, bucket);
    let previous = PreviousPeriodData {
        kpi: kpi_only(scope, prev_from, prev_to),
    };
    StatisticsResponse { current, previous }
}

fn build_period(scope: &Scope, from_ts: i64, to_ts: i64, bucket: Bucket) -> PeriodData {
    PeriodData {
        kpi: kpi_only(scope, from_ts, to_ts),
        timeseries: query_timeseries(scope, from_ts, to_ts, bucket),
        agent_share: query_agent_share(scope, from_ts, to_ts),
        models: query_models(scope, from_ts, to_ts),
        top: query_top(scope, from_ts, to_ts),
        heatmap: query_heatmap(scope, from_ts, to_ts),
    }
}

// ── Helpers: WHERE clause and binding ───────────────────────────────────

fn scope_clause(scope: &Scope) -> &'static str {
    match scope {
        Scope::Global => "1=1",
        Scope::Project(_) => "project_key = ?3",
        Scope::Task { .. } => "project_key = ?3 AND task_id = ?4",
    }
}

/// Bindings for `?1..`: the period, then whatever `scope_clause` names.
fn scope_args(scope: &Scope, from_ts: i64, to_ts: i64) -> Vec<rusqlite::types::Value> {
    let mut args = vec![from_ts.into(), to_ts.into()];
    match scope {
        Scope::Global => {}
        Scope::Project(key) => args.push(key.clone().into()),
        Scope::Task {
            project_key,
            task_id,
        } => {
            args.push(project_key.clone().into());
            args.push(task_id.clone().into());
        }
    }
    args
}

// ── KPI ─────────────────────────────────────────────────────────────────

fn kpi_only(scope: &Scope, from_ts: i64, to_ts: i64) -> KpiData {
    // Sum query in its own scope so the DB guard is dropped before
    // `query_durations` re-acquires it. Holding two nested guards on the
    // same process-wide Mutex deadlocks every other API request.
    let where_scope = scope_clause(scope);
    let row: (i64, i64, i64, i64, i64, i64, f64) = {
        let conn = database::connection();
        let sql = format!(
            "SELECT
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cached_read_tokens), 0),
                COALESCE(SUM(total_tokens), 0),
                COALESCE(SUM(end_ts - start_ts), 0),
                COALESCE(SUM(cost_amount), 0.0)
             FROM chat_token_usage
             WHERE end_ts BETWEEN ?1 AND ?2 AND {where_scope}",
        );
        conn.query_row(
            &sql,
            params_from_iter(scope_args(scope, from_ts, to_ts)),
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .unwrap_or((0, 0, 0, 0, 0, 0, 0.0))
    };

    let (turns, tin, tout, tcached, ttotal, tcompute, tcost) = row;
    let turns = turns as u64;

    // Pull all turn durations to compute p50 in memory (small N — single user).
    let durations = query_durations(scope, from_ts, to_ts);
    let p50 = percentile_50(&durations);
    let avg_dur = if !durations.is_empty() {
        durations.iter().sum::<i64>() as f64 / durations.len() as f64
    } else {
        0.0
    };

    KpiData {
        turns,
        tokens_total: ttotal as u64,
        tokens_in: tin as u64,
        tokens_out: tout as u64,
        tokens_cached: tcached as u64,
        agent_compute_secs: tcompute as u64,
        avg_tokens_per_turn: (ttotal as u64).checked_div(turns).unwrap_or(0),
        avg_duration_secs: avg_dur,
        p50_duration_secs: p50,
        cost_total: tcost,
    }
}

fn query_durations(scope: &Scope, from_ts: i64, to_ts: i64) -> Vec<i64> {
    let conn = database::connection();
    let sql = format!(
        "SELECT (end_ts - start_ts) FROM chat_token_usage
         WHERE end_ts BETWEEN ?1 AND ?2 AND {}",
        scope_clause(scope),
    );
    let mut out = Vec::new();
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let collected: Vec<i64> = match stmt
        .query_map(params_from_iter(scope_args(scope, from_ts, to_ts)), |r| {
            r.get::<_, i64>(0)
        }) {
        Ok(it) => it.flatten().collect(),
        Err(_) => return out,
    };
    let mut had_negative = false;
    for v in collected {
        if v < 0 {
            had_negative = true;
        }
        out.push(v.max(0));
    }
    if had_negative {
        // Negative durations indicate `end_ts < start_ts`, almost always a
        // wall-clock NTP correction during a turn. Flooring to 0 is the
        // pragmatic fix; logging once per query lets us notice if it gets
        // common enough to warrant storing the duration directly.
        log_negative_duration_once();
    }
    out
}

fn log_negative_duration_once() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if LOGGED.swap(true, Ordering::Relaxed) {
        return;
    }
    eprintln!(
        "[stats] chat_token_usage contains rows with end_ts < start_ts; \
         clamping to 0 (likely clock skew / NTP correction)"
    );
}

fn percentile_50(values: &[i64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<i64> = values.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid] as f64
    } else {
        (sorted[mid - 1] + sorted[mid]) as f64 / 2.0
    }
}

// ── Timeseries ──────────────────────────────────────────────────────────

fn query_timeseries(
    scope: &Scope,
    from_ts: i64,
    to_ts: i64,
    bucket: Bucket,
) -> Vec<TimeseriesBucket> {
    // Outer query in its own scope — drop the DB guard before recursing
    // into `query_timeseries_per_agent` which re-acquires the same Mutex.
    let mut out: Vec<TimeseriesBucket> = {
        let conn = database::connection();
        let fmt = bucket.strftime_key();
        let sql = format!(
            "SELECT
                strftime('{fmt}', end_ts, 'unixepoch') AS bk,
                MIN(end_ts),
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(cached_read_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cost_amount), 0.0)
             FROM chat_token_usage
             WHERE end_ts BETWEEN ?1 AND ?2 AND {where_scope}
             GROUP BY bk
             ORDER BY bk ASC",
            where_scope = scope_clause(scope),
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows: Vec<TimeseriesBucket> = match stmt.query_map(
            params_from_iter(scope_args(scope, from_ts, to_ts)),
            map_timeseries_row,
        ) {
            Ok(it) => it.flatten().collect(),
            Err(_) => return Vec::new(),
        };
        rows
    };

    // Per-agent split inside each bucket: one extra query rather than a complex
    // CTE — total round-trips stay small (≤ a few hundred buckets).
    let agent_buckets = query_timeseries_per_agent(scope, from_ts, to_ts, bucket);
    for b in &mut out {
        let key = bucket_key(b.bucket_start, bucket);
        if let Some(list) = agent_buckets.get(&key) {
            b.per_agent = list.clone();
        }
    }
    out
}

fn map_timeseries_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TimeseriesBucket> {
    Ok(TimeseriesBucket {
        bucket_start: r.get(1)?,
        turns: r.get::<_, i64>(2)? as u64,
        tokens_in: r.get::<_, i64>(3)? as u64,
        tokens_cached: r.get::<_, i64>(4)? as u64,
        tokens_out: r.get::<_, i64>(5)? as u64,
        per_agent: Vec::new(),
        cost_total: r.get::<_, f64>(6)?,
    })
}

fn bucket_key(ts: i64, bucket: Bucket) -> String {
    let dt =
        chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0).unwrap_or_else(chrono::Utc::now);
    match bucket {
        Bucket::Hourly => dt.format("%Y-%m-%d %H").to_string(),
        Bucket::Daily => dt.format("%Y-%m-%d").to_string(),
        Bucket::Weekly => dt.format("%Y-%W").to_string(),
        Bucket::Monthly => dt.format("%Y-%m").to_string(),
    }
}

fn query_timeseries_per_agent(
    scope: &Scope,
    from_ts: i64,
    to_ts: i64,
    bucket: Bucket,
) -> std::collections::HashMap<String, Vec<AgentBucket>> {
    let conn = database::connection();
    let fmt = bucket.strftime_key();
    let sql = format!(
        "SELECT
            strftime('{fmt}', end_ts, 'unixepoch') AS bk,
            agent,
            COUNT(*),
            COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(cost_amount), 0.0)
         FROM chat_token_usage
         WHERE end_ts BETWEEN ?1 AND ?2 AND {where_scope}
         GROUP BY bk, agent",
        where_scope = scope_clause(scope),
    );
    let mut out: std::collections::HashMap<String, Vec<AgentBucket>> =
        std::collections::HashMap::new();
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let collected: Vec<(String, String, i64, i64, f64)> =
        match stmt.query_map(params_from_iter(scope_args(scope, from_ts, to_ts)), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, f64>(4)?,
            ))
        }) {
            Ok(it) => it.flatten().collect(),
            Err(_) => return out,
        };
    for (key, agent, turns, tokens, cost) in collected {
        out.entry(key).or_default().push(AgentBucket {
            agent,
            tokens: tokens as u64,
            turns: turns as u64,
            cost,
        });
    }
    out
}

// ── Agent share ─────────────────────────────────────────────────────────

fn query_agent_share(scope: &Scope, from_ts: i64, to_ts: i64) -> Vec<AgentShareItem> {
    let conn = database::connection();
    let sql = format!(
        "SELECT agent, COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_amount), 0.0)
         FROM chat_token_usage
         WHERE end_ts BETWEEN ?1 AND ?2 AND {}
         GROUP BY agent
         ORDER BY 2 DESC",
        scope_clause(scope),
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let collected: Vec<(String, i64, i64, f64)> =
        match stmt.query_map(params_from_iter(scope_args(scope, from_ts, to_ts)), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, f64>(3)?,
            ))
        }) {
            Ok(it) => it.flatten().collect(),
            Err(_) => return Vec::new(),
        };
    let total_turns: i64 = collected.iter().map(|x| x.1).sum();
    collected
        .into_iter()
        .map(|(agent, turns, tokens, cost)| AgentShareItem {
            agent,
            turns: turns as u64,
            tokens: tokens as u64,
            percent: if total_turns > 0 {
                (turns as f64 / total_turns as f64) * 100.0
            } else {
                0.0
            },
            cost,
        })
        .collect()
}

// ── Models ──────────────────────────────────────────────────────────────

fn query_models(scope: &Scope, from_ts: i64, to_ts: i64) -> Vec<ModelItem> {
    let conn = database::connection();
    let sql = format!(
        "SELECT
            COALESCE(model, '') AS m,
            agent,
            COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(cached_read_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COUNT(*),
            COALESCE(SUM(cost_amount), 0.0)
         FROM chat_token_usage
         WHERE end_ts BETWEEN ?1 AND ?2 AND {}
         GROUP BY m, agent
         ORDER BY 3 DESC
         LIMIT 50",
        scope_clause(scope),
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows: Vec<ModelItem> = match stmt.query_map(
        params_from_iter(scope_args(scope, from_ts, to_ts)),
        map_model_row,
    ) {
        Ok(it) => it.flatten().collect(),
        Err(_) => Vec::new(),
    };
    rows
}

fn map_model_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ModelItem> {
    Ok(ModelItem {
        model: r.get(0)?,
        agent: r.get(1)?,
        tokens: r.get::<_, i64>(2)? as u64,
        input_tokens: r.get::<_, i64>(3)? as u64,
        cached_tokens: r.get::<_, i64>(4)? as u64,
        output_tokens: r.get::<_, i64>(5)? as u64,
        turns: r.get::<_, i64>(6)? as u64,
        cost: r.get::<_, f64>(7)?,
    })
}

// ── Top projects / tasks ────────────────────────────────────────────────

fn query_top(scope: &Scope, from_ts: i64, to_ts: i64) -> Vec<TopItem> {
    match scope {
        Scope::Global => query_top_projects(from_ts, to_ts),
        Scope::Project(key) => query_top_tasks(key, from_ts, to_ts),
        Scope::Task {
            project_key,
            task_id,
        } => query_top_sessions(project_key, task_id, from_ts, to_ts),
    }
}

fn query_top_projects(from_ts: i64, to_ts: i64) -> Vec<TopItem> {
    // Acquire the DB guard inside a tight block and drop it before any
    // call that also needs the connection. The DB guard wraps a process-wide
    // Mutex; nesting calls (e.g. `workspace::load_projects()` while still
    // holding `conn`) deadlocks the entire API since every other handler
    // queues behind the same mutex.
    let raw: Vec<(String, i64, i64, i64, i64, i64, f64)> = {
        let conn = database::connection();
        let sql = "SELECT project_key, COUNT(*),
                          COALESCE(SUM(total_tokens), 0),
                          COALESCE(SUM(input_tokens), 0),
                          COALESCE(SUM(cached_read_tokens), 0),
                          COALESCE(SUM(output_tokens), 0),
                          COALESCE(SUM(cost_amount), 0.0)
                   FROM chat_token_usage
                   WHERE end_ts BETWEEN ?1 AND ?2
                   GROUP BY project_key
                   ORDER BY 3 DESC
                   LIMIT 10";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![from_ts, to_ts], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, f64>(6)?,
            ))
        });
        match rows {
            Ok(it) => it.flatten().collect(),
            Err(_) => return Vec::new(),
        }
    };

    raw.into_iter()
        .map(|(key, turns, tokens, input, cached, output, cost)| {
            let name = crate::storage::workspace::load_project_by_hash(&key)
                .ok()
                .flatten()
                .map(|p| p.name)
                .unwrap_or_else(|| key.chars().take(8).collect());
            let agent_split = query_agent_split_for_project(&key, from_ts, to_ts);
            TopItem {
                id: key,
                name,
                turns: turns as u64,
                tokens: tokens as u64,
                input_tokens: input as u64,
                cached_tokens: cached as u64,
                output_tokens: output as u64,
                agent_split,
                cost,
            }
        })
        .collect()
}

fn query_top_tasks(project_key: &str, from_ts: i64, to_ts: i64) -> Vec<TopItem> {
    // Drop the DB guard before calling load_tasks — see `query_top_projects`
    // for the deadlock rationale.
    let raw: Vec<(String, i64, i64, i64, i64, i64, f64)> = {
        let conn = database::connection();
        let sql = "SELECT task_id, COUNT(*),
                          COALESCE(SUM(total_tokens), 0),
                          COALESCE(SUM(input_tokens), 0),
                          COALESCE(SUM(cached_read_tokens), 0),
                          COALESCE(SUM(output_tokens), 0),
                          COALESCE(SUM(cost_amount), 0.0)
                   FROM chat_token_usage
                   WHERE end_ts BETWEEN ?1 AND ?2 AND project_key = ?3
                     AND automation_run_id IS NULL
                   GROUP BY task_id
                   ORDER BY 3 DESC
                   LIMIT 10";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![from_ts, to_ts, project_key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, f64>(6)?,
            ))
        });
        match rows {
            Ok(it) => it.flatten().collect(),
            Err(_) => return Vec::new(),
        }
    };

    let tasks = crate::storage::tasks::load_tasks(project_key).unwrap_or_default();
    let task_names: std::collections::HashMap<String, String> =
        tasks.into_iter().map(|t| (t.id.clone(), t.name)).collect();

    raw.into_iter()
        .map(|(task_id, turns, tokens, input, cached, output, cost)| {
            let name = task_names
                .get(&task_id)
                .cloned()
                .unwrap_or_else(|| task_id.chars().take(8).collect());
            let agent_split = query_agent_split_for_task(project_key, &task_id, from_ts, to_ts);
            TopItem {
                id: task_id,
                name,
                turns: turns as u64,
                tokens: tokens as u64,
                input_tokens: input as u64,
                cached_tokens: cached as u64,
                output_tokens: output as u64,
                agent_split,
                cost,
            }
        })
        .collect()
}

/// chat_id, agent, turns, total, input, cached, output, cost
type SessionAgentRow = (String, String, i64, i64, i64, i64, i64, f64);

fn query_top_sessions(project_key: &str, task_id: &str, from_ts: i64, to_ts: i64) -> Vec<TopItem> {
    // One row per (session, agent): a Buddy session can change agents.
    // Drop the DB guard before loading titles — see `query_top_projects`.
    let raw: Vec<SessionAgentRow> = {
        let conn = database::connection();
        let sql = "SELECT chat_id, agent, COUNT(*),
                          COALESCE(SUM(total_tokens), 0),
                          COALESCE(SUM(input_tokens), 0),
                          COALESCE(SUM(cached_read_tokens), 0),
                          COALESCE(SUM(output_tokens), 0),
                          COALESCE(SUM(cost_amount), 0.0)
                   FROM chat_token_usage
                   WHERE end_ts BETWEEN ?1 AND ?2 AND project_key = ?3 AND task_id = ?4
                     AND automation_run_id IS NULL
                   GROUP BY chat_id, agent";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![from_ts, to_ts, project_key, task_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, f64>(7)?,
            ))
        });
        match rows {
            Ok(it) => it.flatten().collect(),
            Err(_) => return Vec::new(),
        }
    };

    let titles: std::collections::HashMap<String, String> =
        crate::storage::tasks::load_chat_sessions(project_key, task_id)
            .unwrap_or_default()
            .into_iter()
            .map(|chat| (chat.id, chat.title))
            .collect();

    let mut items: Vec<TopItem> = Vec::new();
    for (chat_id, agent, turns, tokens, input, cached, output, cost) in raw {
        let item = match items.iter_mut().find(|item| item.id == chat_id) {
            Some(item) => item,
            None => {
                let name = titles
                    .get(&chat_id)
                    .cloned()
                    .unwrap_or_else(|| "Archived session".to_string());
                items.push(TopItem {
                    id: chat_id,
                    name,
                    turns: 0,
                    tokens: 0,
                    input_tokens: 0,
                    cached_tokens: 0,
                    output_tokens: 0,
                    agent_split: Vec::new(),
                    cost: 0.0,
                });
                items.last_mut().expect("just pushed")
            }
        };
        item.turns += turns as u64;
        item.tokens += tokens as u64;
        item.input_tokens += input as u64;
        item.cached_tokens += cached as u64;
        item.output_tokens += output as u64;
        item.cost += cost;
        item.agent_split.push(AgentBucket {
            agent,
            tokens: tokens as u64,
            turns: turns as u64,
            cost,
        });
    }
    for item in &mut items {
        item.agent_split
            .sort_by_key(|a| std::cmp::Reverse(a.tokens));
    }
    items.sort_by_key(|a| std::cmp::Reverse(a.tokens));
    items
}

fn query_agent_split_for_project(key: &str, from_ts: i64, to_ts: i64) -> Vec<AgentBucket> {
    let conn = database::connection();
    let sql =
        "SELECT agent, COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_amount), 0.0)
               FROM chat_token_usage
               WHERE end_ts BETWEEN ?1 AND ?2 AND project_key = ?3
               GROUP BY agent
               ORDER BY 3 DESC";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![from_ts, to_ts, key], |r| {
        Ok(AgentBucket {
            agent: r.get(0)?,
            turns: r.get::<_, i64>(1)? as u64,
            tokens: r.get::<_, i64>(2)? as u64,
            cost: r.get::<_, f64>(3)?,
        })
    });
    match rows {
        Ok(it) => it.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

fn query_agent_split_for_task(
    project_key: &str,
    task_id: &str,
    from_ts: i64,
    to_ts: i64,
) -> Vec<AgentBucket> {
    let conn = database::connection();
    let sql =
        "SELECT agent, COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_amount), 0.0)
               FROM chat_token_usage
               WHERE end_ts BETWEEN ?1 AND ?2 AND project_key = ?3 AND task_id = ?4
                 AND automation_run_id IS NULL
               GROUP BY agent
               ORDER BY 3 DESC";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![from_ts, to_ts, project_key, task_id], |r| {
        Ok(AgentBucket {
            agent: r.get(0)?,
            turns: r.get::<_, i64>(1)? as u64,
            tokens: r.get::<_, i64>(2)? as u64,
            cost: r.get::<_, f64>(3)?,
        })
    });
    match rows {
        Ok(it) => it.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

// ── Heatmap ─────────────────────────────────────────────────────────────

fn query_heatmap(scope: &Scope, from_ts: i64, to_ts: i64) -> Vec<HeatmapCell> {
    let conn = database::connection();
    let sql = format!(
        "SELECT
            CAST(strftime('%w', end_ts, 'unixepoch') AS INTEGER) AS wd,
            CAST(strftime('%H', end_ts, 'unixepoch') AS INTEGER) AS hr,
            COUNT(*)
         FROM chat_token_usage
         WHERE end_ts BETWEEN ?1 AND ?2 AND {}
         GROUP BY wd, hr",
        scope_clause(scope),
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows: Vec<HeatmapCell> = match stmt.query_map(
        params_from_iter(scope_args(scope, from_ts, to_ts)),
        map_heatmap_row,
    ) {
        Ok(it) => it.flatten().collect(),
        Err(_) => Vec::new(),
    };
    rows
}

fn map_heatmap_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HeatmapCell> {
    Ok(HeatmapCell {
        weekday: r.get::<_, i64>(0)? as u8,
        hour: r.get::<_, i64>(1)? as u8,
        turns: r.get::<_, i64>(2)? as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::token_usage::{self, TokenUsageRecord};

    fn turn(task: &str, chat: &str, agent: &str, tokens: u64, end_ts: i64) {
        token_usage::insert(&TokenUsageRecord {
            project_key: "proj",
            task_id: Some(task),
            chat_id: Some(chat),
            automation_run_id: None,
            agent,
            model: Some("m1"),
            input_tokens: tokens,
            cached_read_tokens: None,
            output_tokens: 0,
            total_tokens: tokens,
            start_ts: end_ts - 10,
            end_ts,
            cost_amount: Some(0.5),
            cost_currency: Some("USD"),
        })
        .unwrap();
    }

    #[test]
    fn task_scope_counts_only_that_task_and_ranks_its_sessions() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        turn("t1", "chat-a", "claude", 100, 1_000);
        turn("t1", "chat-a", "codex", 50, 1_100);
        turn("t1", "chat-b", "claude", 400, 1_200);
        turn("t2", "chat-c", "claude", 9_000, 1_300);

        let scope = Scope::Task {
            project_key: "proj".into(),
            task_id: "t1".into(),
        };
        let period = aggregate(&scope, 0, 2_000, Bucket::Daily).current;
        assert_eq!(period.kpi.turns, 3);
        assert_eq!(period.kpi.tokens_total, 550);
        assert_eq!(period.models.len(), 2); // m1 under claude and under codex
        let sessions: Vec<_> = period
            .top
            .iter()
            .map(|item| (item.id.as_str(), item.tokens, item.agent_split.len()))
            .collect();
        assert_eq!(sessions, vec![("chat-b", 400, 1), ("chat-a", 150, 2)]);

        let project = aggregate(&Scope::Project("proj".into()), 0, 2_000, Bucket::Daily);
        assert_eq!(project.current.kpi.tokens_total, 9_550);

        crate::storage::set_grove_dir_override(None);
    }
}
