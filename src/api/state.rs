//! Global state management for the Web API server.
//!
//! Lazy file watching: a `FileWatcher` is created on demand for a project
//! the first time one of its tasks is activated by the frontend (via the
//! `POST /tasks/{id}/activate` endpoint, hit when the user enters a task
//! workspace page). Server startup itself does not scan projects/tasks;
//! pre-ACP probing via `session_exists` missed all ACP-only tasks and
//! wasted work on stale tmux sessions.

use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

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

/// Shutdown all FileWatchers and flush pending events to disk.
///
/// Called on graceful shutdown (Ctrl+C).
pub fn shutdown_file_watchers() {
    if let Ok(mut watchers) = FILE_WATCHERS.write() {
        for (_, watcher) in watchers.drain() {
            watcher.shutdown();
        }
    }
    eprintln!("FileWatcher: all watchers shut down");
}

/// Ensure file watching is active for the given task. Idempotent: repeated
/// calls for the same task are cheap (the inner watcher dedups by task id).
///
/// Called when the frontend enters a task workspace page (via /activate),
/// and also defensively when a terminal session is opened.
///
/// Also kicks the symbol indexer's once-gated initial build for this
/// task — the indexer subscribes to watcher events for incremental
/// updates, so build and watch share a single trigger point.
pub fn ensure_task_active(project_key: &str, task_id: &str, worktree_path: &str) {
    if let Ok(mut watchers) = FILE_WATCHERS.write() {
        if let Some(watcher) = watchers.get_mut(project_key) {
            watcher.watch(task_id, Path::new(worktree_path));
        } else {
            let mut watcher = FileWatcher::new(project_key);
            watcher.start();
            watcher.watch(task_id, Path::new(worktree_path));
            watchers.insert(project_key.to_string(), watcher);
        }
    }

    crate::symbols::on_watch_started(project_key, task_id, Path::new(worktree_path));
}
