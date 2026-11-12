use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{GroveError, Result};

/// Local Task 的固定 ID
pub const LOCAL_TASK_ID: &str = "_local";
/// Internal TaskChat storage namespace for Memory Organization chats.
/// This is not a persisted Task record.
pub const MEMORY_TASK_ID: &str = "_memory";

/// Chat 会话（一个 Task 下可以有多个 Chat）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    /// Chat ID ("chat-XXXXXX")
    pub id: String,
    /// 标题 ("New Chat 2025-02-16 14:30")
    pub title: String,
    /// Agent 名称 ("claude", "codex", etc.)
    pub agent: String,
    /// ACP session ID（用于 load_session 恢复对话历史）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 职能描述（Agent Graph 引入）。一旦设定，AI 不可改；仅用户可改。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
}

/// `session.readonly_reason`: restored from an export; the Agent's own session
/// stayed on the source machine.
#[allow(dead_code)] // written by the importer
pub const READONLY_IMPORTED: &str = "imported";
/// `session.readonly_reason`: the Agent pruned its local session.
pub const READONLY_AGENT_EXPIRED: &str = "agent_expired";

/// A Session whose Agent cannot be resumed. Permanent; the history stays readable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatReadOnly {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
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
    add_task_on(&conn, project, task)
}

pub(crate) fn add_task_on(conn: &rusqlite::Connection, project: &str, task: Task) -> Result<()> {
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
    if !task.is_local && task.status == TaskStatus::Active {
        place_task_on_top(conn, project, &task.id)?;
    }
    Ok(())
}

/// Step between adjacent `sort_position` values written by [`reorder_tasks`].
const SORT_POSITION_STEP: i64 = 1_000;

/// Move a task above every other placed task in its project.
fn place_task_on_top(conn: &rusqlite::Connection, project: &str, task_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET sort_position = (
             SELECT COALESCE(MIN(sort_position), ?3) - ?3 FROM tasks
             WHERE project = ?1 AND id != ?2 AND sort_position IS NOT NULL
         )
         WHERE project = ?1 AND id = ?2",
        params![project, task_id, SORT_POSITION_STEP],
    )?;
    Ok(())
}

/// User-defined sidebar order of a project's active tasks: task id → rank
/// (ascending). Tasks never placed are absent.
pub fn load_task_order(project: &str) -> Result<std::collections::HashMap<String, i64>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT id, sort_position FROM tasks
         WHERE project = ?1 AND status = 'active' AND sort_position IS NOT NULL",
    )?;
    let order = stmt
        .query_map(params![project], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(order)
}

/// Persist a new sidebar order. `task_ids` lists active tasks top to bottom;
/// tasks not listed keep their current rank.
pub fn reorder_tasks(project: &str, task_ids: &[String]) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    for (index, task_id) in task_ids.iter().enumerate() {
        tx.execute(
            "UPDATE tasks SET sort_position = ?1
             WHERE project = ?2 AND id = ?3 AND status = 'active' AND is_local = 0",
            params![(index as i64 + 1) * SORT_POSITION_STEP, project, task_id],
        )?;
    }
    tx.commit()?;
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
    if task_id == LOCAL_TASK_ID {
        return Err(GroveError::invalid_data("Cannot archive local task"));
    }
    let task = get_task(project, task_id)?;
    if task.is_none() {
        return Ok(None);
    }
    let now = Utc::now().to_rfc3339();
    let changed = {
        let conn = crate::storage::database::connection();
        conn.execute(
            "UPDATE tasks SET status = 'archived', updated_at = ?1, archived_at = ?1 WHERE project = ?2 AND id = ?3 AND status = 'active'",
            params![now, project, task_id],
        )?
    };
    if changed > 0 {
        crate::automation::events::emit(
            project.to_string(),
            "task.finished",
            serde_json::json!({ "task_id": task_id }),
        );
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
    let changed = conn.execute(
        "UPDATE tasks SET status = 'active', updated_at = ?1, archived_at = NULL WHERE project = ?2 AND id = ?3 AND status = 'archived'",
        params![now, project, task_id],
    )?;
    if changed > 0 {
        // A recovered task re-enters the sidebar like a new one: at the top.
        place_task_on_top(&conn, project, task_id)?;
    }
    Ok(())
}

