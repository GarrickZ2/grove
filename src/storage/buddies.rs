//! Buddy persistence. All operations accept the caller's connection so the
//! lifecycle can compose them into one transaction without re-locking the DB.
//! Deletion is deliberately archival; there is no hard-delete operation.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::{tasks::LOCAL_TASK_ID, workspace};
use crate::error::{GroveError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Buddy {
    pub id: String,
    pub project_hash: String,
    pub custom_agent_id: String,
    pub avatar: Option<String>,
    pub description: String,
    pub active_session_id: Option<String>,
    pub sort_position: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub session_id: String,
    pub buddy_id: String,
    pub seq: i64,
    /// Immutable base-Agent snapshot, not the mutable persona id.
    pub agent: String,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationStatus {
    Running,
    Waiting,
    Done,
    Failed,
    Cancelled,
}

impl DelegationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                format!("Unknown Buddy delegation status: {value}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delegation {
    pub id: String,
    pub buddy_id: String,
    pub from_session: String,
    pub target_project: String,
    pub target_task: String,
    pub target_session: String,
    pub title: String,
    pub brief: String,
    pub status: DelegationStatus,
    pub last_result: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// Non-Segment sessions retain their ordinary behavior. Only the current,
/// unended Segment can accept mutations or start an Agent.
pub(crate) fn ensure_session_writable_on(conn: &Connection, session_id: &str) -> Result<()> {
    let blocked: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM buddy_segments s JOIN buddies b ON b.id = s.buddy_id
         WHERE s.session_id = ?1 AND (s.ended_at IS NOT NULL OR b.active_session_id IS NOT s.session_id))",
        [session_id], |r| r.get(0))?;
    if blocked {
        return Err(GroveError::storage_tagged(
            "buddy_segment_read_only",
            "This Buddy Segment is read-only",
        ));
    }
    Ok(())
}

pub(crate) fn ensure_session_writable(session_id: &str) -> Result<()> {
    ensure_session_writable_on(&*super::database::try_connection()?, session_id)
}

const BUDDY_COLUMNS: &str = "id, project_hash, custom_agent_id, avatar, description, active_session_id, sort_position, created_at, updated_at";
const SEGMENT_COLUMNS: &str = "session_id, buddy_id, seq, agent, started_at, ended_at";
const DELEGATION_COLUMNS: &str = "id, buddy_id, from_session, target_project, target_task, target_session, title, brief, status, last_result, created_at, updated_at, completed_at";

fn buddy_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Buddy> {
    Ok(Buddy {
        id: row.get(0)?,
        project_hash: row.get(1)?,
        custom_agent_id: row.get(2)?,
        avatar: row.get(3)?,
        description: row.get(4)?,
        active_session_id: row.get(5)?,
        sort_position: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn segment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Segment> {
    Ok(Segment {
        session_id: row.get(0)?,
        buddy_id: row.get(1)?,
        seq: row.get(2)?,
        agent: row.get(3)?,
        started_at: row.get(4)?,
        ended_at: row.get(5)?,
    })
}

fn delegation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Delegation> {
    Ok(Delegation {
        id: row.get(0)?,
        buddy_id: row.get(1)?,
        from_session: row.get(2)?,
        target_project: row.get(3)?,
        target_task: row.get(4)?,
        target_session: row.get(5)?,
        title: row.get(6)?,
        brief: row.get(7)?,
        status: DelegationStatus::parse(&row.get::<_, String>(8)?)?,
        last_result: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        completed_at: row.get(12)?,
    })
}

pub fn project_directory(id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(GroveError::invalid_data("Invalid Buddy id"));
    }
    Ok(super::grove_dir().join("buddies").join(id))
}

/// Insert only the Project row. The caller owns directory preparation and the
/// transaction that also creates the Buddy, Local Task, persona and Memory.
pub fn insert_project(conn: &Connection, id: &str, name: &str) -> Result<String> {
    if name.trim().is_empty() {
        return Err(GroveError::invalid_data("Buddy name is required"));
    }
    let path = project_directory(id)?.to_string_lossy().into_owned();
    let hash = workspace::project_hash(&path);
    conn.execute(
        "INSERT INTO projects (hash,name,path,is_git_repo,added_at,project_type)
         VALUES (?1,?2,?3,0,?4,'buddy')",
        params![hash, name, path, Utc::now().to_rfc3339()],
    )?;
    Ok(hash)
}

pub fn insert(conn: &Connection, buddy: &Buddy) -> Result<()> {
    // An active pointer is installed only after the Segment exists.
    if buddy.active_session_id.is_some() {
        return Err(GroveError::invalid_data(
            "Create the Buddy before assigning its active Segment",
        ));
    }
    let path = project_directory(&buddy.id)?.to_string_lossy().into_owned();
    let valid: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects p, custom_agent a
         WHERE p.hash=?1 AND p.project_type='buddy' AND p.path=?2
         AND p.is_git_repo=0 AND a.id=?3)",
        params![buddy.project_hash, path, buddy.custom_agent_id],
        |row| row.get(0),
    )?;
    if !valid || workspace::project_hash(&path) != buddy.project_hash {
        return Err(GroveError::invalid_data(
            "Buddy Project or Custom Agent does not match",
        ));
    }
    conn.execute(
        &format!("INSERT INTO buddies ({BUDDY_COLUMNS}) VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,?8)"),
        params![
            buddy.id,
            buddy.project_hash,
            buddy.custom_agent_id,
            buddy.avatar,
            buddy.description,
            buddy.sort_position,
            buddy.created_at,
            buddy.updated_at
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Buddy>> {
    Ok(conn
        .query_row(
            &format!("SELECT {BUDDY_COLUMNS} FROM buddies WHERE id=?1"),
            [id],
            buddy_row,
        )
        .optional()?)
}

pub fn get_by_project(conn: &Connection, project: &str) -> Result<Option<Buddy>> {
    Ok(conn
        .query_row(
            &format!("SELECT {BUDDY_COLUMNS} FROM buddies WHERE project_hash=?1"),
            [project],
            buddy_row,
        )
        .optional()?)
}

pub fn list(conn: &Connection, archived: bool) -> Result<Vec<Buddy>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BUDDY_COLUMNS} FROM buddies WHERE project_hash IN
         (SELECT hash FROM projects WHERE project_type='buddy' AND archived=?1)
         ORDER BY sort_position IS NULL, sort_position, created_at, id"
    ))?;
    let rows = stmt
        .query_map([archived], buddy_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn update_profile(
    conn: &Connection,
    id: &str,
    avatar: Option<&str>,
    description: &str,
) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE buddies SET avatar=?2,description=?3,updated_at=?4 WHERE id=?1",
        params![id, avatar, description, Utc::now().to_rfc3339()],
    )? > 0)
}

