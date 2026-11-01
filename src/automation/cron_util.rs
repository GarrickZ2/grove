//! Cron expression parsing.
//!
//! Users (and the frontend cronstrue preview) speak 5-field standard cron
//! (`minute hour day month weekday`), where Sunday is 0 or 7 and Monday is 1.
//! The `cron` crate speaks 6-field cron with leading seconds (and an optional
//! 7th year field), and numbers weekdays as Sunday=1 through Saturday=7. We
//! translate the weekday field and prepend `"0 "` before parsing. Output
//! `next_run_at` is unix seconds.
//!
//! Schedules are interpreted in the **system local timezone**: a user picking
//! "Daily at 9am" expects 9am on their wall clock, not 9 UTC. The returned
//! unix timestamp is timezone-agnostic (seconds since epoch), so storage and
//! comparison stay clean — only the "what `hour` means in the cron string"
//! interpretation differs.

use std::str::FromStr;

use chrono::{DateTime, Local, TimeZone};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Optional time bounds layered on top of the cron expression.
///
/// - `run_once_at` makes the schedule one-shot: it fires once at that instant
///   and the cron expression is ignored.
/// - `starts_at` / `ends_at` bound a recurring cron to an inclusive window
///   ("every Friday, until Dec 31"). Domain events honour the same window.
///
/// All values are unix seconds. Once a bounded schedule has no future
/// occurrence the scheduler fires the final due run and disables the
/// automation instead of flagging it as broken.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleWindow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_once_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
}

impl ScheduleWindow {
    pub fn is_bounded(&self) -> bool {
        self.run_once_at.is_some() || self.starts_at.is_some() || self.ends_at.is_some()
    }

    /// Whether `ts` falls inside the recurring window. One-shot schedules
    /// accept events until they have fired (the scheduler then disables them).
    pub fn contains(&self, ts: i64) -> bool {
        self.starts_at.is_none_or(|start| ts >= start) && self.ends_at.is_none_or(|end| ts <= end)
    }
}

fn standard_weekday(value: &str) -> Result<u32, String> {
    let ordinal = match value.to_ascii_lowercase().as_str() {
        "sun" | "sunday" => 0,
        "mon" | "monday" => 1,
        "tue" | "tues" | "tuesday" => 2,
        "wed" | "wednesday" => 3,
        "thu" | "thurs" | "thursday" => 4,
        "fri" | "friday" => 5,
        "sat" | "saturday" => 6,
        _ => value
            .parse::<u32>()
            .map_err(|_| format!("invalid day of week: {value}"))?,
    };
    if ordinal > 7 {
        return Err(format!("day of week must be between 0 and 7: {value}"));
    }
    Ok(if ordinal == 7 { 0 } else { ordinal })
}

fn standard_weekday_range(value: &str) -> Result<Vec<u32>, String> {
    if matches!(value, "*" | "?") {
        return Ok((0..=6).collect());
    }

    if let Some((start, end)) = value.split_once('-') {
        let raw_numeric = start.parse::<u32>().ok().zip(end.parse::<u32>().ok());
        if let Some((start, end)) = raw_numeric {
            if start > 7 || end > 7 || start > end {
                return Err(format!("invalid day-of-week range: {value}"));
            }
            return Ok((start..=end)
                .map(|day| if day == 7 { 0 } else { day })
                .collect());
        }

        let start = standard_weekday(start)?;
        let end = standard_weekday(end)?;
        if start > end {
            return Err(format!("invalid day-of-week range: {value}"));
        }
        return Ok((start..=end).collect());
    }

    Ok(vec![standard_weekday(value)?])
}

