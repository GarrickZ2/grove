//! Symbol index orchestration.
//!
//! Per-task coalescing scheduler:
//!
//! ```text
//!   on_watch_started(task) ┐
//!   watcher event (task)   ├─→ request_reindex(task)
//!                          │     (sets next_due = now + DEBOUNCE)
//!                          │
//!                          ▼
//!                ┌────────────────────────┐
//!                │ worker_loop (per task) │
//!                │                        │
//!                │  loop:                 │
//!                │    if next_due is None │ ──→ exit
//!                │    if next_due > now   │ ──→ sleep, re-check
//!                │    else                │ ──→ run_build, re-check
//!                └────────────────────────┘
//! ```
//!
//! - One worker thread per task at a time. Multiple concurrent triggers
//!   don't spawn multiple workers — they just push `next_due` forward.
//! - Debounce: rapid edits (AI tools modifying many files in quick
//!   succession) coalesce into a single reindex once the storm dies down.
//! - During a running build, new triggers reset `next_due`. When the
//!   build finishes, the worker sees `next_due` set and debounces again
//!   before the next run.
//! - `lookup` is a pure SQL read; it never blocks on the build.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use crate::error::Result;

use super::extractor;
use super::store::SymbolStore;
use super::types::{Language, SymbolDef};

/// (project_hash, task_id)
type TaskKey = (String, String);

/// Quiet-period before a coalesced reindex actually runs.
const REINDEX_DEBOUNCE: Duration = Duration::from_millis(1500);

struct BuildSlot {
    /// True while a worker thread is alive for this task.
    scheduled: AtomicBool,
    /// True after the watcher subscription has been registered for this
    /// task — prevents duplicate callbacks if /activate fires repeatedly.
    subscribed: AtomicBool,
    /// Earliest instant the worker should start the next build. Each
    /// `request_reindex` sets this to `now + DEBOUNCE`. None ⇒ no pending
    /// work; the worker treats that as "exit".
    next_due: Mutex<Option<Instant>>,
}

impl BuildSlot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            scheduled: AtomicBool::new(false),
            subscribed: AtomicBool::new(false),
            next_due: Mutex::new(None),
        })
    }
}

struct Registry {
    /// One SymbolStore per project. The Mutex serializes writers; reads
    /// also go through it because rusqlite::Connection is not Sync.
    stores: HashMap<String, Arc<Mutex<SymbolStore>>>,
    /// Per-task coalescing scheduler state.
    slots: HashMap<TaskKey, Arc<BuildSlot>>,
}

static REGISTRY: Lazy<RwLock<Registry>> = Lazy::new(|| {
    RwLock::new(Registry {
        stores: HashMap::new(),
        slots: HashMap::new(),
    })
});

// ============================================================================
// Public API
// ============================================================================

/// Triggered when the FileWatcher starts watching a task. Subscribes
/// the indexer to watcher events (idempotent) and queues a debounced
/// reindex.
pub fn on_watch_started(project_hash: &str, task_id: &str, worktree: &Path) {
    let slot = get_or_create_slot((project_hash.to_string(), task_id.to_string()));

    // Subscribe to watcher events exactly once per task. Each event then
    // funnels back here as `request_reindex`, which the slot debounces.
    if !slot.subscribed.swap(true, Ordering::AcqRel) {
        register_watcher_subscription(project_hash, task_id, worktree);
    }

    request_reindex_with(&slot, project_hash, task_id, worktree);
}

/// Force a fresh from-scratch reindex. Wipes the cached rows for this
/// task (so the build can't mtime-skip them) and queues a build.
pub fn trigger_reindex(project_hash: &str, task_id: &str, worktree: &Path) {
    if let Ok(store) = ensure_store(project_hash) {
        if let Ok(mut s) = store.lock() {
            let _ = s.delete_task(task_id);
        }
    }
    let slot = get_or_create_slot((project_hash.to_string(), task_id.to_string()));
    request_reindex_with(&slot, project_hash, task_id, worktree);
}

