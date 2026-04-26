//! Agent Graph 数据层
//!
//! 表：session / agent_edge / agent_pending_message
//! CRUD 实现见后续 WO（WO-003 / WO-004 / WO-005）

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};

use crate::error::Result;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AgentEdge {
    pub edge_id: i64,
    pub task_id: String,
    pub from_session: String,
    pub to_session: String,
    pub purpose: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AgentPendingMessage {
    pub msg_id: String,
    pub task_id: String,
    pub from_session: String,
    pub to_session: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GcStats {
    pub sessions_deleted: usize,
    pub edges_deleted: usize,
    pub pending_messages_deleted: usize,
}

/// 删除 session 时的级联清理：删除该 session 涉及的所有 edge / pending_message。
pub fn cascade_delete_for_session(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM agent_edge WHERE from_session = ?1 OR to_session = ?1",
        [session_id],
    )?;
    conn.execute(
        "DELETE FROM agent_pending_message WHERE from_session = ?1 OR to_session = ?1",
        [session_id],
    )?;
    Ok(())
}

/// 删除 task 时的级联清理：删除该 project + task 下所有 session / edge / pending_message。
pub fn cascade_delete_for_task(conn: &Connection, project: &str, task_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM agent_pending_message WHERE task_id = ?1",
        [task_id],
    )?;
    conn.execute("DELETE FROM agent_edge WHERE task_id = ?1", [task_id])?;
    conn.execute(
        "DELETE FROM session WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
    Ok(())
}

/// 启动时清理孤儿 session / edge / pending_message。
pub fn gc_orphans(conn: &Connection) -> Result<GcStats> {
    let mut valid = std::collections::HashSet::new();
    let projects_dir = crate::storage::grove_dir().join("projects");
    if let Ok(projects) = std::fs::read_dir(projects_dir) {
        for project in projects.flatten() {
            if !project.path().is_dir() {
                continue;
            }
            let project_id = project.file_name().to_string_lossy().to_string();

            for task in crate::storage::tasks::load_tasks(&project_id).unwrap_or_default() {
                valid.insert((project_id.clone(), task.id));
            }
            for task in crate::storage::tasks::load_archived_tasks(&project_id).unwrap_or_default()
            {
                valid.insert((project_id.clone(), task.id));
            }
        }
    }

    let sessions: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT project, task_id FROM session")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let tx = conn.unchecked_transaction()?;
    let mut sessions_deleted = 0;
    for (project, task_id) in sessions {
        if !valid.contains(&(project.clone(), task_id.clone())) {
            sessions_deleted += tx.execute(
                "DELETE FROM session WHERE project = ?1 AND task_id = ?2",
                params![project, task_id],
            )?;
        }
    }

    let edges_deleted = tx.execute(
        "DELETE FROM agent_edge
         WHERE from_session NOT IN (SELECT session_id FROM session)
            OR to_session NOT IN (SELECT session_id FROM session)",
        [],
    )?;
    let pending_messages_deleted = tx.execute(
        "DELETE FROM agent_pending_message
         WHERE from_session NOT IN (SELECT session_id FROM session)
            OR to_session NOT IN (SELECT session_id FROM session)",
        [],
    )?;
    tx.commit()?;

    Ok(GcStats {
        sessions_deleted,
        edges_deleted,
        pending_messages_deleted,
    })
}