/// Convert a standard cron weekday expression into the `cron` crate's
/// Sunday=1 ordinal set. Expanding the seven-value field keeps ranges and
/// steps correct across the Sunday boundary (for example `5-7` and `*/2`).
fn translate_weekday_field(field: &str) -> Result<String, String> {
    if matches!(field, "*" | "?") {
        return Ok(field.to_string());
    }

    let mut weekdays = BTreeSet::new();
    for item in field.split(',') {
        let (base, step) = match item.split_once('/') {
            Some((base, step)) => {
                let step = step
                    .parse::<usize>()
                    .map_err(|_| format!("invalid day-of-week step: {item}"))?;
                if step == 0 {
                    return Err("day-of-week step cannot be zero".to_string());
                }
                (base, step)
            }
            None => (item, 1),
        };

        let mut values = standard_weekday_range(base)?;
        // Like the backend cron parser, a point followed by `/N` means the
        // range from that point through the maximum weekday.
        if step > 1 && !matches!(base, "*" | "?") && !base.contains('-') {
            let start = values[0];
            values = (start..=6).collect();
        }
        for weekday in values.into_iter().step_by(step) {
            weekdays.insert(weekday);
        }
    }

    if weekdays.is_empty() {
        return Err("day-of-week field cannot be empty".to_string());
    }
    Ok(weekdays
        .into_iter()
        .map(|weekday| (weekday + 1).to_string())
        .collect::<Vec<_>>()
        .join(","))
}

fn normalized_expression(expr: &str) -> Result<String, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Ok(expr.to_string());
    }
    let weekday = translate_weekday_field(fields[4])?;
    Ok(format!(
        "0 {} {} {} {} {}",
        fields[0], fields[1], fields[2], fields[3], weekday
    ))
}

pub fn validate(expr: &str) -> Result<(), String> {
    Schedule::from_str(&normalized_expression(expr.trim())?)
        .map(|_| ())
        .map_err(|e| format!("invalid cron expression: {e}"))
}

/// Next firing time **strictly after** `after`, interpreted in local time.
/// `None` if the cron has no future occurrences (rare — usually a fixed past
/// date). Tests call this with an explicit `after` so they're deterministic;
/// production callers use [`next_unix`].
pub fn next_after(expr: &str, after: DateTime<Local>) -> Result<Option<DateTime<Local>>, String> {
    let schedule = Schedule::from_str(&normalized_expression(expr.trim())?)
        .map_err(|e| format!("invalid cron expression: {e}"))?;
    Ok(schedule.after(&after).next())
}

/// Validate a cron expression together with its window. One-shot schedules
/// ignore the cron expression entirely, so it may be empty.
pub fn validate_schedule(expr: &str, window: ScheduleWindow) -> Result<(), String> {
    if window.run_once_at.is_some() {
        if window.starts_at.is_some() || window.ends_at.is_some() {
            return Err("a one-time schedule cannot also have a start or end time".to_string());
        }
        return Ok(());
    }
    validate(expr)?;
    if let (Some(start), Some(end)) = (window.starts_at, window.ends_at) {
        if start >= end {
            return Err("schedule end time must be after its start time".to_string());
        }
    }
    Ok(())
}

/// Next firing time strictly after `after`, honouring the window.
pub fn next_scheduled_after(
    expr: &str,
    window: ScheduleWindow,
    after: DateTime<Local>,
) -> Result<Option<i64>, String> {
    if let Some(at) = window.run_once_at {
        return Ok((at > after.timestamp()).then_some(at));
    }
    // `next_after` is strictly-after, so step one second back to make an
    // occurrence exactly at `starts_at` eligible.
    let floor = match window.starts_at {
        Some(start) if start - 1 > after.timestamp() => Local
            .timestamp_opt(start - 1, 0)
            .single()
            .ok_or_else(|| format!("invalid schedule start time: {start}"))?,
        _ => after,
    };
    Ok(next_after(expr, floor)?
        .map(|dt| dt.timestamp())
        .filter(|next| window.ends_at.is_none_or(|end| *next <= end)))
}

/// Next firing time strictly after now (system local time), honouring the window.
pub fn next_scheduled(expr: &str, window: ScheduleWindow) -> Result<Option<i64>, String> {
    next_scheduled_after(expr, window, Local::now())
}

