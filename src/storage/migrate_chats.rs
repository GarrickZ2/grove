//! Migration from per-task chats.toml files to the SQLite session table.

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::error::Result;

const MIGRATION_KEY: &str = "chats_toml_migrated";

pub fn migrate_chats_toml_to_sqlite(conn: &Connection) -> Result<()> {
    ensure_migration_table(conn)?;
    if migration_done(conn)? {
        return Ok(());
    }

    let projects_dir = crate::storage::grove_dir().join("projects");
    if !projects_dir.exists() {
        mark_done(conn)?;
        return Ok(());
    }

    let timestamp = Utc::now().format("%Y%m%d%H%M%S").to_string();
    let projects = match std::fs::read_dir(&projects_dir) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!(
                "[warning] chats.toml migration: cannot read {}: {}",
                projects_dir.display(),
                e
            );
            mark_done(conn)?;
            return Ok(());
        }
    };

    for project in projects.flatten() {
        let project_dir = project.path();
        if !project_dir.is_dir() {
            continue;
        }
        let project_id = project.file_name().to_string_lossy().to_string();
        let tasks_dir = project_dir.join("tasks");
        let Ok(tasks) = std::fs::read_dir(&tasks_dir) else {
            continue;
        };

        for task in tasks.flatten() {
            if !task.path().is_dir() {
                continue;
            }
            let task_id = task.file_name().to_string_lossy().to_string();
            let chats_path = task.path().join("chats").join("chats.toml");
            if !chats_path.exists() {
                continue;
            }

            match migrate_one_task(conn, &project_id, &task_id, &chats_path, &timestamp) {
                Ok(count) => eprintln!(
                    "  [migrate] chats.toml → session: {}/{} ({} chats)",
                    project_id, task_id, count
                ),
                Err(e) => eprintln!(
                    "[warning] chats.toml migration failed for {}/{}: {}",
                    project_id, task_id, e
                ),
            }
        }
    }

    mark_done(conn)?;
    Ok(())
}

