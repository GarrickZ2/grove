use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};

/// Local Task 的固定 ID
pub const LOCAL_TASK_ID: &str = "_local";

/// Chat 会话（一个 Task 下可以有多个 Chat）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    /// Chat ID ("chat-XXXXXX")
    pub id: String,
    /// 标题 ("New Chat 2025-02-16 14:30")
    pub title: String,
    /// Agent 名称 ("claude", "codex", etc.)
    pub agent: String,
    /// ACP session ID（用于 load_session 恢复对话历史）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 职能描述（Agent Graph 引入）。一旦设定，AI 不可改；仅用户可改。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
}

/// 任务状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Active,
    Archived,
}

/// 任务数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub target: String,
    pub worktree_path: String,
    pub initial_commit: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default = "default_updated_at")]
    pub updated_at: DateTime<Utc>,
    pub status: TaskStatus,
    #[serde(default = "default_multiplexer")]
    pub multiplexer: String,
    #[serde(default)]
    pub session_name: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<DateTime<Utc>>,
    /// Snapshot of git diff stats taken at archive time. Worktree is gone after
    /// archival, so live recomputation is impossible — these are the only
    /// numbers stats can show for archived tasks. 0 for active tasks.
    #[serde(default)]
    pub code_additions: u32,
    #[serde(default)]
    pub code_deletions: u32,
    #[serde(default)]
    pub files_changed: u32,
    #[serde(default)]
    pub is_local: bool,
}

fn default_multiplexer() -> String {
    "tmux".to_string()
}

fn default_updated_at() -> DateTime<Utc> {
    Utc::now()
}

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let created_at: String = row.get(7)?;
    let updated_at: String = row.get(8)?;
    let status: String = row.get(9)?;
    let archived_at: Option<String> = row.get(13)?;
    let initial_commit: Option<String> = row.get(6)?;
    let is_local: i64 = row.get(14)?;
    let code_additions: i64 = row.get(15)?;
    let code_deletions: i64 = row.get(16)?;
    let files_changed: i64 = row.get(17)?;

    Ok(Task {
        id: row.get(1)?,
        name: row.get(2)?,
        branch: row.get(3)?,
        target: row.get(4)?,
        worktree_path: row.get(5)?,
        initial_commit,
        created_at: parse_dt(&created_at),
        updated_at: parse_dt(&updated_at),
        status: match status.as_str() {
            "archived" => TaskStatus::Archived,
            _ => TaskStatus::Active,
        },
        multiplexer: row.get(10)?,
        session_name: row.get(11)?,
        created_by: row.get(12)?,
        archived_at: archived_at.map(|s| parse_dt(&s)),
        is_local: is_local != 0,
        code_additions: code_additions as u32,
        code_deletions: code_deletions as u32,
        files_changed: files_changed as u32,
    })
}

const TASK_COLUMNS: &str = "project, id, name, branch, target, worktree_path, initial_commit, created_at, updated_at, status, multiplexer, session_name, created_by, archived_at, is_local, code_additions, code_deletions, files_changed";

/// 加载活跃任务列表
pub fn load_tasks(project: &str) -> Result<Vec<Task>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM tasks WHERE project = ?1 AND status = 'active' ORDER BY updated_at DESC",
        TASK_COLUMNS
    ))?;
    let tasks = stmt
        .query_map(params![project], row_to_task)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(tasks)
}

/// 加载归档任务列表
pub fn load_archived_tasks(project: &str) -> Result<Vec<Task>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM tasks WHERE project = ?1 AND status = 'archived' ORDER BY updated_at DESC",
        TASK_COLUMNS
    ))?;
    let tasks = stmt
        .query_map(params![project], row_to_task)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(tasks)
}

/// 添加单个任务
pub fn add_task(project: &str, task: Task) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        &format!("INSERT INTO tasks ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)", TASK_COLUMNS),
        params![
            project,
            task.id,
            task.name,
            task.branch,
            task.target,
            task.worktree_path,
            task.initial_commit,
            task.created_at.to_rfc3339(),
            task.updated_at.to_rfc3339(),
            match task.status { TaskStatus::Active => "active", TaskStatus::Archived => "archived" },
            task.multiplexer,
            task.session_name,
            task.created_by,
            task.archived_at.map(|t| t.to_rfc3339()),
            task.is_local as i64,
            task.code_additions as i64,
            task.code_deletions as i64,
            task.files_changed as i64,
        ],
    )?;
    Ok(())
}

