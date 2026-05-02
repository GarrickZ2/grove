//! Process-level perf metrics endpoint.
//!
//! Exposes RSS + CPU% for the current Grove process so the frontend
//! perf-build panel can plot a memory/CPU trend even on Tauri/WebKit
//! (where `performance.memory` is unavailable).
//!
//! Compiled in only when the `perf-monitor` cargo feature is on (gated
//! at the `mod` declaration in `handlers/mod.rs`). Release builds omit
//! the dep, the route, and any sampling overhead entirely.

use axum::Json;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// Single shared System instance — sysinfo's CPU% is computed as the delta
/// between two consecutive refreshes, so reusing the same instance across
/// requests is required to get meaningful numbers.
static SYS: Lazy<Mutex<System>> = Lazy::new(|| Mutex::new(System::new()));

#[derive(Serialize)]
pub struct SysInfoResponse {
    pub rss_bytes: u64,
    pub cpu_percent: f32,
    pub pid: u32,
}

pub async fn handler_stats_handler() -> Json<crate::api::perf_middleware::HandlerStatsResponse> {
    Json(crate::api::perf_middleware::snapshot())
}

pub async fn handler_stats_reset() -> Json<serde_json::Value> {
    crate::api::perf_middleware::reset();
    Json(serde_json::json!({"ok": true}))
}

#[derive(serde::Deserialize)]
pub struct ListTracesQuery {
    pub route: String,
}

pub async fn list_traces_handler(
    axum::extract::Query(q): axum::extract::Query<ListTracesQuery>,
) -> Json<crate::api::perf_tracing::RouteTracesResponse> {
    Json(crate::api::perf_tracing::list_traces(&q.route))
}

pub async fn get_trace_handler(
    axum::extract::Path(trace_id): axum::extract::Path<u64>,
) -> Result<Json<crate::api::perf_tracing::TraceRecord>, axum::http::StatusCode> {
    crate::api::perf_tracing::get_trace(trace_id)
        .map(Json)
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

pub async fn sysinfo_handler() -> Json<SysInfoResponse> {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = SYS.lock().expect("perf sysinfo mutex poisoned");
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::new().with_memory().with_cpu(),
    );
    let proc = sys.process(pid);
    Json(SysInfoResponse {
        rss_bytes: proc.map(|p| p.memory()).unwrap_or(0),
        cpu_percent: proc.map(|p| p.cpu_usage()).unwrap_or(0.0),
        pid: std::process::id(),
    })
}
