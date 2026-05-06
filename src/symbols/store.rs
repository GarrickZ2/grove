//! Per-project symbol storage: SQLite on disk + in-memory hot cache.
//!
//! Symbol data is *cache* — we deliberately keep it in a separate
//! `index.db` per project so users can `rm` it without touching grove's
//! core `grove.db`. Schema mismatch is handled by dropping and rebuilding
//! the file (the indexer re-extracts on next access).
//!
//! Layout:
//!
//! ```text
//! ~/.grove/projects/<project_hash>/index.db
//! ```
//!
//! Inside the file, rows are scoped by `task_id` because each task
//! worktree has potentially different code (uncommitted branches, new
//! files). Cross-task dedup is a future optimization.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};

use crate::error::{GroveError, Result};

use super::types::{Language, SymbolDef, SymbolKind};

const SCHEMA_VERSION: &str = "1";

/// Per-project store. Owns the SQLite connection and an in-memory
/// `task_id -> {file -> symbols}` cache populated lazily on first access.
pub struct SymbolStore {
    db: Connection,
    cache: HashMap<String, TaskCache>,
}

#[derive(Default)]
struct TaskCache {
    /// Symbols grouped by source file. File-level granularity matches
    /// the only mutation we ever do (replace one file's rows on edit).
    by_file: HashMap<String, Vec<SymbolDef>>,
    /// Whether the cache has been hydrated from SQLite. Distinct from
    /// "the cache is empty" — a brand-new task with no symbols is also
    /// `by_file` empty, but `loaded == true`.
    loaded: bool,
}

impl SymbolStore {
    /// Open or create the index db for `project_hash` under
    /// `~/.grove/projects/<hash>/index.db`. Schema is applied on create;
    /// on schema-version mismatch the file is dropped and recreated.
    pub fn open(project_hash: &str) -> Result<Self> {
        let path = Self::db_path(project_hash);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut db = Self::connect(&path)?;
        Self::apply_schema(&mut db, &path)?;
        Ok(Self {
            db,
            cache: HashMap::new(),
        })
    }

    /// Replace all symbols for `(task_id, file_path)`. Atomic in SQLite
    /// (single transaction) and propagated to the in-memory cache.
    ///
    /// Mtime-gated: if the store already has a row for this file with a
    /// **strictly greater** `file_mtime`, the call is a no-op. This
    /// closes the race where the on_watch_started full scan (which can
    /// read a file's bytes seconds before reaching the write step) would
    /// otherwise clobber a fresher update from a concurrent on_file_event
    /// on the same file. Equal mtime is allowed to overwrite (idempotent).
    pub fn replace_file(
        &mut self,
        task_id: &str,
        file_path: &str,
        file_mtime: i64,
        symbols: Vec<SymbolDef>,
    ) -> Result<()> {
        // Cheap pre-check: under the outer Mutex<SymbolStore>, no other
        // writer is running, so this read is consistent with the SQL we
        // execute below.
        let stored: Option<i64> = self
            .db
            .query_row(
                "SELECT MAX(file_mtime) FROM symbols WHERE task_id = ?1 AND file_path = ?2",
                params![task_id, file_path],
                |r| r.get(0),
            )
            .ok();
        if let Some(stored) = stored {
            if stored > file_mtime {
                return Ok(());
            }
        }

        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM symbols WHERE task_id = ?1 AND file_path = ?2",
            params![task_id, file_path],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO symbols (task_id, file_path, name, kind, line, col, end_line, container, language, file_mtime) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for s in &symbols {
                stmt.execute(params![
                    task_id,
                    s.file_path,
                    s.name,
                    s.kind.as_str(),
                    s.line,
                    s.col,
                    s.end_line,
                    s.container,
                    s.language.as_str(),
                    file_mtime,
                ])?;
            }
        }
        tx.commit()?;

