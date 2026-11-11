//! Task sharing.
//!
//! The owner hands out links to one Task: its code changes and output files,
//! always as they are now. Whoever opens a link gives a name and gets a key;
//! the key holds their place and lets the owner remove that person. They may
//! comment when the link allows it, in Grove or in a browser. Recipients keep the links they opened in `received_shares`, never
//! the content.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::database;
use crate::error::{GroveError, Result};

pub const NAME_LIMIT: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareState {
    Active,
    Expired,
    Exhausted,
    Revoked,
}

/// What one link shows of its Task. Each kind is either all of it (`None`:
/// whatever the Task has, now and later) or the listed items only. A link
/// with no scope shows the whole Task, the comments on the Task itself too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareScope {
    /// Code Reviews: `""` for the Task's own, else a linked Project's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviews: Option<Vec<String>>,
    /// Design boards, by slug.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub designs: Option<Vec<String>>,
    /// Sketches, by id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketches: Option<Vec<String>>,
    /// Output files, by their path under `output/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

impl ShareScope {
    /// `None` when every kind is whole: that is the whole Task.
    pub fn normalized(self) -> Option<Self> {
        (self != Self::default()).then_some(self)
    }

    fn allows(list: &Option<Vec<String>>, item: &str) -> bool {
        list.as_ref()
            .is_none_or(|items| items.iter().any(|i| i == item))
    }