/// Clean up cached symbols for a task that's being deleted *or
/// archived*. The worktree is gone in both cases (archive removes it
/// too), so cached rows can never be queried meaningfully again — and
/// if the user later recovers an archived task, the next /activate
/// fires `on_watch_started` again and rebuilds.
///
/// Best-effort: errors are swallowed. No-op if no on-disk index.db
/// exists yet.
pub fn on_task_deleted(project_hash: &str, task_id: &str) {
    {
        let mut reg = REGISTRY.write().expect("symbols registry poisoned");
        reg.slots
            .remove(&(project_hash.to_string(), task_id.to_string()));
    }

    let db_path = crate::storage::grove_dir()
        .join("projects")
        .join(project_hash)
        .join("index.db");
    if !db_path.exists() {
        return;
    }

    if let Ok(store) = ensure_store(project_hash) {
        if let Ok(mut s) = store.lock() {
            let _ = s.delete_task(task_id);
        }
    }
}

/// Exact-name lookup. Pure read; never blocks on the build pipeline.
/// If the build hasn't run yet, returns whatever rows are persisted
/// (possibly empty); the caller retries.
pub fn lookup(project_hash: &str, task_id: &str, name: &str) -> Result<Vec<SymbolDef>> {
    let store = match get_store(project_hash) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let mut store = store.lock().expect("symbol store mutex poisoned");
    store.lookup(task_id, name)
}

/// Prefix-match search, capped at `limit`.
pub fn search(
    project_hash: &str,
    task_id: &str,
    prefix: &str,
    limit: usize,
) -> Result<Vec<SymbolDef>> {
    let store = match get_store(project_hash) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let mut store = store.lock().expect("symbol store mutex poisoned");
    store.search(task_id, prefix, limit)
}

// ============================================================================
// Slot / scheduler internals
// ============================================================================

fn get_or_create_slot(key: TaskKey) -> Arc<BuildSlot> {
    let mut reg = REGISTRY.write().expect("symbols registry poisoned");
    reg.slots.entry(key).or_insert_with(BuildSlot::new).clone()
}

fn request_reindex_with(slot: &Arc<BuildSlot>, project_hash: &str, task_id: &str, worktree: &Path) {
    {
        let mut due = slot.next_due.lock().expect("slot.next_due poisoned");
        *due = Some(Instant::now() + REINDEX_DEBOUNCE);
    }

    // If we are the first caller to flip `scheduled` from false to true,
    // we own the worker thread for this round. Subsequent callers hit
    // the existing worker via `next_due`.
    if !slot.scheduled.swap(true, Ordering::AcqRel) {
        let slot = Arc::clone(slot);
        let project_hash = project_hash.to_string();
        let task_id = task_id.to_string();
        let worktree = worktree.to_path_buf();
        std::thread::spawn(move || worker_loop(slot, project_hash, task_id, worktree));
    }
}

fn request_reindex_external(project_hash: &str, task_id: &str, worktree: &Path) {
    let slot = get_or_create_slot((project_hash.to_string(), task_id.to_string()));
    request_reindex_with(&slot, project_hash, task_id, worktree);
}

enum Action {
    Sleep(Duration),
    Build,
}

fn worker_loop(slot: Arc<BuildSlot>, project_hash: String, task_id: String, worktree: PathBuf) {
    loop {
        let action = {
            let mut due = slot.next_due.lock().expect("slot.next_due poisoned");
            match *due {
                None => {
                    // No pending work. Mark unscheduled and exit. Holding
                    // the lock across `scheduled.store(false)` closes the
                    // race with concurrent `request_reindex`: a caller
                    // that flips scheduled→true after our store sees it
                    // false and spawns a fresh worker.
                    slot.scheduled.store(false, Ordering::Release);
                    return;
                }
                Some(t) => {
                    let now = Instant::now();
                    if t <= now {
                        // Take the deadline before building so events
                        // arriving during the build start a fresh
                        // debounce window rather than racing with us.
                        *due = None;
                        Action::Build
                    } else {
                        Action::Sleep(t - now)
                    }
                }
            }
        };
        match action {
            Action::Sleep(d) => std::thread::sleep(d),
            Action::Build => {
                if let Err(e) = run_build(&project_hash, &task_id, &worktree) {
                    eprintln!(
                        "[symbols] build failed for ({}, {}): {}",
                        project_hash, task_id, e
                    );
                }
            }
        }
    }
}

