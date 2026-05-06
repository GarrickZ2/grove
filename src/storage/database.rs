//! SQLite database initialization and schema management
//!
//! Single database at `~/.grove/grove.db` with WAL mode.
//! All migrated storage modules share this connection.
//!
//! The connection tracks its file path and re-opens if `grove_dir()` changes
//! (happens when tests override `HOME`).

use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

use super::grove_dir;
use crate::error::Result;

pub const CURRENT_STORAGE_VERSION: &str = "2.4";

/// Database state: caches connection + its path so we can detect HOME changes.
struct DbState {
    path: PathBuf,
    conn: Connection,
}

static DB: Mutex<Option<DbState>> = Mutex::new(None);

/// Process-wide lock for tests that touch the database or HOME env var.
///
/// Grove keeps a single global DB connection (`DB` above) whose target path is
/// derived from `grove_dir()` → `$HOME/.grove/grove.db`. Tests that override
/// HOME to sandbox writes race each other: thread A flips HOME to `/tmp/a`,
/// opens the DB there; thread B concurrently flips HOME to `/tmp/b` and
/// re-opens the global DB at the new path, invisibly hijacking A's writes.
///
/// All test modules that mutate HOME or call `connection()` must serialize
/// through this single shared mutex. Prior to consolidation each module had
/// its own local `FILE_LOCK`, which only serialized tests within the same
/// module — cross-module parallelism still produced flaky failures.
///
/// Returns a `&'static tokio::sync::Mutex<()>` so both sync and async tests
/// can serialize without holding a `std::sync::MutexGuard` across `.await`:
/// - sync `#[test]`: `let _l = test_lock().blocking_lock();`
/// - async `#[tokio::test]`: `let _l = test_lock().lock().await;`
#[cfg(test)]
pub(crate) fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    &TEST_LOCK
}

/// A guard that holds the DB mutex and exposes `&Connection`.
/// Callers get this from `connection()` and use it like `&Connection` via `Deref`.
pub struct DbGuard(std::sync::MutexGuard<'static, Option<DbState>>);

impl std::ops::Deref for DbGuard {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.0.as_ref().unwrap().conn
    }
}

/// Get the global database connection.
///
/// If `grove_dir()` changed since last call (e.g. test overriding HOME),
/// the connection is transparently re-opened at the new path.
pub fn connection() -> DbGuard {
    let mut guard = DB.lock().unwrap();
    let expected = grove_dir().join("grove.db");

    let needs_open = match &*guard {
        Some(state) => state.path != expected,
        None => true,
    };

    if needs_open {
        let conn = open_at(&expected)
            .unwrap_or_else(|e| panic!("Failed to open {}: {}", expected.display(), e));
        *guard = Some(DbState {
            path: expected,
            conn,
        });
    }

    DbGuard(guard)
}

/// Open (or create) the database at a specific path and apply schema
fn open_at(db_path: &std::path::Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;",
    )?;

    create_schema(&conn)?;
    Ok(conn)
}

