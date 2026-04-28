//! Custom Agent (Persona) DAO
//!
//! 表：custom_agent。每行是一条用户在 base agent 之上定制的 persona
//! （Engineer / QA Reviewer 等），保存对应的 model / mode / effort 偏好以及
//! 启动时注入的 system prompt。
//!
//! 注意：这里的 `CustomAgent` 与 `storage::config::CustomAgentServer` 是两个
//! 不同的概念——后者是底层 ACP server 的命令/URL 配置（仍在 TOML 里），前者
//! 是基于该 server 的"身份"配置（在 SQLite 里）。

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    pub base_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
    #[serde(default)]
    pub system_prompt: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CustomAgentInput {
    pub name: String,
    pub base_agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub duty: Option<String>,
    #[serde(default)]
    pub system_prompt: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CustomAgentPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base_agent: Option<String>,
    #[serde(default)]
    pub model: Option<Option<String>>,
    #[serde(default)]
    pub mode: Option<Option<String>>,
    #[serde(default)]
    pub effort: Option<Option<String>>,
    #[serde(default)]
    pub duty: Option<Option<String>>,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn row_to_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<CustomAgent> {
    let created_at_s: String = row.get(8)?;
    let updated_at_s: String = row.get(9)?;
    Ok(CustomAgent {
        id: row.get(0)?,
        name: row.get(1)?,
        base_agent: row.get(2)?,
        model: row.get(3)?,
        mode: row.get(4)?,
        effort: row.get(5)?,
        duty: row.get(6)?,
        system_prompt: row.get(7)?,
        created_at: parse_dt(&created_at_s),
        updated_at: parse_dt(&updated_at_s),
    })
}

const SELECT_COLS: &str =
    "id, name, base_agent, model, mode, effort, duty, system_prompt, created_at, updated_at";

/// 列出所有 custom agent（按 created_at 升序）
pub fn list() -> Result<Vec<CustomAgent>> {
    let conn = crate::storage::database::connection();
    let sql = format!(
        "SELECT {} FROM custom_agent ORDER BY created_at ASC",
        SELECT_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_agent)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 取一条
pub fn get(id: &str) -> Result<Option<CustomAgent>> {
    let conn = crate::storage::database::connection();
    let sql = format!("SELECT {} FROM custom_agent WHERE id = ?1", SELECT_COLS);
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], row_to_agent)
        .optional()
        .map_err(Into::into)
}

/// Persona id prefix. Server-generated ids are always `ca-<uuid>`; the prefix
/// lets agent resolvers cheaply skip the SQLite lookup for built-in agent
/// names ("claude" / "codex" / …) and avoids any chance of a built-in name
/// collision shadowing a real persona.
pub const PERSONA_ID_PREFIX: &str = "ca-";

/// Convenience: only hit SQLite when `agent` looks like a persona id. Returns
/// `Ok(None)` for any non-`ca-` string without consulting the DB.
pub fn try_get_persona(agent: &str) -> Result<Option<CustomAgent>> {
    if !agent.starts_with(PERSONA_ID_PREFIX) {
        return Ok(None);
    }
    get(agent)
}

/// 创建。生成新的 id 并填充时间戳，返回创建后的完整记录。
///
/// L7: 校验 base_agent 必须是已知 ACP agent，避免到 spawn 时才发现未知 base 失败。
pub fn create(input: CustomAgentInput) -> Result<CustomAgent> {
    if crate::acp::resolve_agent(&input.base_agent).is_none() {
        return Err(crate::error::GroveError::storage_tagged(
            "unknown_base_agent",
            format!("unknown base_agent: {}", input.base_agent),
        ));
    }
    let conn = crate::storage::database::connection();
    let id = format!("ca-{}", uuid::Uuid::new_v4());
    let now = Utc::now();
    let now_s = now.to_rfc3339();
    conn.execute(
        "INSERT INTO custom_agent
         (id, name, base_agent, model, mode, effort, duty, system_prompt, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            input.name,
            input.base_agent,
            input.model,
            input.mode,
            input.effort,
            input.duty,
            input.system_prompt,
            now_s,
        ],
    )?;
    Ok(CustomAgent {
        id,
        name: input.name,
        base_agent: input.base_agent,
        model: input.model,
        mode: input.mode,
        effort: input.effort,
        duty: input.duty,
        system_prompt: input.system_prompt,
        created_at: now,
        updated_at: now,
    })
}

/// 更新（只覆盖 patch 里 Some 的字段）。返回更新后的记录；id 不存在时返回 None。
///
/// H7: 用事务包裹 read-modify-write，并以 UPDATE 影响行数判定记录是否还在，
/// 避免并发 delete 导致返回 stale 数据（旧实现先 SELECT 再 UPDATE，
/// 命中 zero rows 时仍返回 Ok(Some(stale))）。
pub fn update(id: &str, patch: CustomAgentPatch) -> Result<Option<CustomAgent>> {
    // 与 create 一致：patch 改 base_agent 时校验合法，避免到 spawn 才炸。
    if let Some(ref new_base) = patch.base_agent {
        if crate::acp::resolve_agent(new_base).is_none() {
            return Err(crate::error::GroveError::storage_tagged(
                "unknown_base_agent",
                format!("unknown base_agent: {}", new_base),
            ));
        }
    }
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    let sql = format!("SELECT {} FROM custom_agent WHERE id = ?1", SELECT_COLS);
    let existing_opt: Option<CustomAgent> = {
        let mut stmt = tx.prepare(&sql)?;
        stmt.query_row(params![id], row_to_agent).optional()?
    };
    let Some(mut existing) = existing_opt else {
        return Ok(None);
    };

    if let Some(name) = patch.name {
        existing.name = name;
    }
    if let Some(base) = patch.base_agent {
        existing.base_agent = base;
    }
    if let Some(model) = patch.model {
        existing.model = model;
    }
    if let Some(mode) = patch.mode {
        existing.mode = mode;
    }
    if let Some(effort) = patch.effort {
        existing.effort = effort;
    }
    if let Some(duty) = patch.duty {
        existing.duty = duty;
    }
    if let Some(prompt) = patch.system_prompt {
        existing.system_prompt = prompt;
    }
    existing.updated_at = Utc::now();
    let updated_s = existing.updated_at.to_rfc3339();

    let n = tx.execute(
        "UPDATE custom_agent SET
            name = ?2, base_agent = ?3, model = ?4, mode = ?5, effort = ?6,
            duty = ?7, system_prompt = ?8, updated_at = ?9
         WHERE id = ?1",
        params![
            existing.id,
            existing.name,
            existing.base_agent,
            existing.model,
            existing.mode,
            existing.effort,
            existing.duty,
            existing.system_prompt,
            updated_s,
        ],
    )?;
    tx.commit()?;
    if n == 0 {
        // 并发 delete 在 SELECT 与 UPDATE 之间发生
        Ok(None)
    } else {
        Ok(Some(existing))
    }
}

/// 删除。返回 true 表示有行被删除。
pub fn delete(id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let n = conn.execute("DELETE FROM custom_agent WHERE id = ?1", params![id])?;
    Ok(n > 0)
}
