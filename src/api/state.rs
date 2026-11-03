//! Global state management for the Web API server.
//!
//! Lazy file watching: a `FileWatcher` is created on demand for a project
//! the first time one of its tasks is activated by the frontend (via the
//! `POST /tasks/{id}/activate` endpoint, hit when the user enters a task
//! workspace page). Server startup itself does not scan projects/tasks;
//! pre-ACP probing via `session_exists` missed all ACP-only tasks and
//! wasted work on stale tmux sessions.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::RwLock;
use std::time::Instant;

use once_cell::sync::Lazy;

use crate::watcher::FileWatcher;

/// Global state: one FileWatcher per project, populated lazily.
pub static FILE_WATCHERS: Lazy<RwLock<HashMap<String, FileWatcher>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Server-startup hook. Currently a no-op kept as a lifecycle placeholder so
/// `gui.rs` and `mod.rs` can still call it symmetrically with shutdown.
pub fn init_file_watchers() {
    Lazy::force(&FILE_WATCHERS);
}

/// Stop all FileWatchers. Called on graceful shutdown (Ctrl+C).
pub fn shutdown_file_watchers() {
    if let Ok(mut watchers) = FILE_WATCHERS.write() {
        watchers.clear();
    }
}

/// Ensure file watching is active for the given task. Idempotent: repeated
/// calls for the same task are cheap (the inner watcher dedups by task id).
///
/// Called when the frontend enters a task workspace page (via /activate),
/// and also defensively when a terminal session is opened.
///
/// The watcher only feeds the symbol indexer, so nothing is watched while
/// indexing is off. Also kicks the indexer's once-gated initial build for
/// this task, so build and watch share a single trigger point.
pub fn ensure_task_active(project_key: &str, task_id: &str, worktree_path: &str) {
    if !crate::storage::config::load_config().indexing.enabled {
        return;
    }
    if let Ok(mut watchers) = FILE_WATCHERS.write() {
        watchers
            .entry(project_key.to_string())
            .or_default()
            .watch(task_id, Path::new(worktree_path));
    }

    crate::symbols::on_watch_started(project_key, task_id, Path::new(worktree_path));
}

/// Global session for the connected browser companion extension.
/// Manages the WebSocket channel and handles async request-response mapping.
#[derive(Debug, Default)]
pub struct CompanionInfo {
    pub extension_version: Option<String>,
    pub protocol_version: Option<u32>,
    pub capabilities: HashSet<String>,
}

pub struct ExtensionSession {
    pub sender: tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
    pub pending_requests:
        std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
    pub companion_info: std::sync::Mutex<CompanionInfo>,
    pub connected_at: Instant,
}

pub static EXTENSION_SESSION: Lazy<RwLock<Option<ExtensionSession>>> =
    Lazy::new(|| RwLock::new(None));
