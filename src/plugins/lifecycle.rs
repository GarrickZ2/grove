//! When a plugin's app-scoped backend runs, and what state it is in.
//!
//! `plugin.json` declares this on `contributes.backend`:
//!   - `lifetime`: `on-demand` (default) or `service`, a process that should
//!     keep running, like a webhook listener.
//!   - `activation`: `onStartup`, `onInvoke` (default) and `onSchedule:<cron>`.
//!   - `restart`: `on-failure` restarts a crashed service, within limits.
//!   - `listeners`: ports the plugin says it opens; shown in review, not enforced.
//!
//! A service never outlives the Grove server that started it. Several Grove
//! instances can share one `~/.grove`, so a machine-wide lease keeps a service
//! to a single process; the other instances report `elsewhere` and take over
//! once the lease frees up.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};

/// Most recent log lines kept per plugin.
const LOG_LINES: usize = 500;
/// Crashes within [`FAILURE_WINDOW`] before a service is left stopped.
const MAX_FAILURES: usize = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(600);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// A backend's declared lifecycle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Policy {
    pub service: bool,
    pub restart: bool,
    pub on_startup: bool,
    pub schedules: Vec<String>,
    pub unknown_activation: Vec<String>,
    pub listeners: Vec<Value>,
}

fn parse_policy(manifest: &Value) -> Policy {
    let backend = manifest.get("contributes").and_then(|c| c.get("backend"));
    let field = |key| backend.and_then(|b: &Value| b.get(key));
    let service = field("lifetime").and_then(Value::as_str) == Some("service");
    let mut policy = Policy {
        service,
        restart: service && field("restart").and_then(Value::as_str) == Some("on-failure"),
        on_startup: service,
        listeners: field("listeners")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        ..Policy::default()
    };
    for event in field("activation")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if event == "onStartup" {
            policy.on_startup = true;
        } else if let Some(cron) = event.strip_prefix("onSchedule:") {
            policy.schedules.push(cron.to_owned());
        } else if event != "onInvoke" {
            policy.unknown_activation.push(event.to_owned());
        }
    }
    policy
}

