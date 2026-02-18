//! Global state management for the Web API server.
//!
//! Manages FileWatchers for all live tasks (tasks with active tmux sessions).

use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

use once_cell::sync::Lazy;

use crate::session;
use crate::storage::{tasks, workspace};
use crate::watcher::FileWatcher;

/// Global state: one FileWatcher per project
pub static FILE_WATCHERS: Lazy<RwLock<HashMap<String, FileWatcher>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Initialize FileWatchers for all live tasks.
///
/// This function scans all registered projects and their tasks,
/// checking for active tmux sessions. For each live task, it starts
/// file watching on the worktree directory.
///
/// Called at web server startup.
pub fn init_file_watchers() {
    let projects = match workspace::load_projects() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to load projects for file watching: {}", e);
            return;
        }
    };

    let mut watchers = match FILE_WATCHERS.write() {
        Ok(w) => w,
        Err(_) => return,
    };

    for project in projects {
        let project_key = workspace::project_hash(&project.path);

        // Load all active tasks for this project
        let project_tasks = match tasks::load_tasks(&project_key) {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Check which tasks have active sessions
        let mut has_live_tasks = false;
        let mut watcher = FileWatcher::new(&project_key);

        for task in &project_tasks {
            let task_mux = session::resolve_session_type(&task.multiplexer);
            let sname = session::resolve_session_name(&task.session_name, &project_key, &task.id);
            if session::session_exists(&task_mux, &sname) {
                // This task is live - start watching its worktree
                if !has_live_tasks {
                    watcher.start();
                    has_live_tasks = true;
                }
                watcher.watch(&task.id, Path::new(&task.worktree_path));
            }
        }

        // Only add watcher if there are live tasks
        if has_live_tasks {
            watchers.insert(project_key, watcher);
        }
    }

    let count: usize = watchers.values().count();
    if count > 0 {
        eprintln!(
            "FileWatcher: monitoring {} project(s) with live tasks",
            count
        );
    }
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

/// Register file watching for a task.
///
/// Called when a new tmux session is created for a task.
/// If the project doesn't have a watcher yet, one is created.
pub fn watch_task(project_key: &str, task_id: &str, worktree_path: &str) {
    if let Ok(mut watchers) = FILE_WATCHERS.write() {
        if let Some(watcher) = watchers.get_mut(project_key) {
            // Project already has a watcher, just add this task
            watcher.watch(task_id, Path::new(worktree_path));
        } else {
            // Project doesn't have a watcher yet, create one
            let mut watcher = FileWatcher::new(project_key);
            watcher.start();
            watcher.watch(task_id, Path::new(worktree_path));
            watchers.insert(project_key.to_string(), watcher);
        }
    }
}