/// Metadata-only archival: no deletion, shutdown, disconnect or Automation change.
pub fn archive(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE projects SET archived=1 WHERE project_type='buddy'
         AND hash=(SELECT project_hash FROM buddies WHERE id=?1)",
        [id],
    )? > 0)
}

/// Reorder supplied IDs atomically; omitted Buddies keep their current positions.
pub fn reorder(conn: &Connection, ids: &[String]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    if ids.iter().any(|id| !seen.insert(id)) {
        return Err(GroveError::invalid_data("Duplicate Buddy id in order"));
    }
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().to_rfc3339();
    for (position, id) in ids.iter().enumerate() {
        if tx.execute(
            "UPDATE buddies SET sort_position=?2,updated_at=?3 WHERE id=?1",
            params![id, position as i64, now],
        )? == 0
        {
            return Err(GroveError::not_found("Buddy not found"));
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn insert_segment(conn: &Connection, segment: &Segment) -> Result<()> {
    if segment.seq < 1 || segment.agent.trim().is_empty() || segment.ended_at.is_some() {
        return Err(GroveError::invalid_data(
            "New Segment must have a positive sequence, Agent and no end time",
        ));
    }
    let valid: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session s JOIN buddies b ON b.project_hash=s.project
         WHERE b.id=?1 AND s.session_id=?2 AND s.task_id=?3 AND s.archived_at IS NULL)",
        params![segment.buddy_id, segment.session_id, LOCAL_TASK_ID],
        |row| row.get(0),
    )?;
    if !valid {
        return Err(GroveError::invalid_data(
            "Segment must belong to the Buddy Local Task",
        ));
    }
    conn.execute(
        &format!("INSERT INTO buddy_segments ({SEGMENT_COLUMNS}) VALUES (?1,?2,?3,?4,?5,NULL)"),
        params![
            segment.session_id,
            segment.buddy_id,
            segment.seq,
            segment.agent,
            segment.started_at
        ],
    )?;
    Ok(())
}

pub fn get_segment(conn: &Connection, session_id: &str) -> Result<Option<Segment>> {
    Ok(conn
        .query_row(
            &format!("SELECT {SEGMENT_COLUMNS} FROM buddy_segments WHERE session_id=?1"),
            [session_id],
            segment_row,
        )
        .optional()?)
}

pub fn list_segments(conn: &Connection, buddy_id: &str) -> Result<Vec<Segment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SEGMENT_COLUMNS} FROM buddy_segments WHERE buddy_id=?1 ORDER BY seq"
    ))?;
    let rows = stmt
        .query_map([buddy_id], segment_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// End once; never rewrite the Agent snapshot or any Session/history fields.
pub fn end_segment(
    conn: &Connection,
    buddy_id: &str,
    session_id: &str,
    ended_at: &str,
) -> Result<bool> {
    Ok(conn.execute("UPDATE buddy_segments SET ended_at=?3 WHERE buddy_id=?1 AND session_id=?2 AND ended_at IS NULL",
        params![buddy_id,session_id,ended_at])? > 0)
}

/// Compare-and-set the active pointer inside the caller's lifecycle transaction.
pub fn set_active_segment(
    conn: &Connection,
    buddy_id: &str,
    expected: Option<&str>,
    session_id: &str,
) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE buddies SET active_session_id=?3,updated_at=?4 WHERE id=?1 AND active_session_id IS ?2
         AND EXISTS(SELECT 1 FROM buddy_segments s WHERE s.buddy_id=?1 AND s.session_id=?3 AND s.ended_at IS NULL)",
        params![buddy_id,expected,session_id,Utc::now().to_rfc3339()],
    )? > 0)
}

