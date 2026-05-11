//! File system watcher for tracking task activity.
//!
//! Monitors worktree directories for file modifications and maintains
//! edit history for visualization in the Stats panel.
//!
//! Only tracks files that are tracked by git (via `git ls-files`).

mod storage;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, RwLock};
use std::thread;

use chrono::{DateTime, Utc};
use notify::{
    event::{CreateKind, ModifyKind, RenameMode},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

pub use storage::{load_edit_history, save_edit_history, EditEvent};

/// Debounce window in seconds - ignore duplicate events for same file within this window
const DEBOUNCE_SECS: i64 = 2;

/// How often to refresh the git tracked files cache (in seconds)
const GIT_CACHE_REFRESH_SECS: u64 = 60;

/// Filter out filesystem noise that would otherwise pollute the edit history.
///
/// Two categories:
/// - **OS/editor cruft**: `.DS_Store`, `Thumbs.db`, vim swap/backup files,
///   emacs lockfiles. Never carry semantic meaning.
/// - **Atomic-write temp files**: `<name>.tmp.<digits>` (Claude Code, Cursor,
///   many others write here then rename to the target). The follow-up
///   rename produces a separate event for the real file, so we don't lose
///   the edit by skipping the tmp.
///
/// For git projects this filter is technically redundant with `git ls-files`
/// (tmp files aren't tracked), but the ls-files cache refreshes only every
/// 60s — newly created tmp files in the gap could slip through. For Studio
/// projects (no git) this is the only line of defense.
fn is_noise_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    // OS metadata files
    if matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | "4913") {
        return true;
    }

    // Editor swap / backup / lockfiles
    if name.starts_with(".#")
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swo")
        || name.ends_with(".swn")
        || name.ends_with(".bak")
        || name.ends_with(".orig")
    {
        return true;
    }

    // `<name>.tmp.<digits-or-hex>` — atomic-write pattern from many AI tools
    // and editors. Suffix must be non-empty and all hex/digit chars to avoid
    // accidentally matching a real file like `report.tmp.draft`.
    if let Some(tmp_idx) = name.rfind(".tmp.") {
        let suffix = &name[tmp_idx + ".tmp.".len()..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_hexdigit()) {
            return true;
        }
    }

    // Bare `.tmp` suffix
    if name.ends_with(".tmp") {
        return true;
    }

    false
}

/// Get list of git-tracked files in a directory
fn get_git_tracked_files(worktree_path: &Path) -> HashSet<PathBuf> {
    let output = Command::new("git")
        .args(["ls-files"])
        .current_dir(worktree_path)
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout
                .lines()
                .map(|line| PathBuf::from(crate::git::git_unquote(line.trim())))
                .collect()
        }
        _ => HashSet::new(),
    }
}

/// Maximum events to keep in memory per task (older events are dropped from memory but kept on disk)
const MAX_MEMORY_EVENTS: usize = 1000;

/// Edit history for a single task
#[derive(Debug, Clone, Default)]
pub struct TaskEditHistory {
    /// All edit events
    pub events: Vec<EditEvent>,
    /// File path -> edit count
    pub file_counts: HashMap<PathBuf, u32>,
    /// File path -> last edit time (for debouncing)
    pub file_last_edit: HashMap<PathBuf, DateTime<Utc>>,
    /// Last activity time
    pub last_activity: Option<DateTime<Utc>>,
}

impl TaskEditHistory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_event(&mut self, event: EditEvent) {
        let file = event.file.clone();

        // Debounce: skip if same file was edited within DEBOUNCE_SECS
        if let Some(&last_time) = self.file_last_edit.get(&file) {
            let diff = event.timestamp.signed_duration_since(last_time);
            if diff.num_seconds() < DEBOUNCE_SECS {
                return; // Skip duplicate event
            }
        }

        self.file_last_edit.insert(file.clone(), event.timestamp);
        self.last_activity = Some(event.timestamp);
        self.events.push(event);
        *self.file_counts.entry(file).or_insert(0) += 1;

