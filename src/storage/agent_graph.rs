//! Agent Graph 数据层
//!
//! 表：session / agent_edge / agent_pending_message
//! CRUD 实现见后续 WO（WO-003 / WO-004 / WO-005）

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{GroveError, Result};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AgentEdge {
    pub edge_id: i64,
    pub project: String,
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

/// Return item for outgoing session contacts: edge plus target session metadata.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct OutgoingContact {
    pub edge_id: i64,
    pub to_session_id: String,
    pub to_session_name: String,
    pub to_session_duty: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GcStats {
    pub sessions_deleted: usize,
    pub edges_deleted: usize,
    pub pending_messages_deleted: usize,
}

/// Storage 层业务错误码（稳定 API），与 `AgentGraphError` 上层枚举一一对应。
#[allow(dead_code)]
pub mod tag {
    pub const ENDPOINT_NOT_FOUND: &str = "endpoint_not_found";
    pub const SAME_TASK_REQUIRED: &str = "same_task_required";
    pub const DUPLICATE_EDGE: &str = "duplicate_edge";
    pub const BIDIRECTIONAL_EDGE: &str = "bidirectional_edge";
    pub const CYCLE_WOULD_FORM: &str = "cycle_would_form";
    pub const NO_EDGE: &str = "no_edge";
    pub const PREVIOUS_MESSAGE_PENDING: &str = "previous_message_pending";
    pub const DUPLICATE_MSG_ID: &str = "duplicate_msg_id";
    pub const PENDING_MESSAGE_NOT_FOUND: &str = "pending_message_not_found";
    pub const DUTY_LOCKED: &str = "duty_locked";
}

#[allow(dead_code)]
fn storage_error(token: &'static str) -> GroveError {
    GroveError::storage_tagged(token, token)
}

#[allow(dead_code)]
fn row_to_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentEdge> {
    let created_at: String = row.get(6)?;
    let created_at = DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    Ok(AgentEdge {
        edge_id: row.get(0)?,
        project: row.get(1)?,
        task_id: row.get(2)?,
        from_session: row.get(3)?,
        to_session: row.get(4)?,
        purpose: row.get(5)?,
        created_at,
    })
}

#[allow(dead_code)]
fn row_to_pending(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentPendingMessage> {
    let created_at: String = row.get(5)?;
    let created_at = DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    Ok(AgentPendingMessage {
        msg_id: row.get(0)?,
        task_id: row.get(1)?,
        from_session: row.get(2)?,
        to_session: row.get(3)?,
        body: row.get(4)?,
        created_at,
    })
}

#[allow(dead_code)]
fn row_to_outgoing_contact(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutgoingContact> {
    Ok(OutgoingContact {
        edge_id: row.get(0)?,
        to_session_id: row.get(1)?,
        to_session_name: row.get(2)?,
        to_session_duty: row.get(3)?,
        purpose: row.get(4)?,
    })
}

/// 创建一条边。返回 edge_id。
#[allow(dead_code)]
pub fn add_edge(
    conn: &Connection,
    project: &str,
    task_id: &str,
    from_session: &str,
    to_session: &str,
    purpose: Option<&str>,
) -> Result<i64> {
    let tx = conn.unchecked_transaction()?;

    let from_scope: Option<(String, String)> = tx
        .query_row(
            "SELECT project, task_id FROM session WHERE session_id = ?1",
            [from_session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let to_scope: Option<(String, String)> = tx
        .query_row(
            "SELECT project, task_id FROM session WHERE session_id = ?1",
            [to_session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let (Some(from_scope), Some(to_scope)) = (from_scope, to_scope) else {
        return Err(storage_error("endpoint_not_found"));
    };

    if from_scope.0 != project
        || to_scope.0 != project
        || from_scope.1 != task_id
        || to_scope.1 != task_id
    {
        return Err(storage_error("same_task_required"));
    }

    let duplicate = tx
        .query_row(
            "SELECT 1 FROM agent_edge WHERE from_session = ?1 AND to_session = ?2",
            params![from_session, to_session],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if duplicate {
        return Err(storage_error("duplicate_edge"));
    }

    let bidirectional = tx
        .query_row(
            "SELECT 1 FROM agent_edge WHERE from_session = ?1 AND to_session = ?2",
            params![to_session, from_session],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if bidirectional {
        return Err(storage_error("bidirectional_edge"));
    }

    let cycle = from_session == to_session
        || tx
            .query_row(
                "WITH RECURSIVE reachable(s) AS (
                   SELECT to_session FROM agent_edge WHERE project = ?1 AND task_id = ?2 AND from_session = ?3
                   UNION
                   SELECT e.to_session
                   FROM agent_edge e
                   JOIN reachable r ON e.from_session = r.s
                   WHERE e.project = ?1 AND e.task_id = ?2
                 )
                 SELECT 1 FROM reachable WHERE s = ?4",
                params![project, task_id, to_session, from_session],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
    if cycle {
        return Err(storage_error("cycle_would_form"));
    }

    tx.execute(
        "INSERT INTO agent_edge (project, task_id, from_session, to_session, purpose, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            project,
            task_id,
            from_session,
            to_session,
            purpose,
            Utc::now().to_rfc3339(),
        ],
    )?;
    let edge_id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(edge_id)
}

/// 删除一条边（按 edge_id），并删除该边上的 pending message。
#[allow(dead_code)]
pub fn delete_edge(conn: &Connection, edge_id: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let endpoints: Option<(String, String)> = tx
        .query_row(
            "SELECT from_session, to_session FROM agent_edge WHERE edge_id = ?1",
            [edge_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    if let Some((from_session, to_session)) = endpoints {
        tx.execute(
            "DELETE FROM agent_pending_message WHERE from_session = ?1 AND to_session = ?2",
            params![from_session, to_session],
        )?;
        tx.execute("DELETE FROM agent_edge WHERE edge_id = ?1", [edge_id])?;
    }

    tx.commit()?;
    Ok(())
}

/// 更新 purpose（可设 Some 或 None 清空）。
#[allow(dead_code)]
pub fn update_edge_purpose(conn: &Connection, edge_id: i64, purpose: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE agent_edge SET purpose = ?1 WHERE edge_id = ?2",
        params![purpose, edge_id],
    )?;
    Ok(())
}

/// 按 edge_id 取一条边。
#[allow(dead_code)]
pub fn get_edge(conn: &Connection, edge_id: i64) -> Result<Option<AgentEdge>> {
    let edge = conn
        .query_row(
            "SELECT edge_id, project, task_id, from_session, to_session, purpose, created_at
             FROM agent_edge
             WHERE edge_id = ?1",
            [edge_id],
            row_to_edge,
        )
        .optional()?;
    Ok(edge)
}

/// 取某 task 下所有边（用于 graph 渲染）。
#[allow(dead_code)]
pub fn list_edges_for_task(
    conn: &Connection,
    project: &str,
    task_id: &str,
) -> Result<Vec<AgentEdge>> {
    let mut stmt = conn.prepare(
        "SELECT edge_id, project, task_id, from_session, to_session, purpose, created_at
         FROM agent_edge
         WHERE project = ?1 AND task_id = ?2
         ORDER BY edge_id ASC",
    )?;
    let edges = stmt
        .query_map(params![project, task_id], row_to_edge)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(edges)
}

/// 投递一条 pending message（即"send"动作的持久化）。
/// 校验顺序：
///   a. (from_session, to_session) 这条边存在于 agent_edge
///   b. (from_session, to_session) 没有未回复 pending（UNIQUE 索引兜底，提前显式报错）
///   c. msg_id 全表唯一
#[allow(dead_code)]
pub fn insert_pending_message(
    conn: &Connection,
    msg_id: &str,
    task_id: &str,
    from_session: &str,
    to_session: &str,
    body: &str,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;

    let edge_project: Option<String> = tx
        .query_row(
            "SELECT project FROM agent_edge WHERE task_id = ?1 AND from_session = ?2 AND to_session = ?3",
            params![task_id, from_session, to_session],
            |row| row.get(0),
        )
        .optional()?;
    let Some(edge_project) = edge_project else {
        return Err(storage_error("no_edge"));
    };

    let pending_exists = tx
        .query_row(
            "SELECT 1 FROM agent_pending_message WHERE from_session = ?1 AND to_session = ?2",
            params![from_session, to_session],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if pending_exists {
        return Err(storage_error("previous_message_pending"));
    }

    let msg_exists = tx
        .query_row(
            "SELECT 1 FROM agent_pending_message WHERE msg_id = ?1",
            [msg_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if msg_exists {
        return Err(storage_error("duplicate_msg_id"));
    }

    // M3: 校验后仍有竞态可能命中 UNIQUE 约束（uniq_pending_pair 或 PRIMARY KEY）。
    // 显式把约束错误映射回业务错误码，让上层 From<GroveError> 能正确归类；
    // tx 在 Err 路径上 Drop 时自动 rollback（rusqlite 默认行为）。
    let insert_res = tx.execute(
        "INSERT INTO agent_pending_message (msg_id, project, task_id, from_session, to_session, body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            msg_id,
            edge_project,
            task_id,
            from_session,
            to_session,
            body,
            Utc::now().to_rfc3339(),
        ],
    );
    if let Err(rusqlite::Error::SqliteFailure(err, _)) = &insert_res {
        if err.code == rusqlite::ErrorCode::ConstraintViolation {
            return Err(storage_error("previous_message_pending"));
        }
    }
    insert_res?;
    tx.commit()?;
    Ok(())
}

/// 删除一条 pending message（即"reply 消费 ticket"）。
/// 找不到 msg_id 报错。
#[allow(dead_code)]
pub fn delete_pending_message(conn: &Connection, msg_id: &str) -> Result<()> {
    let rows = conn.execute(
        "DELETE FROM agent_pending_message WHERE msg_id = ?1",
        [msg_id],
    )?;
    if rows == 0 {
        return Err(storage_error("pending_message_not_found"));
    }
    Ok(())
}

/// 按 msg_id 取一条 pending message。
#[allow(dead_code)]
pub fn get_pending_message(conn: &Connection, msg_id: &str) -> Result<Option<AgentPendingMessage>> {
    let msg = conn
        .query_row(
            "SELECT msg_id, task_id, from_session, to_session, body, created_at
             FROM agent_pending_message
             WHERE msg_id = ?1",
            [msg_id],
            row_to_pending,
        )
        .optional()?;
    Ok(msg)
}

/// 取某 task 下所有 pending message（用于 graph 渲染时计算边的状态）。
#[allow(dead_code)]
pub fn list_pending_for_task(
    conn: &Connection,
    project: &str,
    task_id: &str,
) -> Result<Vec<AgentPendingMessage>> {
    let mut stmt = conn.prepare(
        "SELECT msg_id, task_id, from_session, to_session, body, created_at
         FROM agent_pending_message
         WHERE project = ?1 AND task_id = ?2
         ORDER BY created_at ASC",
    )?;
    let msgs = stmt
        .query_map(params![project, task_id], row_to_pending)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(msgs)
}

/// 以 session 为视角，返回该 session 所有出边及目标 session metadata。
#[allow(dead_code)]
pub fn outgoing_for_session(conn: &Connection, session_id: &str) -> Result<Vec<OutgoingContact>> {
    let mut stmt = conn.prepare(
        "SELECT e.edge_id, e.to_session, s.title, s.duty, e.purpose
         FROM agent_edge e
         JOIN session s ON s.session_id = e.to_session
         WHERE e.from_session = ?1
         ORDER BY e.created_at ASC",
    )?;
    let contacts = stmt
        .query_map([session_id], row_to_outgoing_contact)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(contacts)
}

/// 以 session 为视角，返回该 session 所有入边。
#[allow(dead_code)]
pub fn incoming_for_session(conn: &Connection, session_id: &str) -> Result<Vec<AgentEdge>> {
    let mut stmt = conn.prepare(
        "SELECT edge_id, project, task_id, from_session, to_session, purpose, created_at
         FROM agent_edge
         WHERE to_session = ?1
         ORDER BY created_at ASC",
    )?;
    let edges = stmt
        .query_map([session_id], row_to_edge)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(edges)
}

/// 别人欠我回复的消息（contacts.pending_replies 数据源）。
#[allow(dead_code)]
pub fn pending_replies_for(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<AgentPendingMessage>> {
    let mut stmt = conn.prepare(
        "SELECT msg_id, task_id, from_session, to_session, body, created_at
         FROM agent_pending_message
         WHERE to_session = ?1
         ORDER BY created_at DESC",
    )?;
    let msgs = stmt
        .query_map([session_id], row_to_pending)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(msgs)
}

/// 我发出但还没被回复的消息（contacts.awaiting_reply 数据源）。
#[allow(dead_code)]
pub fn awaiting_reply_for(conn: &Connection, session_id: &str) -> Result<Vec<AgentPendingMessage>> {
    let mut stmt = conn.prepare(
        "SELECT msg_id, task_id, from_session, to_session, body, created_at
         FROM agent_pending_message
         WHERE from_session = ?1
         ORDER BY created_at DESC",
    )?;
    let msgs = stmt
        .query_map([session_id], row_to_pending)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(msgs)
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
        "DELETE FROM agent_pending_message WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
    conn.execute(
        "DELETE FROM agent_edge WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
    conn.execute(
        "DELETE FROM session WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
    Ok(())
}

/// 启动时清理孤儿 session / edge / pending_message。
///
/// M7: 反向扫描 — 只 enumerate 已有 session 的 (project, task)，再针对每个去
/// 检查 task 是否还存在。100+ projects 时启动避免 O(N projects × N tasks)。
/// L3 安全性：load_tasks 出 IO 错误时跳过该 task（保留 sessions），不再因
/// 短暂权限错误而误删 — 通过 result.is_ok() 区分 "无 task" vs "读不到"。
pub fn gc_orphans(conn: &Connection) -> Result<GcStats> {
    let session_keys: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT DISTINCT project, task_id FROM session")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let tx = conn.unchecked_transaction()?;
    let mut sessions_deleted = 0;
    for (project, task_id) in session_keys {
        let active = crate::storage::tasks::load_tasks(&project);
        let archived = crate::storage::tasks::load_archived_tasks(&project);
        // 区分 "读不到" 与 "明确不存在"：任一 IO 错误都跳过 GC，
        // 避免短暂权限错 / 文件被锁导致误删该 project 全部 sessions。
        if active.is_err() || archived.is_err() {
            eprintln!("[gc_orphans] skip project={} (toml read failed)", project);
            continue;
        }
        let exists = active
            .as_ref()
            .ok()
            .map(|v| v.iter().any(|t| t.id == task_id))
            .unwrap_or(false)
            || archived
                .as_ref()
                .ok()
                .map(|v| v.iter().any(|t| t.id == task_id))
                .unwrap_or(false);
        if !exists {
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

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "project-a";

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::database::create_schema(&conn).unwrap();
        conn
    }

    fn add_edge(
        conn: &Connection,
        task_id: &str,
        from_session: &str,
        to_session: &str,
        purpose: Option<&str>,
    ) -> Result<i64> {
        super::add_edge(conn, PROJECT, task_id, from_session, to_session, purpose)
    }

    fn list_edges_for_task(conn: &Connection, task_id: &str) -> Result<Vec<AgentEdge>> {
        super::list_edges_for_task(conn, PROJECT, task_id)
    }

    fn list_pending_for_task(conn: &Connection, task_id: &str) -> Result<Vec<AgentPendingMessage>> {
        super::list_pending_for_task(conn, PROJECT, task_id)
    }

    fn insert_session(conn: &Connection, session_id: &str, task_id: &str) {
        insert_session_in_project(conn, PROJECT, session_id, task_id);
    }

    fn insert_session_in_project(
        conn: &Connection,
        project: &str,
        session_id: &str,
        task_id: &str,
    ) {
        conn.execute(
            "INSERT INTO session
             (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
             VALUES (?1, ?2, ?3, ?4, 'codex', NULL, NULL, ?5)",
            params![
                session_id,
                project,
                task_id,
                format!("Session {session_id}"),
                Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    fn insert_session_with_title_and_duty(
        conn: &Connection,
        session_id: &str,
        task_id: &str,
        title: &str,
        duty: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO session
             (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
             VALUES (?1, ?2, ?3, ?4, 'codex', NULL, ?5, ?6)",
            params![
                session_id,
                PROJECT,
                task_id,
                title,
                duty,
                Utc::now().to_rfc3339()
            ],
        )
        .unwrap();
    }

    fn err_token(result: Result<i64>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn add_edge_happy_path_allows_chain() {
        let conn = test_conn();
        for session in ["a", "b", "c"] {
            insert_session(&conn, session, "task-1");
        }

        let ab = add_edge(&conn, "task-1", "a", "b", Some("delegate")).unwrap();
        let bc = add_edge(&conn, "task-1", "b", "c", None).unwrap();

        let first = get_edge(&conn, ab).unwrap().unwrap();
        assert_eq!(first.from_session, "a");
        assert_eq!(first.to_session, "b");
        assert_eq!(first.purpose.as_deref(), Some("delegate"));
        assert!(bc > ab);
    }

    #[test]
    fn add_edge_rejects_duplicate_edge() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");

        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        let err = err_token(add_edge(&conn, "task-1", "a", "b", None));

        assert!(err.contains("duplicate_edge"));
    }

    #[test]
    fn add_edge_rejects_bidirectional_edge() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");

        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        let err = err_token(add_edge(&conn, "task-1", "b", "a", None));

        assert!(err.contains("bidirectional_edge"));
    }

    #[test]
    fn add_edge_rejects_long_cycle() {
        let conn = test_conn();
        for session in ["a", "b", "c", "d"] {
            insert_session(&conn, session, "task-1");
        }

        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        add_edge(&conn, "task-1", "b", "c", None).unwrap();
        add_edge(&conn, "task-1", "c", "d", None).unwrap();
        let err = err_token(add_edge(&conn, "task-1", "d", "a", None));

        assert!(err.contains("cycle_would_form"));
    }

    #[test]
    fn add_edge_rejects_cross_task_endpoints() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-2");

        let err = err_token(add_edge(&conn, "task-1", "a", "b", None));

        assert!(err.contains("same_task_required"));
    }

    #[test]
    fn add_edge_rejects_missing_endpoint() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");

        let err = err_token(add_edge(&conn, "task-1", "a", "missing", None));

        assert!(err.contains("endpoint_not_found"));
    }

    #[test]
    fn delete_edge_cascades_pending_message_on_same_edge() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        let edge_id = add_edge(&conn, "task-1", "a", "b", None).unwrap();
        conn.execute(
            "INSERT INTO agent_pending_message
             (msg_id, project, task_id, from_session, to_session, body, created_at)
             VALUES ('msg-1', ?1, 'task-1', 'a', 'b', 'hello', ?2)",
            params![PROJECT, Utc::now().to_rfc3339()],
        )
        .unwrap();

        delete_edge(&conn, edge_id).unwrap();

        let pending_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_pending_message", [], |row| {
                row.get(0)
            })
            .unwrap();
        let edge_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_edge", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending_count, 0);
        assert_eq!(edge_count, 0);
    }

    #[test]
    fn update_edge_purpose_round_trips_some_and_none() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        let edge_id = add_edge(&conn, "task-1", "a", "b", None).unwrap();

        update_edge_purpose(&conn, edge_id, Some("handoff")).unwrap();
        assert_eq!(
            get_edge(&conn, edge_id)
                .unwrap()
                .unwrap()
                .purpose
                .as_deref(),
            Some("handoff")
        );

        update_edge_purpose(&conn, edge_id, None).unwrap();
        assert_eq!(get_edge(&conn, edge_id).unwrap().unwrap().purpose, None);
    }

    #[test]
    fn list_edges_for_task_filters_by_task() {
        let conn = test_conn();
        for session in ["a", "b", "c"] {
            insert_session(&conn, session, "task-1");
        }
        insert_session(&conn, "x", "task-2");
        insert_session(&conn, "y", "task-2");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        add_edge(&conn, "task-1", "b", "c", None).unwrap();
        add_edge(&conn, "task-2", "x", "y", None).unwrap();

        let edges = list_edges_for_task(&conn, "task-1").unwrap();

        assert_eq!(edges.len(), 2);
        assert!(edges.iter().all(|edge| edge.task_id == "task-1"));
        assert_eq!(edges[0].from_session, "a");
        assert_eq!(edges[1].from_session, "b");
    }

    // --- WO-004: Pending Message tests ---

    fn err_token_unit(result: Result<()>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn pending_message_happy_path_after_edge() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();

        insert_pending_message(&conn, "msg-1", "task-1", "a", "b", "hello").unwrap();

        let msg = get_pending_message(&conn, "msg-1").unwrap().unwrap();
        assert_eq!(msg.msg_id, "msg-1");
        assert_eq!(msg.from_session, "a");
        assert_eq!(msg.to_session, "b");
        assert_eq!(msg.body, "hello");
        assert_eq!(msg.task_id, "task-1");
    }

    #[test]
    fn pending_message_rejects_no_edge() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");

        let err = err_token_unit(insert_pending_message(
            &conn, "msg-1", "task-1", "a", "b", "hello",
        ));

        assert!(err.contains("no_edge"));
    }

    #[test]
    fn pending_message_rejects_previous_pending_same_direction() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();

        insert_pending_message(&conn, "msg-1", "task-1", "a", "b", "hello").unwrap();
        let err = err_token_unit(insert_pending_message(
            &conn, "msg-2", "task-1", "a", "b", "world",
        ));

        assert!(err.contains("previous_message_pending"));
    }

    #[test]
    fn pending_message_allows_opposite_direction() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        // B→A edge inserted via raw SQL since add_edge rejects bidirectional,
        // but insert_pending_message only checks edge existence, not direction constraints.
        conn.execute(
            "INSERT INTO agent_edge (project, task_id, from_session, to_session, purpose, created_at)
             VALUES (?1, 'task-1', 'b', 'a', NULL, ?2)",
            params![PROJECT, Utc::now().to_rfc3339()],
        )
        .unwrap();

        insert_pending_message(&conn, "msg-ab", "task-1", "a", "b", "hello").unwrap();
        insert_pending_message(&conn, "msg-ba", "task-1", "b", "a", "reply").unwrap();

        let all = list_pending_for_task(&conn, "task-1").unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn pending_message_rejects_duplicate_msg_id() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        insert_session(&conn, "c", "task-1");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        add_edge(&conn, "task-1", "a", "c", None).unwrap();

        insert_pending_message(&conn, "msg-x", "task-1", "a", "b", "hello").unwrap();
        let err = err_token_unit(insert_pending_message(
            &conn, "msg-x", "task-1", "a", "c", "world",
        ));

        assert!(err.contains("duplicate_msg_id"));
    }

    #[test]
    fn delete_pending_message_frees_slot_for_reinsert() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();

        insert_pending_message(&conn, "msg-1", "task-1", "a", "b", "hello").unwrap();
        delete_pending_message(&conn, "msg-1").unwrap();
        insert_pending_message(&conn, "msg-2", "task-1", "a", "b", "world").unwrap();

        let msg = get_pending_message(&conn, "msg-2").unwrap().unwrap();
        assert_eq!(msg.body, "world");
        assert!(get_pending_message(&conn, "msg-1").unwrap().is_none());
    }

    #[test]
    fn delete_pending_message_not_found() {
        let conn = test_conn();

        let err = err_token_unit(delete_pending_message(&conn, "nonexistent"));

        assert!(err.contains("pending_message_not_found"));
    }

    #[test]
    fn get_pending_message_exists_and_missing() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session(&conn, "b", "task-1");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();

        assert!(get_pending_message(&conn, "msg-1").unwrap().is_none());

        insert_pending_message(&conn, "msg-1", "task-1", "a", "b", "hello").unwrap();
        assert!(get_pending_message(&conn, "msg-1").unwrap().is_some());
    }

    #[test]
    fn list_pending_for_task_isolates_across_tasks() {
        let conn = test_conn();
        insert_session(&conn, "a1", "task-1");
        insert_session(&conn, "b1", "task-1");
        insert_session(&conn, "a2", "task-2");
        insert_session(&conn, "b2", "task-2");
        add_edge(&conn, "task-1", "a1", "b1", None).unwrap();
        add_edge(&conn, "task-2", "a2", "b2", None).unwrap();

        insert_pending_message(&conn, "msg-t1", "task-1", "a1", "b1", "task1").unwrap();
        insert_pending_message(&conn, "msg-t2", "task-2", "a2", "b2", "task2").unwrap();

        let t1 = list_pending_for_task(&conn, "task-1").unwrap();
        let t2 = list_pending_for_task(&conn, "task-2").unwrap();

        assert_eq!(t1.len(), 1);
        assert_eq!(t1[0].msg_id, "msg-t1");
        assert_eq!(t2.len(), 1);
        assert_eq!(t2[0].msg_id, "msg-t2");
    }

    // --- WO-005: DAG query tests ---

    fn insert_pending_raw(
        conn: &Connection,
        msg_id: &str,
        task_id: &str,
        from_session: &str,
        to_session: &str,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO agent_pending_message
             (msg_id, project, task_id, from_session, to_session, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                msg_id,
                PROJECT,
                task_id,
                from_session,
                to_session,
                "body",
                created_at
            ],
        )
        .unwrap();
    }

    #[test]
    fn dag_queries_return_expected_edges_and_pending_messages() {
        let conn = test_conn();
        insert_session(&conn, "a", "task-1");
        insert_session_with_title_and_duty(&conn, "b", "task-1", "Builder B", Some("build"));
        insert_session(&conn, "c", "task-1");
        add_edge(&conn, "task-1", "a", "b", Some("handoff")).unwrap();
        add_edge(&conn, "task-1", "a", "c", None).unwrap();
        insert_pending_message(&conn, "msg-ab", "task-1", "a", "b", "hello").unwrap();

        let outgoing_a = outgoing_for_session(&conn, "a").unwrap();
        let outgoing_b = outgoing_for_session(&conn, "b").unwrap();
        let incoming_b = incoming_for_session(&conn, "b").unwrap();
        let incoming_a = incoming_for_session(&conn, "a").unwrap();
        let pending_b = pending_replies_for(&conn, "b").unwrap();
        let pending_a = pending_replies_for(&conn, "a").unwrap();
        let awaiting_a = awaiting_reply_for(&conn, "a").unwrap();
        let awaiting_b = awaiting_reply_for(&conn, "b").unwrap();

        assert_eq!(outgoing_a.len(), 2);
        assert_eq!(outgoing_a[0].to_session_id, "b");
        assert_eq!(outgoing_a[0].to_session_name, "Builder B");
        assert_eq!(outgoing_a[0].to_session_duty.as_deref(), Some("build"));
        assert_eq!(outgoing_a[0].purpose.as_deref(), Some("handoff"));
        assert_eq!(outgoing_a[1].to_session_id, "c");
        assert!(outgoing_b.is_empty());

        assert_eq!(incoming_b.len(), 1);
        assert_eq!(incoming_b[0].from_session, "a");
        assert_eq!(incoming_b[0].to_session, "b");
        assert!(incoming_a.is_empty());

        assert_eq!(pending_b.len(), 1);
        assert_eq!(pending_b[0].msg_id, "msg-ab");
        assert_eq!(pending_b[0].from_session, "a");
        assert!(pending_a.is_empty());

        assert_eq!(awaiting_a.len(), 1);
        assert_eq!(awaiting_a[0].msg_id, "msg-ab");
        assert!(awaiting_b.is_empty());
    }

    #[test]
    fn dag_pending_queries_order_by_created_at_desc() {
        let conn = test_conn();
        for session in ["a", "b", "c"] {
            insert_session(&conn, session, "task-1");
        }
        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        add_edge(&conn, "task-1", "a", "c", None).unwrap();
        insert_pending_raw(&conn, "old", "task-1", "a", "b", "2024-01-01T00:00:00Z");
        insert_pending_raw(&conn, "new", "task-1", "c", "b", "2024-01-02T00:00:00Z");
        insert_pending_raw(&conn, "middle", "task-1", "a", "c", "2024-01-01T12:00:00Z");

        let pending_for_b = pending_replies_for(&conn, "b").unwrap();
        let awaiting_for_a = awaiting_reply_for(&conn, "a").unwrap();

        assert_eq!(
            pending_for_b
                .iter()
                .map(|msg| msg.msg_id.as_str())
                .collect::<Vec<_>>(),
            vec!["new", "old"]
        );
        assert_eq!(
            awaiting_for_a
                .iter()
                .map(|msg| msg.msg_id.as_str())
                .collect::<Vec<_>>(),
            vec!["middle", "old"]
        );
    }

    #[test]
    fn dag_queries_isolate_sessions_across_tasks() {
        let conn = test_conn();
        for session in ["a", "b", "c"] {
            insert_session(&conn, session, "task-1");
        }
        insert_session(&conn, "d", "task-2");
        insert_session(&conn, "e", "task-2");
        add_edge(&conn, "task-1", "a", "b", None).unwrap();
        add_edge(&conn, "task-1", "a", "c", None).unwrap();
        add_edge(&conn, "task-2", "d", "e", Some("other-task")).unwrap();
        insert_pending_message(&conn, "msg-ab", "task-1", "a", "b", "hello").unwrap();
        insert_pending_message(&conn, "msg-de", "task-2", "d", "e", "other").unwrap();

        assert_eq!(outgoing_for_session(&conn, "a").unwrap().len(), 2);
        assert_eq!(outgoing_for_session(&conn, "d").unwrap().len(), 1);
        assert_eq!(incoming_for_session(&conn, "b").unwrap().len(), 1);
        assert_eq!(incoming_for_session(&conn, "e").unwrap().len(), 1);
        assert_eq!(pending_replies_for(&conn, "b").unwrap().len(), 1);
        assert_eq!(pending_replies_for(&conn, "e").unwrap().len(), 1);
        assert_eq!(awaiting_reply_for(&conn, "a").unwrap().len(), 1);
        assert_eq!(awaiting_reply_for(&conn, "d").unwrap().len(), 1);

        assert!(outgoing_for_session(&conn, "missing").unwrap().is_empty());
        assert!(incoming_for_session(&conn, "missing").unwrap().is_empty());
        assert!(pending_replies_for(&conn, "missing").unwrap().is_empty());
        assert!(awaiting_reply_for(&conn, "missing").unwrap().is_empty());
    }

    #[test]
    fn graph_rows_are_project_scoped_when_task_ids_match() {
        let conn = test_conn();
        insert_session_in_project(&conn, "project-a", "a1", "shared-task");
        insert_session_in_project(&conn, "project-a", "a2", "shared-task");
        insert_session_in_project(&conn, "project-b", "b1", "shared-task");
        insert_session_in_project(&conn, "project-b", "b2", "shared-task");

        super::add_edge(&conn, "project-a", "shared-task", "a1", "a2", None).unwrap();
        super::add_edge(&conn, "project-b", "shared-task", "b1", "b2", None).unwrap();
        insert_pending_message(&conn, "msg-a", "shared-task", "a1", "a2", "a").unwrap();
        insert_pending_message(&conn, "msg-b", "shared-task", "b1", "b2", "b").unwrap();

        assert_eq!(
            super::list_edges_for_task(&conn, "project-a", "shared-task")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            super::list_pending_for_task(&conn, "project-a", "shared-task")
                .unwrap()
                .len(),
            1
        );

        cascade_delete_for_task(&conn, "project-a", "shared-task").unwrap();

        assert_eq!(
            super::list_edges_for_task(&conn, "project-b", "shared-task")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            super::list_pending_for_task(&conn, "project-b", "shared-task")
                .unwrap()
                .len(),
            1
        );
        assert!(
            super::list_edges_for_task(&conn, "project-a", "shared-task")
                .unwrap()
                .is_empty()
        );
    }
}