pub fn insert_delegation(conn: &Connection, delegation: &Delegation) -> Result<()> {
    let valid: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM buddy_segments WHERE buddy_id=?1 AND session_id=?2)
         AND EXISTS(SELECT 1 FROM session WHERE session_id=?3 AND project=?4 AND task_id=?5 AND archived_at IS NULL)",
        params![delegation.buddy_id,delegation.from_session,delegation.target_session,
            delegation.target_project,delegation.target_task], |row| row.get(0),
    )?;
    if !valid || delegation.status != DelegationStatus::Running || delegation.completed_at.is_some()
    {
        return Err(GroveError::invalid_data(
            "New delegation requires matching sessions and running status",
        ));
    }
    conn.execute(&format!("INSERT INTO buddy_delegations ({DELEGATION_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL)"),
        params![delegation.id,delegation.buddy_id,delegation.from_session,delegation.target_project,
            delegation.target_task,delegation.target_session,delegation.title,delegation.brief,
            delegation.status.as_str(),delegation.last_result,delegation.created_at,delegation.updated_at])?;
    Ok(())
}

pub fn get_delegation(conn: &Connection, buddy_id: &str, id: &str) -> Result<Option<Delegation>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {DELEGATION_COLUMNS} FROM buddy_delegations WHERE buddy_id=?1 AND id=?2"
            ),
            params![buddy_id, id],
            delegation_row,
        )
        .optional()?)
}