    pub fn allows_review(&self, id: &str) -> bool {
        Self::allows(&self.reviews, id)
    }
    pub fn allows_design(&self, slug: &str) -> bool {
        Self::allows(&self.designs, slug)
    }
    pub fn allows_sketch(&self, id: &str) -> bool {
        Self::allows(&self.sketches, id)
    }
    pub fn allows_file(&self, path: &str) -> bool {
        Self::allows(&self.files, path)
    }
    /// The design system shows as a board only with every design shared.
    pub fn all_designs(&self) -> bool {
        self.designs.is_none()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Share {
    pub token: String,
    pub project_key: String,
    pub task_id: String,
    pub can_comment: bool,
    /// What the link shows; `None` for the whole Task.
    pub scope: Option<ShareScope>,
    pub expires_at: Option<String>,
    pub max_opens: Option<u32>,
    pub opens: u32,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

impl Share {
    pub fn state(&self) -> ShareState {
        if self.revoked_at.is_some() {
            return ShareState::Revoked;
        }
        if let Some(expires) = self.expires_at.as_deref().and_then(parse_time) {
            if expires <= Utc::now() {
                return ShareState::Expired;
            }
        }
        if let Some(max) = self.max_opens {
            if self.opens >= max {
                return ShareState::Exhausted;
            }
        }
        ShareState::Active
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VisitorKind {
    Grove,
    Browser,
}

impl VisitorKind {
    fn as_str(self) -> &'static str {
        match self {
            VisitorKind::Grove => "grove",
            VisitorKind::Browser => "browser",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "grove" {
            VisitorKind::Grove
        } else {
            VisitorKind::Browser
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Visitor {
    pub id: String,
    pub token: String,
    pub kind: VisitorKind,
    pub name: String,
    pub device: String,
    /// Which Grove it was, per link, so someone removed stays removed.
    #[serde(skip)]
    pub client: String,
    #[serde(skip)]
    key_hash: String,
    pub created_at: String,
    pub last_open_at: Option<String>,
    pub removed_at: Option<String>,
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("system randomness");
    hex::encode(buf)
}

/// Link tokens are short enough to read aloud and long enough not to guess.
fn random_token() -> String {
    const ALPHABET: &[u8] = b"23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("system randomness");
    buf.iter()
        .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
        .collect()
}

fn hash_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

/// A name as it is shown to the owner: trimmed, one line, not too long.
pub fn clean_name(name: &str) -> Result<String> {
    let name: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        return Err(GroveError::invalid_data("Enter your name"));
    }
    if name.chars().count() > NAME_LIMIT {
        return Err(GroveError::invalid_data(format!(
            "A name can have at most {NAME_LIMIT} characters"
        )));
    }
    Ok(name)
}

// ============================================================================
// Links (owner side)
// ============================================================================

fn share_from_row(row: &Row) -> rusqlite::Result<Share> {
    Ok(Share {
        token: row.get(0)?,
        project_key: row.get(1)?,
        task_id: row.get(2)?,
        can_comment: row.get::<_, i64>(3)? != 0,
        expires_at: row.get(4)?,
        max_opens: row.get(5)?,
        opens: row.get(6)?,
        created_at: row.get(7)?,
        revoked_at: row.get(8)?,
        // A scope that no longer reads is the narrowest one: nothing.
        scope: row
            .get::<_, Option<String>>(9)?
            .map(|text| serde_json::from_str(&text).unwrap_or_else(|_| nothing_scope())),
    })
}

fn nothing_scope() -> ShareScope {
    ShareScope {
        reviews: Some(Vec::new()),
        designs: Some(Vec::new()),
        sketches: Some(Vec::new()),
        files: Some(Vec::new()),
    }
}

fn scope_text(scope: &Option<ShareScope>) -> Option<String> {
    scope
        .as_ref()
        .map(|scope| serde_json::to_string(scope).unwrap_or_default())
}

const SHARE_COLUMNS: &str =
    "token, project_key, task_id, can_comment, expires_at, max_opens, opens, created_at, revoked_at, scope";

pub fn create_share(
    project_key: &str,
    task_id: &str,
    can_comment: bool,
    expires_in_days: Option<u32>,
    max_opens: Option<u32>,
    scope: Option<ShareScope>,
) -> Result<Share> {
    let scope = scope.and_then(ShareScope::normalized);
    let now = Utc::now();
    let share = Share {
        token: random_token(),
        project_key: project_key.to_string(),
        task_id: task_id.to_string(),
        can_comment,
        expires_at: expires_in_days
            .filter(|days| *days > 0)
            .map(|days| (now + Duration::days(days as i64)).to_rfc3339()),
        max_opens: max_opens.filter(|max| *max > 0),
        opens: 0,
        created_at: now.to_rfc3339(),
        revoked_at: None,
        scope,
    };
    database::connection().execute(
        "INSERT INTO task_shares (token, project_key, task_id, can_comment, expires_at, max_opens, opens, created_at, scope)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
        params![
            share.token,
            share.project_key,
            share.task_id,
            share.can_comment as i64,
            share.expires_at,
            share.max_opens,
            share.created_at,
            scope_text(&share.scope),
        ],
    )?;
    Ok(share)
}

/// Change what a link shows. `None` (or every kind whole) is the whole Task.
pub fn set_scope(token: &str, scope: Option<ShareScope>) -> Result<bool> {
    let scope = scope.and_then(ShareScope::normalized);
    let updated = database::connection().execute(
        "UPDATE task_shares SET scope = ?1 WHERE token = ?2",
        params![scope_text(&scope), token],
    )?;
    Ok(updated > 0)
}

pub fn get_share(token: &str) -> Result<Option<Share>> {
    let conn = database::connection();
    Ok(conn
        .query_row(
            &format!("SELECT {SHARE_COLUMNS} FROM task_shares WHERE token = ?1"),
            params![token],
            share_from_row,
        )
        .optional()?)
}

/// Every link of a Task, newest first.
pub fn list_shares(project_key: &str, task_id: &str) -> Result<Vec<Share>> {
    let conn = database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHARE_COLUMNS} FROM task_shares
         WHERE project_key = ?1 AND task_id = ?2
         ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![project_key, task_id], share_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn revoke_share(token: &str) -> Result<bool> {
    let updated = database::connection().execute(
        "UPDATE task_shares SET revoked_at = ?1 WHERE token = ?2 AND revoked_at IS NULL",
        params![Utc::now().to_rfc3339(), token],
    )?;
    Ok(updated > 0)
}

/// Forget a link and who opened it. Comments left through it stay with
/// the Task.
pub fn delete_share(token: &str) -> Result<()> {
    let conn = database::connection();
    conn.execute(
        "DELETE FROM share_visitors WHERE token = ?1",
        params![token],
    )?;
    conn.execute("DELETE FROM task_shares WHERE token = ?1", params![token])?;
    Ok(())
}

/// A deleted Task takes its links along. Runs inside the caller's transaction.
pub fn delete_task_shares(
    conn: &rusqlite::Connection,
    project_key: &str,
    task_id: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM share_visitors WHERE token IN
            (SELECT token FROM task_shares WHERE project_key = ?1 AND task_id = ?2)",
        params![project_key, task_id],
    )?;
    conn.execute(
        "DELETE FROM task_shares WHERE project_key = ?1 AND task_id = ?2",
        params![project_key, task_id],
    )?;
    Ok(())
}

/// Every link of a project that is going away.
pub fn delete_project_shares(conn: &rusqlite::Connection, project_key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM share_visitors WHERE token IN
            (SELECT token FROM task_shares WHERE project_key = ?1)",
        params![project_key],
    )?;
    conn.execute(
        "DELETE FROM task_shares WHERE project_key = ?1",
        params![project_key],
    )?;
    Ok(())
}

// ============================================================================
// Visitors (owner side)
// ============================================================================

fn visitor_from_row(row: &Row) -> rusqlite::Result<Visitor> {
    Ok(Visitor {
        id: row.get(0)?,
        token: row.get(1)?,
        kind: VisitorKind::parse(&row.get::<_, String>(2)?),
        name: row.get(3)?,
        device: row.get(4)?,
        key_hash: row.get(5)?,
        created_at: row.get(6)?,
        last_open_at: row.get(7)?,
        removed_at: row.get(8)?,
        client: row.get(9)?,
    })
}

const VISITOR_COLUMNS: &str =
    "id, token, kind, name, device, key_hash, created_at, last_open_at, removed_at, client";

pub fn list_visitors(token: &str) -> Result<Vec<Visitor>> {
    let conn = database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {VISITOR_COLUMNS} FROM share_visitors WHERE token = ?1 ORDER BY created_at"
    ))?;
    let rows = stmt.query_map(params![token], visitor_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_visitor(id: &str) -> Result<Option<Visitor>> {
    let conn = database::connection();
    Ok(conn
        .query_row(
            &format!("SELECT {VISITOR_COLUMNS} FROM share_visitors WHERE id = ?1"),
            params![id],
            visitor_from_row,
        )
        .optional()?)
}

/// The visitor a credential (`<id>.<key>`) belongs to, on this link.
pub fn authenticate(token: &str, credential: &str) -> Result<Option<Visitor>> {
    let Some((id, key)) = credential.split_once('.') else {
        return Ok(None);
    };
    let Some(visitor) = get_visitor(id)? else {
        return Ok(None);
    };
    if visitor.token != token || visitor.removed_at.is_some() {
        return Ok(None);
    }
    let expected = hash_key(key);
    let matches: bool = expected
        .as_bytes()
        .iter()
        .zip(visitor.key_hash.as_bytes())
        .fold(expected.len() == visitor.key_hash.len(), |same, (a, b)| {
            same & (a == b)
        });
    Ok(matches.then_some(visitor))
}

/// Someone gives a name and gets a key. Returns the visitor and the
/// credential (`<id>.<key>`) to present from now on.
pub fn add_visitor(
    token: &str,
    kind: VisitorKind,
    name: &str,
    device: &str,
    client: &str,
) -> Result<(Visitor, String)> {
    let name = clean_name(name)?;
    let device: String = device.chars().take(80).collect();
    let client: String = client.chars().take(128).collect();
    let id = random_hex(12);
    let key = random_hex(24);
    let visitor = Visitor {
        id: id.clone(),
        token: token.to_string(),
        kind,
        name,
        device: device.trim().to_string(),
        client,
        key_hash: hash_key(&key),
        created_at: Utc::now().to_rfc3339(),
        last_open_at: None,
        removed_at: None,
    };
    database::connection().execute(
        "INSERT INTO share_visitors (id, token, kind, name, device, client, key_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            visitor.id,
            visitor.token,
            visitor.kind.as_str(),
            visitor.name,
            visitor.device,
            visitor.client,
            visitor.key_hash,
            visitor.created_at,
        ],
    )?;
    Ok((visitor, format!("{id}.{key}")))
}

/// The same Grove joining a link again (say, under another address of the
/// owner's Grove): it stays one visitor, with a fresh key.
pub fn rejoin_visitor(
    token: &str,
    client: &str,
    name: &str,
    device: &str,
) -> Result<Option<(Visitor, String)>> {
    if client.is_empty() {
        return Ok(None);
    }
    let name = clean_name(name)?;
    let device: String = device.chars().take(80).collect();
    let conn = database::connection();
    let existing: Option<Visitor> = conn
        .query_row(
            &format!(
                "SELECT {VISITOR_COLUMNS} FROM share_visitors
                 WHERE token = ?1 AND client = ?2 AND removed_at IS NULL LIMIT 1"
            ),
            params![token, client],
            visitor_from_row,
        )
        .optional()?;
    let Some(mut visitor) = existing else {
        return Ok(None);
    };
    let key = random_hex(24);
    visitor.name = name;
    visitor.device = device.trim().to_string();
    visitor.key_hash = hash_key(&key);
    conn.execute(
        "UPDATE share_visitors SET name = ?1, device = ?2, key_hash = ?3 WHERE id = ?4",
        params![visitor.name, visitor.device, visitor.key_hash, visitor.id],
    )?;
    let credential = format!("{}.{key}", visitor.id);
    Ok(Some((visitor, credential)))
}

/// Whether this Grove was removed from the link before.
pub fn client_removed(token: &str, client: &str) -> Result<bool> {
    if client.is_empty() {
        return Ok(false);
    }
    let found: Option<i64> = database::connection()
        .query_row(
            "SELECT 1 FROM share_visitors
             WHERE token = ?1 AND client = ?2 AND removed_at IS NOT NULL LIMIT 1",
            params![token, client],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// Whether someone joined again under a name the owner had removed.
pub fn rejoined(visitor: &Visitor, everyone: &[Visitor]) -> bool {
    everyone.iter().any(|other| {
        other.id != visitor.id
            && other
                .removed_at
                .as_deref()
                .is_some_and(|removed| removed <= visitor.created_at.as_str())
            && other.name.to_lowercase() == visitor.name.to_lowercase()
    })
}

/// Forget someone entirely, as if they never joined.
pub fn delete_visitor(id: &str) -> Result<()> {
    database::connection().execute("DELETE FROM share_visitors WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn remove_visitor(token: &str, id: &str) -> Result<bool> {
    let updated = database::connection().execute(
        "UPDATE share_visitors SET removed_at = ?1 WHERE id = ?2 AND token = ?3 AND removed_at IS NULL",
        params![Utc::now().to_rfc3339(), id, token],
    )?;
    Ok(updated > 0)
}

/// Record an open. A link counts people, not opens (`max_opens` and `opens`
/// hold the limit and the count): someone's first open takes a place, and
/// whoever has one keeps opening the link even once it is full.
/// Returns the link's state after the open.
pub fn record_open(share: &Share, visitor: &Visitor) -> Result<ShareState> {
    let state = share.state();
    if matches!(state, ShareState::Revoked | ShareState::Expired) {
        return Ok(state);
    }
    let now = Utc::now();
    let conn = database::connection();
    if has_opened(visitor) {
        conn.execute(
            "UPDATE share_visitors SET last_open_at = ?1 WHERE id = ?2",
            params![now.to_rfc3339(), visitor.id],
        )?;
        return Ok(ShareState::Active);
    }
    if state == ShareState::Exhausted {
        return Ok(state);
    }
    // Guarded so two people racing for the last place can't both get it.
    let counted = conn.execute(
        "UPDATE task_shares SET opens = opens + 1
         WHERE token = ?1 AND (max_opens IS NULL OR opens < max_opens)",
        params![share.token],
    )?;
    if counted == 0 {
        return Ok(ShareState::Exhausted);
    }
    conn.execute(
        "UPDATE share_visitors SET last_open_at = ?1 WHERE id = ?2",
        params![now.to_rfc3339(), visitor.id],
    )?;
    Ok(ShareState::Active)
}

/// Whether this visitor has a place on the link, so a full link still
/// serves them.
pub fn has_opened(visitor: &Visitor) -> bool {
    visitor.last_open_at.is_some()
}

/// Comments written through each link of this Task: (token, all, still open).
pub fn comment_counts(project_key: &str, task_id: &str) -> Result<Vec<(String, u32, u32)>> {
    let conn = database::connection();
    let mut stmt = conn.prepare(
        "SELECT v.token, COUNT(*), SUM(CASE WHEN c.status = 'open' THEN 1 ELSE 0 END)
         FROM review_comments c
         JOIN share_visitors v ON v.id = c.share_visitor
         WHERE c.project_key = ?1 AND c.task_id = ?2
         GROUP BY v.token",
    )?;
    let rows = stmt.query_map(params![project_key, task_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, u32>(2)?,
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Visitor names by id, for every link of a Task.
pub fn task_visitor_names(
    project_key: &str,
    task_id: &str,
) -> Result<std::collections::HashMap<String, String>> {
    let conn = database::connection();
    let mut stmt = conn.prepare(
        "SELECT v.id, v.name FROM share_visitors v
         JOIN task_shares s ON s.token = v.token
         WHERE s.project_key = ?1 AND s.task_id = ?2",
    )?;
    let rows = stmt.query_map(params![project_key, task_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ============================================================================
// Received shares (recipient side)
// ============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct Received {
    pub id: String,
    pub url: String,
    pub base_url: String,
    pub token: String,
    pub visitor_id: String,
    #[serde(skip)]
    pub visitor_key: String,
    pub title: String,
    pub owner: String,
    pub project: String,
    pub can_comment: bool,
    pub added_at: String,
    pub seen_at: Option<String>,
}

impl Received {
    /// The credential this Grove presents to the owner's.
    pub fn credential(&self) -> String {
        format!("{}.{}", self.visitor_id, self.visitor_key)
    }
}

fn received_from_row(row: &Row) -> rusqlite::Result<Received> {
    Ok(Received {
        id: row.get(0)?,
        url: row.get(1)?,
        base_url: row.get(2)?,
        token: row.get(3)?,
        visitor_id: row.get(4)?,
        visitor_key: row.get(5)?,
        title: row.get(6)?,
        owner: row.get(7)?,
        project: row.get(8)?,
        can_comment: row.get::<_, i64>(9)? != 0,
        added_at: row.get(10)?,
        seen_at: row.get(11)?,
    })
}

const RECEIVED_COLUMNS: &str = "id, url, base_url, token, visitor_id, visitor_key, title, owner, project, can_comment, added_at, seen_at";

pub fn list_received() -> Result<Vec<Received>> {
    let conn = database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {RECEIVED_COLUMNS} FROM received_shares ORDER BY added_at DESC"
    ))?;
    let rows = stmt.query_map([], received_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_received(id: &str) -> Result<Option<Received>> {
    let conn = database::connection();
    Ok(conn
        .query_row(
            &format!("SELECT {RECEIVED_COLUMNS} FROM received_shares WHERE id = ?1"),
            params![id],
            received_from_row,
        )
        .optional()?)
}

/// A link opened here before. Found by its token, since the same link can
/// arrive under another address of the owner's Grove.
pub fn find_received_by_token(token: &str) -> Result<Option<Received>> {
    let conn = database::connection();
    Ok(conn
        .query_row(
            &format!("SELECT {RECEIVED_COLUMNS} FROM received_shares WHERE token = ?1"),
            params![token],
            received_from_row,
        )
        .optional()?)
}

/// The owner's Grove now answers at another address.
pub fn update_received_address(id: &str, url: &str, base_url: &str) -> Result<()> {
    database::connection().execute(
        "UPDATE received_shares SET url = ?1, base_url = ?2 WHERE id = ?3",
        params![url, base_url, id],
    )?;
    Ok(())
}

pub struct NewReceived<'a> {
    pub url: &'a str,
    pub base_url: &'a str,
    pub token: &'a str,
    pub credential: &'a str,
    pub title: &'a str,
    pub owner: &'a str,
    pub project: &'a str,
    pub can_comment: bool,
}

pub fn save_received(new: NewReceived) -> Result<Received> {
    let (visitor_id, visitor_key) = new
        .credential
        .split_once('.')
        .ok_or_else(|| GroveError::invalid_data("The share sent back a bad key"))?;
    let id = random_hex(8);
    let now = Utc::now().to_rfc3339();
    database::connection().execute(
        "INSERT INTO received_shares (id, url, base_url, token, visitor_id, visitor_key, title, owner, project, can_comment, added_at, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT(url) DO UPDATE SET
            base_url = excluded.base_url, token = excluded.token,
            visitor_id = excluded.visitor_id, visitor_key = excluded.visitor_key,
            title = excluded.title, owner = excluded.owner, project = excluded.project,
            can_comment = excluded.can_comment",
        params![
            id,
            new.url,
            new.base_url,
            new.token,
            visitor_id,
            visitor_key,
            new.title,
            new.owner,
            new.project,
            new.can_comment as i64,
            now,
        ],
    )?;
    find_received_by_token(new.token)?
        .ok_or_else(|| GroveError::storage("The share was not saved".to_string()))
}

/// Keep what the sidebar shows in step with the owner's latest answer.
pub fn update_received_meta(
    id: &str,
    title: &str,
    owner: &str,
    project: &str,
    can_comment: bool,
) -> Result<()> {
    database::connection().execute(
        "UPDATE received_shares SET title = ?1, owner = ?2, project = ?3, can_comment = ?4 WHERE id = ?5",
        params![title, owner, project, can_comment as i64, id],
    )?;
    Ok(())
}

pub fn mark_received_seen(id: &str) -> Result<()> {
    database::connection().execute(
        "UPDATE received_shares SET seen_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn delete_received(id: &str) -> Result<bool> {
    let deleted =
        database::connection().execute("DELETE FROM received_shares WHERE id = ?1", params![id])?;
    Ok(deleted > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_one_trimmed_line() {
        assert_eq!(clean_name("  周远 \n MacBook ").unwrap(), "周远 MacBook");
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"x".repeat(NAME_LIMIT + 1)).is_err());
    }

    #[test]
    fn tokens_avoid_lookalikes() {
        let token = random_token();
        assert_eq!(token.len(), 16);
        assert!(!token.contains(['0', 'O', '1', 'l', 'I']));
    }

    #[test]
    fn scope_lists_or_whole_kinds() {
        // Every kind whole is the whole Task.
        assert_eq!(ShareScope::default().normalized(), None);
        let scope = ShareScope {
            designs: Some(vec!["home".into()]),
            files: Some(Vec::new()),
            ..Default::default()
        };
        assert!(scope.allows_design("home"));
        assert!(!scope.allows_design("about"));
        assert!(!scope.all_designs());
        assert!(!scope.allows_file("report.md"));
        // A kind left out is all of it, later additions too.
        assert!(scope.allows_sketch("anything"));
        assert!(scope.allows_review(""));
        assert_eq!(scope.clone().normalized(), Some(scope));
    }

    #[test]
    fn state_follows_limits() {
        let mut share = Share {
            token: "t".into(),
            project_key: "p".into(),
            task_id: "x".into(),
            can_comment: false,
            expires_at: None,
            max_opens: Some(2),
            opens: 1,
            created_at: Utc::now().to_rfc3339(),
            revoked_at: None,
            scope: None,
        };
        assert_eq!(share.state(), ShareState::Active);
        share.opens = 2;
        assert_eq!(share.state(), ShareState::Exhausted);
        share.expires_at = Some((Utc::now() - Duration::minutes(1)).to_rfc3339());
        assert_eq!(share.state(), ShareState::Expired);
        share.revoked_at = Some(Utc::now().to_rfc3339());
        assert_eq!(share.state(), ShareState::Revoked);
    }
}