/// Update mutable Local Task metadata (name, branch, target, worktree_path).
/// Used by `loader.rs::ensure_local_task_synced` when the project's branch /
/// path drifts. Plain UPDATE — INSERT would collide on the (project, id)
/// primary key and be silently swallowed by callers that ignore the error.
pub fn update_local_task(project: &str, task: &Task) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE tasks SET name = ?1, branch = ?2, target = ?3, worktree_path = ?4, updated_at = ?5
         WHERE project = ?6 AND id = ?7",
        params![
            task.name,
            task.branch,
            task.target,
            task.worktree_path,
            Utc::now().to_rfc3339(),
            project,
            task.id,
        ],
    )?;
    Ok(())
}

/// Snapshot git diff stats onto an archived task. Worktree no longer exists
/// after archival, so this is the only chance to record per-task line counts
/// for stats. Restored after the v2.4 migration accidentally dropped it.
pub fn update_archived_task_code_stats(
    project: &str,
    task_id: &str,
    additions: u32,
    deletions: u32,
    files_changed: u32,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE tasks SET code_additions = ?1, code_deletions = ?2, files_changed = ?3
         WHERE project = ?4 AND id = ?5 AND status = 'archived'",
        params![
            additions as i64,
            deletions as i64,
            files_changed as i64,
            project,
            task_id,
        ],
    )?;
    Ok(())
}

/// 归档任务
pub fn archive_task(project: &str, task_id: &str) -> Result<Option<Task>> {
    let task = get_task(project, task_id)?;
    if task.is_none() {
        return Ok(None);
    }
    let now = Utc::now().to_rfc3339();
    {
        let conn = crate::storage::database::connection();
        conn.execute(
            "UPDATE tasks SET status = 'archived', updated_at = ?1, archived_at = ?1 WHERE project = ?2 AND id = ?3 AND status = 'active'",
            params![now, project, task_id],
        )?;
    }
    // `conn` released; `get_task_any` re-acquires the global mutex.
    // std::sync::Mutex is not reentrant — without the scope above,
    // the inner call would deadlock against our own outer guard.
    get_task_any(project, task_id)
}

/// 恢复任务
pub fn recover_task(project: &str, task_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE tasks SET status = 'active', updated_at = ?1, archived_at = NULL WHERE project = ?2 AND id = ?3 AND status = 'archived'",
        params![now, project, task_id],
    )?;
    Ok(())
}