// ============================================================================
// Build pipeline
// ============================================================================

fn get_store(project_hash: &str) -> Option<Arc<Mutex<SymbolStore>>> {
    let reg = REGISTRY.read().ok()?;
    reg.stores.get(project_hash).cloned()
}

fn ensure_store(project_hash: &str) -> Result<Arc<Mutex<SymbolStore>>> {
    if let Some(s) = get_store(project_hash) {
        return Ok(s);
    }
    let store = SymbolStore::open(project_hash)?;
    let arc = Arc::new(Mutex::new(store));
    let mut reg = REGISTRY.write().expect("symbols registry poisoned");
    Ok(reg
        .stores
        .entry(project_hash.to_string())
        .or_insert(arc)
        .clone())
}

/// Walks the worktree's git-tracked files, parses supported languages,
/// and writes results to the store. mtime-skips files unchanged since
/// the last persisted scan.
///
/// `SymbolStore::replace_file` is mtime-gated, so concurrent watcher
/// events that happen to also update a file we're processing here can't
/// be clobbered by a stale write from this build.
fn run_build(project_hash: &str, task_id: &str, worktree: &Path) -> Result<()> {
    let store = ensure_store(project_hash)?;

    let cached_mtimes = {
        let store = store.lock().expect("symbol store mutex poisoned");
        store.file_mtimes(task_id).unwrap_or_default()
    };

    let candidates = git_tracked_supported_files(worktree);
    for (rel_path, language) in candidates {
        let abs = worktree.join(&rel_path);
        let mtime = match file_mtime_unix(&abs) {
            Some(m) => m,
            None => continue,
        };

        let rel_str = rel_path.to_string_lossy().replace('\\', "/");
        if cached_mtimes.get(&rel_str).copied() == Some(mtime) {
            continue;
        }

        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let symbols = extractor::extract(language, &rel_str, &bytes);

        let mut store = store.lock().expect("symbol store mutex poisoned");
        let _ = store.replace_file(task_id, &rel_str, mtime, symbols);
    }

    Ok(())
}

fn register_watcher_subscription(project_hash: &str, task_id: &str, worktree: &Path) {
    let watchers = match crate::api::state::FILE_WATCHERS.read() {
        Ok(w) => w,
        Err(_) => return,
    };
    let Some(watcher) = watchers.get(project_hash) else {
        return;
    };

    let project_hash = project_hash.to_string();
    let task_id_owned = task_id.to_string();
    let worktree = worktree.to_path_buf();
    watcher.subscribe(task_id, move |_event| {
        // All edits feed into the same coalescing slot — the worker
        // debounces them so an AI burst that touches 50 files results
        // in one reindex, not 50.
        request_reindex_external(&project_hash, &task_id_owned, &worktree);
    });
}

fn git_tracked_supported_files(worktree: &Path) -> Vec<(PathBuf, Language)> {
    let output = match Command::new("git")
        .args(["ls-files"])
        .current_dir(worktree)
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&output);
    stdout
        .lines()
        .filter_map(|line| {
            let path = PathBuf::from(crate::git::git_unquote(line.trim()));
            let ext = path.extension().and_then(|s| s.to_str())?;
            let lang = Language::from_extension(ext)?;
            Some((path, lang))
        })
        .collect()
}

