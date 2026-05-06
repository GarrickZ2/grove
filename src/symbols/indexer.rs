//! Symbol index orchestration: lazy build on first access, incremental
//! updates driven by `FileWatcher`, and a small global registry shared
//! by the HTTP API and the watcher subscription callbacks.
//!
//! Lifecycle:
//! - First `ensure_built(project_hash, task_id, worktree)` triggers a
//!   full scan of the worktree (`git ls-files` ∩ supported extensions),
//!   parses each file via tree-sitter, and persists symbols via
//!   `SymbolStore`. Subsequent calls for the same task short-circuit.
//! - After a successful build the indexer subscribes to the project's
//!   `FileWatcher` for that task; debounced edit events fire a single-
//!   file re-parse and replace the file's rows.
//! - Concurrent first-access requests coalesce via a per-task
//!   `BuildState` (atomic `done` flag + `tokio::sync::Notify`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use once_cell::sync::Lazy;

use crate::error::Result;

use super::extractor;
use super::store::SymbolStore;
use super::types::{Language, SymbolDef};

/// (project_hash, task_id)
type TaskKey = (String, String);

struct BuildState {
    done: AtomicBool,
    notify: tokio::sync::Notify,
}

impl BuildState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            done: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        })
    }
}

/// Process-wide registry. Accessed by the HTTP API for lookup/search and
/// by the watcher subscription callback for incremental updates.
struct Registry {
    /// One SymbolStore per project. The Mutex serializes writers; reads
    /// also go through it because rusqlite::Connection is not Sync.
    stores: HashMap<String, Arc<Mutex<SymbolStore>>>,
    /// Per-task build state (single-flight gate).
    builds: HashMap<TaskKey, Arc<BuildState>>,
}

static REGISTRY: Lazy<RwLock<Registry>> = Lazy::new(|| {
    RwLock::new(Registry {
        stores: HashMap::new(),
        builds: HashMap::new(),
    })
});

/// Maximum time a `/lookup` is willing to wait for an in-flight initial
/// build. After timeout the lookup returns whatever's already persisted
/// (typically empty for the very first request) — the user retries.
const ENSURE_BUILT_TIMEOUT: Duration = Duration::from_secs(2);

/// Public entry point. Idempotent: returns immediately if the task's
/// index has already been built for this process. Otherwise blocks the
/// caller (up to ENSURE_BUILT_TIMEOUT) on the in-flight build.
pub async fn ensure_built(project_hash: &str, task_id: &str, worktree: &Path) -> Result<()> {
    let key: TaskKey = (project_hash.to_string(), task_id.to_string());

    // Fast path + single-flight admission, all under one write lock.
    let state = {
        let mut reg = REGISTRY.write().expect("symbols registry poisoned");
        match reg.builds.get(&key) {
            Some(s) if s.done.load(Ordering::Acquire) => return Ok(()),
            Some(s) => s.clone(),
            None => {
                let s = BuildState::new();
                reg.builds.insert(key.clone(), s.clone());

                let project_hash = project_hash.to_string();
                let task_id = task_id.to_string();
                let worktree = worktree.to_path_buf();
                let state = s.clone();
                // The build itself is CPU-bound (tree-sitter parsing) +
                // blocking I/O (SQLite), so push it off the async runtime.
                tokio::task::spawn_blocking(move || {
                    if let Err(e) = run_build(&project_hash, &task_id, &worktree) {
                        eprintln!(
                            "[symbols] build failed for ({}, {}): {}",
                            project_hash, task_id, e
                        );
                    }
                    // Successful or not, mark done so retries don't
                    // pile up. A subsequent /reindex resets explicitly.
                    state.done.store(true, Ordering::Release);
                    state.notify.notify_waiters();
                });
                s
            }
        }
    };

    // Wait briefly for the in-flight build. Timeouts are non-fatal —
    // the lookup proceeds with whatever's persisted.
    let _ = tokio::time::timeout(ENSURE_BUILT_TIMEOUT, state.notify.notified()).await;
    Ok(())
}

/// Force a fresh full rebuild for a task. Drops any prior build state
/// so the next `ensure_built` will re-run from scratch.
pub fn trigger_reindex(project_hash: &str, task_id: &str) {
    let key: TaskKey = (project_hash.to_string(), task_id.to_string());
    let mut reg = REGISTRY.write().expect("symbols registry poisoned");
    reg.builds.remove(&key);
}