/// The lifecycle declared by the manifest in `local_path`.
pub fn policy(local_path: &str) -> Policy {
    std::fs::read_to_string(Path::new(local_path).join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .map(|manifest| parse_policy(&manifest))
        .unwrap_or_default()
}

/// How long to wait before restart number `failures`, or None to give up.
fn backoff(failures: usize) -> Option<Duration> {
    if failures == 0 || failures >= MAX_FAILURES {
        return None;
    }
    let delay = Duration::from_secs(1 << (failures - 1).min(6));
    Some(delay.min(MAX_BACKOFF))
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    /// `stopped` | `running` | `restarting` | `failed` | `elsewhere`
    pub state: &'static str,
    pub detail: Option<String>,
    pub pid: Option<u32>,
    pub restarts: u32,
    /// Unix milliseconds.
    pub started_at: Option<i64>,
    pub last_error: Option<String>,
    #[serde(skip)]
    failures: Vec<Instant>,
    #[serde(skip)]
    logs: VecDeque<String>,
}

static RUNTIME: Lazy<Mutex<HashMap<String, Runtime>>> = Lazy::new(Default::default);

fn with_runtime<T>(plugin_id: &str, change: impl FnOnce(&mut Runtime) -> T) -> T {
    let mut runtimes = RUNTIME.lock().unwrap();
    let runtime = runtimes.entry(plugin_id.to_owned()).or_default();
    if runtime.state.is_empty() {
        runtime.state = "stopped";
    }
    change(runtime)
}

pub fn record_started(plugin_id: &str, pid: Option<u32>) {
    with_runtime(plugin_id, |runtime| {
        runtime.state = "running";
        runtime.detail = None;
        runtime.pid = pid;
        runtime.started_at = Some(chrono::Utc::now().timestamp_millis());
    });
}

pub fn record_stopped(plugin_id: &str) {
    with_runtime(plugin_id, |runtime| {
        runtime.state = "stopped";
        runtime.detail = None;
        runtime.pid = None;
    });
}

pub fn record_elsewhere(plugin_id: &str) {
    with_runtime(plugin_id, |runtime| {
        runtime.state = "elsewhere";
        runtime.detail = Some("Running in another Grove window".into());
        runtime.pid = None;
    });
}

pub fn record_detail(plugin_id: &str, detail: Option<String>) {
    with_runtime(plugin_id, |runtime| runtime.detail = detail);
}

/// Log an unexpected exit and decide whether to restart, and after how long.
pub fn record_crash(plugin_id: &str, error: String, restart: bool) -> Option<Duration> {
    with_runtime(plugin_id, |runtime| {
        runtime.pid = None;
        runtime.detail = None;
        runtime.last_error = Some(error);
        runtime.failures.retain(|at| at.elapsed() < FAILURE_WINDOW);
        runtime.failures.push(Instant::now());
        let delay = restart.then(|| backoff(runtime.failures.len())).flatten();
        if delay.is_some() {
            runtime.state = "restarting";
            runtime.restarts += 1;
        } else {
            runtime.state = if restart { "failed" } else { "stopped" };
        }
        delay
    })
}

/// A user-requested start forgets past crashes.
pub fn reset_failures(plugin_id: &str) {
    with_runtime(plugin_id, |runtime| {
        runtime.failures.clear();
        runtime.last_error = None;
    });
}

pub fn record_log(plugin_id: &str, line: &str) {
    with_runtime(plugin_id, |runtime| {
        if runtime.logs.len() == LOG_LINES {
            runtime.logs.pop_front();
        }
        runtime.logs.push_back(line.to_owned());
    });
}

/// Current state and recent logs, for the plugin's detail page.
pub fn snapshot(plugin_id: &str) -> Value {
    let (runtime, logs) = with_runtime(plugin_id, |runtime| {
        (
            runtime.clone(),
            runtime.logs.iter().cloned().collect::<Vec<_>>(),
        )
    });
    let mut value = serde_json::to_value(runtime).unwrap_or_else(|_| json!({}));
    value["logs"] = json!(logs);
    value
}

/// Current state without logs, for plugin lists.
pub fn summary(plugin_id: &str) -> Value {
    let mut value = snapshot(plugin_id);
    if let Some(fields) = value.as_object_mut() {
        fields.remove("logs");
    }
    value
}

pub fn forget(plugin_id: &str) {
    RUNTIME.lock().unwrap().remove(plugin_id);
}

fn lease_file(name: &str) -> std::io::Result<File> {
    let dir = crate::storage::grove_dir().join("plugin-leases");
    std::fs::create_dir_all(&dir)?;
    File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(format!("{name}.lock")))
}

/// Take the machine-wide lease on a plugin's service; held until the returned
/// file drops. None when another process holds it.
pub fn acquire_service_lease(plugin_id: &str) -> std::io::Result<Option<File>> {
    let file = lease_file(plugin_id)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

/// Claim one scheduled run: true for exactly one Grove instance per `slot`.
pub fn claim_schedule_slot(plugin_id: &str, slot: i64) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut file = lease_file(&format!("{plugin_id}.schedule"))?;
    file.lock()?;
    let mut last = String::new();
    file.read_to_string(&mut last)?;
    let claimed = last.trim().parse::<i64>().map_or(true, |last| last < slot);
    if claimed {
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        write!(file, "{slot}")?;
    }
    file.unlock()?;
    Ok(claimed)
}