/// 删除活跃任务
pub fn remove_task(project: &str, task_id: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    crate::storage::agent_graph::cascade_delete_for_task(&tx, project, task_id)?;
    tx.execute(
        "DELETE FROM tasks WHERE project = ?1 AND id = ?2",
        params![project, task_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 删除归档任务
pub fn remove_archived_task(project: &str, task_id: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    crate::storage::agent_graph::cascade_delete_for_task(&tx, project, task_id)?;
    tx.execute(
        "DELETE FROM tasks WHERE project = ?1 AND id = ?2 AND status = 'archived'",
        params![project, task_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 更新任务的 target branch
pub fn update_task_target(project: &str, task_id: &str, new_target: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE tasks SET target = ?1, updated_at = ?2 WHERE project = ?3 AND id = ?4",
        params![new_target, Utc::now().to_rfc3339(), project, task_id],
    )?;
    Ok(())
}

/// 更新 task 的 updated_at 时间戳
pub fn touch_task(project: &str, task_id: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE project = ?2 AND id = ?3",
        params![Utc::now().to_rfc3339(), project, task_id],
    )?;
    Ok(())
}

/// 更新 task 的 multiplexer 和 session_name
pub fn persist_task_session(
    project: &str,
    task_id: &str,
    multiplexer: &str,
    session_name: &str,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE tasks SET multiplexer = ?1, session_name = ?2, updated_at = ?3 WHERE project = ?4 AND id = ?5",
        params![multiplexer, session_name, Utc::now().to_rfc3339(), project, task_id],
    )?;
    Ok(())
}

/// 根据 task_id 获取活跃任务
pub fn get_task(project: &str, task_id: &str) -> Result<Option<Task>> {
    let conn = crate::storage::database::connection();
    let task = conn
        .query_row(
            &format!(
                "SELECT {} FROM tasks WHERE project = ?1 AND id = ?2 AND status = 'active'",
                TASK_COLUMNS
            ),
            params![project, task_id],
            row_to_task,
        )
        .optional()?;
    Ok(task)
}

/// 根据 task_id 获取归档任务
pub fn get_archived_task(project: &str, task_id: &str) -> Result<Option<Task>> {
    let conn = crate::storage::database::connection();
    let task = conn
        .query_row(
            &format!(
                "SELECT {} FROM tasks WHERE project = ?1 AND id = ?2 AND status = 'archived'",
                TASK_COLUMNS
            ),
            params![project, task_id],
            row_to_task,
        )
        .optional()?;
    Ok(task)
}

/// 根据 task_id 获取任务（不限状态）
fn get_task_any(project: &str, task_id: &str) -> Result<Option<Task>> {
    let conn = crate::storage::database::connection();
    let task = conn
        .query_row(
            &format!(
                "SELECT {} FROM tasks WHERE project = ?1 AND id = ?2",
                TASK_COLUMNS
            ),
            params![project, task_id],
            row_to_task,
        )
        .optional()?;
    Ok(task)
}

fn build_local_task(
    repo_path: &str,
    current_branch: &str,
    default_branch: &str,
    project_name: &str,
) -> Task {
    let now = Utc::now();
    Task {
        id: LOCAL_TASK_ID.to_string(),
        name: project_name.to_string(),
        branch: current_branch.to_string(),
        target: default_branch.to_string(),
        worktree_path: repo_path.to_string(),
        initial_commit: None,
        created_at: now,
        updated_at: now,
        status: TaskStatus::Active,
        multiplexer: "tmux".to_string(),
        session_name: String::new(),
        created_by: "system".to_string(),
        archived_at: None,
        code_additions: 0,
        code_deletions: 0,
        files_changed: 0,
        is_local: true,
    }
}

/// Ensure the Local Task for a project exists in the database.
///
/// Called at project registration time (`add_project`, `create_new_project`,
/// `auto_register_cwd_if_git_repo`). If the Local Task already exists, this
/// is a no-op — the sync-on-read path in `loader::ensure_local_task_synced`
/// handles keeping branch/target/path/name up to date.
pub fn ensure_local_task(
    project_key: &str,
    project_path: &str,
    project_name: &str,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM tasks WHERE project = ?1 AND id = ?2 LIMIT 1",
            params![project_key, LOCAL_TASK_ID],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if exists {
        return Ok(());
    }
    drop(conn);

    let is_git = crate::git::is_git_repo(project_path);
    let (current_branch, default_branch) = if is_git {
        let cur = crate::git::current_branch(project_path).unwrap_or_else(|_| "main".to_string());
        let def = crate::git::default_branch(project_path);
        (cur, def)
    } else {
        (String::new(), String::new())
    };

    let task = build_local_task(project_path, &current_branch, &default_branch, project_name);
    add_task(project_key, task)
}

/// 生成全局唯一 chat/session ID ("chat-<uuid>")
pub fn generate_chat_id() -> String {
    format!("chat-{}", uuid::Uuid::new_v4().simple())
}

// ========== Chat Session 存储 (独立 chats.toml) ==========

/// Chat 列表容器 (用于 TOML 序列化)
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct ChatsFile {
    #[serde(default)]
    pub(crate) chats: Vec<ChatSession>,
}

/// 获取 chats.toml 路径: ~/.grove/projects/{project}/tasks/{task_id}/chats/chats.toml
pub(crate) fn chats_file_path(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = super::ensure_task_data_dir(project, task_id)?.join("chats");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("chats.toml"))
}

#[allow(dead_code)]
pub(crate) fn load_chat_sessions_from_toml(
    project: &str,
    task_id: &str,
) -> Result<Vec<ChatSession>> {
    let path = chats_file_path(project, task_id)?;
    if path.exists() {
        let file: ChatsFile = super::load_toml(&path)?;
        return Ok(file.chats);
    }

    Ok(Vec::new())
}

#[allow(dead_code)]
fn save_chat_sessions(project: &str, task_id: &str, chats: &[ChatSession]) -> Result<()> {
    let path = chats_file_path(project, task_id)?;
    let file = ChatsFile {
        chats: chats.to_vec(),
    };
    super::save_toml(&path, &file)
}

fn row_to_chat_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSession> {
    let created_at: String = row.get(4)?;
    let created_at = DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    Ok(ChatSession {
        id: row.get(0)?,
        title: row.get(1)?,
        agent: row.get(2)?,
        acp_session_id: row.get(3)?,
        created_at,
        duty: row.get(5)?,
    })
}

/// 加载 task 的所有 chat sessions
pub fn load_chat_sessions(project: &str, task_id: &str) -> Result<Vec<ChatSession>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT session_id, title, agent, acp_session_id, created_at, duty
         FROM session
         WHERE project = ?1 AND task_id = ?2
         ORDER BY created_at ASC",
    )?;
    let chats = stmt
        .query_map(params![project, task_id], row_to_chat_session)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(chats)
}