fn ensure_migration_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _migration (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

fn migration_done(conn: &Connection) -> Result<bool> {
    let done = conn
        .query_row(
            "SELECT value FROM _migration WHERE key = ?1",
            [MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .map(|value| value == "true")
        .unwrap_or(false);
    Ok(done)
}

fn mark_done(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO _migration (key, value, updated_at)
         VALUES (?1, 'true', ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![MIGRATION_KEY, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn migrate_one_task(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    chats_path: &std::path::Path,
    timestamp: &str,
) -> Result<usize> {
    let file: crate::storage::tasks::ChatsFile = crate::storage::load_toml(chats_path)?;
    let count = file.chats.len();

    let tx = conn.unchecked_transaction()?;
    for chat in &file.chats {
        tx.execute(
            "INSERT INTO session
             (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id) DO NOTHING",
            params![
                chat.id,
                project_id,
                task_id,
                chat.title,
                chat.agent,
                chat.acp_session_id,
                chat.duty,
                chat.created_at.to_rfc3339(),
            ],
        )?;
    }
    tx.commit()?;

    let bak_path = chats_path.with_file_name(format!("chats.toml.bak.{}", timestamp));
    if !bak_path.exists() {
        std::fs::rename(chats_path, bak_path)?;
    }

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::database::{connection, test_lock};
    use crate::storage::set_grove_dir_override;
    use crate::storage::tasks::{
        add_chat_session, add_task, get_chat_session, remove_task, update_chat_duty, ChatSession,
        Task, TaskStatus,
    };

    struct GroveDirGuard;
    impl Drop for GroveDirGuard {
        fn drop(&mut self) {
            set_grove_dir_override(None);
            let _ = connection();
        }
    }

    fn with_temp_home(test: impl FnOnce(&std::path::Path)) {
        let _lock = test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        let grove_path = temp.path().join(".grove");
        std::fs::create_dir_all(&grove_path).unwrap();
        set_grove_dir_override(Some(grove_path));
        let _guard = GroveDirGuard;
        test(temp.path());
    }

    fn chat(id: &str, duty: Option<&str>) -> ChatSession {
        ChatSession {
            id: id.to_string(),
            title: "Test Chat".to_string(),
            agent: "codex".to_string(),
            acp_session_id: Some("acp-1".to_string()),
            created_at: chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .unwrap()
                .to_utc(),
            duty: duty.map(str::to_string),
        }
    }

    fn task(id: &str) -> Task {
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .to_utc();
        Task {
            id: id.to_string(),
            name: "Task".to_string(),
            branch: "grove/task".to_string(),
            target: "main".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
            created_at: now,
            updated_at: now,
            status: TaskStatus::Active,
            multiplexer: "tmux".to_string(),
            session_name: String::new(),
            created_by: "test".to_string(),
            archived_at: None,
            code_additions: 0,
            code_deletions: 0,
            files_changed: 0,
            is_local: false,
        }
    }

    #[test]
    fn migrates_chats_toml_and_renames_backup() {
        with_temp_home(|home| {
            let chats_dir = home.join(".grove/projects/project-1/tasks/task-1/chats");
            std::fs::create_dir_all(&chats_dir).unwrap();
            let chats_path = chats_dir.join("chats.toml");
            crate::storage::save_toml(
                &chats_path,
                &crate::storage::tasks::ChatsFile {
                    chats: vec![chat("chat-1", Some("review"))],
                },
            )
            .unwrap();

            let conn = connection();
            migrate_chats_toml_to_sqlite(&conn).unwrap();

            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
            assert!(!chats_path.exists());
            assert!(std::fs::read_dir(&chats_dir)
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("chats.toml.bak.")));
        });
    }

    #[test]
    fn migration_is_idempotent() {
        with_temp_home(|home| {
            let chats_dir = home.join(".grove/projects/project-1/tasks/task-1/chats");
            std::fs::create_dir_all(&chats_dir).unwrap();
            let chats_path = chats_dir.join("chats.toml");
            crate::storage::save_toml(
                &chats_path,
                &crate::storage::tasks::ChatsFile {
                    chats: vec![chat("chat-1", None)],
                },
            )
            .unwrap();

            let conn = connection();
            migrate_chats_toml_to_sqlite(&conn).unwrap();
            migrate_chats_toml_to_sqlite(&conn).unwrap();

            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
        });
    }

    #[test]
    fn duty_lock_rejects_second_some_but_allows_clear() {
        with_temp_home(|_| {
            add_chat_session("project-1", "task-1", chat("chat-1", None)).unwrap();
            update_chat_duty("project-1", "task-1", "chat-1", Some("review".to_string())).unwrap();
            assert!(
                update_chat_duty("project-1", "task-1", "chat-1", Some("plan".to_string()))
                    .is_err()
            );
            update_chat_duty("project-1", "task-1", "chat-1", None).unwrap();
            assert!(get_chat_session("project-1", "task-1", "chat-1")
                .unwrap()
                .unwrap()
                .duty
                .is_none());
        });
    }

    #[test]
    fn delete_chat_session_cascades_edges_and_pending_messages() {
        with_temp_home(|_| {
            add_chat_session("project-1", "task-1", chat("chat-1", None)).unwrap();
            add_chat_session("project-1", "task-1", chat("chat-2", None)).unwrap();

            let conn = connection();
            conn.execute(
                "INSERT INTO agent_edge (task_id, from_session, to_session, purpose, created_at)
                 VALUES ('task-1', 'chat-1', 'chat-2', 'handoff', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_pending_message
                 (msg_id, task_id, from_session, to_session, body, created_at)
                 VALUES ('msg-1', 'task-1', 'chat-2', 'chat-1', 'hello', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            drop(conn);

            crate::storage::tasks::delete_chat_session("project-1", "task-1", "chat-1").unwrap();

            let conn = connection();
            let edges: i64 = conn
                .query_row("SELECT COUNT(*) FROM agent_edge", [], |row| row.get(0))
                .unwrap();
            let pending: i64 = conn
                .query_row("SELECT COUNT(*) FROM agent_pending_message", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let sessions: i64 = conn
                .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
                .unwrap();
            assert_eq!(edges, 0);
            assert_eq!(pending, 0);
            assert_eq!(sessions, 1);
        });
    }

    #[test]
    fn remove_task_cascades_sessions_edges_and_pending_messages() {
        with_temp_home(|_| {
            add_task("project-1", task("task-1")).unwrap();
            add_chat_session("project-1", "task-1", chat("chat-1", None)).unwrap();
            add_chat_session("project-1", "task-1", chat("chat-2", None)).unwrap();

            let conn = connection();
            conn.execute(
                "INSERT INTO agent_edge (task_id, from_session, to_session, purpose, created_at)
                 VALUES ('task-1', 'chat-1', 'chat-2', 'handoff', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_pending_message
                 (msg_id, task_id, from_session, to_session, body, created_at)
                 VALUES ('msg-1', 'task-1', 'chat-1', 'chat-2', 'hello', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            drop(conn);

            remove_task("project-1", "task-1").unwrap();

            let conn = connection();
            for table in ["session", "agent_edge", "agent_pending_message"] {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0, "{} should be empty", table);
            }
        });
    }
}