/// `(cron, slot)` for each schedule due in `(after, now]`.
pub fn due_schedules(
    schedules: &[String],
    after: chrono::DateTime<chrono::Local>,
    now: chrono::DateTime<chrono::Local>,
) -> Vec<(String, i64)> {
    schedules
        .iter()
        .filter_map(|cron| {
            let next = crate::automation::cron_util::next_after(cron, after).ok()??;
            (next <= now).then(|| (cron.clone(), next.timestamp()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_defaults_to_on_demand() {
        let policy = parse_policy(&json!({"contributes": {"backend": {"command": "node"}}}));
        assert_eq!(policy, Policy::default());
    }

    #[test]
    fn a_service_starts_with_grove_and_restarts_only_when_asked() {
        let policy = parse_policy(&json!({"contributes": {"backend": {
            "lifetime": "service",
            "listeners": [{"id": "webhook", "port": 8787}]
        }}}));
        assert!(policy.service && policy.on_startup && !policy.restart);
        assert_eq!(policy.listeners[0]["port"], 8787);
        let policy = parse_policy(&json!({"contributes": {"backend": {
            "lifetime": "service", "restart": "on-failure"
        }}}));
        assert!(policy.restart);
        // Restart means nothing without a service to keep alive.
        let policy = parse_policy(&json!({"contributes": {"backend": {"restart": "on-failure"}}}));
        assert!(!policy.restart);
    }

    #[test]
    fn activation_events_are_parsed_and_unknown_ones_kept_for_review() {
        let policy = parse_policy(&json!({"contributes": {"backend": {
            "activation": ["onStartup", "onInvoke", "onSchedule:0 9 * * *", "onMoon"]
        }}}));
        assert!(policy.on_startup);
        assert_eq!(policy.schedules, vec!["0 9 * * *"]);
        assert_eq!(policy.unknown_activation, vec!["onMoon"]);
    }

    #[test]
    fn backoff_grows_then_gives_up() {
        let delays: Vec<_> = (1..=5).map(backoff).collect();
        assert_eq!(
            delays,
            vec![
                Some(Duration::from_secs(1)),
                Some(Duration::from_secs(2)),
                Some(Duration::from_secs(4)),
                Some(Duration::from_secs(8)),
                None
            ]
        );
    }

    #[test]
    fn crashes_restart_until_the_limit_then_fail() {
        let id = "pl-crash-test";
        forget(id);
        for _ in 0..4 {
            assert!(record_crash(id, "boom".into(), true).is_some());
        }
        assert_eq!(snapshot(id)["state"], "restarting");
        assert!(record_crash(id, "boom".into(), true).is_none());
        let state = snapshot(id);
        assert_eq!(state["state"], "failed");
        assert_eq!(state["restarts"], 4);
        assert_eq!(state["lastError"], "boom");
        reset_failures(id);
        assert!(record_crash(id, "again".into(), true).is_some());
        forget(id);
    }

    #[test]
    fn an_on_demand_crash_does_not_restart() {
        let id = "pl-crash-on-demand";
        forget(id);
        assert!(record_crash(id, "boom".into(), false).is_none());
        assert_eq!(snapshot(id)["state"], "stopped");
        forget(id);
    }

    #[test]
    fn logs_keep_the_most_recent_lines() {
        let id = "pl-log-test";
        forget(id);
        for line in 0..=LOG_LINES {
            record_log(id, &line.to_string());
        }
        let state = snapshot(id);
        let logs = state["logs"].as_array().unwrap();
        assert_eq!(logs.len(), LOG_LINES);
        assert_eq!(logs[0], "1");
        forget(id);
    }

    #[test]
    fn only_one_holder_gets_a_service_lease() {
        let directory = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(directory.path().to_path_buf()));
        let first = acquire_service_lease("p").unwrap();
        assert!(first.is_some());
        assert!(acquire_service_lease("p").unwrap().is_none());
        assert!(acquire_service_lease("other").unwrap().is_some());
        drop(first);
        assert!(acquire_service_lease("p").unwrap().is_some());
        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn a_schedule_slot_is_claimed_once() {
        let directory = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(directory.path().to_path_buf()));
        assert!(claim_schedule_slot("p", 100).unwrap());
        assert!(!claim_schedule_slot("p", 100).unwrap());
        assert!(!claim_schedule_slot("p", 99).unwrap());
        assert!(claim_schedule_slot("p", 101).unwrap());
        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn due_schedules_fire_only_inside_the_window() {
        use chrono::TimeZone;
        let at = |minute| {
            chrono::Local
                .with_ymd_and_hms(2026, 3, 2, 9, minute, 0)
                .unwrap()
        };
        let schedules = vec!["*/5 * * * *".to_string()];
        assert_eq!(due_schedules(&schedules, at(1), at(4)).len(), 0);
        assert_eq!(due_schedules(&schedules, at(1), at(6)).len(), 1);
        assert!(due_schedules(&["not a cron".to_string()], at(1), at(6)).is_empty());
    }
}