/// Create all tables if they don't exist
pub(crate) fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        -- Projects
        CREATE TABLE IF NOT EXISTS projects (
            hash         TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            path         TEXT NOT NULL UNIQUE,
            is_git_repo  INTEGER NOT NULL DEFAULT 1,
            added_at     TEXT NOT NULL,
            project_type TEXT NOT NULL DEFAULT 'repo'
        );

        -- Tasks (active + archived, unified)
        CREATE TABLE IF NOT EXISTS tasks (
            project        TEXT    NOT NULL,
            id             TEXT    NOT NULL,
            name           TEXT    NOT NULL,
            branch         TEXT    NOT NULL,
            target         TEXT    NOT NULL,
            worktree_path  TEXT    NOT NULL,
            initial_commit TEXT,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'active',
            multiplexer    TEXT    NOT NULL DEFAULT 'tmux',
            session_name   TEXT    NOT NULL DEFAULT '',
            created_by     TEXT    NOT NULL DEFAULT '',
            archived_at    TEXT,
            is_local       INTEGER NOT NULL DEFAULT 0,
            -- diff snapshot taken at archive time; 0 for active tasks
            code_additions INTEGER NOT NULL DEFAULT 0,
            code_deletions INTEGER NOT NULL DEFAULT 0,
            files_changed  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (project, id)
        );

        -- Task Groups
        CREATE TABLE IF NOT EXISTS task_groups (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            color      TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_group_slots (
            group_id       TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
            position       INTEGER NOT NULL,
            project_id     TEXT NOT NULL,
            task_id        TEXT NOT NULL,
            target_chat_id TEXT,
            PRIMARY KEY (group_id, position)
        );

        CREATE INDEX IF NOT EXISTS ix_task_group_slots_task
            ON task_group_slots (project_id, task_id);

        -- Hook notifications
        CREATE TABLE IF NOT EXISTS hook_notifications (
            project_key TEXT NOT NULL,
            task_id     TEXT NOT NULL,
            level       TEXT NOT NULL,
            timestamp   TEXT NOT NULL,
            message     TEXT,
            chat_id     TEXT,
            PRIMARY KEY (project_key, task_id)
        );

        CREATE INDEX IF NOT EXISTS ix_hook_notifications_timestamp
            ON hook_notifications (timestamp DESC);

        -- AI Providers
        CREATE TABLE IF NOT EXISTS ai_providers (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            base_url      TEXT NOT NULL,
            api_key       TEXT NOT NULL,
            model         TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'draft'
        );

        -- Audio Config (global, single row)
        CREATE TABLE IF NOT EXISTS audio_config (
            id                  INTEGER PRIMARY KEY CHECK (id = 1),
            enabled             INTEGER NOT NULL DEFAULT 0,
            transcribe_provider TEXT NOT NULL DEFAULT '',
            toggle_shortcut     TEXT NOT NULL DEFAULT '',
            push_to_talk_key    TEXT NOT NULL DEFAULT '',
            max_duration        INTEGER NOT NULL DEFAULT 60,
            min_duration        INTEGER NOT NULL DEFAULT 2,
            revise_enabled      INTEGER NOT NULL DEFAULT 0,
            revise_provider     TEXT NOT NULL DEFAULT '',
            revise_prompt       TEXT NOT NULL DEFAULT '',
            preferred_languages TEXT NOT NULL DEFAULT '[]'
        );

        -- Audio Config (project-level)
        CREATE TABLE IF NOT EXISTS audio_config_project (
            project_hash  TEXT PRIMARY KEY,
            revise_prompt TEXT NOT NULL DEFAULT ''
        );

        -- Audio Terms (global + project-level)
        CREATE TABLE IF NOT EXISTS audio_terms (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            project_hash  TEXT,
            type          TEXT NOT NULL,
            from_term     TEXT,
            target_term   TEXT NOT NULL
        );

        -- Unique index using COALESCE so NULL columns are properly deduplicated
        CREATE UNIQUE INDEX IF NOT EXISTS ux_audio_terms_effective
            ON audio_terms (COALESCE(project_hash, ''), type, COALESCE(from_term, ''), target_term);

        -- Skill Agents
        CREATE TABLE IF NOT EXISTS skill_agents (
            id                 TEXT PRIMARY KEY,
            display_name       TEXT NOT NULL,
            global_skills_dir  TEXT NOT NULL,
            project_skills_dir TEXT NOT NULL,
            shared_group       TEXT,
            icon_id            TEXT,
            enabled            INTEGER NOT NULL DEFAULT 1,
            is_builtin         INTEGER NOT NULL DEFAULT 0
        );

        -- Skill Sources
        CREATE TABLE IF NOT EXISTS skill_sources (
            name        TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            url         TEXT NOT NULL,
            subpath     TEXT,
            repo_key    TEXT NOT NULL,
            last_synced TEXT,
            local_head  TEXT
        );

        -- Skill Manifest
        CREATE TABLE IF NOT EXISTS skill_manifest (
            repo_key      TEXT NOT NULL,
            repo_path     TEXT NOT NULL,
            name          TEXT NOT NULL,
            description   TEXT NOT NULL,
            source        TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            license       TEXT,
            author        TEXT,
            PRIMARY KEY (repo_key, repo_path)
        );

        -- Skill Installed
        CREATE TABLE IF NOT EXISTS skill_installed (
            repo_key     TEXT NOT NULL,
            repo_path    TEXT NOT NULL,
            source_name  TEXT NOT NULL,
            skill_name   TEXT NOT NULL,
            installed_at TEXT NOT NULL,
            PRIMARY KEY (repo_key, repo_path)
        );

        CREATE TABLE IF NOT EXISTS skill_installed_agents (
            repo_key      TEXT NOT NULL,
            repo_path     TEXT NOT NULL,
            agent_id      TEXT NOT NULL,
            symlink_path  TEXT,
            PRIMARY KEY (repo_key, repo_path, agent_id),
            FOREIGN KEY (repo_key, repo_path) REFERENCES skill_installed(repo_key, repo_path) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS skill_installed_projects (
            repo_key     TEXT NOT NULL,
            repo_path    TEXT NOT NULL,
            project_path TEXT NOT NULL,
            agent_id     TEXT NOT NULL,
            symlink_path TEXT,
            PRIMARY KEY (repo_key, repo_path, project_path, agent_id),
            FOREIGN KEY (repo_key, repo_path) REFERENCES skill_installed(repo_key, repo_path) ON DELETE CASCADE
        );

        -- Agent Graph: Session (corresponds to ChatSession struct)
        CREATE TABLE IF NOT EXISTS session (
            session_id     TEXT PRIMARY KEY,
            project        TEXT NOT NULL,
            task_id        TEXT NOT NULL,
            title          TEXT NOT NULL,
            agent          TEXT NOT NULL,
            acp_session_id TEXT,
            duty           TEXT,
            created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_task ON session(project, task_id);

        -- Agent Graph: Edge (dependency between sessions)
        -- H6: FK to session(session_id) ON DELETE CASCADE — referential
        -- integrity at the DB layer; cascade_delete_for_session 仍保留作为
        -- 跨表 broadcast 的统一入口，但 DB 层会兜底所有遗漏路径。
        CREATE TABLE IF NOT EXISTS agent_edge (
            edge_id      INTEGER PRIMARY KEY AUTOINCREMENT,
            project      TEXT NOT NULL DEFAULT '',
            task_id      TEXT NOT NULL,
            from_session TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
            to_session   TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
            purpose      TEXT,
            created_at   TEXT NOT NULL,
            UNIQUE (from_session, to_session)
        );
        CREATE INDEX IF NOT EXISTS idx_edge_from ON agent_edge(from_session);
        CREATE INDEX IF NOT EXISTS idx_edge_to ON agent_edge(to_session);

        -- Agent Graph: Pending messages between sessions
        CREATE TABLE IF NOT EXISTS agent_pending_message (
            msg_id       TEXT PRIMARY KEY,
            project      TEXT NOT NULL DEFAULT '',
            task_id      TEXT NOT NULL,
            from_session TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
            to_session   TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
            body         TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pending_to ON agent_pending_message(to_session);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_pair ON agent_pending_message(from_session, to_session);

        -- Custom Agent (persona): 用户基于已有 ACP base agent 定制的身份配置
        CREATE TABLE IF NOT EXISTS custom_agent (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            base_agent    TEXT NOT NULL,
            model         TEXT,
            mode          TEXT,
            effort        TEXT,
            duty          TEXT,
            system_prompt TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );

        -- Review Comments
        CREATE TABLE IF NOT EXISTS review_comments (
            id           INTEGER NOT NULL,
            project_key  TEXT NOT NULL,
            task_id      TEXT NOT NULL,
            comment_type TEXT NOT NULL DEFAULT 'inline',
            file_path    TEXT,
            side         TEXT,
            start_line   INTEGER,
            end_line     INTEGER,
            content      TEXT NOT NULL,
            agent        TEXT NOT NULL DEFAULT '',
            model_name   TEXT NOT NULL DEFAULT '',
            role         TEXT NOT NULL DEFAULT '',
            timestamp    TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'open',
            anchor_text  TEXT,
            PRIMARY KEY (project_key, task_id, id)
        );

        CREATE TABLE IF NOT EXISTS review_replies (
            id          INTEGER NOT NULL,
            comment_id  INTEGER NOT NULL,
            project_key TEXT NOT NULL,
            task_id     TEXT NOT NULL,
            content     TEXT NOT NULL,
            agent       TEXT NOT NULL DEFAULT '',
            model_name  TEXT NOT NULL DEFAULT '',
            role        TEXT NOT NULL DEFAULT '',
            timestamp   TEXT NOT NULL,
            PRIMARY KEY (project_key, task_id, comment_id, id),
            FOREIGN KEY (project_key, task_id, comment_id)
                REFERENCES review_comments(project_key, task_id, id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS ix_review_comments_status
            ON review_comments(project_key, task_id, status);
    ",
    )?;

    // Column migrations for existing databases
    // ALTER TABLE ADD COLUMN is not idempotent in SQLite, so we ignore errors
    let _ = conn.execute_batch(
        "ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'repo';",
    );
    // chat_id is nullable: pre-migration rows have no chat context, and the
    // notification UI falls back to navigating to the task only when NULL.
    let _ = conn.execute_batch("ALTER TABLE hook_notifications ADD COLUMN chat_id TEXT;");
    let _ =
        conn.execute_batch("ALTER TABLE agent_edge ADD COLUMN project TEXT NOT NULL DEFAULT '';");
    let _ = conn.execute_batch(
        "ALTER TABLE agent_pending_message ADD COLUMN project TEXT NOT NULL DEFAULT '';",
    );
    conn.execute_batch(
        "UPDATE agent_edge
         SET project = COALESCE((SELECT s.project FROM session s WHERE s.session_id = agent_edge.from_session), project)
         WHERE project = '';
         UPDATE agent_pending_message
         SET project = COALESCE((SELECT e.project FROM agent_edge e
                                 WHERE e.from_session = agent_pending_message.from_session
                                   AND e.to_session = agent_pending_message.to_session), project)
         WHERE project = '';
         CREATE INDEX IF NOT EXISTS idx_edge_task ON agent_edge(project, task_id);
         CREATE INDEX IF NOT EXISTS idx_pending_task ON agent_pending_message(project, task_id);",
    )?;

    // H6: 旧库的 agent_edge / agent_pending_message 缺 FK；SQLite 不支持
    // ALTER TABLE 加 FK，所以做一次表重建。仅在 sqlite_master 中检测到这些
    // 表无 REFERENCES 时执行；用 sql 字段的 LIKE 判定，不依赖 PRAGMA。
    let needs_fk_migrate: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('agent_edge','agent_pending_message')
               AND sql NOT LIKE '%REFERENCES session%'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if needs_fk_migrate {
        // M-N4: 迁移会丢弃引用了不存在 session 的孤儿行 — 提前算一下要被丢的数量，
        // 让 ops 在升级日志里能看到。后续 gc_orphans 也会兜底。
        let orphan_edges: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_edge
                 WHERE from_session NOT IN (SELECT session_id FROM session)
                    OR to_session   NOT IN (SELECT session_id FROM session)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let orphan_pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_pending_message
                 WHERE from_session NOT IN (SELECT session_id FROM session)
                    OR to_session   NOT IN (SELECT session_id FROM session)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if orphan_edges > 0 || orphan_pending > 0 {
            eprintln!(
                "[fk_migrate] dropping {} orphan edges and {} orphan pending messages \
                 (referenced sessions no longer exist)",
                orphan_edges, orphan_pending
            );
        }
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE agent_edge__new (
                 edge_id      INTEGER PRIMARY KEY AUTOINCREMENT,
                 project      TEXT NOT NULL DEFAULT '',
                 task_id      TEXT NOT NULL,
                 from_session TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
                 to_session   TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
                 purpose      TEXT,
                 created_at   TEXT NOT NULL,
                 UNIQUE (from_session, to_session)
             );
             INSERT INTO agent_edge__new
                 SELECT edge_id, project, task_id, from_session, to_session, purpose, created_at
                 FROM agent_edge
                 WHERE from_session IN (SELECT session_id FROM session)
                   AND to_session   IN (SELECT session_id FROM session);
             DROP TABLE agent_edge;
             ALTER TABLE agent_edge__new RENAME TO agent_edge;
             CREATE INDEX IF NOT EXISTS idx_edge_from ON agent_edge(from_session);
             CREATE INDEX IF NOT EXISTS idx_edge_to   ON agent_edge(to_session);
             CREATE INDEX IF NOT EXISTS idx_edge_task ON agent_edge(project, task_id);

             CREATE TABLE agent_pending_message__new (
                 msg_id       TEXT PRIMARY KEY,
                 project      TEXT NOT NULL DEFAULT '',
                 task_id      TEXT NOT NULL,
                 from_session TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
                 to_session   TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
                 body         TEXT NOT NULL,
                 created_at   TEXT NOT NULL
             );
             INSERT INTO agent_pending_message__new
                 SELECT msg_id, project, task_id, from_session, to_session, body, created_at
                 FROM agent_pending_message
                 WHERE from_session IN (SELECT session_id FROM session)
                   AND to_session   IN (SELECT session_id FROM session);
             DROP TABLE agent_pending_message;
             ALTER TABLE agent_pending_message__new RENAME TO agent_pending_message;
             CREATE INDEX IF NOT EXISTS idx_pending_to   ON agent_pending_message(to_session);
             CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_pair ON agent_pending_message(from_session, to_session);
             CREATE INDEX IF NOT EXISTS idx_pending_task ON agent_pending_message(project, task_id);
             COMMIT;",
        )?;
    }

    // Add code-stat columns onto already-migrated v2.4 task tables (the v2.4
    // migration shipped without them). Idempotent — second call sees the
    // column already there and no-ops via the duplicate-column check below.
    add_column_if_missing(
        conn,
        "tasks",
        "code_additions",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        conn,
        "tasks",
        "code_deletions",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "tasks", "files_changed", "INTEGER NOT NULL DEFAULT 0")?;

    Ok(())
}

/// `ALTER TABLE ... ADD COLUMN` swallowing the "duplicate column name" error
/// SQLite returns when the column already exists. Lets us evolve a previously
/// installed schema without managing a per-column migration version.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl);
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.to_lowercase().contains("duplicate column") =>
        {
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

// ============================================================================
// File → SQLite migration (v1.x → v2.0)
// ============================================================================

/// Migrate all legacy files into SQLite. Each module is its own transaction.
/// Original files are left untouched — use `grove migrate --prune` to remove them.
///
/// Note: some migration functions use the storage API (e.g. `ai::save_audio_global`)
/// which internally calls `connection()`. To avoid deadlock, we acquire and release
/// the connection separately for each module.
pub fn migrate_from_files() {
    // These use conn directly (manual SQL inserts)
    {
        let conn = connection();
        migrate_projects(&conn);
    }
    {
        let conn = connection();
        migrate_taskgroups(&conn);
    }
    {
        let conn = connection();
        migrate_providers(&conn);
    }
    // These use the storage API which calls connection() internally
    migrate_audio_global();
    migrate_audio_projects();
    migrate_skills_all();

    let _ = super::taskgroups::ensure_system_groups();
}

pub fn run_agent_graph_startup_maintenance() {
    {
        let conn = connection();
        if let Err(e) = super::migrate_chats::migrate_chats_toml_to_sqlite(&conn) {
            eprintln!("[warning] chats.toml migration failed: {}", e);
        }
    }

    {
        let conn = connection();
        match super::agent_graph::gc_orphans(&conn) {
            Ok(stats)
                if stats.sessions_deleted > 0
                    || stats.edges_deleted > 0
                    || stats.pending_messages_deleted > 0 =>
            {
                eprintln!(
                    "[warning] agent graph GC removed {} session(s), {} edge(s), {} pending message(s)",
                    stats.sessions_deleted, stats.edges_deleted, stats.pending_messages_deleted
                );
            }
            Ok(_) => {}
            Err(e) => eprintln!("[warning] agent graph GC failed: {}", e),
        }
    }
}

fn migrate_projects(conn: &Connection) {
    let projects_dir = grove_dir().join("projects");
    if !projects_dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    #[derive(serde::Deserialize)]
    struct P {
        name: String,
        path: String,
        #[serde(default)]
        added_at: Option<chrono::DateTime<chrono::Utc>>,
        #[serde(default = "super::database::default_true_for_migration")]
        is_git_repo: bool,
    }

    // Collect all projects first, then dedupe by path keeping newest added_at
    let mut all: Vec<(String, P)> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let toml_path = dir.join("project.toml");
        if !toml_path.exists() {
            continue;
        }
        let hash = entry.file_name().to_string_lossy().to_string();

        let content = match std::fs::read_to_string(&toml_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let p: P = match toml::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        all.push((hash, p));
    }

    // Sort by added_at descending so newest comes first (None = oldest)
    let min_dt = chrono::DateTime::<chrono::Utc>::MIN_UTC;
    all.sort_by(|a, b| {
        let a_time = a.1.added_at.unwrap_or(min_dt);
        let b_time = b.1.added_at.unwrap_or(min_dt);
        b_time.cmp(&a_time)
    });

    // Dedupe by path: first occurrence (newest) wins
    let mut seen_paths = std::collections::HashSet::new();
    for (hash, p) in &all {
        if !seen_paths.insert(p.path.clone()) {
            continue; // duplicate path, skip older entry
        }
        let added_at = p.added_at.unwrap_or_else(chrono::Utc::now).to_rfc3339();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO projects (hash, name, path, is_git_repo, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash, p.name, p.path, p.is_git_repo, added_at],
        );
    }
    eprintln!("  [migrate] projects → SQLite done");
}

fn migrate_taskgroups(conn: &Connection) {
    let path = grove_dir().join("taskgroups.toml");
    if !path.exists() {
        return;
    }

    #[derive(serde::Deserialize)]
    struct TGFile {
        #[serde(default)]
        groups: Vec<super::taskgroups::TaskGroup>,
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let file: TGFile = match toml::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(e) => {
            eprintln!("  [migrate] failed to begin transaction: {}", e);
            return;
        }
    };
    for g in &file.groups {
        let _ = tx.execute(
            "INSERT OR IGNORE INTO task_groups (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![g.id, g.name, g.color, g.created_at.to_rfc3339()],
        );
        for s in &g.slots {
            let _ = tx.execute(
                "INSERT OR IGNORE INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![g.id, s.position as i64, s.project_id, s.task_id, s.target_chat_id],
            );
        }
    }
    let _ = tx.commit();
    eprintln!("  [migrate] taskgroups → SQLite done");
}

fn migrate_providers(conn: &Connection) {
    let path = grove_dir().join("ai").join("providers.json");
    if !path.exists() {
        return;
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let data: super::ai::ProvidersData = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(e) => {
            eprintln!("  [migrate] failed to begin transaction: {}", e);
            return;
        }
    };
    for p in &data.providers {
        let _ = tx.execute(
            "INSERT OR IGNORE INTO ai_providers (id, name, provider_type, base_url, api_key, model, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![p.id, p.name, p.provider_type, p.base_url, p.api_key, p.model, p.status],
        );
    }
    let _ = tx.commit();
    eprintln!("  [migrate] ai/providers → SQLite done");
}

fn migrate_audio_global() {
    let path = grove_dir().join("ai").join("audio.json");
    if !path.exists() {
        return;
    }

    // Skip if already migrated (audio_config row exists)
    let already: bool = connection()
        .query_row("SELECT COUNT(*) FROM audio_config WHERE id = 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap_or(0)
        > 0;
    if already {
        return;
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let data: super::ai::AudioSettingsGlobal = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let _ = super::ai::save_audio_global(&data);
    eprintln!("  [migrate] ai/audio (global) → SQLite done");
}

fn migrate_audio_projects() {
    let projects_dir = grove_dir().join("projects");
    if !projects_dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let audio_path = dir.join("ai").join("audio.json");
        if !audio_path.exists() {
            continue;
        }

        let hash = entry.file_name().to_string_lossy().to_string();
        let content = match std::fs::read_to_string(&audio_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let data: super::ai::AudioSettingsProject = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let _ = super::ai::save_audio_project(&hash, &data);
    }
    eprintln!("  [migrate] ai/audio (project) → SQLite done");
}

fn migrate_skills_all() {
    // Skip if already migrated — check skill_sources (always populated after a full migration)
    let already: bool = connection()
        .query_row("SELECT COUNT(*) FROM skill_sources", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap_or(0)
        > 0;
    if already {
        eprintln!("  [migrate] skills → already in SQLite, skipping");
        return;
    }

    let skills_dir = grove_dir().join("skills");

    let read_file = |filename: &str| -> Option<String> {
        let path = skills_dir.join(filename);
        if path.exists() {
            std::fs::read_to_string(&path).ok()
        } else {
            None
        }
    };

    // Agents (no repo_key involved)
    if let Some(content) = read_file("agents.toml") {
        if let Ok(data) = toml::from_str::<super::skills::AgentsFile>(&content) {
            let _ = super::skills::save_agents(&data);
        }
    }

    // Sources: build old_key → new_key mapping by recomputing FNV from url
    let mut key_remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(content) = read_file("sources.toml") {
        if let Ok(mut data) = toml::from_str::<super::skills::SourcesFile>(&content) {
            for src in &mut data.sources {
                let new_key = super::skills::compute_repo_key(&src.url);
                if !src.repo_key.is_empty() && src.repo_key != new_key {
                    key_remap.insert(src.repo_key.clone(), new_key.clone());
                }
                src.repo_key = new_key;
            }
            let _ = super::skills::save_sources(&data);
        }
    }

    // Manifest: remap repo_key
    if let Some(content) = read_file("manifest.toml") {
        if let Ok(mut data) = toml::from_str::<super::skills::ManifestFile>(&content) {
            for entry in &mut data.skills {
                if let Some(new_key) = key_remap.get(&entry.repo_key) {
                    entry.repo_key = new_key.clone();
                }
            }
            let _ = super::skills::save_manifest(&data);
        }
    }

    // Installed: remap repo_key
    if let Some(content) = read_file("installed.toml") {
        if let Ok(mut data) = toml::from_str::<super::skills::InstalledFile>(&content) {
            for skill in &mut data.installed {
                if let Some(new_key) = key_remap.get(&skill.repo_key) {
                    skill.repo_key = new_key.clone();
                }
            }
            let _ = super::skills::save_installed(&data);
        }
    }

    if !key_remap.is_empty() {
        eprintln!(
            "  [migrate] skills: remapped {} repo_key(s) to stable FNV hash",
            key_remap.len()
        );
    }
    eprintln!("  [migrate] skills → SQLite done");
}

fn default_true_for_migration() -> bool {
    true
}

/// Migrate tasks from per-project tasks.toml + archived.toml to SQLite (v2.3 → v2.4).
///
/// Caller (`ensure_storage_version`) gates this on the storage version bump,
/// so it runs at most once per upgrade. Idempotency comes from per-row
/// `INSERT OR IGNORE` against the (project, id) primary key — we deliberately
/// do **not** stack a global "tasks table non-empty → bail" guard on top.
/// That guard was the original v2.4 design; it false-positived on contaminated
/// dev DBs (leftover `cargo test` rows) and let the version flip to 2.4
/// without real data, after which `gc_orphans` saw an "empty" tasks table and
/// wiped all chat sessions. Trust the row-level idempotency only.
pub fn migrate_tasks_toml_to_sqlite() {
    let projects_dir = grove_dir().join("projects");
    if !projects_dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut total_migrated: u32 = 0;

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let project_key = entry.file_name().to_string_lossy().to_string();

        for (filename, status_str) in &[("tasks.toml", "active"), ("archived.toml", "archived")] {
            let toml_path = dir.join(filename);
            if !toml_path.exists() {
                continue;
            }
            let content = match std::fs::read_to_string(&toml_path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "  [migrate] tasks.toml read failed for {}/{}: {}",
                        project_key, filename, e
                    );
                    continue;
                }
            };
            let data: toml::Value = match toml::from_str(&content) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!(
                        "  [migrate] tasks.toml parse failed for {}/{}: {}",
                        project_key, filename, e
                    );
                    continue;
                }
            };
            let tasks = match data.get("tasks").and_then(|t| t.as_array()) {
                Some(a) => a,
                None => continue,
            };

            let conn = connection();
            let tx = match conn.unchecked_transaction() {
                Ok(tx) => tx,
                Err(_) => continue,
            };

            for task in tasks {
                let id = match task.get("id").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let name = task.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let branch = task.get("branch").and_then(|v| v.as_str()).unwrap_or("");
                let target = task.get("target").and_then(|v| v.as_str()).unwrap_or("");
                let worktree_path = task
                    .get("worktree_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let created_at = task
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let updated_at = task
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or(created_at);
                let multiplexer = task
                    .get("multiplexer")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tmux");
                let session_name = task
                    .get("session_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let created_by = task
                    .get("created_by")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let archived_at = task.get("archived_at").and_then(|v| v.as_str());
                let is_local = task
                    .get("is_local")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // Carry the archive-time diff snapshot across the migration.
                // Without these fields archived rows show 0/0/0 in the stats
                // page even when the old tasks.toml had real numbers.
                let code_additions = task
                    .get("code_additions")
                    .and_then(|v| v.as_integer())
                    .unwrap_or(0)
                    .max(0);
                let code_deletions = task
                    .get("code_deletions")
                    .and_then(|v| v.as_integer())
                    .unwrap_or(0)
                    .max(0);
                let files_changed = task
                    .get("files_changed")
                    .and_then(|v| v.as_integer())
                    .unwrap_or(0)
                    .max(0);

                if let Err(e) = tx.execute(
                    "INSERT OR IGNORE INTO tasks (project, id, name, branch, target, worktree_path, initial_commit, created_at, updated_at, status, multiplexer, session_name, created_by, archived_at, is_local, code_additions, code_deletions, files_changed)
                     VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                    params![
                        project_key,
                        id,
                        name,
                        branch,
                        target,
                        worktree_path,
                        created_at,
                        updated_at,
                        status_str,
                        multiplexer,
                        session_name,
                        created_by,
                        archived_at,
                        is_local as i64,
                        code_additions,
                        code_deletions,
                        files_changed,
                    ],
                ) {
                    eprintln!(
                        "  [migrate] tasks.toml insert failed for {}/{}: {}",
                        project_key, id, e
                    );
                }
            }

            if let Err(e) = tx.commit() {
                eprintln!(
                    "  [migrate] tasks.toml commit failed for {}/{}: {}",
                    project_key, filename, e
                );
            } else {
                total_migrated += tasks.len() as u32;
            }
        }
    }

    if total_migrated > 0 {
        eprintln!(
            "  [migrate] tasks.toml/archived.toml → SQLite done ({} tasks)",
            total_migrated
        );
    }
}

/// Migrate review comments from per-task `review.json` files to SQLite (v2.2 → v2.3).
pub fn migrate_review_to_sqlite() {
    let projects_dir = grove_dir().join("projects");
    if !projects_dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let project_key = entry.file_name().to_string_lossy().to_string();
        let tasks_dir = project_dir.join("tasks");
        if !tasks_dir.exists() {
            continue;
        }
        let task_entries = match std::fs::read_dir(&tasks_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for task_entry in task_entries.flatten() {
            let task_dir = task_entry.path();
            if !task_dir.is_dir() {
                continue;
            }
            let review_path = task_dir.join("review.json");
            if !review_path.exists() {
                continue;
            }
            let task_id = task_entry.file_name().to_string_lossy().to_string();

            let content = match std::fs::read_to_string(&review_path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let raw: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let comments_array = raw.get("comments").and_then(|c| c.as_array());
            let comments_array = match comments_array {
                Some(a) => a,
                None => continue,
            };

            let conn = connection();

            for comment_val in comments_array {
                let id = comment_val.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let author = comment_val
                    .get("author")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let (agent, role) = super::comments::parse_author_to_agent_role(author);
                let comment_type_str = comment_val
                    .get("comment_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("inline");
                let status_str = comment_val
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("open");

                let file_path = comment_val.get("file_path").and_then(|v| v.as_str());
                let side = comment_val.get("side").and_then(|v| v.as_str());
                let start_line = comment_val
                    .get("start_line")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);
                let end_line = comment_val
                    .get("end_line")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);
                let content = comment_val
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let timestamp = comment_val
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let anchor_text = comment_val.get("anchor_text").and_then(|v| v.as_str());

                let result = conn.execute(
                    "INSERT OR IGNORE INTO review_comments
                     (id, project_key, task_id, comment_type, file_path, side, start_line, end_line, content, agent, model_name, role, timestamp, status, anchor_text)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        id,
                        project_key,
                        task_id,
                        comment_type_str,
                        file_path,
                        side,
                        start_line,
                        end_line,
                        content,
                        agent,
                        "",
                        role,
                        timestamp,
                        status_str,
                        anchor_text,
                    ],
                );

                if result.is_ok() {
                    // Iterate replies from raw JSON
                    if let Some(replies_arr) = comment_val.get("replies").and_then(|r| r.as_array())
                    {
                        for reply_val in replies_arr {
                            let reply_id =
                                reply_val.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                            let reply_author = reply_val
                                .get("author")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let (r_agent, r_role) =
                                super::comments::parse_author_to_agent_role(reply_author);
                            let reply_content = reply_val
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let reply_timestamp = reply_val
                                .get("timestamp")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let _ = conn.execute(
                                "INSERT OR IGNORE INTO review_replies
                                 (id, comment_id, project_key, task_id, content, agent, model_name, role, timestamp)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                                params![
                                    reply_id,
                                    id,
                                    project_key,
                                    task_id,
                                    reply_content,
                                    r_agent,
                                    "",
                                    r_role,
                                    reply_timestamp,
                                ],
                            );
                        }
                    }
                }
            }

            // Rename the source file so a future re-run of this migration won't
            // re-import stale data and shadow newer SQLite-era comments. INSERT OR
            // IGNORE already protects against duplicate ids, but a rename makes the
            // one-shot intent explicit. Log on failure (read-only fs / permission)
            // so the operator can clean it up — silent failure was hiding real
            // breakage.
            let target = review_path.with_extension("json.migrated");
            if let Err(e) = std::fs::rename(&review_path, &target) {
                eprintln!(
                    "  [migrate] failed to rename {} → {}: {}",
                    review_path.display(),
                    target.display(),
                    e
                );
            }
        }
    }
}

// ============================================================================
// Prune legacy files (grove migrate --prune)
// ============================================================================

/// Remove legacy files that have been migrated to SQLite.
/// Only runs when storage_version is already at current version (migration completed).
pub fn prune_legacy_files() {
    // Ensure DB is initialized
    let _ = connection();

    let config = super::config::load_config();
    if config.storage_version.as_deref() != Some(CURRENT_STORAGE_VERSION) {
        eprintln!(
            "Storage version is {:?}, not {}. Run `grove` first to migrate, then prune.",
            config.storage_version, CURRENT_STORAGE_VERSION
        );
        return;
    }

    let grove = grove_dir();
    let mut removed = 0u32;

    // taskgroups.toml
    let p = grove.join("taskgroups.toml");
    if p.exists() {
        std::fs::remove_file(&p).ok();
        eprintln!("  removed taskgroups.toml");
        removed += 1;
    }

    // ai/providers.json, ai/audio.json
    for name in &["providers.json", "audio.json"] {
        let p = grove.join("ai").join(name);
        if p.exists() {
            std::fs::remove_file(&p).ok();
            eprintln!("  removed ai/{}", name);
            removed += 1;
        }
    }

    // skills/*.toml (agents, sources, manifest, installed)
    for name in &[
        "agents.toml",
        "sources.toml",
        "manifest.toml",
        "installed.toml",
    ] {
        let p = grove.join("skills").join(name);
        if p.exists() {
            std::fs::remove_file(&p).ok();
            eprintln!("  removed skills/{}", name);
            removed += 1;
        }
    }

    // projects/*/{project.toml, ai/audio.json, review/, ai/<task>/, tasks/<task>/review.json[.migrated], tasks.toml, archived.toml}
    let projects_dir = grove.join("projects");
    if projects_dir.exists() {
        let mut project_removed = 0u32;
        let mut review_files_removed = 0u32;
        let mut review_dirs_removed = 0u32;
        let mut ai_task_dirs_removed = 0u32;
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let toml_path = dir.join("project.toml");
                if toml_path.exists() {
                    std::fs::remove_file(&toml_path).ok();
                    project_removed += 1;
                }

                // v2.4: tasks.toml + archived.toml → SQLite
                for name in &["tasks.toml", "archived.toml"] {
                    let p = dir.join(name);
                    if p.exists() {
                        std::fs::remove_file(&p).ok();
                        project_removed += 1;
                    }
                }

                let audio_path = dir.join("ai").join("audio.json");
                if audio_path.exists() {
                    std::fs::remove_file(&audio_path).ok();
                    project_removed += 1;
                }

                // v2.3: per-task review.json (and rename trail) — comments now
                // live in SQLite, the on-disk copies are dust.
                let tasks_dir = dir.join("tasks");
                if tasks_dir.exists() {
                    if let Ok(task_entries) = std::fs::read_dir(&tasks_dir) {
                        for task_entry in task_entries.flatten() {
                            let task_dir = task_entry.path();
                            if !task_dir.is_dir() {
                                continue;
                            }
                            for name in &["review.json", "review.json.migrated"] {
                                let p = task_dir.join(name);
                                if p.exists() {
                                    std::fs::remove_file(&p).ok();
                                    review_files_removed += 1;
                                }
                            }
                        }
                    }
                }

                // Older formats: standalone review/<task>.json directory and the
                // pre-2.0 ai/<task>/ per-task review folders. Both fully
                // superseded by SQLite as of v2.3.
                let legacy_review_dir = dir.join("review");
                if legacy_review_dir.exists() {
                    std::fs::remove_dir_all(&legacy_review_dir).ok();
                    review_dirs_removed += 1;
                }
                let ai_dir = dir.join("ai");
                if ai_dir.exists() {
                    if let Ok(ai_entries) = std::fs::read_dir(&ai_dir) {
                        for ai_entry in ai_entries.flatten() {
                            let p = ai_entry.path();
                            // Skip files (e.g. audio.json above); only legacy
                            // per-task subdirs.
                            if p.is_dir() {
                                std::fs::remove_dir_all(&p).ok();
                                ai_task_dirs_removed += 1;
                            }
                        }
                    }
                }
            }
        }
        if project_removed > 0 {
            eprintln!(
                "  removed {} project.toml/audio.json files from project dirs",
                project_removed
            );
            removed += project_removed;
        }
        if review_files_removed > 0 {
            eprintln!(
                "  removed {} per-task review.json files (now in SQLite)",
                review_files_removed
            );
            removed += review_files_removed;
        }
        if review_dirs_removed > 0 {
            eprintln!(
                "  removed {} legacy review/ directories",
                review_dirs_removed
            );
            removed += review_dirs_removed;
        }
        if ai_task_dirs_removed > 0 {
            eprintln!(
                "  removed {} legacy ai/<task>/ directories",
                ai_task_dirs_removed
            );
            removed += ai_task_dirs_removed;
        }
    }

    if removed > 0 {
        eprintln!("Pruned {} legacy files.", removed);
    } else {
        eprintln!("No legacy files to prune.");
    }
}

