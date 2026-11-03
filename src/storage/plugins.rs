//! Plugins registry DAO.
//!
//! 表：plugins。每行是一个已注册的插件（含 plugin.json 的文件夹）。`source` 决定
//! local_path 指向哪、以及 delete 是否删文件：
//!   'dev'   → local_path 是用户自己的开发文件夹（引用、不拷贝、热更新；delete 只删行）
//!   'local' → 拷贝进 ~/.grove/plugins/<id>（delete 删文件）
//!   'git'   → 从 git_url[/subpath] clone 进 ~/.grove/plugins/<id>（delete 删文件）

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    /// "dev" | "local" | "git"
    pub source: String,
    pub local_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
    /// Security digest the user approved (see `plugins::approval`). None until
    /// the plugin has been reviewed; never sent to clients as-is.
    #[serde(skip)]
    pub approved_digest: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const PLUGIN_ID_PREFIX: &str = "pl-";

const SELECT_COLS: &str =
    "id, name, version, source, local_path, git_url, subpath, created_at, updated_at, approved_digest";

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn row_to_plugin(row: &rusqlite::Row<'_>) -> rusqlite::Result<Plugin> {
    let created_at_s: String = row.get(7)?;
    let updated_at_s: String = row.get(8)?;
    Ok(Plugin {
        id: row.get(0)?,
        name: row.get(1)?,
        version: row.get(2)?,
        source: row.get(3)?,
        local_path: row.get(4)?,
        git_url: row.get(5)?,
        subpath: row.get(6)?,
        approved_digest: row.get(9)?,
        created_at: parse_dt(&created_at_s),
        updated_at: parse_dt(&updated_at_s),
    })
}

/// Generate a fresh plugin id (`pl-<uuid>`).
pub fn new_id() -> String {
    format!("{}{}", PLUGIN_ID_PREFIX, uuid::Uuid::new_v4())
}

/// 列出所有插件（按 created_at 升序）。
pub fn list() -> Result<Vec<Plugin>> {
    let conn = crate::storage::database::connection();
    let sql = format!(
        "SELECT {} FROM plugins ORDER BY created_at ASC",
        SELECT_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_plugin)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 取一条；id 不存在返回 None。
pub fn get(id: &str) -> Result<Option<Plugin>> {
    let conn = crate::storage::database::connection();
    let sql = format!("SELECT {} FROM plugins WHERE id = ?1", SELECT_COLS);
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], row_to_plugin)
        .optional()
        .map_err(Into::into)
}

/// 插入或更新一条 plugin 记录。调用方负责生成 id（用 `new_id()`）并把文件放到位
/// （dev=用户路径；local/git=~/.grove/plugins/<id>）。`local_path` 唯一：若该路径
/// 已注册，则刷新其余字段并保留原 id/created_at（幂等）。
///
/// 注意：全程只用同一个 conn guard，绝不在持有时再调 `get()`/`connection()`
/// —— 那会重入同一个 std Mutex 造成死锁。
#[allow(clippy::too_many_arguments)]
pub fn upsert(
    id: &str,
    name: &str,
    version: &str,
    source: &str,
    local_path: &str,
    git_url: Option<&str>,
    subpath: Option<&str>,
) -> Result<Plugin> {
    let conn = crate::storage::database::connection();
    let now = Utc::now();
    let now_s = now.to_rfc3339();

    // Idempotent on local_path: refresh in place if already registered there.
    let existing: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, created_at, approved_digest FROM plugins WHERE local_path = ?1",
            params![local_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;

    // Re-registration keeps the approval; it lapses by itself if the manifest
    // now asks for something the user did not review.
    if let Some((eid, created_s, approved_digest)) = existing {
        conn.execute(
            "UPDATE plugins SET name=?1, version=?2, source=?3, git_url=?4, subpath=?5, updated_at=?6 WHERE id=?7",
            params![name, version, source, git_url, subpath, now_s, eid],
        )?;
        return Ok(Plugin {
            id: eid,
            name: name.to_string(),
            version: version.to_string(),
            source: source.to_string(),
            local_path: local_path.to_string(),
            git_url: git_url.map(String::from),
            subpath: subpath.map(String::from),
            approved_digest,
            created_at: parse_dt(&created_s),
            updated_at: now,
        });
    }

    conn.execute(
        "INSERT INTO plugins (id, name, version, source, local_path, git_url, subpath, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, name, version, source, local_path, git_url, subpath, now_s],
    )?;
    Ok(Plugin {
        id: id.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        source: source.to_string(),
        local_path: local_path.to_string(),
        git_url: git_url.map(String::from),
        subpath: subpath.map(String::from),
        approved_digest: None,
        created_at: now,
        updated_at: now,
    })
}

/// Record (or clear) the security digest the user approved for a plugin.
pub fn set_approved_digest(id: &str, digest: Option<&str>) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let n = conn.execute(
        "UPDATE plugins SET approved_digest = ?1 WHERE id = ?2",
        params![digest, id],
    )?;
    Ok(n > 0)
}

/// 删除 registry 记录。返回是否删掉了一行。**不**碰磁盘文件 —— 调用方（handler）
/// 按 source 决定要不要删 ~/.grove/plugins/<id> 下的文件。
pub fn delete(id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let n = conn.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
    Ok(n > 0)
}
