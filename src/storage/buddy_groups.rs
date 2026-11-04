//! Buddy group persistence: the group, its members and the shared message log.
//! The log is the only record of a conversation; each member's Session is just
//! what that Buddy has been told. Functions take the caller's connection so the
//! lifecycle can compose them into one transaction.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub sort_position: Option<i64>,
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub group_id: String,
    pub buddy_id: String,
    pub task_id: String,
    pub session_id: String,
    /// The base Agent `session_id` runs on; a Buddy that switched gets a new one.
    pub agent: String,
    pub seen_seq: i64,
    pub pending_wake: Option<String>,
    pub left_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub mime_type: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub group_id: String,
    pub seq: i64,
    /// user | buddy | system | quiet | failed
    pub sender_kind: String,
    pub sender_id: Option<String>,
    pub text: String,
    pub mentions: Vec<String>,
    pub attachments: Vec<Attachment>,
    pub created_at: String,
}

const GROUP_COLUMNS: &str =
    "id, name, sort_position, pinned_at, archived_at, created_at, updated_at";
const MEMBER_COLUMNS: &str =
    "group_id, buddy_id, task_id, session_id, agent, seen_seq, pending_wake, left_at";
const MESSAGE_COLUMNS: &str =
    "group_id, seq, sender_kind, sender_id, text, mentions, attachments, created_at";

fn group_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Group> {
    Ok(Group {
        id: row.get(0)?,
        name: row.get(1)?,
        sort_position: row.get(2)?,
        pinned_at: row.get(3)?,
        archived_at: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn member_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Member> {
    Ok(Member {
        group_id: row.get(0)?,
        buddy_id: row.get(1)?,
        task_id: row.get(2)?,
        session_id: row.get(3)?,
        agent: row.get(4)?,
        seen_seq: row.get(5)?,
        pending_wake: row.get(6)?,
        left_at: row.get(7)?,
    })
}

fn message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let mentions: String = row.get(5)?;
    let attachments: String = row.get(6)?;
    Ok(Message {
        group_id: row.get(0)?,
        seq: row.get(1)?,
        sender_kind: row.get(2)?,
        sender_id: row.get(3)?,
        text: row.get(4)?,
        mentions: serde_json::from_str(&mentions).unwrap_or_default(),
        attachments: serde_json::from_str(&attachments).unwrap_or_default(),
        created_at: row.get(7)?,
    })
}

pub fn insert_group(conn: &Connection, group: &Group) -> Result<()> {
    conn.execute(
        &format!("INSERT INTO buddy_groups ({GROUP_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7)"),
        params![
            group.id,
            group.name,
            group.sort_position,
            group.pinned_at,
            group.archived_at,
            group.created_at,
            group.updated_at
        ],
    )?;
    Ok(())
}

pub fn get_group(conn: &Connection, id: &str) -> Result<Option<Group>> {
    Ok(conn
        .query_row(
            &format!("SELECT {GROUP_COLUMNS} FROM buddy_groups WHERE id=?1"),
            [id],
            group_row,
        )
        .optional()?)
}

pub fn list_groups(conn: &Connection) -> Result<Vec<Group>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {GROUP_COLUMNS} FROM buddy_groups WHERE archived_at IS NULL
         ORDER BY sort_position IS NULL, sort_position, created_at, id"
    ))?;
    let rows = stmt
        .query_map([], group_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn rename_group(conn: &Connection, id: &str, name: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE buddy_groups SET name=?2,updated_at=?3 WHERE id=?1 AND archived_at IS NULL",
        params![id, name, Utc::now().to_rfc3339()],
    )? > 0)
}

pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    Ok(conn.execute(
        "UPDATE buddy_groups SET pinned_at=CASE WHEN ?2 THEN COALESCE(pinned_at, ?3) ELSE NULL END,
         updated_at=?3 WHERE id=?1",
        params![id, pinned, now],
    )? > 0)
}

pub fn archive_group(conn: &Connection, id: &str) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    Ok(conn.execute(
        "UPDATE buddy_groups SET archived_at=?2,updated_at=?2 WHERE id=?1 AND archived_at IS NULL",
        params![id, now],
    )? > 0)
}

pub fn insert_member(conn: &Connection, member: &Member) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO buddy_group_members ({MEMBER_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
        ),
        params![
            member.group_id,
            member.buddy_id,
            member.task_id,
            member.session_id,
            member.agent,
            member.seen_seq,
            member.pending_wake,
            member.left_at
        ],
    )?;
    Ok(())
}

pub fn get_member(conn: &Connection, group: &str, buddy: &str) -> Result<Option<Member>> {
    Ok(conn
        .query_row(
            &format!("SELECT {MEMBER_COLUMNS} FROM buddy_group_members WHERE group_id=?1 AND buddy_id=?2"),
            [group, buddy],
            member_row,
        )
        .optional()?)
}

/// The current member a Session belongs to, if any.
pub fn member_by_session(conn: &Connection, session: &str) -> Result<Option<Member>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {MEMBER_COLUMNS} FROM buddy_group_members
                 WHERE session_id=?1 AND left_at IS NULL"
            ),
            [session],
            member_row,
        )
        .optional()?)
}

/// A Buddy's current place in the group a Task belongs to.
pub fn member_by_task(conn: &Connection, buddy: &str, task: &str) -> Result<Option<Member>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {MEMBER_COLUMNS} FROM buddy_group_members
                 WHERE buddy_id=?1 AND task_id=?2 AND left_at IS NULL"
            ),
            [buddy, task],
            member_row,
        )
        .optional()?)
}