pub fn list_delegations(conn: &Connection, buddy_id: &str) -> Result<Vec<Delegation>> {
    let mut stmt = conn.prepare(&format!("SELECT {DELEGATION_COLUMNS} FROM buddy_delegations WHERE buddy_id=?1 ORDER BY updated_at DESC,id"))?;
    let rows = stmt
        .query_map([buddy_id], delegation_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Conditional persistence only; turn ordering/recovery belong to the watcher.
pub fn update_delegation_status(
    conn: &Connection,
    buddy_id: &str,
    id: &str,
    expected: DelegationStatus,
    status: DelegationStatus,
    last_result: Option<&str>,
) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let completed = match status {
        DelegationStatus::Running | DelegationStatus::Waiting => None,
        _ => Some(now.as_str()),
    };
    let result = last_result.map(|text| {
        let mut result = super::automations::truncate_agent_response(text);
        // The shared helper appends a marker beyond its 16KiB body budget.
        // Buddy's stored result has a hard total byte limit, including markers.
        let mut end = result.len().min(16 * 1024);
        while !result.is_char_boundary(end) {
            end -= 1;
        }
        result.truncate(end);
        result
    });
    Ok(conn.execute(
        "UPDATE buddy_delegations SET status=?4,last_result=COALESCE(?5,last_result),updated_at=?6,completed_at=?7
         WHERE buddy_id=?1 AND id=?2 AND status=?3",
        params![buddy_id,id,expected.as_str(),status.as_str(),result,now,completed],
    )? > 0)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Caller holds database::test_lock(). Uses a thread-local storage root,
    /// never process-wide HOME or the user's real database.
    pub struct Store {
        _directory: tempfile::TempDir,
    }

    impl Store {
        pub fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            super::super::set_grove_dir_override(Some(directory.path().to_path_buf()));
            Self {
                _directory: directory,
            }
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            super::super::set_grove_dir_override(None);
        }
    }

    pub fn seed_session(conn: &Connection, project: &str, task: &str, id: &str) {
        conn.execute(
            "INSERT INTO session (session_id,project,task_id,title,agent,acp_session_id,created_at)
            VALUES (?1,?2,?3,'Test','claude-acp','original-acp-id','2026-10-30T00:00:00Z')",
            params![id, project, task],
        )
        .unwrap();
    }

    pub fn seed_buddy(conn: &Connection, id: &str) -> Buddy {
        let project = insert_project(conn, id, id).unwrap();
        let path = project_directory(id).unwrap();
        std::fs::create_dir_all(&path).unwrap();
        let agent = format!("ca-{id}");
        let now = "2026-10-30T00:00:00Z";
        conn.execute(
            "INSERT INTO custom_agent (id,name,base_agent,created_at,updated_at)
            VALUES (?1,?1,'claude-acp',?2,?2)",
            params![agent, now],
        )
        .unwrap();
        conn.execute("INSERT INTO tasks (project,id,name,branch,target,worktree_path,created_at,updated_at,is_local)
            VALUES (?1,?2,'Local','','',?3,?4,?4,1)",
            params![project,LOCAL_TASK_ID,path.to_string_lossy(),now]).unwrap();
        let buddy = Buddy {
            id: id.into(),
            project_hash: project,
            custom_agent_id: agent,
            avatar: None,
            description: String::new(),
            active_session_id: None,
            sort_position: None,
            created_at: now.into(),
            updated_at: now.into(),
        };
        insert(conn, &buddy).unwrap();
        let session_id = format!("{id}-segment-1");
        seed_session(conn, &buddy.project_hash, LOCAL_TASK_ID, &session_id);
        insert_segment(
            conn,
            &Segment {
                session_id: session_id.clone(),
                buddy_id: buddy.id.clone(),
                seq: 1,
                agent: "claude-acp".into(),
                started_at: now.into(),
                ended_at: None,
            },
        )
        .unwrap();
        assert!(set_active_segment(conn, id, None, &session_id).unwrap());
        get(conn, id).unwrap().unwrap()
    }

    pub fn delegation(conn: &Connection, buddy: &Buddy, id: &str) -> Delegation {
        let target = format!("{id}-target");
        seed_session(conn, "other-project", "task", &target);
        Delegation {
            id: id.into(),
            buddy_id: buddy.id.clone(),
            from_session: buddy.active_session_id.clone().unwrap(),
            target_project: "other-project".into(),
            target_task: "task".into(),
            target_session: target,
            title: "Research".into(),
            brief: "Read code".into(),
            status: DelegationStatus::Running,
            last_result: None,
            created_at: "2026-10-30T00:00:00Z".into(),
            updated_at: "2026-10-30T00:00:00Z".into(),
            completed_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::storage::database;

    #[test]
    fn buddy_crud_order_and_atomic_reorder() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::try_connection().unwrap();
        let a = seed_buddy(&conn, "a");
        seed_buddy(&conn, "b");
        assert_eq!(get_by_project(&conn, &a.project_hash).unwrap(), Some(a));
        assert!(get(&conn, "missing").unwrap().is_none());
        assert!(update_profile(&conn, "a", Some("avatar"), "Description").unwrap());
        let edited = get(&conn, "a").unwrap().unwrap();
        assert_eq!(edited.avatar.as_deref(), Some("avatar"));
        assert_eq!(edited.description, "Description");
        assert!(!update_profile(&conn, "missing", None, "").unwrap());
        reorder(&conn, &["b".into(), "a".into()]).unwrap();
        assert_eq!(
            list(&conn, false)
                .unwrap()
                .iter()
                .map(|b| b.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert!(reorder(&conn, &["a".into(), "missing".into()]).is_err());
        assert_eq!(get(&conn, "a").unwrap().unwrap().sort_position, Some(1));
        assert!(reorder(&conn, &["a".into(), "a".into()]).is_err());
        assert!(update_profile(&conn, "a", None, "").unwrap());
        assert!(get(&conn, "a").unwrap().unwrap().avatar.is_none());
    }

    #[test]
    fn segments_validate_scope_and_preserve_closed_records() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::try_connection().unwrap();
        let a = seed_buddy(&conn, "a");
        let b = seed_buddy(&conn, "b");
        let old = a.active_session_id.as_deref().unwrap();
        let mut next = get_segment(&conn, old).unwrap().unwrap();
        next.session_id = "second".into();
        next.seq = 2;
        seed_session(&conn, &a.project_hash, "not-local", "wrong-task");
        next.session_id = "wrong-task".into();
        assert!(insert_segment(&conn, &next).is_err());
        next.session_id = b.active_session_id.clone().unwrap();
        assert!(insert_segment(&conn, &next).is_err());
        next.session_id = "second".into();
        seed_session(&conn, &a.project_hash, LOCAL_TASK_ID, "second");
        next.seq = 1;
        assert!(insert_segment(&conn, &next).is_err());
        next.seq = 0;
        assert!(insert_segment(&conn, &next).is_err());
        next.seq = 2;
        next.agent = "codex-acp".into();
        insert_segment(&conn, &next).unwrap();
        assert!(!set_active_segment(&conn, "a", None, "second").unwrap());
        assert!(!set_active_segment(&conn, "b", b.active_session_id.as_deref(), "second").unwrap());
        assert!(end_segment(&conn, "a", old, "2026-10-30T01:00:00Z").unwrap());
        assert!(!end_segment(&conn, "a", old, "2026-10-31T01:00:00Z").unwrap());
        assert!(set_active_segment(&conn, "a", Some(old), "second").unwrap());
        assert!(!set_active_segment(&conn, "a", Some("second"), old).unwrap());
        let segments = list_segments(&conn, "a").unwrap();
        assert_eq!(
            segments.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(segments[0].agent, "claude-acp");
        assert_eq!(
            segments[0].ended_at.as_deref(),
            Some("2026-10-30T01:00:00Z")
        );
        let acp_id: String = conn
            .query_row(
                "SELECT acp_session_id FROM session WHERE session_id=?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(acp_id, "original-acp-id");
    }

    #[test]
    fn delegation_scope_status_compare_and_set_and_utf8_result() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::try_connection().unwrap();
        let buddy = seed_buddy(&conn, "a");
        let mut d = delegation(&conn, &buddy, "d");
        d.target_task = "incorrect".into();
        assert!(insert_delegation(&conn, &d).is_err());
        d.target_task = "task".into();
        insert_delegation(&conn, &d).unwrap();
        assert!(get_delegation(&conn, "another-buddy", "d")
            .unwrap()
            .is_none());
        assert!(!update_delegation_status(
            &conn,
            "another-buddy",
            "d",
            DelegationStatus::Running,
            DelegationStatus::Done,
            None
        )
        .unwrap());
        assert!(update_delegation_status(
            &conn,
            "a",
            "d",
            DelegationStatus::Running,
            DelegationStatus::Waiting,
            None
        )
        .unwrap());
        assert!(!update_delegation_status(
            &conn,
            "a",
            "d",
            DelegationStatus::Running,
            DelegationStatus::Done,
            None
        )
        .unwrap());
        let text = "界".repeat(10_000);
        assert!(update_delegation_status(
            &conn,
            "a",
            "d",
            DelegationStatus::Waiting,
            DelegationStatus::Done,
            Some(&text)
        )
        .unwrap());
        let done = get_delegation(&conn, "a", "d").unwrap().unwrap();
        assert!(done.completed_at.is_some());
        assert!(done.last_result.as_ref().unwrap().len() <= 16 * 1024);
        assert!(update_delegation_status(
            &conn,
            "a",
            "d",
            DelegationStatus::Done,
            DelegationStatus::Running,
            None
        )
        .unwrap());
        let resumed = list_delegations(&conn, "a").unwrap().pop().unwrap();
        assert!(resumed.completed_at.is_none());
        assert_eq!(resumed.last_result, done.last_result);
        assert!(update_delegation_status(
            &conn,
            "a",
            "d",
            DelegationStatus::Running,
            DelegationStatus::Cancelled,
            None
        )
        .unwrap());
        assert!(!update_delegation_status(
            &conn,
            "a",
            "d",
            DelegationStatus::Running,
            DelegationStatus::Done,
            None
        )
        .unwrap());
        assert_eq!(
            get_delegation(&conn, "a", "d").unwrap().unwrap().status,
            DelegationStatus::Cancelled
        );
    }

    #[test]
    fn archive_preserves_history_sessions_and_other_resources() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::try_connection().unwrap();
        let buddy = seed_buddy(&conn, "a");
        let d = delegation(&conn, &buddy, "d");
        insert_delegation(&conn, &d).unwrap();
        conn.execute("INSERT INTO automations (id,project,name,task_mode,session_mode,prompt,schedule_cron,created_at,updated_at)
            VALUES ('routine',?1,'Routine','existing','existing','hello','0 * * * *',1,1)", [&buddy.project_hash]).unwrap();
        conn.execute("INSERT INTO connects (id,name,platform,app_id,app_secret,project_id,task_id,session_id,buddy_id,created_at,updated_at)
            VALUES ('connect','IM','feishu','','',?1,?2,?3,?4,1,1)",
            params![buddy.project_hash,LOCAL_TASK_ID,buddy.active_session_id,buddy.id]).unwrap();
        let history = super::super::chat_history::history_file_path(
            &buddy.project_hash,
            LOCAL_TASK_ID,
            buddy.active_session_id.as_deref().unwrap(),
        );
        std::fs::create_dir_all(history.parent().unwrap()).unwrap();
        let bytes = b"{\"type\":\"message_chunk\",\"text\":\"keep me\"}\n";
        std::fs::write(&history, bytes).unwrap();
        assert!(archive(&conn, "a").unwrap());
        assert!(archive(&conn, "a").unwrap());
        assert!(!archive(&conn, "missing").unwrap());
        assert!(list(&conn, false).unwrap().is_empty());
        assert_eq!(list(&conn, true).unwrap(), vec![buddy]);
        assert_eq!(std::fs::read(&history).unwrap(), bytes);
        for table in [
            "buddies",
            "buddy_segments",
            "buddy_delegations",
            "tasks",
            "custom_agent",
            "automations",
            "connects",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1, "{table} must be preserved");
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM session", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(conn
            .query_row("SELECT enabled FROM automations", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert!(conn
            .query_row("SELECT enabled FROM connects", [], |r| r.get::<_, bool>(0))
            .unwrap());
    }

    #[test]
    fn transaction_rollback_and_project_identity_validation() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::try_connection().unwrap();
        {
            let tx = conn.unchecked_transaction().unwrap();
            seed_buddy(&tx, "rollback");
            // No commit: every database write in the fixture must roll back.
        }
        for table in [
            "projects",
            "buddies",
            "custom_agent",
            "tasks",
            "session",
            "buddy_segments",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        let buddy = seed_buddy(&conn, "valid");
        let mut invalid = buddy.clone();
        invalid.active_session_id = None;
        invalid.id = "other".into();
        assert!(insert(&conn, &invalid).is_err());
        invalid.id = "valid".into();
        invalid.custom_agent_id = "missing".into();
        assert!(insert(&conn, &invalid).is_err());
        assert!(insert(&conn, &buddy).is_err());
        for id in ["", "..", "../escape", "/absolute", "a/b", "a\\b"] {
            assert!(project_directory(id).is_err(), "{id}");
        }
    }

    #[test]
    fn schema_enforces_foreign_keys_and_unique_buddy_project() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::try_connection().unwrap();
        let a = seed_buddy(&conn, "a");
        assert!(conn
            .execute(
                "INSERT INTO buddy_segments VALUES ('missing','a',2,'agent','now',NULL)",
                []
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO buddy_segments VALUES ('a-segment-1','missing',2,'agent','now',NULL)",
                []
            )
            .is_err());
        assert!(conn.execute("INSERT INTO buddies SELECT 'duplicate',project_hash,custom_agent_id,avatar,description,NULL,NULL,created_at,updated_at FROM buddies WHERE id='a'", []).is_err());
        let d = delegation(&conn, &a, "d");
        insert_delegation(&conn, &d).unwrap();
        assert!(conn
            .execute(
                "UPDATE buddy_delegations SET buddy_id='missing' WHERE id='d'",
                []
            )
            .is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }
}