        // Limit memory usage: keep only recent events in memory
        // (older events are still on disk for historical reference)
        if self.events.len() > MAX_MEMORY_EVENTS {
            // Remove oldest 20% to avoid frequent trimming
            let trim_count = MAX_MEMORY_EVENTS / 5;
            self.events.drain(0..trim_count);
        }
    }

    /// Get files sorted by edit count (descending)
    pub fn files_by_count(&self) -> Vec<(&PathBuf, u32)> {
        let mut files: Vec<_> = self.file_counts.iter().map(|(k, v)| (k, *v)).collect();
        files.sort_by_key(|b| std::cmp::Reverse(b.1));
        files
    }

    /// Get activity buckets for timeline visualization
    /// Returns: Vec of (hour_start, buckets) where buckets is 60 x 1-minute slots
    pub fn activity_timeline(&self) -> Vec<(DateTime<Utc>, [u32; 60])> {
        use chrono::Timelike;

        if self.events.is_empty() {
            return vec![];
        }

        // Group events by hour
        let mut hours: HashMap<DateTime<Utc>, [u32; 60]> = HashMap::new();

        for event in &self.events {
            let hour_start = event
                .timestamp
                .with_minute(0)
                .and_then(|t| t.with_second(0))
                .and_then(|t| t.with_nanosecond(0))
                .unwrap_or(event.timestamp);

            let bucket_idx = event.timestamp.minute() as usize;
            let buckets = hours.entry(hour_start).or_insert([0; 60]);
            if bucket_idx < 60 {
                buckets[bucket_idx] += 1;
            }
        }

        // Sort by time and filter out hours with no activity
        let mut result: Vec<_> = hours
            .into_iter()
            .filter(|(_, buckets)| buckets.iter().any(|&b| b > 0))
            .collect();
        result.sort_by_key(|(hour, _)| *hour);
        result
    }

    /// Total edit count
    pub fn total_edits(&self) -> u32 {
        self.file_counts.values().sum()
    }
}

/// Per-task event subscriber. Called from the watcher thread for every
/// debounced edit event matching the registered `task_id`. Implementors
/// must be lightweight — heavy work should be moved off-thread.
pub type SubscriberFn = dyn Fn(&EditEvent) + Send + Sync + 'static;

/// Manages file watching for multiple tasks
pub struct FileWatcher {
    /// Sender to control the watcher thread
    control_tx: Option<Sender<WatcherCommand>>,
    /// Shared edit history per task
    histories: Arc<RwLock<HashMap<String, TaskEditHistory>>>,
    /// Pending events to flush
    pending_events: Arc<RwLock<HashMap<String, Vec<EditEvent>>>>,
    /// Per-task callbacks invoked from the watcher thread for each
    /// debounced edit event. Used by the symbol indexer to keep its
    /// in-memory index in sync with disk; other consumers can plug in.
    subscribers: Arc<RwLock<HashMap<String, Vec<Arc<SubscriberFn>>>>>,
    /// Project key for storage
    project_key: String,
}

enum WatcherCommand {
    Watch {
        task_id: String,
        path: PathBuf,
    },
    #[allow(dead_code)]
    Unwatch {
        task_id: String,
    },
    Shutdown,
}

impl FileWatcher {
    /// Create a new FileWatcher for a project
    pub fn new(project_key: &str) -> Self {
        Self {
            control_tx: None,
            histories: Arc::new(RwLock::new(HashMap::new())),
            pending_events: Arc::new(RwLock::new(HashMap::new())),
            subscribers: Arc::new(RwLock::new(HashMap::new())),
            project_key: project_key.to_string(),
        }
    }

    /// Register a callback for `task_id`. Multiple callbacks per task
    /// are supported; they fire in registration order. Idempotent in
    /// the sense that repeated registrations stack — call `unsubscribe`
    /// to clear.
    #[allow(dead_code)]
    pub fn subscribe<F>(&self, task_id: impl Into<String>, callback: F)
    where
        F: Fn(&EditEvent) + Send + Sync + 'static,
    {
        if let Ok(mut subs) = self.subscribers.write() {
            subs.entry(task_id.into())
                .or_default()
                .push(Arc::new(callback));
        }
    }

    /// Drop all callbacks for `task_id`. No-op if none were registered.
    #[allow(dead_code)]
    pub fn unsubscribe(&self, task_id: &str) {
        if let Ok(mut subs) = self.subscribers.write() {
            subs.remove(task_id);
        }
    }