/// 删除活跃任务
pub fn remove_task(project: &str, task_id: &str) -> Result<()> {
    if task_id == LOCAL_TASK_ID {
        return Err(GroveError::invalid_data("Cannot delete local task"));
    }
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    crate::storage::agent_graph::cascade_delete_for_task(&tx, project, task_id)?;
    crate::storage::shares::delete_task_shares(&tx, project, task_id)?;
    tx.execute(
        "DELETE FROM task_linked_projects WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
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
    crate::storage::shares::delete_task_shares(&tx, project, task_id)?;
    tx.execute(
        "DELETE FROM task_linked_projects WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
    tx.execute(
        "DELETE FROM tasks WHERE project = ?1 AND id = ?2 AND status = 'archived'",
        params![project, task_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 更新任务名称
pub fn update_task_name(project: &str, task_id: &str, new_name: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    let affected = conn.execute(
        "UPDATE tasks SET name = ?1, updated_at = ?2 WHERE project = ?3 AND id = ?4",
        params![new_name, Utc::now().to_rfc3339(), project, task_id],
    )?;
    if affected == 0 {
        return Err(GroveError::not_found(format!(
            "task {task_id} not found in project {project}"
        )));
    }
    Ok(())
}

/// Project IDs linked into a Task's ACP workspace, in user-defined order.
pub fn load_linked_project_ids(project: &str, task_id: &str) -> Result<Vec<String>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT linked_project_id FROM task_linked_projects
         WHERE project = ?1 AND task_id = ?2 ORDER BY position, linked_project_id",
    )?;
    let ids = stmt
        .query_map(params![project, task_id], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Atomically replace the Task's linked Project IDs.
pub fn replace_linked_project_ids(
    project: &str,
    task_id: &str,
    linked_project_ids: &[String],
) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM task_linked_projects WHERE project = ?1 AND task_id = ?2",
        params![project, task_id],
    )?;
    for (position, linked_project_id) in linked_project_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO task_linked_projects
             (project, task_id, linked_project_id, position) VALUES (?1, ?2, ?3, ?4)",
            params![project, task_id, linked_project_id, position as i64],
        )?;
    }
    tx.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE project = ?2 AND id = ?3",
        params![Utc::now().to_rfc3339(), project, task_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// Project-level default linked Project IDs, in user-defined order.
///
/// These are only a template: a new user-created Task copies them once via
/// [`copy_project_linked_projects_to_task`]; nothing reads them live.
pub fn load_project_linked_project_ids(project: &str) -> Result<Vec<String>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT linked_project_id FROM project_linked_projects
         WHERE project = ?1 ORDER BY position, linked_project_id",
    )?;
    let ids = stmt
        .query_map(params![project], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Atomically replace the Project's default linked Project IDs.
pub fn replace_project_linked_project_ids(
    project: &str,
    linked_project_ids: &[String],
) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM project_linked_projects WHERE project = ?1",
        params![project],
    )?;
    for (position, linked_project_id) in linked_project_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO project_linked_projects
             (project, linked_project_id, position) VALUES (?1, ?2, ?3)",
            params![project, linked_project_id, position as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Seed a freshly created Task's linked Projects from its Project's default
/// set. This is a one-time copy: later edits on either side stay independent.
/// A self-link and archived Projects (treated as removed) are skipped;
/// unregistered IDs are copied as-is and handled by the ACP resolver exactly
/// like a Task-level stale link.
pub fn copy_project_linked_projects_to_task(project: &str, task_id: &str) -> Result<()> {
    let archived: std::collections::HashSet<String> =
        crate::storage::workspace::load_archived_projects()?
            .iter()
            .map(|archived| crate::storage::workspace::project_hash(&archived.path))
            .collect();
    let ids: Vec<String> = load_project_linked_project_ids(project)?
        .into_iter()
        .filter(|id| id != project && !archived.contains(id))
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    replace_linked_project_ids(project, task_id, &ids)
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

/// 根据 ACP session_id (chat_id) 反查所属 (project, task_id, task_name)。
///
/// 用于 grove_browser_* MCP 工具：caller agent 的 chat_id 通过 URL 路径 token
/// 拿到后，需要查出对应 task 的 name 作为 Chrome Tab Group 的标题。
/// 包含已归档任务（agent 在归档完成前还可能继续调用）。
///
/// 用单条 SQL JOIN 而不是两次查询 —— `DbGuard` 持有的是 std::sync::MutexGuard，
/// 同线程二次 `connection()` 会在 macOS pthread 上死锁，把整个 grove 卡死。
pub fn session_to_task(session_id: &str) -> Result<Option<(String, String, String)>> {
    let conn = crate::storage::database::connection();
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT s.project, s.task_id, t.name \
             FROM session s \
             INNER JOIN tasks t ON t.project = s.project AND t.id = s.task_id \
             WHERE s.session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(row)
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

pub(crate) fn build_local_task(
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
pub fn ensure_local_task(project_key: &str, project_path: &str, project_name: &str) -> Result<()> {
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
    // Race-tolerant: between the existence check above and add_task,
    // another thread (loader backfill / parallel registration) could
    // have inserted the row. Treat the unique-violation as success
    // — the post-condition ("a Local Task row exists") is satisfied.
    match add_task(project_key, task) {
        Ok(()) => Ok(()),
        Err(e) => {
            let conn = crate::storage::database::connection();
            let exists_now: bool = conn
                .query_row(
                    "SELECT 1 FROM tasks WHERE project = ?1 AND id = ?2 LIMIT 1",
                    params![project_key, LOCAL_TASK_ID],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if exists_now {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
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
        "SELECT session_id, title, COALESCE((SELECT bs.agent FROM buddy_segments bs WHERE bs.session_id = session.session_id AND bs.ended_at IS NOT NULL), agent), acp_session_id, created_at, duty
         FROM session
         WHERE project = ?1 AND task_id = ?2 AND archived_at IS NULL
         ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC",
    )?;
    let chats = stmt
        .query_map(params![project, task_id], row_to_chat_session)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(chats)
}

/// The Sessions of a Task an Agent can still run in. Read-only Sessions stay in
/// `load_chat_sessions` so they can be viewed; anything that sends to a Session
/// or offers it as a target lists from here.
pub fn load_writable_chat_sessions(project: &str, task_id: &str) -> Result<Vec<ChatSession>> {
    let readonly = load_readonly_chats(project, task_id)?;
    let mut chats = load_chat_sessions(project, task_id)?;
    chats.retain(|chat| !readonly.contains_key(&chat.id));
    Ok(chats)
}

fn parse_readonly(reason: String, meta: Option<String>) -> ChatReadOnly {
    ChatReadOnly {
        reason,
        meta: meta.and_then(|meta| serde_json::from_str(&meta).ok()),
    }
}

/// Read-only Sessions of a Task, archived ones included.
pub fn load_readonly_chats(
    project: &str,
    task_id: &str,
) -> Result<std::collections::HashMap<String, ChatReadOnly>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT session_id, readonly_reason, readonly_meta FROM session
         WHERE project = ?1 AND task_id = ?2 AND readonly_reason IS NOT NULL",
    )?;
    let rows = stmt
        .query_map(params![project, task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                parse_readonly(row.get(1)?, row.get(2)?),
            ))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

pub fn chat_readonly(chat_id: &str) -> Result<Option<ChatReadOnly>> {
    let conn = crate::storage::database::try_connection()?;
    Ok(conn
        .query_row(
            "SELECT readonly_reason, readonly_meta FROM session
             WHERE session_id = ?1 AND readonly_reason IS NOT NULL",
            [chat_id],
            |row| Ok(parse_readonly(row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// Every Agent start passes through here, so one check covers the WebSocket,
/// MCP, Automations, Agent Graph and Connect.
pub fn ensure_chat_writable(chat_id: &str) -> Result<()> {
    match chat_readonly(chat_id)? {
        Some(readonly) => Err(crate::error::GroveError::storage_tagged(
            "session_read_only",
            format!(
                "Session {chat_id} is read-only ({}); its Agent cannot be resumed. Read its history instead.",
                readonly.reason
            ),
        )),
        None => Ok(()),
    }
}

/// Make a Session read-only and drop what was waiting on its Agent. Returns
/// false when nothing changed. A Buddy Segment is never marked: the Buddy owns
/// its lifecycle, and a read-only active Segment would lock the Buddy out.
pub fn mark_chat_readonly(
    project: &str,
    task_id: &str,
    chat_id: &str,
    reason: &str,
    meta: serde_json::Value,
) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE session SET readonly_reason = ?1, readonly_meta = ?2, acp_session_id = NULL
         WHERE project = ?3 AND task_id = ?4 AND session_id = ?5 AND readonly_reason IS NULL
           AND NOT EXISTS (SELECT 1 FROM buddy_segments WHERE session_id = ?5)",
        params![reason, meta.to_string(), project, task_id, chat_id],
    )? > 0;
    if changed {
        tx.execute(
            "DELETE FROM agent_pending_message WHERE from_session = ?1 OR to_session = ?1",
            [chat_id],
        )?;
        tx.execute(
            "UPDATE task_group_slots SET target_chat_id = NULL WHERE target_chat_id = ?1",
            [chat_id],
        )?;
    }
    tx.commit()?;
    Ok(changed)
}

/// Last activity per active Session of a Task: session_id →
/// `COALESCE(updated_at, created_at)` as stored (RFC 3339). This is the value
/// `load_chat_sessions` orders by.
pub fn load_chat_activity(
    project: &str,
    task_id: &str,
) -> Result<std::collections::HashMap<String, String>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT session_id, COALESCE(updated_at, created_at) FROM session
         WHERE project = ?1 AND task_id = ?2 AND archived_at IS NULL",
    )?;
    let rows = stmt
        .query_map(params![project, task_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// Every active Session of a Project as (task_id, session_id, title), newest first.
pub fn list_project_sessions(project: &str) -> Result<Vec<(String, String, String)>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT task_id, session_id, title FROM session
         WHERE project = ?1 AND archived_at IS NULL
         ORDER BY COALESCE(updated_at, created_at) DESC",
    )?;
    let rows = stmt
        .query_map(params![project], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Load archived sessions for the dedicated read-only SessionList section.
/// Normal discovery paths intentionally use `load_chat_sessions` and therefore
/// cannot see these rows until they are restored.
pub fn load_archived_chat_sessions(project: &str, task_id: &str) -> Result<Vec<ChatSession>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT session_id, title, COALESCE((SELECT bs.agent FROM buddy_segments bs WHERE bs.session_id = session.session_id AND bs.ended_at IS NOT NULL), agent), acp_session_id, created_at, duty
         FROM session
         WHERE project = ?1 AND task_id = ?2 AND archived_at IS NOT NULL
         ORDER BY archived_at DESC",
    )?;
    let chats = stmt
        .query_map(params![project, task_id], row_to_chat_session)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(chats)
}

/// IDs of a task's active sessions pinned to the top of its session list.
pub fn load_pinned_chat_ids(
    project: &str,
    task_id: &str,
) -> Result<std::collections::HashSet<String>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT session_id FROM session
         WHERE project = ?1 AND task_id = ?2 AND archived_at IS NULL AND pinned_at IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![project, task_id], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(ids)
}

/// Pin or unpin an active session. Returns false when no active session matched.
pub fn set_chat_session_pinned(
    project: &str,
    task_id: &str,
    chat_id: &str,
    pinned: bool,
) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let pinned_at = pinned.then(|| Utc::now().to_rfc3339());
    let changed = conn.execute(
        "UPDATE session SET pinned_at = ?1
         WHERE project = ?2 AND task_id = ?3 AND session_id = ?4 AND archived_at IS NULL",
        params![pinned_at, project, task_id, chat_id],
    )?;
    Ok(changed > 0)
}

/// Archiving also unpins: a restored session comes back as an ordinary one.
pub fn archive_chat_session(project: &str, task_id: &str, chat_id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let changed = conn.execute(
        "UPDATE session SET archived_at = ?1, pinned_at = NULL
         WHERE project = ?2 AND task_id = ?3 AND session_id = ?4 AND archived_at IS NULL",
        params![Utc::now().to_rfc3339(), project, task_id, chat_id],
    )?;
    Ok(changed > 0)
}

pub fn restore_chat_session(project: &str, task_id: &str, chat_id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let changed = conn.execute(
        "UPDATE session SET archived_at = NULL
         WHERE project = ?1 AND task_id = ?2 AND session_id = ?3 AND archived_at IS NOT NULL",
        params![project, task_id, chat_id],
    )?;
    Ok(changed > 0)
}

/// Mark a session as recently active without changing any presentation metadata.
/// Archived sessions are deliberately excluded: activity cannot implicitly restore one.
pub fn touch_chat_session(project: &str, task_id: &str, chat_id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let changed = conn.execute(
        "UPDATE session SET updated_at = ?1
         WHERE project = ?2 AND task_id = ?3 AND session_id = ?4 AND archived_at IS NULL",
        params![Utc::now().to_rfc3339(), project, task_id, chat_id],
    )?;
    Ok(changed > 0)
}

pub fn load_acp_session_ids_for_agent(agent: &str) -> Result<std::collections::HashSet<String>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT acp_session_id FROM session WHERE agent = ?1 AND acp_session_id IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![agent], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(ids)
}

/// 添加 ChatSession
pub fn add_chat_session(project: &str, task_id: &str, chat: ChatSession) -> Result<()> {
    let conn = crate::storage::database::connection();
    add_chat_session_on(&conn, project, task_id, chat)
}

pub(crate) fn add_chat_session_on(
    conn: &rusqlite::Connection,
    project: &str,
    task_id: &str,
    chat: ChatSession,
) -> Result<()> {
    super::buddies::ensure_session_writable_on(conn, &chat.id)?;
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
         (session_id, project, task_id, title, agent, acp_session_id, duty, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(session_id) DO UPDATE SET
            title = excluded.title,
            agent = excluded.agent,
            acp_session_id = excluded.acp_session_id,
            duty = excluded.duty,
            created_at = excluded.created_at,
            updated_at = COALESCE(session.updated_at, excluded.updated_at)",
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

/// Remember the config values chosen for a Session before it existed, so its
/// first `session/new` can carry them.
pub fn set_chat_initial_config(
    project: &str,
    task_id: &str,
    chat_id: &str,
    values: &std::collections::BTreeMap<String, crate::acp::ConfigOptionValue>,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE session SET initial_config = ?1 WHERE project = ?2 AND task_id = ?3 AND session_id = ?4",
        params![serde_json::to_string(values)?, project, task_id, chat_id],
    )?;
    Ok(())
}

/// The config values chosen for a Session before it existed, if any.
pub fn chat_initial_config(
    project: &str,
    task_id: &str,
    chat_id: &str,
) -> Option<std::collections::BTreeMap<String, crate::acp::ConfigOptionValue>> {
    let conn = crate::storage::database::connection();
    let raw: Option<String> = conn
        .query_row(
            "SELECT initial_config FROM session WHERE project = ?1 AND task_id = ?2 AND session_id = ?3",
            params![project, task_id, chat_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Who set a Session's title. A title is only replaced by an equal or higher
/// source, so the user's own name always stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i64)]
pub enum TitleSource {
    /// Grove's default, or the title taken from the first prompt.
    Auto = 0,
    /// The Agent called Grove's `set_title` tool.
    AgentTool = 1,
    /// The Agent's own `session_info_update`.
    AgentInfo = 2,
    /// The user renamed it.
    User = 3,
}

/// Set a Session's title unless a higher source already set it. Returns
/// whether the title was applied.
pub fn update_chat_title(
    project: &str,
    task_id: &str,
    chat_id: &str,
    title: &str,
    source: TitleSource,
) -> Result<bool> {
    let conn = crate::storage::database::connection();
    Ok(conn.execute(
        "UPDATE session SET title = ?1, title_source = ?5
         WHERE project = ?2 AND task_id = ?3 AND session_id = ?4 AND title_source <= ?5",
        params![title, project, task_id, chat_id, source as i64],
    )? > 0)
}

/// Rename only if the title has not changed since it was inspected.
pub fn update_chat_title_if_unchanged(
    project: &str,
    task_id: &str,
    chat_id: &str,
    expected: &str,
    title: &str,
) -> Result<bool> {
    let conn = crate::storage::database::connection();
    Ok(conn.execute(
        "UPDATE session SET title = ?1
         WHERE project = ?2 AND task_id = ?3 AND session_id = ?4 AND title = ?5 AND title_source = ?6",
        params![title, project, task_id, chat_id, expected, TitleSource::Auto as i64],
    )? > 0)
}

/// Apply Agent metadata without treating a rename as new conversation activity.
/// `None` leaves a field alone; an empty title or `Some(None)` clears it.
pub fn update_chat_session_info(
    project: &str,
    task_id: &str,
    chat_id: &str,
    title: Option<&str>,
    updated_at: Option<Option<DateTime<Utc>>>,
) -> Result<bool> {
    let timestamp = updated_at
        .as_ref()
        .and_then(|value| value.map(|dt| dt.to_rfc3339()));
    let conn = crate::storage::database::connection();
    // The Agent's title replaces Grove's and the `set_title` tool's, never the
    // user's (TitleSource).
    let changed = conn.execute(
        "UPDATE session SET
            title = CASE WHEN ?1 AND title_source <= ?8 THEN ?2 ELSE title END,
            title_source = CASE WHEN ?1 AND title_source <= ?8 THEN ?8 ELSE title_source END,
            updated_at = CASE WHEN ?3 THEN ?4 ELSE updated_at END
         WHERE project = ?5 AND task_id = ?6 AND session_id = ?7
           AND ((?1 AND title_source <= ?8 AND (title IS NOT ?2 OR title_source < ?8))
                OR (?3 AND updated_at IS NOT ?4))",
        params![
            title.is_some(),
            title,
            updated_at.is_some(),
            timestamp,
            project,
            task_id,
            chat_id,
            TitleSource::AgentInfo as i64
        ],
    )?;
    Ok(changed > 0)
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
            "SELECT session_id, title, COALESCE((SELECT bs.agent FROM buddy_segments bs WHERE bs.session_id = session.session_id AND bs.ended_at IS NOT NULL), agent), acp_session_id, created_at, duty
             FROM session
             WHERE project = ?1 AND task_id = ?2 AND session_id = ?3 AND archived_at IS NULL",
            params![project, task_id, chat_id],
            row_to_chat_session,
        )
        .optional()?;
    Ok(chat)
}

/// Fetch a session regardless of lifecycle state. Reserved for archive/restore
/// and read-only history; live Agent paths should use `get_chat_session`.
pub fn get_chat_session_including_archived(
    project: &str,
    task_id: &str,
    chat_id: &str,
) -> Result<Option<ChatSession>> {
    let conn = crate::storage::database::connection();
    let chat = conn
        .query_row(
            "SELECT session_id, title, COALESCE((SELECT bs.agent FROM buddy_segments bs WHERE bs.session_id = session.session_id AND bs.ended_at IS NOT NULL), agent), acp_session_id, created_at, duty
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
    find_chat_session_filtered(chat_id, false)
}

pub(crate) fn find_chat_session_any(
    chat_id: &str,
) -> Result<Option<(String, String, ChatSession)>> {
    find_chat_session_filtered(chat_id, true)
}

fn find_chat_session_filtered(
    chat_id: &str,
    include_archived: bool,
) -> Result<Option<(String, String, ChatSession)>> {
    let conn = crate::storage::database::connection();
    let row = conn
        .query_row(
            "SELECT project, task_id, session_id, title, COALESCE((SELECT bs.agent FROM buddy_segments bs WHERE bs.session_id = session.session_id AND bs.ended_at IS NOT NULL), agent), acp_session_id, created_at, duty
             FROM session
             WHERE session_id = ?1 AND (?2 OR archived_at IS NULL)",
            params![chat_id, include_archived],
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
    let slug = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    // The slug names the task's directory.
    if cfg!(windows) && is_windows_device_name(&slug) {
        format!("{slug}-task")
    } else {
        slug
    }
}

/// Names Windows reserves for devices, which can't be used as a directory.
fn is_windows_device_name(name: &str) -> bool {
    matches!(name, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            name.strip_prefix(prefix).is_some_and(|digit| {
                matches!(digit, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
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
    fn memory_namespace_uses_ordinary_chat_storage_without_a_task_record() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now();
        assert!(get_task_any(&project, MEMORY_TASK_ID).unwrap().is_none());

        let chat_id = generate_chat_id();
        add_chat_session(
            &project,
            MEMORY_TASK_ID,
            ChatSession {
                id: chat_id.clone(),
                title: "Memory Run".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: now,
                duty: None,
            },
        )
        .unwrap();
        assert!(get_task_any(&project, MEMORY_TASK_ID).unwrap().is_none());
        assert_eq!(
            load_chat_sessions(&project, MEMORY_TASK_ID)
                .unwrap()
                .into_iter()
                .map(|chat| chat.id)
                .collect::<Vec<_>>(),
            vec![chat_id]
        );

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn pinning_marks_active_sessions_and_archiving_unpins() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let chat_id = generate_chat_id();
        add_chat_session(
            &project,
            "task",
            ChatSession {
                id: chat_id.clone(),
                title: "Pinned".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: Utc::now(),
                duty: None,
            },
        )
        .unwrap();
        let pinned = || load_pinned_chat_ids(&project, "task").unwrap();

        assert!(set_chat_session_pinned(&project, "task", &chat_id, true).unwrap());
        assert!(pinned().contains(&chat_id));
        assert!(set_chat_session_pinned(&project, "task", &chat_id, false).unwrap());
        assert!(pinned().is_empty());

        set_chat_session_pinned(&project, "task", &chat_id, true).unwrap();
        assert!(archive_chat_session(&project, "task", &chat_id).unwrap());
        assert!(!set_chat_session_pinned(&project, "task", &chat_id, true).unwrap());
        assert!(restore_chat_session(&project, "task", &chat_id).unwrap());
        assert!(pinned().is_empty());

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn readonly_sessions_stay_viewable_but_refuse_agents() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let task_id = "task-readonly";
        let make_chat = |id: &str| ChatSession {
            id: id.to_string(),
            title: id.to_string(),
            agent: "codex".to_string(),
            acp_session_id: Some("agent-session".to_string()),
            created_at: Utc::now(),
            duty: None,
        };
        add_chat_session(&project, task_id, make_chat("live")).unwrap();
        add_chat_session(&project, task_id, make_chat("gone")).unwrap();
        {
            let conn = crate::storage::database::connection();
            conn.execute(
                "INSERT INTO agent_pending_message (msg_id, project, task_id, from_session, to_session, body, created_at)
                 VALUES ('msg', ?1, ?2, 'live', 'gone', 'hi', '2026-11-03T00:00:00Z')",
                params![project, task_id],
            )
            .unwrap();
        }

        let meta = serde_json::json!({ "error": "no rollout" });
        assert!(mark_chat_readonly(
            &project,
            task_id,
            "gone",
            READONLY_AGENT_EXPIRED,
            meta.clone()
        )
        .unwrap());
        // Terminal: a second mark must not overwrite the original reason.
        assert!(!mark_chat_readonly(
            &project,
            task_id,
            "gone",
            READONLY_IMPORTED,
            serde_json::Value::Null
        )
        .unwrap());

        assert_eq!(load_chat_sessions(&project, task_id).unwrap().len(), 2);
        assert_eq!(
            load_writable_chat_sessions(&project, task_id)
                .unwrap()
                .into_iter()
                .map(|chat| chat.id)
                .collect::<Vec<_>>(),
            vec!["live"]
        );
        assert_eq!(
            chat_readonly("gone").unwrap(),
            Some(ChatReadOnly {
                reason: READONLY_AGENT_EXPIRED.to_string(),
                meta: Some(meta),
            })
        );
        assert!(ensure_chat_writable("live").is_ok());
        assert!(ensure_chat_writable("gone").is_err());
        assert_eq!(
            get_chat_session(&project, task_id, "gone")
                .unwrap()
                .unwrap()
                .acp_session_id,
            None
        );
        let pending: i64 = crate::storage::database::connection()
            .query_row("SELECT COUNT(*) FROM agent_pending_message", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(pending, 0);

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn buddy_segments_are_never_marked_readonly() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        add_chat_session(
            &project,
            "task",
            ChatSession {
                id: "segment".to_string(),
                title: "segment".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: Utc::now(),
                duty: None,
            },
        )
        .unwrap();
        {
            let conn = crate::storage::database::connection();
            conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
            conn.execute(
                "INSERT INTO buddy_segments (session_id, buddy_id, seq, agent, started_at)
                 VALUES ('segment', 'buddy', 1, 'codex', '2026-11-03T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        }

        assert!(!mark_chat_readonly(
            &project,
            "task",
            "segment",
            READONLY_AGENT_EXPIRED,
            serde_json::Value::Null
        )
        .unwrap());
        assert_eq!(chat_readonly("segment").unwrap(), None);

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn title_sources_only_replace_equal_or_lower_ones() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let task = "task-title";
        add_chat_session(
            &project,
            task,
            ChatSession {
                id: "chat".to_string(),
                title: "New session".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: Utc::now(),
                duty: None,
            },
        )
        .unwrap();
        let title = || {
            get_chat_session(&project, task, "chat")
                .unwrap()
                .unwrap()
                .title
        };

        // Grove's first-prompt title, then the tool, then the Agent's own.
        assert!(update_chat_title_if_unchanged(
            &project,
            task,
            "chat",
            "New session",
            "From prompt"
        )
        .unwrap());
        assert!(
            update_chat_title(&project, task, "chat", "From tool", TitleSource::AgentTool).unwrap()
        );
        assert!(!update_chat_title_if_unchanged(
            &project,
            task,
            "chat",
            "From tool",
            "Prompt again"
        )
        .unwrap());
        assert!(
            update_chat_session_info(&project, task, "chat", Some("From agent"), None).unwrap()
        );
        assert!(
            !update_chat_title(&project, task, "chat", "Tool again", TitleSource::AgentTool)
                .unwrap()
        );
        assert_eq!(title(), "From agent");

        // The user's name stands against everything else.
        assert!(update_chat_title(&project, task, "chat", "Mine", TitleSource::User).unwrap());
        assert!(
            !update_chat_session_info(&project, task, "chat", Some("Agent again"), None).unwrap()
        );
        assert!(
            !update_chat_title(&project, task, "chat", "Tool again", TitleSource::AgentTool)
                .unwrap()
        );
        assert_eq!(title(), "Mine");
        assert!(
            update_chat_title(&project, task, "chat", "Mine, renamed", TitleSource::User).unwrap()
        );
        assert_eq!(title(), "Mine, renamed");
        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn archived_sessions_leave_normal_discovery_until_restored() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let task_id = "task-archive";
        let make_chat = |id: &str| ChatSession {
            id: id.to_string(),
            title: id.to_string(),
            agent: "codex".to_string(),
            acp_session_id: None,
            created_at: Utc::now(),
            duty: None,
        };
        add_chat_session(&project, task_id, make_chat("active")).unwrap();
        add_chat_session(&project, task_id, make_chat("archive-me")).unwrap();

        assert!(archive_chat_session(&project, task_id, "archive-me").unwrap());
        assert_eq!(
            load_chat_sessions(&project, task_id)
                .unwrap()
                .into_iter()
                .map(|chat| chat.id)
                .collect::<Vec<_>>(),
            vec!["active"]
        );
        assert_eq!(
            load_archived_chat_sessions(&project, task_id)
                .unwrap()
                .into_iter()
                .map(|chat| chat.id)
                .collect::<Vec<_>>(),
            vec!["archive-me"]
        );
        assert!(get_chat_session(&project, task_id, "archive-me")
            .unwrap()
            .is_none());
        assert!(
            get_chat_session_including_archived(&project, task_id, "archive-me")
                .unwrap()
                .is_some()
        );

        assert!(restore_chat_session(&project, task_id, "archive-me").unwrap());
        assert!(load_archived_chat_sessions(&project, task_id)
            .unwrap()
            .is_empty());
        assert!(get_chat_session(&project, task_id, "archive-me")
            .unwrap()
            .is_some());

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn active_sessions_are_ordered_by_recent_activity() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let task_id = "task-recent-activity";
        let now = Utc::now();
        let make_chat = |id: &str, created_at| ChatSession {
            id: id.to_string(),
            title: id.to_string(),
            agent: "codex".to_string(),
            acp_session_id: None,
            created_at,
            duty: None,
        };
        add_chat_session(
            &project,
            task_id,
            make_chat("older", now - chrono::Duration::days(1)),
        )
        .unwrap();
        add_chat_session(&project, task_id, make_chat("newer", now)).unwrap();

        let ids = || {
            load_chat_sessions(&project, task_id)
                .unwrap()
                .into_iter()
                .map(|chat| chat.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(), vec!["newer", "older"]);

        assert!(touch_chat_session(&project, task_id, "older").unwrap());
        assert_eq!(ids(), vec!["older", "newer"]);

        assert!(archive_chat_session(&project, task_id, "older").unwrap());
        assert!(!touch_chat_session(&project, task_id, "older").unwrap());
        assert!(restore_chat_session(&project, task_id, "older").unwrap());
        assert_eq!(ids(), vec!["older", "newer"]);

        crate::storage::set_grove_dir_override(None);
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

    #[test]
    fn manual_task_order_puts_new_and_recovered_tasks_on_top() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let make_task = |id: &str| Task {
            id: id.to_string(),
            name: id.to_string(),
            branch: id.to_string(),
            target: "main".to_string(),
            worktree_path: String::new(),
            initial_commit: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            status: TaskStatus::Active,
            multiplexer: "tmux".to_string(),
            session_name: String::new(),
            created_by: String::new(),
            archived_at: None,
            code_additions: 0,
            code_deletions: 0,
            files_changed: 0,
            is_local: false,
        };
        let ordered = || {
            let order = load_task_order(&project).unwrap();
            let mut ids: Vec<String> = order.keys().cloned().collect();
            ids.sort_by_key(|id| order[id]);
            ids
        };

        add_task(&project, make_task("a")).unwrap();
        add_task(&project, make_task("b")).unwrap();
        add_task(&project, make_task("c")).unwrap();
        assert_eq!(ordered(), ["c", "b", "a"]);

        reorder_tasks(&project, &["a".into(), "c".into(), "b".into()]).unwrap();
        assert_eq!(ordered(), ["a", "c", "b"]);

        archive_task(&project, "c").unwrap();
        assert_eq!(ordered(), ["a", "b"]);
        recover_task(&project, "c").unwrap();
        assert_eq!(ordered(), ["c", "a", "b"]);

        // Recovering an already-active task must not move it.
        recover_task(&project, "b").unwrap();
        assert_eq!(ordered(), ["c", "a", "b"]);

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn project_linked_projects_are_copied_once_then_independent() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        let task = |id: &str| Task {
            id: id.to_string(),
            name: id.to_string(),
            branch: id.to_string(),
            target: "main".to_string(),
            worktree_path: String::new(),
            initial_commit: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            status: TaskStatus::Active,
            multiplexer: "tmux".to_string(),
            session_name: String::new(),
            created_by: "user".to_string(),
            archived_at: None,
            code_additions: 0,
            code_deletions: 0,
            files_changed: 0,
            is_local: false,
        };

        // An existing Task is not touched when the Project set changes.
        add_task(&project, task("old")).unwrap();
        replace_project_linked_project_ids(&project, &["b".into(), "a".into()]).unwrap();
        assert_eq!(
            load_project_linked_project_ids(&project).unwrap(),
            ["b", "a"]
        );
        assert!(load_linked_project_ids(&project, "old").unwrap().is_empty());

        // A new Task copies the set in order.
        add_task(&project, task("new")).unwrap();
        copy_project_linked_projects_to_task(&project, "new").unwrap();
        assert_eq!(
            load_linked_project_ids(&project, "new").unwrap(),
            ["b", "a"]
        );

        // Editing either side afterwards does not affect the other.
        replace_project_linked_project_ids(&project, &["c".into()]).unwrap();
        assert_eq!(
            load_linked_project_ids(&project, "new").unwrap(),
            ["b", "a"]
        );
        replace_linked_project_ids(&project, "new", &["a".into()]).unwrap();
        assert_eq!(load_project_linked_project_ids(&project).unwrap(), ["c"]);

        // An empty Project set leaves a new Task without links.
        replace_project_linked_project_ids(&project, &[]).unwrap();
        add_task(&project, task("empty")).unwrap();
        copy_project_linked_projects_to_task(&project, "empty").unwrap();
        assert!(load_linked_project_ids(&project, "empty")
            .unwrap()
            .is_empty());

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn windows_device_names_are_recognized() {
        for name in ["con", "nul", "com1", "lpt9"] {
            assert!(is_windows_device_name(name), "{name}");
        }
        for name in ["console", "com", "com10", "nullable"] {
            assert!(!is_windows_device_name(name), "{name}");
        }
    }
}
