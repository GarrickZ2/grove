//! Cron expression parsing.
//!
//! Users (and the frontend cronstrue preview) speak 5-field standard cron
//! (`minute hour day month weekday`). The `cron` crate speaks 6-field cron
//! with leading seconds (and an optional 7th year field), so we prepend
//! `"0 "` before parsing. Output `next_run_at` is unix seconds.
//!
//! Schedules are interpreted in the **system local timezone**: a user picking
//! "Daily at 9am" expects 9am on their wall clock, not 9 UTC. The returned
//! unix timestamp is timezone-agnostic (seconds since epoch), so storage and
//! comparison stay clean — only the "what `hour` means in the cron string"
//! interpretation differs.

use std::str::FromStr;

use chrono::{DateTime, Local};
use cron::Schedule;

/// Promote a 5-field standard cron expression to the cron-crate's 6-field
/// form. Returns the input unchanged if it already has 6 or 7 fields so a
/// caller who knows what they're doing can pass through seconds-precision.
fn to_six_field(expr: &str) -> String {
    let field_count = expr.split_whitespace().count();
    if field_count == 5 {
        format!("0 {expr}")
    } else {
        expr.to_string()
    }
}

pub fn validate(expr: &str) -> Result<(), String> {
    Schedule::from_str(&to_six_field(expr.trim()))
        .map(|_| ())
        .map_err(|e| format!("invalid cron expression: {e}"))
}

/// Next firing time **strictly after** `after`, interpreted in local time.
/// `None` if the cron has no future occurrences (rare — usually a fixed past
/// date). Tests call this with an explicit `after` so they're deterministic;
/// production callers use [`next_unix`].
pub fn next_after(expr: &str, after: DateTime<Local>) -> Result<Option<DateTime<Local>>, String> {
    let schedule = Schedule::from_str(&to_six_field(expr.trim()))
        .map_err(|e| format!("invalid cron expression: {e}"))?;
    Ok(schedule.after(&after).next())
}

/// Next firing time strictly after `now` (system local time) as unix seconds.
pub fn next_unix(expr: &str) -> Result<Option<i64>, String> {
    Ok(next_after(expr, Local::now())?.map(|dt| dt.timestamp()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    #[test]
    fn validate_accepts_standard_5_field() {
        validate("0 9 * * *").expect("9am daily");
        validate("*/15 * * * *").expect("every 15 min");
        validate("0 9 * * 1-5").expect("9am weekdays");
    }

    #[test]
    fn validate_rejects_garbage() {
        assert!(validate("not a cron").is_err());
        assert!(validate("60 0 * * *").is_err());
    }

    #[test]
    fn next_after_is_strictly_future_local() {
        // 8 AM local → next 9am local is one hour later.
        let now = Local
            .with_ymd_and_hms(2026, 5, 23, 8, 0, 0)
            .single()
            .unwrap();
        let next = next_after("0 9 * * *", now).unwrap().unwrap();
        assert_eq!(next.hour(), 9);
        assert_eq!(next.date_naive(), now.date_naive());
    }
}