    /// Start the watcher background thread
    pub fn start(&mut self) {
        let (control_tx, control_rx) = channel();
        let histories = Arc::clone(&self.histories);
        let pending_events = Arc::clone(&self.pending_events);
        let subscribers = Arc::clone(&self.subscribers);
        let project_key = self.project_key.clone();

        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_watcher_thread(
                    control_rx,
                    histories,
                    pending_events,
                    subscribers,
                    project_key,
                );
            }));
            if let Err(e) = result {
                let msg = if let Some(s) = e.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = e.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic".to_string()
                };
                eprintln!("[Grove] File watcher thread panicked: {}", msg);
            }
        });

        self.control_tx = Some(control_tx);
    }

    /// Watch a task's worktree directory
    pub fn watch(&self, task_id: &str, path: &Path) {
        // Load existing history from disk (without re-applying debounce logic)
        if let Ok(events) = load_edit_history(&self.project_key, task_id) {
            let mut history = TaskEditHistory::new();
            for event in events {
                // Directly rebuild state without debounce check
                let file = event.file.clone();
                history.last_activity = Some(event.timestamp);
                history.file_last_edit.insert(file.clone(), event.timestamp);
                history.events.push(event);
                *history.file_counts.entry(file).or_insert(0) += 1;
            }
            // Apply memory limit
            if history.events.len() > MAX_MEMORY_EVENTS {
                let trim_count = history.events.len() - MAX_MEMORY_EVENTS;
                history.events.drain(0..trim_count);
            }
            if let Ok(mut histories) = self.histories.write() {
                histories.insert(task_id.to_string(), history);
            }
        }

        if let Some(tx) = &self.control_tx {
            let _ = tx.send(WatcherCommand::Watch {
                task_id: task_id.to_string(),
                path: path.to_path_buf(),
            });
        }
    }

    /// Load history only without starting file monitoring (for read-only mode)
    pub fn load_history_only(&self, task_id: &str, _path: &Path) {
        self.reload_history(task_id);
    }

    /// Reload history from disk (for refreshing read-only mode data)
    pub fn reload_history(&self, task_id: &str) {
        if let Ok(events) = load_edit_history(&self.project_key, task_id) {
            let mut history = TaskEditHistory::new();
            for event in events {
                let file = event.file.clone();
                history.last_activity = Some(event.timestamp);
                history.file_last_edit.insert(file.clone(), event.timestamp);
                history.events.push(event);
                *history.file_counts.entry(file).or_insert(0) += 1;
            }
            if history.events.len() > MAX_MEMORY_EVENTS {
                let trim_count = history.events.len() - MAX_MEMORY_EVENTS;
                history.events.drain(0..trim_count);
            }
            if let Ok(mut histories) = self.histories.write() {
                histories.insert(task_id.to_string(), history);
            }
        }
    }

    /// Stop watching a task
    #[allow(dead_code)]
    pub fn unwatch(&self, task_id: &str) {
        if let Some(tx) = &self.control_tx {
            let _ = tx.send(WatcherCommand::Unwatch {
                task_id: task_id.to_string(),
            });
        }
    }

    /// Get edit history for a task
    pub fn get_history(&self, task_id: &str) -> Option<TaskEditHistory> {
        self.histories
            .read()
            .ok()
            .and_then(|h| h.get(task_id).cloned())
    }

    /// Flush pending events to disk
    pub fn flush(&self) {
        if let Ok(mut pending) = self.pending_events.write() {
            for (task_id, events) in pending.drain() {
                if !events.is_empty() {
                    let _ = save_edit_history(&self.project_key, &task_id, &events);
                }
            }
        }
    }

    /// Shutdown the watcher
    pub fn shutdown(&self) {
        self.flush();
        if let Some(tx) = &self.control_tx {
            let _ = tx.send(WatcherCommand::Shutdown);
        }
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_watcher_thread(
    control_rx: Receiver<WatcherCommand>,
    histories: Arc<RwLock<HashMap<String, TaskEditHistory>>>,
    pending_events: Arc<RwLock<HashMap<String, Vec<EditEvent>>>>,
    subscribers: Arc<RwLock<HashMap<String, Vec<Arc<SubscriberFn>>>>>,
    project_key: String,
) {
    let (event_tx, event_rx) = channel();

    let mut watcher = match RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.send(event);
            }
        },
        Config::default(),
    ) {
        Ok(w) => w,
        Err(_) => return,
    };

    // Map of path -> task_id for event routing
    let mut path_to_task: HashMap<PathBuf, String> = HashMap::new();

    // Cache of git-tracked files per worktree (path -> set of relative file paths)
    let mut git_tracked_cache: HashMap<PathBuf, HashSet<PathBuf>> = HashMap::new();
    let mut last_cache_refresh = std::time::Instant::now();

    // Track last flush time
    let mut last_flush = std::time::Instant::now();
    let mut event_count_since_flush = 0;

    loop {
        // Check for control commands (non-blocking)
        while let Ok(cmd) = control_rx.try_recv() {
            match cmd {
                WatcherCommand::Watch { task_id, path } => {
                    if watcher.watch(&path, RecursiveMode::Recursive).is_ok() {
                        // Initialize git tracked files cache for this worktree
                        let tracked = get_git_tracked_files(&path);
                        git_tracked_cache.insert(path.clone(), tracked);
                        path_to_task.insert(path, task_id);
                    }
                }
                WatcherCommand::Unwatch { task_id } => {
                    // Find and remove the path
                    let path_to_remove: Vec<_> = path_to_task
                        .iter()
                        .filter(|(_, tid)| *tid == &task_id)
                        .map(|(p, _)| p.clone())
                        .collect();
                    for path in path_to_remove {
                        let _ = watcher.unwatch(&path);
                        path_to_task.remove(&path);
                        git_tracked_cache.remove(&path);
                    }
                    // Also drop any subscriber callbacks for this task so
                    // they release their captured Arcs and don't fire on
                    // a residual late event.
                    if let Ok(mut subs) = subscribers.write() {
                        subs.remove(&task_id);
                    }
                }
                WatcherCommand::Shutdown => {
                    return;
                }
            }
        }

        // Refresh git tracked files cache periodically
        if last_cache_refresh.elapsed().as_secs() >= GIT_CACHE_REFRESH_SECS {
            for path in path_to_task.keys() {
                let tracked = get_git_tracked_files(path);
                git_tracked_cache.insert(path.clone(), tracked);
            }
            last_cache_refresh = std::time::Instant::now();
        }

        // Batch process file events to reduce lock contention
        // Collect events for up to 100ms or until channel is empty
        let mut batch: Vec<(String, EditEvent)> = Vec::new();
        let batch_deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);

        loop {
            let timeout = batch_deadline.saturating_duration_since(std::time::Instant::now());
            if timeout.is_zero() {
                break;
            }

            match event_rx.recv_timeout(timeout) {
                Ok(event) => {
                    // Process file content changes:
                    // - Modify(Data): direct file edits
                    // - Modify(Any): platform doesn't distinguish modification types
                    // - Modify(Name(To/Any)): file renamed TO this path (atomic write pattern)
                    // - Create(File): file created (includes copy operations)
                    // - Create(Any): platform doesn't distinguish creation types
                    // This catches both direct edits and "write-to-temp-then-rename" patterns
                    // used by many editors and AI tools (Claude Code, Cursor, etc.)
                    let dominated = matches!(
                        event.kind,
                        EventKind::Modify(ModifyKind::Data(_))
                            | EventKind::Modify(ModifyKind::Any)
                            | EventKind::Modify(ModifyKind::Name(RenameMode::To))
                            | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
                            | EventKind::Create(CreateKind::File)
                            | EventKind::Create(CreateKind::Any)
                    );
                    if !dominated {
                        continue;
                    }

                    for path in event.paths {
                        // Skip directories - only track file modifications
                        if path.is_dir() {
                            continue;
                        }

                        // Find which task this path belongs to
                        for (watch_path, task_id) in &path_to_task {
                            if path.starts_with(watch_path) {
                                let relative_path =
                                    path.strip_prefix(watch_path).unwrap_or(&path).to_path_buf();

                                if relative_path.as_os_str().is_empty() {
                                    continue;
                                }

                                // Drop OS cruft and atomic-write tmp files
                                // before any git/disk check.
                                if is_noise_file(&relative_path) {
                                    continue;
                                }

                                // Only track git-tracked files
                                // Empty set means no git repo (Studio project) - track all files
                                if let Some(tracked) = git_tracked_cache.get(watch_path) {
                                    if !tracked.is_empty() && !tracked.contains(&relative_path) {
                                        continue;
                                    }
                                }

                                batch.push((
                                    task_id.clone(),
                                    EditEvent {
                                        timestamp: Utc::now(),
                                        file: relative_path,
                                    },
                                ));
                                break;
                            }
                        }
                    }
                }
                Err(_) => break, // Timeout or disconnected
            }
        }

        // Process batch with single lock acquisition
        if !batch.is_empty() {
            if let Ok(mut histories) = histories.write() {
                for (task_id, event) in &batch {
                    let history = histories
                        .entry(task_id.clone())
                        .or_insert_with(TaskEditHistory::new);
                    history.add_event(event.clone());
                }
            }

            // Dispatch to per-task subscribers. We snapshot the
            // callbacks per task under a short read lock, then call
            // them outside the lock so a slow callback can't stall
            // event processing for unrelated tasks.
            let snapshots: HashMap<String, Vec<Arc<SubscriberFn>>> = match subscribers.read() {
                Ok(subs) => batch
                    .iter()
                    .map(|(tid, _)| tid.clone())
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .filter_map(|tid| subs.get(&tid).map(|v| (tid, v.clone())))
                    .collect(),
                Err(_) => HashMap::new(),
            };
            for (task_id, event) in &batch {
                if let Some(callbacks) = snapshots.get(task_id) {
                    for cb in callbacks {
                        cb(event);
                    }
                }
            }

            if let Ok(mut pending) = pending_events.write() {
                for (task_id, event) in batch {
                    pending.entry(task_id).or_insert_with(Vec::new).push(event);
                    event_count_since_flush += 1;
                }
            }
        }

        // Flush every 30 seconds or every 10 events
        let should_flush = last_flush.elapsed().as_secs() >= 30 || event_count_since_flush >= 10;
        if should_flush && event_count_since_flush > 0 {
            if let Ok(mut pending) = pending_events.write() {
                for (task_id, events) in pending.drain() {
                    if !events.is_empty() {
                        let _ = save_edit_history(&project_key, &task_id, &events);
                    }
                }
            }
            last_flush = std::time::Instant::now();
            event_count_since_flush = 0;
        }
    }
}