pub fn list_members(conn: &Connection, group: &str) -> Result<Vec<Member>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMBER_COLUMNS} FROM buddy_group_members
         WHERE group_id=?1 AND left_at IS NULL ORDER BY rowid"
    ))?;
    let rows = stmt
        .query_map([group], member_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Groups a Buddy is in now.
pub fn groups_of(conn: &Connection, buddy: &str) -> Result<Vec<Group>> {
    let columns = GROUP_COLUMNS
        .split(", ")
        .map(|column| format!("g.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT {columns} FROM buddy_groups g JOIN buddy_group_members m ON m.group_id = g.id
         WHERE m.buddy_id=?1 AND m.left_at IS NULL AND g.archived_at IS NULL
         ORDER BY g.created_at, g.id"
    ))?;
    let rows = stmt
        .query_map([buddy], group_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn set_member_session(
    conn: &Connection,
    group: &str,
    buddy: &str,
    session: &str,
    agent: &str,
    seen_seq: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE buddy_group_members SET session_id=?3,agent=?4,seen_seq=?5,left_at=NULL
         WHERE group_id=?1 AND buddy_id=?2",
        params![group, buddy, session, agent, seen_seq],
    )?;
    Ok(())
}

pub fn set_seen(conn: &Connection, group: &str, buddy: &str, seq: i64) -> Result<()> {
    conn.execute(
        "UPDATE buddy_group_members SET seen_seq=MAX(seen_seq,?3) WHERE group_id=?1 AND buddy_id=?2",
        params![group, buddy, seq],
    )?;
    Ok(())
}

/// Remember a wake for when the member's turn ends. A must-answer wake is not
/// downgraded by a later open one.
pub fn set_pending(conn: &Connection, group: &str, buddy: &str, mode: &str) -> Result<()> {
    conn.execute(
        "UPDATE buddy_group_members SET pending_wake=CASE WHEN pending_wake='must' THEN 'must' ELSE ?3 END
         WHERE group_id=?1 AND buddy_id=?2",
        params![group, buddy, mode],
    )?;
    Ok(())
}

pub fn take_pending(conn: &Connection, group: &str, buddy: &str) -> Result<Option<String>> {
    let pending = conn
        .query_row(
            "SELECT pending_wake FROM buddy_group_members WHERE group_id=?1 AND buddy_id=?2",
            [group, buddy],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if pending.is_some() {
        clear_pending(conn, group, Some(buddy))?;
    }
    Ok(pending)
}

pub fn clear_pending(conn: &Connection, group: &str, buddy: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE buddy_group_members SET pending_wake=NULL WHERE group_id=?1 AND (?2 IS NULL OR buddy_id=?2)",
        params![group, buddy],
    )?;
    Ok(())
}

/// Groups that were waiting to wake someone, cleared. Grove restarted.
pub fn clear_all_pending(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT group_id FROM buddy_group_members WHERE pending_wake IS NOT NULL",
    )?;
    let groups = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    conn.execute("UPDATE buddy_group_members SET pending_wake=NULL", [])?;
    Ok(groups)
}

pub fn mark_left(conn: &Connection, group: &str, buddy: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE buddy_group_members SET left_at=?3,pending_wake=NULL
         WHERE group_id=?1 AND buddy_id=?2 AND left_at IS NULL",
        params![group, buddy, Utc::now().to_rfc3339()],
    )? > 0)
}

/// Append to the log; the sequence is assigned inside the insert so concurrent
/// writers can't collide.
pub fn append_message(
    conn: &Connection,
    group: &str,
    sender_kind: &str,
    sender_id: Option<&str>,
    text: &str,
    mentions: &[String],
    attachments: &[Attachment],
) -> Result<Message> {
    let mentions = serde_json::to_string(mentions)?;
    let attachments = serde_json::to_string(attachments)?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO buddy_group_messages (group_id,seq,sender_kind,sender_id,text,mentions,attachments,created_at)
         SELECT ?1, COALESCE(MAX(seq),0)+1, ?2,?3,?4,?5,?6,?7 FROM buddy_group_messages WHERE group_id=?1",
        params![group, sender_kind, sender_id, text, mentions, attachments, now],
    )?;
    conn.execute(
        "UPDATE buddy_groups SET updated_at=?2 WHERE id=?1",
        params![group, now],
    )?;
    Ok(conn.query_row(
        &format!(
            "SELECT {MESSAGE_COLUMNS} FROM buddy_group_messages
             WHERE group_id=?1 ORDER BY seq DESC LIMIT 1"
        ),
        [group],
        message_row,
    )?)
}

pub fn latest_seq(conn: &Connection, group: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM buddy_group_messages WHERE group_id=?1",
        [group],
        |row| row.get(0),
    )?)
}

/// A page of the log, oldest first, ending before `before`.
pub fn messages_before(
    conn: &Connection,
    group: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM buddy_group_messages
         WHERE group_id=?1 AND (?2 IS NULL OR seq<?2) ORDER BY seq DESC LIMIT ?3"
    ))?;
    let mut rows: Vec<Message> = stmt
        .query_map(params![group, before, limit], message_row)?
        .collect::<rusqlite::Result<_>>()?;
    rows.reverse();
    Ok(rows)
}

/// Everything after `seq`, oldest first.
pub fn messages_after(conn: &Connection, group: &str, seq: i64) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM buddy_group_messages
         WHERE group_id=?1 AND seq>?2 ORDER BY seq"
    ))?;
    let rows = stmt
        .query_map(params![group, seq], message_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The latest thing anyone said, for previews.
pub fn last_spoken(conn: &Connection, group: &str) -> Result<Option<Message>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {MESSAGE_COLUMNS} FROM buddy_group_messages
                 WHERE group_id=?1 AND sender_kind IN ('user','buddy')
                 ORDER BY seq DESC LIMIT 1"
            ),
            [group],
            message_row,
        )
        .optional()?)
}