fn file_mtime_unix(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::set_grove_dir_override;
    use crate::symbols::types::SymbolKind;

    fn write(p: &Path, s: &str) {
        std::fs::write(p, s).unwrap();
    }

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@e"]);
        run(&["config", "user.name", "t"]);
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn run_build_indexes_go_files_and_skips_others() {
        let root = std::env::temp_dir().join("grove-symidx-build");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let grove_home = root.join("grove-home");
        std::fs::create_dir_all(&grove_home).unwrap();
        set_grove_dir_override(Some(grove_home));

        let worktree = root.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        write(&worktree.join("a.go"), "package x\nfunc Indexed() {}\n");
        write(&worktree.join("readme.md"), "ignored");
        std::fs::create_dir_all(worktree.join("vendor")).unwrap();
        write(
            &worktree.join("vendor/v.go"),
            "package v\nfunc NotTracked() {}\n",
        );
        init_repo(&worktree);
        Command::new("git")
            .args(["rm", "-rq", "vendor"])
            .current_dir(&worktree)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "drop vendor"])
            .current_dir(&worktree)
            .output()
            .unwrap();

        run_build("proj-1", "task-1", &worktree).unwrap();

        let hits = lookup("proj-1", "task-1", "Indexed").unwrap();
        assert_eq!(hits.len(), 1, "expected to index Indexed in a.go");
        assert!(lookup("proj-1", "task-1", "NotTracked").unwrap().is_empty());
    }

    #[test]
    fn slot_coalesces_rapid_requests() {
        let root = std::env::temp_dir().join("grove-symidx-coalesce");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        set_grove_dir_override(Some(root.join("grove-home")));

        let worktree = root.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        write(&worktree.join("a.go"), "package x\nfunc One() {}\n");
        init_repo(&worktree);

        let slot = get_or_create_slot(("p-coalesce".into(), "t".into()));

        // Fire 50 requests in rapid succession. Only one worker thread
        // should be spawned; only one build should run after debounce.
        for _ in 0..50 {
            request_reindex_with(&slot, "p-coalesce", "t", &worktree);
        }

        // scheduled should be true exactly once across all calls.
        assert!(slot.scheduled.load(Ordering::Acquire));

        // Wait for the worker to finish. With DEBOUNCE=1500ms and a
        // tiny project, one build cycle should complete well within 5s.
        std::thread::sleep(Duration::from_millis(2500));

        // After build done and no further requests, scheduled goes false.
        assert!(!slot.scheduled.load(Ordering::Acquire));

        // The build should have happened — `One` is in the index.
        let hits = lookup("p-coalesce", "t", "One").unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn on_task_deleted_drops_rows_and_slot() {
        let root = std::env::temp_dir().join("grove-symidx-cleanup");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        set_grove_dir_override(Some(root.join("grove-home")));

        let store = ensure_store("proj-x").unwrap();
        {
            let mut s = store.lock().unwrap();
            s.replace_file(
                "task-keep",
                "k.go",
                1,
                vec![SymbolDef {
                    name: "Keep".into(),
                    kind: SymbolKind::Function,
                    file_path: "k.go".into(),
                    line: 0,
                    col: 0,
                    end_line: 1,
                    container: None,
                    language: Language::Go,
                }],
            )
            .unwrap();
            s.replace_file(
                "task-drop",
                "d.go",
                1,
                vec![SymbolDef {
                    name: "Drop".into(),
                    kind: SymbolKind::Function,
                    file_path: "d.go".into(),
                    line: 0,
                    col: 0,
                    end_line: 1,
                    container: None,
                    language: Language::Go,
                }],
            )
            .unwrap();
        }
        // Pretend a slot existed.
        get_or_create_slot(("proj-x".into(), "task-drop".into()));

        on_task_deleted("proj-x", "task-drop");

        assert!(lookup("proj-x", "task-drop", "Drop").unwrap().is_empty());
        assert_eq!(lookup("proj-x", "task-keep", "Keep").unwrap().len(), 1);
        assert!(!REGISTRY
            .read()
            .unwrap()
            .slots
            .contains_key(&("proj-x".to_string(), "task-drop".to_string())));
    }

    #[test]
    fn on_task_deleted_no_op_when_db_missing() {
        let root = std::env::temp_dir().join("grove-symidx-cleanup-empty");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        set_grove_dir_override(Some(root.clone()));

        on_task_deleted("proj-empty", "task-x");
        assert!(!root.join("projects/proj-empty/index.db").exists());
    }
}