fn task_group_slots_empty() -> bool {
    let conn = connection();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM task_group_slots", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);
    count == 0
}

pub fn migrate_v20_fix_empty_slots() -> bool {
    if !task_group_slots_empty() {
        return false;
    }
    eprintln!("Fixing empty task_group_slots (v2.0 bug)...");
    if let Err(e) = super::taskgroups::ensure_system_groups() {
        eprintln!(
            "[warning] migrate_v20_fix_empty_slots: ensure_system_groups failed: {}",
            e
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared with other DB-touching test modules via `test_lock` above.

    /// RAII guard that restores HOME on drop (including panic unwind).
    struct HomeGuard(String);
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            std::env::set_var("HOME", &self.0);
        }
    }

    /// Dry-run migration test: copies real ~/.grove/ to a temp dir,
    /// runs migration there, and compares old file data vs new SQLite data.
    ///
    /// Run with: cargo test storage::database::tests::dry_run_migration -- --nocapture
    #[test]
    fn dry_run_migration() {
        let _env_guard = test_lock().blocking_lock();
        let real_grove = dirs::home_dir().unwrap().join(".grove");
        if !real_grove.exists() {
            eprintln!("[skip] No ~/.grove/ found, nothing to test");
            return;
        }

        // 1. Copy ~/.grove/ to temp dir
        let temp = std::env::temp_dir().join(format!("grove-migrate-test-{}", std::process::id()));
        let temp_grove = temp.join(".grove");
        if temp_grove.exists() {
            std::fs::remove_dir_all(&temp_grove).unwrap();
        }
        copy_dir_recursive(&real_grove, &temp_grove);
        eprintln!("[dry-run] Copied ~/.grove/ → {}", temp_grove.display());

        // Delete any existing grove.db in the copy (start fresh)
        let _ = std::fs::remove_file(temp_grove.join("grove.db"));
        let _ = std::fs::remove_file(temp_grove.join("grove.db-wal"));
        let _ = std::fs::remove_file(temp_grove.join("grove.db-shm"));

        // 2. Read old data from files (before migration)
        let old_projects = read_old_projects(&temp_grove);
        let old_taskgroups = read_old_taskgroups(&temp_grove);
        let old_providers = read_old_providers(&temp_grove);
        let old_audio_global = read_old_audio_global(&temp_grove);
        let old_skills_agents = read_old_skills_agents(&temp_grove);

        eprintln!("[dry-run] Old data loaded:");
        eprintln!("  projects: {}", old_projects.len());
        eprintln!("  taskgroups: {}", old_taskgroups);
        eprintln!("  providers: {}", old_providers);
        eprintln!("  audio_global: {}", old_audio_global);
        eprintln!("  skills_agents: {}", old_skills_agents);

        // 3. Override HOME and run migration (RAII guard restores on panic)
        let _home_guard = HomeGuard(std::env::var("HOME").unwrap_or_default());
        std::env::set_var("HOME", &temp);

        // Force DB to re-open at new location
        migrate_from_files();

        // 4. Read new data from SQLite
        let conn = connection();
        let new_projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap_or(0);
        let new_task_groups: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_groups", [], |r| r.get(0))
            .unwrap_or(0);
        let new_task_group_slots: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_slots", [], |r| r.get(0))
            .unwrap_or(0);
        let new_providers: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_providers", [], |r| r.get(0))
            .unwrap_or(0);
        let new_audio: i64 = conn
            .query_row("SELECT COUNT(*) FROM audio_config", [], |r| r.get(0))
            .unwrap_or(0);
        let new_audio_terms: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audio_terms WHERE project_hash IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let new_skill_agents: i64 = conn
            .query_row("SELECT COUNT(*) FROM skill_agents", [], |r| r.get(0))
            .unwrap_or(0);
        let new_skill_sources: i64 = conn
            .query_row("SELECT COUNT(*) FROM skill_sources", [], |r| r.get(0))
            .unwrap_or(0);
        let new_skill_manifest: i64 = conn
            .query_row("SELECT COUNT(*) FROM skill_manifest", [], |r| r.get(0))
            .unwrap_or(0);
        let new_skill_installed: i64 = conn
            .query_row("SELECT COUNT(*) FROM skill_installed", [], |r| r.get(0))
            .unwrap_or(0);
        drop(conn);

        eprintln!("\n[dry-run] New SQLite data:");
        eprintln!("  projects: {}", new_projects);
        eprintln!("  task_groups: {}", new_task_groups);
        eprintln!("  task_group_slots: {}", new_task_group_slots);
        eprintln!("  ai_providers: {}", new_providers);
        eprintln!("  audio_config: {}", new_audio);
        eprintln!("  audio_terms (global): {}", new_audio_terms);
        eprintln!("  skill_agents: {}", new_skill_agents);
        eprintln!("  skill_sources: {}", new_skill_sources);
        eprintln!("  skill_manifest: {}", new_skill_manifest);
        eprintln!("  skill_installed: {}", new_skill_installed);

        // 5. Verify counts match
        eprintln!("\n[dry-run] Verification:");
        assert_eq!(
            new_projects,
            old_projects.len() as i64,
            "projects count mismatch"
        );
        eprintln!("  ✓ projects: {} == {}", new_projects, old_projects.len());

        // Verify project data integrity (spot check: paths should all be present)
        {
            let conn2 = connection();
            let mut stmt = conn2.prepare("SELECT path FROM projects").unwrap();
            let db_paths: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            for old_path in &old_projects {
                assert!(
                    db_paths.contains(old_path),
                    "Missing project path in SQLite: {}",
                    old_path
                );
            }
            eprintln!("  ✓ all project paths present in SQLite");
        } // conn2 dropped here before HOME restore

        // Verify original files are untouched (no .bak renaming)
        if !old_projects.is_empty() {
            let originals_intact = std::fs::read_dir(temp_grove.join("projects"))
                .ok()
                .map(|entries| {
                    entries
                        .flatten()
                        .any(|e| e.path().join("project.toml").exists())
                })
                .unwrap_or(false);
            assert!(originals_intact, "Original files should be untouched");
            eprintln!("  ✓ original files untouched");
        }

        eprintln!("\n[dry-run] ✓ Migration looks correct!");

        // 6. Clean up — HOME restored automatically by _home_guard drop
        drop(_home_guard);
        let _ = std::fs::remove_dir_all(&temp);
        eprintln!("[dry-run] Temp dir cleaned up");
    }

    // --- Helpers to read old file-based data ---

    fn read_old_projects(grove: &std::path::Path) -> Vec<String> {
        let projects_dir = grove.join("projects");
        if !projects_dir.exists() {
            return vec![];
        }
        let mut paths = vec![];
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let toml_path = entry.path().join("project.toml");
                if toml_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&toml_path) {
                        if let Ok(val) = toml::from_str::<toml::Value>(&content) {
                            if let Some(p) = val.get("path").and_then(|v| v.as_str()) {
                                paths.push(p.to_string());
                            }
                        }
                    }
                }
            }
        }
        paths
    }

    fn read_old_taskgroups(grove: &std::path::Path) -> String {
        let path = grove.join("taskgroups.toml");
        if !path.exists() {
            return "no file".to_string();
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = toml::from_str::<toml::Value>(&content) {
                let groups = val
                    .get("groups")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let slots: usize = val
                    .get("groups")
                    .and_then(|v| v.as_array())
                    .map(|groups| {
                        groups
                            .iter()
                            .map(|g| {
                                g.get("slots")
                                    .and_then(|s| s.as_array())
                                    .map(|a| a.len())
                                    .unwrap_or(0)
                            })
                            .sum()
                    })
                    .unwrap_or(0);
                return format!("{} groups, {} slots", groups, slots);
            }
        }
        "parse error".to_string()
    }

    fn read_old_providers(grove: &std::path::Path) -> String {
        let path = grove.join("ai").join("providers.json");
        if !path.exists() {
            return "no file".to_string();
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let count = val
                    .get("providers")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                return format!("{} providers", count);
            }
        }
        "parse error".to_string()
    }

    fn read_old_audio_global(grove: &std::path::Path) -> String {
        let path = grove.join("ai").join("audio.json");
        if !path.exists() {
            return "no file".to_string();
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let terms: usize = val
                    .get("preferred_terms")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0)
                    + val
                        .get("forbidden_terms")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0)
                    + val
                        .get("replacements")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                return format!("exists, {} terms", terms);
            }
        }
        "parse error".to_string()
    }

    fn read_old_skills_agents(grove: &std::path::Path) -> String {
        let path = grove.join("skills").join("agents.toml");
        if !path.exists() {
            return "no file".to_string();
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = toml::from_str::<toml::Value>(&content) {
                let custom = val
                    .get("custom_agents")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let overrides = val
                    .get("builtin_overrides")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                return format!("{} custom, {} overrides", custom, overrides);
            }
        }
        "parse error".to_string()
    }

    fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
        std::fs::create_dir_all(dst).unwrap();
        for entry in std::fs::read_dir(src).unwrap().flatten() {
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if src_path.is_dir() {
                // Skip skills/repos (can be huge)
                if entry.file_name() == "repos" {
                    continue;
                }
                copy_dir_recursive(&src_path, &dst_path);
            } else {
                let _ = std::fs::copy(&src_path, &dst_path);
            }
        }
    }
}
