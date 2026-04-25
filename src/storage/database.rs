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

pub const CURRENT_STORAGE_VERSION: &str = "2.1";

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
fn create_schema(conn: &Connection) -> Result<()> {
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
    ",
    )?;

    // Column migrations for existing databases
    // ALTER TABLE ADD COLUMN is not idempotent in SQLite, so we ignore errors
    let _ = conn.execute_batch(
        "ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'repo';",
    );

    Ok(())
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

    // projects/*/project.toml, projects/*/ai/audio.json
    let projects_dir = grove.join("projects");
    if projects_dir.exists() {
        let mut project_removed = 0u32;
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
                let audio_path = dir.join("ai").join("audio.json");
                if audio_path.exists() {
                    std::fs::remove_file(&audio_path).ok();
                    project_removed += 1;
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