/// 添加 ChatSession
pub fn add_chat_session(project: &str, task_id: &str, chat: ChatSession) -> Result<()> {
    let conn = crate::storage::database::connection();
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT project, task_id FROM session WHERE session_id = ?1",
            params![chat.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((existing_project, existing_task)) = existing {
        if existing_project != project || existing_task != task_id {
            return Err(GroveError::storage("duplicate session_id"));
        }
    }
    conn.execute(
        "INSERT INTO session
         (session_id, project, task_id, title, agent, acp_session_id, duty, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_id) DO UPDATE SET
            title = excluded.title,
            agent = excluded.agent,
            acp_session_id = excluded.acp_session_id,
            duty = excluded.duty,
            created_at = excluded.created_at",
        params![
            chat.id,
            project,
            task_id,
            chat.title,
            chat.agent,
            chat.acp_session_id,
            chat.duty,
            chat.created_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

/// 更新 ChatSession 的标题
pub fn update_chat_title(project: &str, task_id: &str, chat_id: &str, title: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE session SET title = ?1 WHERE project = ?2 AND task_id = ?3 AND session_id = ?4",
        params![title, project, task_id, chat_id],
    )?;
    Ok(())
}

/// 更新 ChatSession 的 ACP session ID
pub fn update_chat_acp_session_id(
    project: &str,
    task_id: &str,
    chat_id: &str,
    session_id: &str,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE session
         SET acp_session_id = ?1
         WHERE project = ?2 AND task_id = ?3 AND session_id = ?4",
        params![session_id, project, task_id, chat_id],
    )?;
    Ok(())
}

/// 更新 ChatSession 的 duty，并实现 Duty Lock。
#[allow(dead_code)]
pub fn update_chat_duty(
    project: &str,
    task_id: &str,
    chat_id: &str,
    duty: Option<String>,
    force: bool,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    let existing: Option<Option<String>> = conn
        .query_row(
            "SELECT duty FROM session WHERE project = ?1 AND task_id = ?2 AND session_id = ?3",
            params![project, task_id, chat_id],
            |row| row.get(0),
        )
        .optional()?;

    let Some(existing_duty) = existing else {
        return Err(GroveError::storage_tagged(
            "chat_not_found",
            "chat_not_found",
        ));
    };

    // AI 不可改 duty（一旦设置就锁定）；用户编辑路径传 `force = true` 绕过此检查。
    if !force && duty.is_some() && existing_duty.is_some() {
        return Err(GroveError::storage_tagged(
            "duty_locked",
            "chat duty is locked",
        ));
    }

    conn.execute(
        "UPDATE session SET duty = ?1 WHERE project = ?2 AND task_id = ?3 AND session_id = ?4",
        params![duty, project, task_id, chat_id],
    )?;
    Ok(())
}

/// 删除 ChatSession
/// Count how many chat sessions reference `agent_str` exactly. Used by the
/// Custom Agent (persona) layer to refuse a delete / base_agent change while
/// in-flight chats still depend on the persona — see
/// `api/handlers/custom_agent.rs::delete` and `update`.
pub fn count_chats_with_agent(agent_str: &str) -> Result<i64> {
    let conn = crate::storage::database::connection();
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session WHERE agent = ?1",
        params![agent_str],
        |row| row.get(0),
    )?;
    Ok(n)
}

pub fn delete_chat_session(project: &str, task_id: &str, chat_id: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    crate::storage::agent_graph::cascade_delete_for_session(&tx, chat_id)?;
    tx.execute(
        "DELETE FROM session WHERE project = ?1 AND task_id = ?2 AND session_id = ?3",
        params![project, task_id, chat_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 获取 task 的某个 chat session
pub fn get_chat_session(
    project: &str,
    task_id: &str,
    chat_id: &str,
) -> Result<Option<ChatSession>> {
    let conn = crate::storage::database::connection();
    let chat = conn
        .query_row(
            "SELECT session_id, title, agent, acp_session_id, created_at, duty
             FROM session
             WHERE project = ?1 AND task_id = ?2 AND session_id = ?3",
            params![project, task_id, chat_id],
            row_to_chat_session,
        )
        .optional()?;
    Ok(chat)
}

/// 反查：仅给 chat_id，返回该 chat 所属的 (project, task_id, ChatSession)。
/// agent_graph 工具用，agent 调工具时只携带 chat_id，需要据此定位 task 上下文。
#[allow(dead_code)]
pub fn find_chat_session(chat_id: &str) -> Result<Option<(String, String, ChatSession)>> {
    let conn = crate::storage::database::connection();
    let row = conn
        .query_row(
            "SELECT project, task_id, session_id, title, agent, acp_session_id, created_at, duty
             FROM session
             WHERE session_id = ?1",
            params![chat_id],
            |row| {
                let project: String = row.get(0)?;
                let task_id: String = row.get(1)?;
                let created_at: String = row.get(6)?;
                let created_at = DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                Ok((
                    project,
                    task_id,
                    ChatSession {
                        id: row.get(2)?,
                        title: row.get(3)?,
                        agent: row.get(4)?,
                        acp_session_id: row.get(5)?,
                        created_at,
                        duty: row.get(7)?,
                    },
                ))
            },
        )
        .optional()?;
    Ok(row)
}

/// 生成 slug (用于任务 ID 和目录名)
pub fn to_slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// 基于当前时间戳生成 6 位短哈希
fn generate_time_hash() -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    let mut hash = FNV_OFFSET_BASIS;
    for byte in timestamp.to_le_bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:06x}", hash & 0xFFFFFF)
}

/// 截断 slug 到最多 max_words 个单词
fn truncate_to_words(slug: &str, max_words: usize) -> String {
    slug.split('-')
        .take(max_words)
        .collect::<Vec<_>>()
        .join("-")
}

/// 生成分支名核心逻辑（不含哈希后缀）
fn generate_branch_name_base(task_name: &str, max_words: usize) -> String {
    if let Some(slash_idx) = task_name.find('/') {
        // 用户提供了前缀 - 只取第一个 / 前面的
        let prefix = &task_name[..slash_idx];
        let body = &task_name[slash_idx + 1..];
        let prefix_slug = to_slug(prefix);
        let body_slug = truncate_to_words(&to_slug(body), max_words);

        if prefix_slug.is_empty() {
            // 前缀为空（比如 "/xxx"）→ 使用默认 grove/
            if body_slug.is_empty() {
                "grove/task".to_string()
            } else {
                format!("grove/{}", body_slug)
            }
        } else if body_slug.is_empty() {
            format!("{}/task", prefix_slug)
        } else {
            format!("{}/{}", prefix_slug, body_slug)
        }
    } else {
        // 没有 / → 默认使用 grove/ 前缀
        let slug = truncate_to_words(&to_slug(task_name), max_words);
        if slug.is_empty() {
            "grove/task".to_string()
        } else {
            format!("grove/{}", slug)
        }
    }
}

/// 生成分支名（用于实际创建分支）
/// - 如果 task_name 包含 `/`，使用第一个 `/` 前面的作为前缀
/// - 否则使用默认前缀 `grove/`
/// - 所有非法字符由 to_slug() 处理（转为 -，合并连续 -）
/// - 限制最多 3 个单词
/// - 添加 6 位时间戳哈希后缀防止重名
pub fn generate_branch_name(task_name: &str) -> String {
    let base = generate_branch_name_base(task_name, 3);
    let hash = generate_time_hash();
    format!("{}-{}", base, hash)
}

/// 生成分支名预览（用于 UI 显示）
/// 显示 `<hash>` 占位符而非实际哈希值
pub fn preview_branch_name(task_name: &str) -> String {
    let base = generate_branch_name_base(task_name, 3);
    format!("{}-<hash>", base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_slug() {
        assert_eq!(to_slug("Add OAuth login"), "add-oauth-login");
        assert_eq!(to_slug("Fix: header bug"), "fix-header-bug");
        assert_eq!(to_slug("  multiple   spaces  "), "multiple-spaces");
    }

    #[test]
    fn test_truncate_to_words() {
        assert_eq!(
            truncate_to_words("add-oauth-login-support", 3),
            "add-oauth-login"
        );
        assert_eq!(truncate_to_words("bug", 3), "bug");
        assert_eq!(truncate_to_words("a-b-c-d-e", 3), "a-b-c");
        assert_eq!(truncate_to_words("single", 3), "single");
    }

    #[test]
    fn test_generate_branch_name_base() {
        // 用户提供前缀 - 限制 3 个单词
        assert_eq!(
            generate_branch_name_base("fix/header bug", 3),
            "fix/header-bug"
        );
        assert_eq!(
            generate_branch_name_base("feature/add oauth login support for github", 3),
            "feature/add-oauth-login"
        );
        assert_eq!(
            generate_branch_name_base("hotfix/urgent", 3),
            "hotfix/urgent"
        );

        // 默认 grove/ 前缀 - 限制 3 个单词
        assert_eq!(
            generate_branch_name_base("Add new feature for testing", 3),
            "grove/add-new-feature"
        );
        assert_eq!(
            generate_branch_name_base("Fix: header bug", 3),
            "grove/fix-header-bug"
        );

        // 边缘情况
        assert_eq!(generate_branch_name_base("fix/", 3), "fix/task");
        assert_eq!(generate_branch_name_base("   ", 3), "grove/task");
        assert_eq!(generate_branch_name_base("/xxx", 3), "grove/xxx");
    }

    #[test]
    fn test_generate_branch_name_has_hash() {
        let branch = generate_branch_name("feature/add oauth login support");
        // 格式: feature/add-oauth-login-xxxxxx
        assert!(branch.starts_with("feature/add-oauth-login-"));
        // 最后 6 位是哈希
        let hash_part = branch.split('-').next_back().unwrap();
        assert_eq!(hash_part.len(), 6);
        // 哈希应该是十六进制
        assert!(hash_part.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_preview_branch_name() {
        assert_eq!(
            preview_branch_name("feature/add oauth login support for github"),
            "feature/add-oauth-login-<hash>"
        );
        assert_eq!(preview_branch_name("fix/bug"), "fix/bug-<hash>");
        assert_eq!(
            preview_branch_name("Add new feature for testing"),
            "grove/add-new-feature-<hash>"
        );
    }

    #[test]
    fn test_generate_time_hash() {
        let hash1 = generate_time_hash();
        assert_eq!(hash1.len(), 6);
        assert!(hash1.chars().all(|c| c.is_ascii_hexdigit()));

        // 生成两次，应该不同（时间不同）
        std::thread::sleep(std::time::Duration::from_millis(1));
        let hash2 = generate_time_hash();
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_generate_chat_id_is_uuid_backed() {
        let id = generate_chat_id();
        let uuid = id.strip_prefix("chat-").expect("chat prefix");

        assert_eq!(uuid.len(), 32);
        assert!(uuid.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_chat_session_old_toml_without_duty() {
        let old_toml = r#"
id = "chat-abc123"
title = "Test Chat"
agent = "claude"
created_at = "2025-01-01T00:00:00Z"
"#;
        let session: ChatSession = toml::from_str(old_toml).expect("old toml should parse");
        assert_eq!(session.id, "chat-abc123");
        assert!(session.duty.is_none());
        assert!(session.acp_session_id.is_none());
    }

    #[test]
    fn test_chat_session_duty_none_no_emit() {
        let session = ChatSession {
            id: "chat-xyz789".to_string(),
            title: "Test".to_string(),
            agent: "codex".to_string(),
            acp_session_id: None,
            created_at: chrono::DateTime::parse_from_rfc3339("2025-06-01T12:00:00Z")
                .unwrap()
                .to_utc(),
            duty: None,
        };
        let toml_str = toml::to_string(&session).unwrap();
        assert!(
            !toml_str.contains("duty"),
            "duty=None should not emit: {}",
            toml_str
        );
    }

    #[test]
    fn test_chat_session_duty_some_roundtrip() {
        let mut session = ChatSession {
            id: "chat-abc".to_string(),
            title: "Reviewer".to_string(),
            agent: "claude".to_string(),
            acp_session_id: Some("acp-123".to_string()),
            created_at: chrono::DateTime::parse_from_rfc3339("2025-06-01T00:00:00Z")
                .unwrap()
                .to_utc(),
            duty: Some("code review".to_string()),
        };
        let toml_str = toml::to_string(&session).unwrap();
        let restored: ChatSession = toml::from_str(&toml_str).unwrap();
        assert_eq!(restored.duty, Some("code review".to_string()));

        session.duty = None;
        let toml_str2 = toml::to_string(&session).unwrap();
        assert!(!toml_str2.contains("duty"));
    }
}
