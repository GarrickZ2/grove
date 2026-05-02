//! Per-handler request timing middleware.
//!
//! Records request duration into an in-memory ring buffer keyed by the
//! axum-matched route pattern (e.g. `/projects/{id}/git/status` rather
//! than the concrete URL). Buffers are bounded so memory is constant.
//!
//! Stats are surfaced through `handlers::perf::handler_stats_handler`,
//! which the frontend perf panel polls. Compiled in only with the
//! `perf-monitor` feature (gated at the `mod` declaration).

use axum::{
    body::Body,
    extract::{MatchedPath, Request},
    http::Response,
    middleware::Next,
};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Per-route ring buffer capacity. Trades a few KB for stable percentiles.
const SAMPLES_PER_ROUTE: usize = 1000;

#[derive(Default)]
struct RouteSamples {
    /// Ring of duration in microseconds. Older samples are overwritten.
    samples: Vec<u64>,
    next: usize,
    total_count: u64,
    /// HTTP status of the most recent sample, for sniff-checking errors.
    last_status: u16,
}

impl RouteSamples {
    fn push(&mut self, micros: u64, status: u16) {
        if self.samples.len() < SAMPLES_PER_ROUTE {
            self.samples.push(micros);
        } else {
            self.samples[self.next] = micros;
            self.next = (self.next + 1) % SAMPLES_PER_ROUTE;
        }
        self.total_count += 1;
        self.last_status = status;
    }
}

static STATS: Lazy<Mutex<HashMap<String, RouteSamples>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub async fn perf_timing_middleware(req: Request, next: Next) -> Response<Body> {
    use tracing::Instrument;

    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());
    let method = req.method().clone();
    let key = format!("{} {}", method, route);

    let started = Instant::now();
    // Root span — the perf_tracing layer keys traces by this name, so it
    // doubles as the trace identifier for the per-route ring buffer.
    let span = tracing::info_span!("request", otel.name = %key);
    let response = next.run(req).instrument(span).await;
    let micros = started.elapsed().as_micros() as u64;
    let status = response.status().as_u16();

    if let Ok(mut guard) = STATS.lock() {
        guard.entry(key).or_default().push(micros, status);
    }

    response
}

#[derive(Serialize)]
pub struct RouteStat {
    pub route: String,
    pub count: u64,
    pub samples_in_window: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub last_status: u16,
}

#[derive(Serialize)]
pub struct HandlerStatsResponse {
    pub routes: Vec<RouteStat>,
}

pub fn snapshot() -> HandlerStatsResponse {
    let guard = match STATS.lock() {
        Ok(g) => g,
        Err(_) => return HandlerStatsResponse { routes: vec![] },
    };
    let mut routes: Vec<RouteStat> = guard
        .iter()
        .map(|(route, rs)| {
            let mut sorted = rs.samples.clone();
            sorted.sort_unstable();
            let n = sorted.len();
            let pct = |q: f64| {
                if n == 0 {
                    0.0
                } else {
                    let idx = ((n as f64 - 1.0) * q).round() as usize;
                    sorted[idx.min(n - 1)] as f64 / 1000.0
                }
            };
            RouteStat {
                route: route.clone(),
                count: rs.total_count,
                samples_in_window: n,
                p50_ms: pct(0.50),
                p95_ms: pct(0.95),
                p99_ms: pct(0.99),
                max_ms: sorted.last().copied().unwrap_or(0) as f64 / 1000.0,
                last_status: rs.last_status,
            }
        })
        .collect();
    routes.sort_by(|a, b| {
        b.p95_ms
            .partial_cmp(&a.p95_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    HandlerStatsResponse { routes }
}

pub fn reset() {
    if let Ok(mut guard) = STATS.lock() {
        guard.clear();
    }
}
