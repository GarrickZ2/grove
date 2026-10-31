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
    #[serde(default)]
    pub buddy_id: Option<String>,
    pub bound_chat_id: Option<String>,
    pub bound_user_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectTarget {
    Buddy { buddy_id: String },
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
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub target: Option<ConnectTarget>,
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
        buddy_id: row.get(13)?,
    })
}

const SELECT: &str = "SELECT id,name,platform,domain,enabled,adapter_config_json,project_id,task_id,CASE WHEN buddy_id IS NOT NULL THEN COALESCE((SELECT active_session_id FROM buddies WHERE buddies.id=connects.buddy_id),'') ELSE session_id END,bound_chat_id,bound_user_id,created_at,updated_at,buddy_id FROM connects";

/// Repair stale routing on read so both configuration views and inbound IM
/// messages return to Auto New, including bindings saved before this repair.
/// Match the whole target and only clear sessions confirmed missing/archived;
/// an offline agent still has a valid session and must keep its history.
fn reset_unavailable_sessions(conn: &rusqlite::Connection, id: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE connects SET session_id='', updated_at=?1
         WHERE (?2 IS NULL OR id=?2) AND session_id<>'' AND buddy_id IS NULL
         AND NOT EXISTS (
             SELECT 1 FROM session
             WHERE session.session_id=connects.session_id
               AND session.project=connects.project_id
               AND session.task_id=connects.task_id
               AND session.archived_at IS NULL
         )",
        params![now(), id],
    )?;
    Ok(())
}

pub fn list() -> Result<Vec<Connect>> {
    let conn = database::connection();
    reset_unavailable_sessions(&conn, None)?;
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
    reset_unavailable_sessions(&conn, Some(id))?;
    Ok(conn
        .query_row(&format!("{SELECT} WHERE id=?1"), [id], row)
        .optional()?)
}

pub fn create(input: ConnectInput) -> Result<Connect> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let buddy_id = input.target.as_ref().map(|target| match target {
        ConnectTarget::Buddy { buddy_id } => buddy_id.as_str(),
    });
    let adapter_config = serde_json::to_string(&input.adapter_config)?;
    let conn = database::connection();
    // Keep legacy credential columns populated as empty strings for databases
    // created before adapter_config_json was introduced.
    conn.execute("INSERT INTO connects (id,name,platform,domain,enabled,adapter_config_json,app_id,app_secret,project_id,task_id,session_id,created_at,updated_at,buddy_id) VALUES (?1,?2,?3,?4,?5,?6,'','',?7,?8,?9,?10,?10,?11)", params![id,input.name,input.platform,input.domain,input.enabled as i64,adapter_config,input.project_id,input.task_id,input.session_id,ts,buddy_id])?;
    drop(conn);
    Ok(get(&id)?.expect("created connect"))
}

pub fn update(id: &str, input: ConnectInput) -> Result<Option<Connect>> {
    let Some(_) = get(id)? else {
        return Ok(None);
    };
    let buddy_id = input.target.as_ref().map(|target| match target {
        ConnectTarget::Buddy { buddy_id } => buddy_id.as_str(),
    });
    let adapter_config = serde_json::to_string(&input.adapter_config)?;
    let conn = database::connection();
    let changed = conn.execute("UPDATE connects SET name=?2,platform=?3,domain=?4,enabled=?5,adapter_config_json=?6,project_id=?7,task_id=?8,session_id=?9,updated_at=?10,buddy_id=?11 WHERE id=?1", params![id,input.name,input.platform,input.domain,input.enabled as i64,adapter_config,input.project_id,input.task_id,input.session_id,now(),buddy_id])?;
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
        "UPDATE connects SET session_id=?2, updated_at=?3 WHERE id=?1 AND buddy_id IS NULL",
        params![id, session_id, now()],
    )?;
    Ok(changed > 0)
}

/// Persist a full routing target. An empty session id means "create on first
/// message"; routing changes do not restart the platform connection.
pub fn set_routing(id: &str, project_id: &str, task_id: &str, session_id: &str) -> Result<bool> {
    let conn = database::connection();
    let changed = conn.execute(
        "UPDATE connects SET project_id=?2, task_id=?3, session_id=?4, buddy_id=NULL, updated_at=?5 WHERE id=?1",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::tasks;

    struct GroveDirGuard;
    impl Drop for GroveDirGuard {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    #[test]
    fn reads_reset_deleted_and_archived_sessions_to_auto_new() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _guard = GroveDirGuard;

        for read_list in [false, true] {
            for archive in [false, true] {
                let chat_id = tasks::generate_chat_id();
                tasks::add_chat_session(
                    "project",
                    "task",
                    tasks::ChatSession {
                        id: chat_id.clone(),
                        title: "Existing session".into(),
                        agent: "codex-acp".into(),
                        acp_session_id: None,
                        created_at: Utc::now(),
                        duty: None,
                        launch_mode: "acp".into(),
                    },
                )
                .unwrap();
                let connection = create(ConnectInput {
                    target: None,
                    name: "Recovery test".into(),
                    platform: "feishu".into(),
                    domain: "feishu".into(),
                    enabled: true,
                    adapter_config: serde_json::json!({"app_secret": "keep-secret"}),
                    project_id: "project".into(),
                    task_id: "task".into(),
                    session_id: chat_id.clone(),
                })
                .unwrap();
                bind_private_chat(&connection.id, "chat", "user").unwrap();
                let before = get(&connection.id).unwrap().unwrap();
                // A saved session stays selected even with no running agent.
                assert_eq!(before.session_id, chat_id);

                if archive {
                    tasks::archive_chat_session("project", "task", &chat_id).unwrap();
                } else {
                    tasks::delete_chat_session("project", "task", &chat_id).unwrap();
                }
                let recovered = if read_list {
                    list()
                        .unwrap()
                        .into_iter()
                        .find(|item| item.id == connection.id)
                        .unwrap()
                } else {
                    get(&connection.id).unwrap().unwrap()
                };
                let mut expected = before;
                expected.session_id.clear();
                expected.updated_at = recovered.updated_at;
                assert_eq!(recovered, expected);
                // The reset is persisted; restoring an archive must not bind
                // the connection back to that old conversation.
                if archive {
                    tasks::restore_chat_session("project", "task", &chat_id).unwrap();
                }
                assert!(get(&connection.id).unwrap().unwrap().session_id.is_empty());
            }
        }
    }
}
