//! In-memory tracing collector for the perf-build frontend.
//!
//! Records every #[tracing::instrument] span tree as a "trace", grouped by
//! the root span name (typically the axum route pattern set by the perf
//! middleware). Each route keeps its most recent N traces in a ring buffer.
//! Surfaced through `handlers::perf::traces_*`.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

const TRACES_PER_ROUTE: usize = 50;

#[derive(Debug, Clone, Serialize)]
pub struct SpanRecord {
    pub id: u64,
    pub parent_id: Option<u64>,
    pub name: String,
    pub start_us: u64,
    pub duration_us: u64,
    pub fields: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceRecord {
    pub trace_id: u64,
    pub root_name: String,
    pub started_at_ms: u64,
    pub total_us: u64,
    pub spans: Vec<SpanRecord>,
}

struct InProgressSpan {
    name: String,
    started: Instant,
    parent_id: Option<u64>,
    fields: HashMap<String, String>,
    /// Root trace id this span belongs to (own id if it's a root).
    root_id: u64,
}

struct InProgressTrace {
    root_name: String,
    started: Instant,
    started_at_ms: u64,
    spans: Vec<SpanRecord>,
}

struct CollectorState {
    in_progress_spans: HashMap<u64, InProgressSpan>,
    in_progress_traces: HashMap<u64, InProgressTrace>,
    /// Per-route ring buffer of completed traces.
    completed: HashMap<String, Vec<TraceRecord>>,
}

static STATE: Lazy<Mutex<CollectorState>> = Lazy::new(|| {
    Mutex::new(CollectorState {
        in_progress_spans: HashMap::new(),
        in_progress_traces: HashMap::new(),
        completed: HashMap::new(),
    })
});

pub struct PerfTraceLayer;

impl<S> Layer<S> for PerfTraceLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let parent_id = ctx.current_span().id().map(|p| p.into_u64());
        let mut fields = HashMap::new();
        let mut visitor = FieldVisitor(&mut fields);
        attrs.record(&mut visitor);

        let mut state = match STATE.lock() {
            Ok(s) => s,
            Err(_) => return,
        };

        let own_id = id.into_u64();
        let root_id = match parent_id {
            Some(pid) => state
                .in_progress_spans
                .get(&pid)
                .map(|p| p.root_id)
                .unwrap_or(own_id),
            None => own_id,
        };

        if parent_id.is_none() {
            // New root span — start a trace. Prefer the `route` /
            // `otel.name` field if the caller set one (the perf
            // middleware does, so we bucket by `METHOD /pattern`),
            // otherwise fall back to the span's static name.
            let route_name = fields
                .get("otel.name")
                .or_else(|| fields.get("route"))
                .cloned()
                .unwrap_or_else(|| attrs.metadata().name().to_owned());
            state.in_progress_traces.insert(
                own_id,
                InProgressTrace {
                    root_name: route_name,
                    started: Instant::now(),
                    started_at_ms: now_ms(),
                    spans: Vec::new(),
                },
            );
        }

        state.in_progress_spans.insert(
            own_id,
            InProgressSpan {
                name: attrs.metadata().name().to_owned(),
                started: Instant::now(),
                parent_id,
                fields,
                root_id,
            },
        );
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, _ctx: Context<'_, S>) {
        let mut state = match STATE.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if let Some(sp) = state.in_progress_spans.get_mut(&id.into_u64()) {
            let mut visitor = FieldVisitor(&mut sp.fields);
            values.record(&mut visitor);
        }
    }

    fn on_event(&self, _event: &Event<'_>, _ctx: Context<'_, S>) {
        // Events not collected — keep the buffer focused on span trees.
    }

    fn on_close(&self, id: Id, _ctx: Context<'_, S>) {
        let mut state = match STATE.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let span_id = id.into_u64();
        let Some(sp) = state.in_progress_spans.remove(&span_id) else {
            return;
        };

        let root_id = sp.root_id;
        let trace_started = match state.in_progress_traces.get(&root_id) {
            Some(t) => t.started,
            None => return,
        };
        let start_us = sp.started.duration_since(trace_started).as_micros() as u64;
        let duration_us = sp.started.elapsed().as_micros() as u64;

        let record = SpanRecord {
            id: span_id,
            parent_id: sp.parent_id,
            name: sp.name,
            start_us,
            duration_us,
            fields: sp.fields,
        };

        if let Some(t) = state.in_progress_traces.get_mut(&root_id) {
            t.spans.push(record);
        }

        // If this was the root, finalize the trace.
        if span_id == root_id {
            if let Some(t) = state.in_progress_traces.remove(&root_id) {
                let route = t.root_name.clone();
                // Skip self-observation (perf endpoints).
                if route.contains("/perf/") {
                    return;
                }
                let trace = TraceRecord {
                    trace_id: root_id,
                    root_name: t.root_name,
                    started_at_ms: t.started_at_ms,
                    total_us: t.started.elapsed().as_micros() as u64,
                    spans: t.spans,
                };
                let buf = state.completed.entry(route).or_default();
                if buf.len() >= TRACES_PER_ROUTE {
                    buf.remove(0);
                }
                buf.push(trace);
            }
        }
    }
}

struct FieldVisitor<'a>(&'a mut HashMap<String, String>);

impl tracing::field::Visit for FieldVisitor<'_> {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.insert(field.name().to_owned(), value.to_owned());
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().to_owned(), format!("{:?}", value));
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
pub struct TraceListEntry {
    pub trace_id: u64,
    pub started_at_ms: u64,
    pub total_us: u64,
    pub span_count: usize,
}

#[derive(Serialize)]
pub struct RouteTracesResponse {
    pub route: String,
    pub traces: Vec<TraceListEntry>,
}

pub fn list_traces(route: &str) -> RouteTracesResponse {
    let guard = match STATE.lock() {
        Ok(s) => s,
        Err(_) => {
            return RouteTracesResponse {
                route: route.to_owned(),
                traces: vec![],
            }
        }
    };
    let traces = guard
        .completed
        .get(route)
        .map(|buf| {
            buf.iter()
                .rev()
                .map(|t| TraceListEntry {
                    trace_id: t.trace_id,
                    started_at_ms: t.started_at_ms,
                    total_us: t.total_us,
                    span_count: t.spans.len(),
                })
                .collect()
        })
        .unwrap_or_default();
    RouteTracesResponse {
        route: route.to_owned(),
        traces,
    }
}

pub fn get_trace(trace_id: u64) -> Option<TraceRecord> {
    let guard = STATE.lock().ok()?;
    for buf in guard.completed.values() {
        if let Some(t) = buf.iter().find(|t| t.trace_id == trace_id) {
            return Some(t.clone());
        }
    }
    None
}

pub fn install() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let subscriber = tracing_subscriber::registry().with(PerfTraceLayer);
    let _ = subscriber.try_init();
}
