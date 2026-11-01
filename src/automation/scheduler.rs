//! Background cron-tick scheduler.
//!
//! One tokio task, ~30s ticks. On each tick:
//! 1. Read all `enabled = true` automations whose `next_run_at <= now`.
//! 2. For each one, atomically advance `next_run_at` so a slow run can't
//!    re-fire on the next tick.
//! 3. Spawn the executor.
//!
//! The scheduler only runs while the Grove process is alive — automations
//! do not fire when Grove is shut down. This is documented in the UI; we
//! catch up on the *next* fire window only, not on missed historical ones.

use std::collections::HashSet;
use std::time::Duration;

use chrono::Utc;

use crate::storage::automations;

use super::{awarn, executor};

const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Boot the scheduler. Fire-and-forget — the returned future never resolves
/// in normal operation; the task is owned by the tokio runtime.
pub fn spawn() {
    tokio::spawn(async {
        // Stagger the first tick by one full interval so we don't slam the
        // DB during startup when many other tasks are also booting.
        let mut ticker = tokio::time::interval(TICK_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // First .tick() returns immediately; skip it.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = run_tick().await {
                awarn!("tick failed: {e}");
            }
        }
    });
}

async fn run_tick() -> Result<(), String> {
    let now = Utc::now().timestamp();
    let due = automations::load_due(now).map_err(|e| e.to_string())?;
    if due.is_empty() {
        return Ok(());
    }

    // Partition due rows:
    // - a valid future occurrence → advance `next_run_at` (de-dup gate so a
    //   slow executor doesn't make the same automation fire twice on the
    //   next tick);
    // - a bounded schedule (one-time, or past its end time) with nothing
    //   left → fire this final run, then disable it as finished;
    // - an unbounded cron with no future occurrences → disable with an
    //   error, otherwise it would stay due forever and spawn every 30s.
    let mut advances: Vec<(String, i64)> = Vec::with_capacity(due.len());
    let mut finished: Vec<String> = Vec::new();
    let mut dead: Vec<String> = Vec::new();
    for a in &due {
        match executor::advance_next_run(a) {
            Some(next) => advances.push((a.id.clone(), next)),
            None if a.window.is_bounded() => finished.push(a.id.clone()),
            None => dead.push(a.id.clone()),
        }
    }
    let refs: Vec<(&str, i64)> = advances.iter().map(|(id, n)| (id.as_str(), *n)).collect();
    automations::claim_due(now, &refs).map_err(|e| e.to_string())?;
    let mut fire: HashSet<String> = advances.into_iter().map(|(id, _)| id).collect();
    for id in finished {
        match automations::finish_schedule(&id) {
            Ok(()) => {
                fire.insert(id);
            }
            Err(e) => awarn!("finish schedule {id}: {e}"),
        }
    }
    for id in &dead {
        if let Err(e) = automations::disable_with_error(
            id,
            "Cron expression has no future occurrences — automation disabled",
        ) {
            awarn!("disable dead-cron {id}: {e}");
        }
    }

    // Only fire automations whose `next_run_at` was successfully advanced or
    // cleared. The detached spawn keeps a single hung run from stalling
    // future ticks.
    for automation in due {
        if !fire.contains(&automation.id) {
            continue;
        }
        tokio::spawn(async move {
            executor::run(&automation, "cron").await;
        });
    }

    Ok(())
}
