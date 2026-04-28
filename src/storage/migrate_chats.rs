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

            match migrate_one_task(conn, &project_id, &task_id, &chats_path) {
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
) -> Result<usize> {
    let file: crate::storage::tasks::ChatsFile = crate::storage::load_toml(chats_path)?;

    let tx = conn.unchecked_transaction()?;
    let mut migrated = 0;
    for chat in &file.chats {
        let rows = tx.execute(
            "INSERT OR IGNORE INTO session
             (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
        if rows == 0 {
            eprintln!(
                "[warning] chats.toml migration: chat id '{}' already exists in session table, skipping {}/{}",
                chat.id, project_id, task_id
            );
        } else {
            migrated += 1;
        }
    }
    tx.commit()?;
    // 不再 rename chats.toml；新服务只读 SQLite session 表，留着旧文件做应急备份。
    Ok(migrated)
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
    fn migrates_chats_toml_to_sqlite() {
        with_temp_home(|home| {
            let chats_dir = home.join(".grove/projects/project-1/tasks/task-1/chats");
            std::fs::create_dir_all(&chats_dir).unwrap();
            let old_chat_dir = chats_dir.join("chat-1");
            std::fs::create_dir_all(&old_chat_dir).unwrap();
            std::fs::write(old_chat_dir.join("history.jsonl"), "{}\n").unwrap();
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
            let migrated_id: String = conn
                .query_row("SELECT session_id FROM session", [], |row| row.get(0))
                .unwrap();
            assert_eq!(migrated_id, "chat-1");
            assert!(old_chat_dir.exists());
            assert!(old_chat_dir.join("history.jsonl").exists());
            // chats.toml 已不再被 rename — 新流程只读 SQLite，留着旧文件做备份。
            assert!(chats_path.exists());
        });
    }

    #[test]
    fn migration_remaps_duplicate_legacy_chat_ids_across_tasks() {
        with_temp_home(|home| {
            for task_id in ["task-1", "task-2"] {
                let chats_dir = home
                    .join(".grove/projects/project-1/tasks")
                    .join(task_id)
                    .join("chats");
                std::fs::create_dir_all(chats_dir.join("chat-1")).unwrap();
                crate::storage::save_toml(
                    &chats_dir.join("chats.toml"),
                    &crate::storage::tasks::ChatsFile {
                        chats: vec![chat("chat-1", None)],
                    },
                )
                .unwrap();
            }

            let conn = connection();
            migrate_chats_toml_to_sqlite(&conn).unwrap();

            let mut stmt = conn
                .prepare("SELECT session_id FROM session ORDER BY task_id")
                .unwrap();
            let ids = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();

            assert_eq!(ids.len(), 1);
            assert_eq!(ids[0], "chat-1");
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
            update_chat_duty(
                "project-1",
                "task-1",
                "chat-1",
                Some("review".to_string()),
                false,
            )
            .unwrap();
            assert!(update_chat_duty(
                "project-1",
                "task-1",
                "chat-1",
                Some("plan".to_string()),
                false
            )
            .is_err());
            // force=true 用户路径，应允许覆盖
            update_chat_duty(
                "project-1",
                "task-1",
                "chat-1",
                Some("plan2".to_string()),
                true,
            )
            .unwrap();
            update_chat_duty("project-1", "task-1", "chat-1", None, false).unwrap();
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
                "INSERT INTO agent_edge (project, task_id, from_session, to_session, purpose, created_at)
                 VALUES ('project-1', 'task-1', 'chat-1', 'chat-2', 'handoff', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_pending_message
                 (msg_id, project, task_id, from_session, to_session, body, created_at)
                 VALUES ('msg-1', 'project-1', 'task-1', 'chat-2', 'chat-1', 'hello', '2026-01-01T00:00:00Z')",
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
                "INSERT INTO agent_edge (project, task_id, from_session, to_session, purpose, created_at)
                 VALUES ('project-1', 'task-1', 'chat-1', 'chat-2', 'handoff', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_pending_message
                 (msg_id, project, task_id, from_session, to_session, body, created_at)
                 VALUES ('msg-1', 'project-1', 'task-1', 'chat-1', 'chat-2', 'hello', '2026-01-01T00:00:00Z')",
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
