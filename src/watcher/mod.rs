//! File system watcher for task worktrees.
//!
//! Forwards file content changes to per-task subscribers (the symbol
//! indexer keeps its index in sync this way). Nothing is recorded or
//! written to disk; subscribers filter and debounce for themselves.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use notify::{
    event::{CreateKind, ModifyKind, RenameMode},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

/// Per-task subscriber, called on the notify thread with the absolute path
/// of every changed file. Must be lightweight.
pub type SubscriberFn = dyn Fn(&Path) + Send + Sync + 'static;

#[derive(Default)]
struct Routes {
    /// task id -> watched worktree
    roots: HashMap<String, PathBuf>,
    subscribers: HashMap<String, Vec<Arc<SubscriberFn>>>,
}

/// Watches the worktrees of one project's tasks.
pub struct FileWatcher {
    /// Created on the first `watch`; dropping it stops the notify thread.
    watcher: Mutex<Option<RecommendedWatcher>>,
    routes: Arc<RwLock<Routes>>,
}

impl FileWatcher {
    pub fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
            routes: Arc::new(RwLock::new(Routes::default())),
        }
    }

    /// Register a callback for `task_id`. Repeated registrations stack;
    /// call `unsubscribe` to clear.
    pub fn subscribe<F>(&self, task_id: impl Into<String>, callback: F)
    where
        F: Fn(&Path) + Send + Sync + 'static,
    {
        if let Ok(mut routes) = self.routes.write() {
            routes
                .subscribers
                .entry(task_id.into())
                .or_default()
                .push(Arc::new(callback));
        }
    }

    /// Drop all callbacks for `task_id`. No-op if none were registered.
    pub fn unsubscribe(&self, task_id: &str) {
        if let Ok(mut routes) = self.routes.write() {
            routes.subscribers.remove(task_id);
        }
    }

    /// Watch a task's worktree. Idempotent per task.
    pub fn watch(&self, task_id: &str, path: &Path) {
        let Ok(mut slot) = self.watcher.lock() else {
            return;
        };
        if slot.is_none() {
            let routes = Arc::clone(&self.routes);
            match RecommendedWatcher::new(
                move |res: notify::Result<Event>| {
                    if let Ok(event) = res {
                        dispatch(&routes, event);
                    }
                },
                Config::default(),
            ) {
                Ok(watcher) => *slot = Some(watcher),
                Err(_) => return,
            }
        }
        let Some(watcher) = slot.as_mut() else {
            return;
        };
        let Ok(mut routes) = self.routes.write() else {
            return;
        };
        if routes.roots.get(task_id).map(PathBuf::as_path) == Some(path) {
            return;
        }
        if let Some(old) = routes.roots.remove(task_id) {
            let _ = watcher.unwatch(&old);
        }
        if watcher.watch(path, RecursiveMode::Recursive).is_ok() {
            routes.roots.insert(task_id.to_string(), path.to_path_buf());
        }
    }

    /// Stop watching a task and drop its subscribers.
    pub fn unwatch(&self, task_id: &str) {
        let root = match self.routes.write() {
            Ok(mut routes) => {
                routes.subscribers.remove(task_id);
                routes.roots.remove(task_id)
            }
            Err(_) => return,
        };
        if let (Some(root), Ok(mut slot)) = (root, self.watcher.lock()) {
            if let Some(watcher) = slot.as_mut() {
                let _ = watcher.unwatch(&root);
            }
        }
    }
}

impl Default for FileWatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Route a content change to the subscribers of the task that owns it.
///
/// Covers direct edits, creations and "write to a temp file, then rename"
/// saves (many editors and AI tools), which arrive as a rename to the path.
fn dispatch(routes: &RwLock<Routes>, event: Event) {
    let content_change = matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Name(RenameMode::To))
            | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
            | EventKind::Create(CreateKind::File)
            | EventKind::Create(CreateKind::Any)
    );
    if !content_change {
        return;
    }
    // Snapshot the callbacks so a slow one can't hold the lock.
    let targets: Vec<(PathBuf, Vec<Arc<SubscriberFn>>)> = {
        let Ok(routes) = routes.read() else {
            return;
        };
        event
            .paths
            .into_iter()
            .filter_map(|path| {
                let (task_id, _) = routes
                    .roots
                    .iter()
                    .find(|(_, root)| path.starts_with(root))?;
                let callbacks = routes.subscribers.get(task_id)?.clone();
                Some((path, callbacks))
            })
            .collect()
    };
    for (path, callbacks) in targets {
        for callback in callbacks {
            callback(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::CanonicalPath;
    use std::time::Duration;

    #[test]
    fn forwards_changes_to_the_tasks_subscribers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonical().unwrap();
        let watcher = FileWatcher::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        watcher.subscribe("t1", move |path| {
            let _ = tx.lock().unwrap().send(path.to_path_buf());
        });
        watcher.watch("t1", &root);

        let file = root.join("main.go");
        std::fs::write(&file, "package main").unwrap();
        let seen = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(seen, file);

        watcher.unwatch("t1");
        while rx.try_recv().is_ok() {}
        std::fs::write(root.join("other.go"), "package main").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    }
}
