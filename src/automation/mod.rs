//! Automation: cron-driven prompts injected into chat sessions.
//!
//! See `src/storage/automations.rs` for the persistence model and the
//! `src/api/handlers/automations.rs` REST surface. The scheduler is spawned
//! once at API server startup (`api::start_server`).

pub mod cron_util;
pub mod executor;
pub mod scheduler;

/// Subsystem-wide warning log. Routes through `tracing::warn!` when the
/// `perf-monitor` feature is on (so the in-memory trace collector picks it
/// up alongside other handler instrumentation); falls back to a plain
/// `eprintln!` with a `[automation]` prefix otherwise. Centralised so every
/// background-task error in this subsystem uses the same channel.
macro_rules! awarn {
    ($($arg:tt)*) => {{
        #[cfg(feature = "perf-monitor")]
        ::tracing::warn!(target: "grove::automation", $($arg)*);
        #[cfg(not(feature = "perf-monitor"))]
        ::std::eprintln!("[automation] {}", ::std::format_args!($($arg)*));
    }};
}
pub(crate) use awarn;