        let cache = self.cache.entry(task_id.to_string()).or_default();
        cache.by_file.insert(file_path.to_string(), symbols);
        Ok(())
    }

    /// Drop a single file's symbols (e.g. file deleted on disk).
    /// Currently unused — file deletion is handled implicitly: the next
    /// debounced reindex re-scans `git ls-files` and the file's rows
    /// stay in the table only until then. Kept here as part of the
    /// store's vocabulary in case a future feature needs targeted drops.
    #[allow(dead_code)]
    pub fn delete_file(&mut self, task_id: &str, file_path: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM symbols WHERE task_id = ?1 AND file_path = ?2",
            params![task_id, file_path],
        )?;
        if let Some(cache) = self.cache.get_mut(task_id) {
            cache.by_file.remove(file_path);
        }
        Ok(())
    }

    /// Drop all symbols for `task_id` (e.g. task archived). Wired to a
    /// future archive-task hook; not yet on a hot path.
    #[allow(dead_code)]
    pub fn delete_task(&mut self, task_id: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM symbols WHERE task_id = ?1", params![task_id])?;
        self.cache.remove(task_id);
        Ok(())
    }

    /// Hydrate the in-memory cache for `task_id` from SQLite if not
    /// already loaded. Cheap on subsequent calls.
    pub fn ensure_loaded(&mut self, task_id: &str) -> Result<()> {
        if self.cache.get(task_id).map(|c| c.loaded).unwrap_or(false) {
            return Ok(());
        }

        let mut stmt = self.db.prepare(
            "SELECT file_path, name, kind, line, col, end_line, container, language \
             FROM symbols WHERE task_id = ?1",
        )?;
        let rows = stmt.query_map(params![task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SymbolDef {
                    name: row.get(1)?,
                    kind: parse_kind(&row.get::<_, String>(2)?).unwrap_or(SymbolKind::Function),
                    file_path: row.get(0)?,
                    line: row.get(3)?,
                    col: row.get(4)?,
                    end_line: row.get(5)?,
                    container: row.get(6)?,
                    language: parse_lang(&row.get::<_, String>(7)?).unwrap_or(Language::Go),
                },
            ))
        })?;

        let mut by_file: HashMap<String, Vec<SymbolDef>> = HashMap::new();
        for row in rows {
            let (fp, sym) = row?;
            by_file.entry(fp).or_default().push(sym);
        }
        self.cache.insert(
            task_id.to_string(),
            TaskCache {
                by_file,
                loaded: true,
            },
        );
        Ok(())
    }

    /// Exact-name lookup. Returns clones because callers usually need to
    /// rank/serialize and we don't want to bind a borrow to `&mut self`.
    pub fn lookup(&mut self, task_id: &str, name: &str) -> Result<Vec<SymbolDef>> {
        self.ensure_loaded(task_id)?;
        let Some(cache) = self.cache.get(task_id) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for syms in cache.by_file.values() {
            for s in syms {
                if s.name == name {
                    out.push(s.clone());
                }
            }
        }
        Ok(out)
    }

    /// Prefix search across symbol names, capped at `limit`.
    pub fn search(&mut self, task_id: &str, prefix: &str, limit: usize) -> Result<Vec<SymbolDef>> {
        self.ensure_loaded(task_id)?;
        let Some(cache) = self.cache.get(task_id) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for syms in cache.by_file.values() {
            for s in syms {
                if s.name.starts_with(prefix) {
                    out.push(s.clone());
                    if out.len() >= limit {
                        return Ok(out);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Map of `file_path -> file_mtime` previously stored. Used by the
    /// indexer to decide which files are stale and need re-parsing.
    pub fn file_mtimes(&self, task_id: &str) -> Result<HashMap<String, i64>> {
        let mut stmt = self.db.prepare(
            "SELECT file_path, MAX(file_mtime) FROM symbols WHERE task_id = ?1 GROUP BY file_path",
        )?;
        let rows = stmt.query_map(params![task_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut out = HashMap::new();
        for row in rows {
            let (fp, mtime) = row?;
            out.insert(fp, mtime);
        }
        Ok(out)
    }

    fn db_path(project_hash: &str) -> PathBuf {
        crate::storage::grove_dir()
            .join("projects")
            .join(project_hash)
            .join("index.db")
    }

    fn connect(path: &Path) -> Result<Connection> {
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        // WAL gives us concurrent reads; NORMAL sync trades a tiny
        // crash-safety window for ~10x faster batch inserts (acceptable
        // for cache data).
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(db)
    }

    fn apply_schema(db: &mut Connection, path: &Path) -> Result<()> {
        // Detect mismatched schema first; nuke-and-recreate the file.
        // Fresh dbs have no `meta` table, so the SELECT fails and we
        // proceed to create. Mismatch is treated the same as "unreadable".
        let existing: Option<String> = db
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .ok();
        if let Some(v) = existing {
            if v == SCHEMA_VERSION {
                return Ok(());
            }
            // Version mismatch: drop the file and reopen. Treat this as
            // cache invalidation, not an error path users care about.
            drop(std::mem::replace(db, Connection::open_in_memory()?));
            std::fs::remove_file(path)?;
            *db = Self::connect(path)?;
        }

        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS symbols (
                 task_id    TEXT NOT NULL,
                 file_path  TEXT NOT NULL,
                 name       TEXT NOT NULL,
                 kind       TEXT NOT NULL,
                 line       INTEGER NOT NULL,
                 col        INTEGER NOT NULL,
                 end_line   INTEGER NOT NULL,
                 container  TEXT,
                 language   TEXT NOT NULL,
                 file_mtime INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(task_id, name);
             CREATE INDEX IF NOT EXISTS idx_symbols_file   ON symbols(task_id, file_path);",
        )?;
        db.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION],
        )?;
        Ok(())
    }
}

fn parse_kind(s: &str) -> Option<SymbolKind> {
    match s {
        "function" => Some(SymbolKind::Function),
        "method" => Some(SymbolKind::Method),
        "struct" => Some(SymbolKind::Struct),
        "interface" => Some(SymbolKind::Interface),
        "type" => Some(SymbolKind::Type),
        "const" => Some(SymbolKind::Const),
        "var" => Some(SymbolKind::Var),
        "field" => Some(SymbolKind::Field),
        _ => None,
    }
}

fn parse_lang(s: &str) -> Option<Language> {
    match s {
        "go" => Some(Language::Go),
        _ => None,
    }
}

// Future-proof: if we need to surface a non-rusqlite/non-io custom
// failure mode, route it through GroveError::Storage with this helper
// rather than introducing a new error type.
#[allow(dead_code)]
fn store_err(msg: impl Into<String>) -> GroveError {
    GroveError::Storage(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::set_grove_dir_override;

    fn fresh_store(test_name: &str) -> SymbolStore {
        let dir = std::env::temp_dir().join(format!("grove-symstore-{}", test_name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        set_grove_dir_override(Some(dir));
        SymbolStore::open("project-abc").unwrap()
    }

    fn sym(name: &str, file: &str, kind: SymbolKind) -> SymbolDef {
        SymbolDef {
            name: name.to_string(),
            kind,
            file_path: file.to_string(),
            line: 1,
            col: 0,
            end_line: 3,
            container: None,
            language: Language::Go,
        }
    }

    #[test]
    fn insert_lookup_and_replace() {
        let mut s = fresh_store("insert_lookup");
        s.replace_file(
            "task-1",
            "foo.go",
            100,
            vec![
                sym("ParseConfig", "foo.go", SymbolKind::Function),
                sym("Helper", "foo.go", SymbolKind::Function),
            ],
        )
        .unwrap();

        let hits = s.lookup("task-1", "ParseConfig").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SymbolKind::Function);

        // Replace with one less symbol — old rows must vanish.
        s.replace_file(
            "task-1",
            "foo.go",
            200,
            vec![sym("ParseConfig", "foo.go", SymbolKind::Function)],
        )
        .unwrap();
        assert!(s.lookup("task-1", "Helper").unwrap().is_empty());
        assert_eq!(s.lookup("task-1", "ParseConfig").unwrap().len(), 1);
    }

    #[test]
    fn task_isolation() {
        let mut s = fresh_store("task_isolation");
        s.replace_file(
            "task-A",
            "foo.go",
            1,
            vec![sym("Same", "foo.go", SymbolKind::Function)],
        )
        .unwrap();
        s.replace_file(
            "task-B",
            "foo.go",
            1,
            vec![sym("Same", "foo.go", SymbolKind::Method)],
        )
        .unwrap();

        let a = s.lookup("task-A", "Same").unwrap();
        let b = s.lookup("task-B", "Same").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].kind, SymbolKind::Function);
        assert_eq!(b[0].kind, SymbolKind::Method);

        s.delete_task("task-A").unwrap();
        assert!(s.lookup("task-A", "Same").unwrap().is_empty());
        assert_eq!(s.lookup("task-B", "Same").unwrap().len(), 1);
    }

    #[test]
    fn search_prefix_with_limit() {
        let mut s = fresh_store("search_prefix");
        s.replace_file(
            "t",
            "x.go",
            1,
            vec![
                sym("ParseA", "x.go", SymbolKind::Function),
                sym("ParseB", "x.go", SymbolKind::Function),
                sym("ParseC", "x.go", SymbolKind::Function),
                sym("Other", "x.go", SymbolKind::Function),
            ],
        )
        .unwrap();
        let res = s.search("t", "Parse", 2).unwrap();
        assert_eq!(res.len(), 2);
        assert!(res.iter().all(|s| s.name.starts_with("Parse")));
    }

    #[test]
    fn reload_after_reopen() {
        let dir = std::env::temp_dir().join("grove-symstore-reload");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        set_grove_dir_override(Some(dir.clone()));

        {
            let mut s = SymbolStore::open("p").unwrap();
            s.replace_file(
                "t",
                "x.go",
                1,
                vec![sym("Persist", "x.go", SymbolKind::Function)],
            )
            .unwrap();
        }
        // New store, same path: persisted data should be readable.
        let mut s2 = SymbolStore::open("p").unwrap();
        assert_eq!(s2.lookup("t", "Persist").unwrap().len(), 1);
    }

    #[test]
    fn file_mtimes_returns_max_per_file() {
        let mut s = fresh_store("file_mtimes");
        s.replace_file(
            "t",
            "a.go",
            100,
            vec![sym("A", "a.go", SymbolKind::Function)],
        )
        .unwrap();
        s.replace_file(
            "t",
            "b.go",
            200,
            vec![sym("B", "b.go", SymbolKind::Function)],
        )
        .unwrap();
        let m = s.file_mtimes("t").unwrap();
        assert_eq!(m.get("a.go"), Some(&100));
        assert_eq!(m.get("b.go"), Some(&200));
    }
}