/// Next firing time strictly after `now` (system local time) as unix seconds.
pub fn next_unix(expr: &str) -> Result<Option<i64>, String> {
    Ok(next_after(expr, Local::now())?.map(|dt| dt.timestamp()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Timelike, Weekday};

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

    #[test]
    fn standard_numeric_weekday_fires_on_tuesday() {
        let tuesday_after_fire_time = Local
            .with_ymd_and_hms(2026, 8, 11, 11, 0, 0)
            .single()
            .unwrap();
        let next = next_after("10 10 * * 2", tuesday_after_fire_time)
            .unwrap()
            .unwrap();
        assert_eq!(next.weekday(), Weekday::Tue);
        assert_eq!(next.day(), 18);
    }

    #[test]
    fn standard_sunday_zero_and_seven_are_equivalent() {
        let saturday = Local
            .with_ymd_and_hms(2026, 8, 15, 11, 0, 0)
            .single()
            .unwrap();
        let zero = next_after("10 10 * * 0", saturday).unwrap().unwrap();
        let seven = next_after("10 10 * * 7", saturday).unwrap().unwrap();
        assert_eq!(zero, seven);
        assert_eq!(zero.weekday(), Weekday::Sun);
    }

    #[test]
    fn translates_standard_weekday_lists_ranges_and_steps() {
        assert_eq!(translate_weekday_field("1,3,5").unwrap(), "2,4,6");
        assert_eq!(translate_weekday_field("1-5").unwrap(), "2,3,4,5,6");
        assert_eq!(translate_weekday_field("5-7").unwrap(), "1,6,7");
        assert_eq!(translate_weekday_field("*/2").unwrap(), "1,3,5,7");
        assert_eq!(translate_weekday_field("MON-FRI").unwrap(), "2,3,4,5,6");
    }

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    #[test]
    fn one_time_schedule_fires_once_and_ignores_cron() {
        let at = local(2026, 12, 31, 14, 30).timestamp();
        let window = ScheduleWindow {
            run_once_at: Some(at),
            ..Default::default()
        };
        validate_schedule("", window).expect("cron is ignored for one-time runs");
        let before = local(2026, 12, 1, 0, 0);
        assert_eq!(next_scheduled_after("", window, before).unwrap(), Some(at));
        let after = local(2026, 12, 31, 14, 30);
        assert_eq!(next_scheduled_after("", window, after).unwrap(), None);
        assert!(validate_schedule(
            "",
            ScheduleWindow {
                ends_at: Some(at),
                ..window
            }
        )
        .is_err());
    }

    #[test]
    fn window_bounds_recurring_schedule() {
        // Fridays at 09:00, from Nov 10 until Dec 31 2026.
        let window = ScheduleWindow {
            run_once_at: None,
            starts_at: Some(local(2026, 11, 10, 0, 0).timestamp()),
            ends_at: Some(local(2026, 12, 31, 23, 59).timestamp()),
        };
        validate_schedule("0 9 * * 5", window).unwrap();
        let next = next_scheduled_after("0 9 * * 5", window, local(2026, 11, 1, 0, 0))
            .unwrap()
            .unwrap();
        assert_eq!(next, local(2026, 11, 13, 9, 0).timestamp());
        let last = next_scheduled_after("0 9 * * 5", window, local(2026, 12, 20, 0, 0))
            .unwrap()
            .unwrap();
        assert_eq!(last, local(2026, 12, 25, 9, 0).timestamp());
        assert_eq!(
            next_scheduled_after("0 9 * * 5", window, local(2026, 12, 25, 9, 0)).unwrap(),
            None
        );
        assert!(window.contains(local(2026, 12, 1, 0, 0).timestamp()));
        assert!(!window.contains(local(2027, 1, 1, 0, 0).timestamp()));
    }

    #[test]
    fn start_time_on_an_occurrence_is_inclusive() {
        let start = local(2026, 11, 13, 9, 0).timestamp();
        let window = ScheduleWindow {
            starts_at: Some(start),
            ..Default::default()
        };
        let next = next_scheduled_after("0 9 * * *", window, local(2026, 11, 1, 0, 0))
            .unwrap()
            .unwrap();
        assert_eq!(next, start);
        assert!(validate_schedule(
            "0 9 * * *",
            ScheduleWindow {
                ends_at: Some(start),
                ..window
            }
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_standard_weekdays() {
        assert!(validate("0 9 * * 8").is_err());
        assert!(validate("0 9 * * 5-1").is_err());
        assert!(validate("0 9 * * */0").is_err());
    }
}
