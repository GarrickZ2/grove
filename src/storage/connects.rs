use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::storage::database;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Connect {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub domain: String,
    pub enabled: bool,
    /// Platform-owned configuration. Core persists and forwards this JSON
    /// without interpreting its fields.
    #[serde(skip_serializing)]
    pub adapter_config: Value,
    pub project_id: String,
    pub task_id: String,
    pub session_id: String,
    pub bound_chat_id: Option<String>,
    pub bound_user_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectInput {
    pub name: String,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default = "default_domain")]
    pub domain: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub adapter_config: Value,
    pub project_id: String,
    pub task_id: String,
    pub session_id: String,
}

fn default_platform() -> String {
    "feishu".into()
}
fn default_domain() -> String {
    "feishu".into()
}
fn default_true() -> bool {
    true
}
fn now() -> i64 {
    Utc::now().timestamp()
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Connect> {
    Ok(Connect {
        id: row.get(0)?,
        name: row.get(1)?,
        platform: row.get(2)?,
        domain: row.get(3)?,
        enabled: row.get::<_, i64>(4)? != 0,
        adapter_config: serde_json::from_str(&row.get::<_, String>(5)?)
            .unwrap_or_else(|_| Value::Object(Default::default())),
        project_id: row.get(6)?,
        task_id: row.get(7)?,
        session_id: row.get(8)?,
        bound_chat_id: row.get(9)?,
        bound_user_id: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const SELECT: &str = "SELECT id,name,platform,domain,enabled,adapter_config_json,project_id,task_id,session_id,bound_chat_id,bound_user_id,created_at,updated_at FROM connects";

pub fn list() -> Result<Vec<Connect>> {
    let conn = database::connection();
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY updated_at DESC"))?;
    let items = stmt
        .query_map([], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}

pub fn list_enabled() -> Result<Vec<Connect>> {
    Ok(list()?.into_iter().filter(|item| item.enabled).collect())
}

pub fn get(id: &str) -> Result<Option<Connect>> {
    let conn = database::connection();
    Ok(conn
        .query_row(&format!("{SELECT} WHERE id=?1"), [id], row)
        .optional()?)
}

pub fn create(input: ConnectInput) -> Result<Connect> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let adapter_config = serde_json::to_string(&input.adapter_config)?;
    let conn = database::connection();
    // Keep legacy credential columns populated as empty strings for databases
    // created before adapter_config_json was introduced.
    conn.execute("INSERT INTO connects (id,name,platform,domain,enabled,adapter_config_json,app_id,app_secret,project_id,task_id,session_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'','',?7,?8,?9,?10,?10)", params![id,input.name,input.platform,input.domain,input.enabled as i64,adapter_config,input.project_id,input.task_id,input.session_id,ts])?;
    drop(conn);
    Ok(get(&id)?.expect("created connect"))
}

pub fn update(id: &str, input: ConnectInput) -> Result<Option<Connect>> {
    let Some(_) = get(id)? else {
        return Ok(None);
    };
    let adapter_config = serde_json::to_string(&input.adapter_config)?;
    let conn = database::connection();
    let changed = conn.execute("UPDATE connects SET name=?2,platform=?3,domain=?4,enabled=?5,adapter_config_json=?6,project_id=?7,task_id=?8,session_id=?9,updated_at=?10 WHERE id=?1", params![id,input.name,input.platform,input.domain,input.enabled as i64,adapter_config,input.project_id,input.task_id,input.session_id,now()])?;
    drop(conn);
    if changed == 0 {
        Ok(None)
    } else {
        get(id)
    }
}

pub fn delete(id: &str) -> Result<bool> {
    Ok(database::connection().execute("DELETE FROM connects WHERE id=?1", [id])? > 0)
}

/// Persist just the routed session id created by the first external message.
pub fn set_session(id: &str, session_id: &str) -> Result<bool> {
    let conn = database::connection();
    let changed = conn.execute(
        "UPDATE connects SET session_id=?2, updated_at=?3 WHERE id=?1",
        params![id, session_id, now()],
    )?;
    Ok(changed > 0)
}

/// Persist a full routing target. An empty session id means "create on first
/// message"; routing changes do not restart the platform connection.
pub fn set_routing(id: &str, project_id: &str, task_id: &str, session_id: &str) -> Result<bool> {
    let conn = database::connection();
    let changed = conn.execute(
        "UPDATE connects SET project_id=?2, task_id=?3, session_id=?4, updated_at=?5 WHERE id=?1",
        params![id, project_id, task_id, session_id, now()],
    )?;
    Ok(changed > 0)
}

/// Pre-seeds the authorizing user's open id (QR registration). Until the
/// chat itself is bound on first contact, bind_private_chat rejects messages
/// from any other tenant member.
pub fn prebind_user(id: &str, user_id: &str) -> Result<bool> {
    let conn = database::connection();
    let changed = conn.execute(
        "UPDATE connects SET bound_user_id=?2 WHERE id=?1 AND bound_user_id IS NULL",
        params![id, user_id],
    )?;
    Ok(changed > 0)
}

/// Binds the private chat on first contact. A pre-seeded `bound_user_id`
/// (QR registration stores the authorizing user) must match the sender, so a
/// bot visible to the whole tenant cannot be captured by whoever messages
/// first. Unseeded connections keep the first-messenger-wins behavior.
pub fn bind_private_chat(id: &str, chat_id: &str, user_id: &str) -> Result<bool> {
    let conn = database::connection();
    let changed = conn.execute(
        "UPDATE connects SET bound_chat_id=COALESCE(bound_chat_id,?2), bound_user_id=COALESCE(bound_user_id,?3) WHERE id=?1 AND (bound_chat_id IS NULL OR bound_chat_id=?2) AND (bound_user_id IS NULL OR bound_user_id=?3)",
        params![id, chat_id, user_id],
    )?;
    Ok(changed > 0)
}