/// Clean up cached symbols for a task that's being deleted *or
/// archived*. The worktree is gone in both cases (archive removes it
/// too), so cached rows can never be queried meaningfully again — and
/// if the user later recovers an archived task, the lazy ensure_built
/// path rebuilds from the recreated worktree.
///
/// Best-effort: errors are swallowed (cache cleanup must not block
/// task deletion). No-op if no on-disk index.db exists yet.
pub fn on_task_deleted(project_hash: &str, task_id: &str) {
    // 1. Drop in-process build state so a same-id task created later
    //    re-builds from scratch instead of seeing the stale "done" flag.
    {
        let mut reg = REGISTRY.write().expect("symbols registry poisoned");
        reg.builds
            .remove(&(project_hash.to_string(), task_id.to_string()));
    }

    // 2. If the project's index.db doesn't exist on disk yet (no task
    //    in this project has been indexed), there's nothing to clean.
    //    Avoid creating an empty file just to delete from it.
    let db_path = crate::storage::grove_dir()
        .join("projects")
        .join(project_hash)
        .join("index.db");
    if !db_path.exists() {
        return;
    }

    // 3. Open (or reuse) the store and drop this task's rows.
    if let Ok(store) = ensure_store(project_hash) {
        if let Ok(mut s) = store.lock() {
            let _ = s.delete_task(task_id);
        }
    }
}

/// Exact-name lookup. Does not trigger a build — callers should
/// `ensure_built(...)` first.
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

// --- internals ---------------------------------------------------------

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

/// Full build for one task. Walks the worktree's git-tracked files,
/// parses supported languages, and writes results to the store. Files
/// whose mtime hasn't changed since the last persisted scan are
/// skipped — this keeps cold starts fast across grove restarts.
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
            None => continue, // file vanished between ls-files and stat
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

    // Wire up incremental updates. If the watcher hasn't been started
    // for this project yet (frontend hasn't hit /activate), skip — a
    // later activation/build cycle will pick it up.
    register_watcher_subscription(project_hash, task_id, worktree);

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
    watcher.subscribe(task_id, move |event| {
        handle_file_event(&project_hash, &task_id_owned, &worktree, &event.file);
    });
}

fn handle_file_event(project_hash: &str, task_id: &str, worktree: &Path, rel_file: &Path) {
    let Some(ext) = rel_file.extension().and_then(|s| s.to_str()) else {
        return;
    };
    let Some(language) = Language::from_extension(ext) else {
        return; // unsupported extension; nothing to update
    };

    let abs = worktree.join(rel_file);
    let rel_str = rel_file.to_string_lossy().replace('\\', "/");

    let store = match ensure_store(project_hash) {
        Ok(s) => s,
        Err(_) => return,
    };

    if !abs.exists() {
        // File deleted: drop its rows.
        let mut store = store.lock().expect("symbol store mutex poisoned");
        let _ = store.delete_file(task_id, &rel_str);
        return;
    }

    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(_) => return,
    };
    let mtime = file_mtime_unix(&abs).unwrap_or(0);
    let symbols = extractor::extract(language, &rel_str, &bytes);
    let mut store = store.lock().expect("symbol store mutex poisoned");
    let _ = store.replace_file(task_id, &rel_str, mtime, symbols);
}

/// `git ls-files` output filtered to extensions we have grammars for.
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
        // Write .gitignore so vendor isn't committed (simulating a real
        // worktree where vendor is checked-in or not). Keep it simple:
        // commit only a.go and readme.md.
        init_repo(&worktree);
        // Reset and re-add only the files we want tracked, since init
        // above added everything. Simpler: commit removes vendor.
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
    fn on_task_deleted_drops_rows_and_build_state() {
        let root = std::env::temp_dir().join("grove-symidx-cleanup");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let grove_home = root.join("grove-home");
        std::fs::create_dir_all(&grove_home).unwrap();
        set_grove_dir_override(Some(grove_home));

        // Seed two tasks under the same project so we can verify
        // cleanup is task-scoped.
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

        // Pretend task-drop went through ensure_built so it has a
        // BuildState entry; on_task_deleted must clear it too.
        {
            let mut reg = REGISTRY.write().unwrap();
            reg.builds
                .insert(("proj-x".into(), "task-drop".into()), BuildState::new());
        }

        on_task_deleted("proj-x", "task-drop");

        assert!(
            lookup("proj-x", "task-drop", "Drop").unwrap().is_empty(),
            "task-drop's rows should be gone"
        );
        assert_eq!(
            lookup("proj-x", "task-keep", "Keep").unwrap().len(),
            1,
            "sibling task's rows must be untouched"
        );
        assert!(
            REGISTRY
                .read()
                .unwrap()
                .builds
                .get(&("proj-x".to_string(), "task-drop".to_string()))
                .is_none(),
            "build state for deleted task should be cleared"
        );
    }

    #[test]
    fn on_task_deleted_no_op_when_db_missing() {
        let root = std::env::temp_dir().join("grove-symidx-cleanup-empty");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        set_grove_dir_override(Some(root.clone()));

        // No prior indexing for this project — no index.db on disk.
        on_task_deleted("proj-empty", "task-x");
        // Mustn't have created the file as a side effect.
        assert!(!root.join("projects/proj-empty/index.db").exists());
    }
}
