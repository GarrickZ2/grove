//! Workspace 数据存储
//! 管理 projects 表中的项目元数据（SQLite）

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::grove_dir;
use crate::error::Result;
use crate::git;

/// 项目类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProjectType {
    /// 代码仓库项目（git 或非 git 目录）
    #[default]
    Repo,
    /// Studio 项目（AI Agent 工作空间，无 git）
    Studio,
    /// Persistent AI teammate, backed by a real directory without git.
    Buddy,
}

impl ProjectType {
    pub fn as_str(&self) -> &str {
        match self {
            ProjectType::Repo => "repo",
            ProjectType::Studio => "studio",
            ProjectType::Buddy => "buddy",
        }
    }
}

impl std::str::FromStr for ProjectType {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Ok(match s {
            "studio" => ProjectType::Studio,
            "buddy" => ProjectType::Buddy,
            _ => ProjectType::Repo,
        })
    }
}

/// 注册的项目信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredProject {
    /// 项目名称（目录名）
    pub name: String,
    /// 项目路径（绝对路径）
    pub path: String,
    /// 添加时间
    pub added_at: DateTime<Utc>,
    /// 是否为 git 仓库
    #[serde(default = "default_is_git_repo")]
    pub is_git_repo: bool,
    /// 项目类型
    #[serde(default)]
    pub project_type: ProjectType,
    /// Whether the project is hidden from normal project discovery.
    #[serde(default)]
    pub archived: bool,
}

fn default_is_git_repo() -> bool {
    true
}

/// 展开路径中的 ~ 前缀为 HOME 目录
pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|p| p.join(rest).to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
    }
    #[cfg(windows)]
    if let Some(rest) = path.strip_prefix("~\\") {
        return dirs::home_dir()
            .map(|p| p.join(rest).to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
    }
    path.to_string()
}

/// 根据项目路径生成唯一的目录名（hash）
/// 使用 FNV-1a 算法，确保相同路径始终生成相同 hash
pub fn project_hash(path: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET_BASIS;
    for byte in path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}", hash)
}

/// 解析项目路径,处理 worktree 和非 git 目录
///
/// - Git repo / worktree → 返回主 repo 的规范化路径
/// - 非 git 目录 → canonicalize 后直接返回
fn resolve_project_path(path: &str) -> Result<String> {
    let expanded = expand_tilde(path);

    // 尝试 git 路径解析
    if let Ok(repo_root) = git::repo_root(&expanded) {
        // 如果是 worktree, 返回主 repo 路径
        return git::get_main_repo_path(&repo_root).or(Ok(repo_root));
    }

    // 非 git 目录: canonicalize 路径
    let canonical = std::fs::canonicalize(&expanded)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(expanded);
    Ok(canonical)
}

/// 加载普通注册项目（不含 Buddy），包括已归档项目。
pub fn load_projects() -> Result<Vec<RegisteredProject>> {
    load_projects_filtered(None, false)
}

/// Buddy discovery includes archived rows; callers choose the archive view.
#[allow(dead_code)] // Consumed by the Buddy lifecycle/API in subsequent steps.
pub fn load_buddy_projects() -> Result<Vec<RegisteredProject>> {
    load_projects_filtered(None, true)
}

/// Load the persisted project identifiers used by tasks and group slots.
/// Startup repair must use these keys directly rather than recomputing a hash
/// from a path whose normalization rules may have changed since registration.
pub(crate) fn load_project_hashes() -> Result<Vec<String>> {
    let conn = crate::storage::database::try_connection()?;
    let mut stmt = conn.prepare("SELECT hash FROM projects ORDER BY added_at DESC")?;
    let hashes = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(hashes)
}

/// 加载未归档的注册项目列表。
pub fn load_active_projects() -> Result<Vec<RegisteredProject>> {
    load_projects_filtered(Some(false), false)
}

/// 加载已归档的注册项目列表。
pub fn load_archived_projects() -> Result<Vec<RegisteredProject>> {
    load_projects_filtered(Some(true), false)
}

fn load_projects_filtered(archived: Option<bool>, buddy: bool) -> Result<Vec<RegisteredProject>> {
    let conn = crate::storage::database::try_connection()?;
    let mut stmt = conn.prepare(
        "SELECT hash, name, path, is_git_repo, added_at, project_type, archived
         FROM projects WHERE (?1 IS NULL OR archived = ?1)
         AND (project_type = 'buddy') = ?2 ORDER BY added_at DESC",
    )?;
    let projects = stmt
        .query_map(rusqlite::params![archived, buddy], |row| {
            let name: String = row.get(1)?;
            let path: String = row.get(2)?;
            let is_git: bool = row.get(3)?;
            let added_at_str: String = row.get(4)?;
            let project_type_str: String = row.get(5)?;
            let archived: bool = row.get(6)?;
            let added_at = DateTime::parse_from_rfc3339(&added_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            Ok(RegisteredProject {
                name,
                path,
                added_at,
                is_git_repo: is_git,
                project_type: project_type_str.parse().unwrap_or_default(),
                archived,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(projects)
}

/// 根据 hash 加载单个项目
pub fn load_project_by_hash(hash: &str) -> Result<Option<RegisteredProject>> {
    let conn = crate::storage::database::try_connection()?;
    let result = conn.query_row(
        "SELECT name, path, is_git_repo, added_at, project_type, archived FROM projects WHERE hash = ?1",
        rusqlite::params![hash],
        |row| {
            let name: String = row.get(0)?;
            let path: String = row.get(1)?;
            let is_git: bool = row.get(2)?;
            let added_at_str: String = row.get(3)?;
            let project_type_str: String = row.get(4)?;
            let archived: bool = row.get(5)?;
            let added_at = DateTime::parse_from_rfc3339(&added_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            Ok(RegisteredProject {
                name,
                path,
                added_at,
                is_git_repo: is_git,
                project_type: project_type_str.parse().unwrap_or_default(),
                archived,
            })
        },
    );
    match result {
        Ok(project) => Ok(Some(project)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 添加项目
///
/// 自动处理 worktree:如果传入的路径是 worktree,会自动注册主 repo
pub fn add_project(name: &str, path: &str) -> Result<()> {
    add_project_with_type(name, path, ProjectType::Repo)
}

/// 启动时调用一次:如果 cwd 处于一个 git 仓库内,把它的 work_dir 注册为 project。
///
/// 设计意图:用户在终端 `cd` 进仓库后启动 grove,自动把仓库登记进来。
/// 这是**启动期**操作 —— 不要在 HTTP handler 里反复调用,因为
/// `gix::discover` + `add_project` 的"已存在"分支加在一起在大型仓库
/// 上能跑到 80ms+。
pub fn auto_register_cwd_if_git_repo() {
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let Ok(repo) = gix::discover(&cwd) else {
        return;
    };
    let Some(work_dir) = repo.work_dir() else {
        return;
    };
    let git_root = work_dir.to_string_lossy().to_string();
    let name = work_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // "already registered" 当成成功 —— 我们只需要保证仓库在 DB 里。
    let _ = add_project(&name, &git_root);
    // 不论 add_project 走哪条分支(成功 / 已存在),都补一次 Local Task。
    // 这覆盖老项目升级到 "Local Task at registration" 重构后缺一行的情况;
    // ensure_local_task 自身幂等,已存在就 no-op。
    let hash = project_hash(&git_root);
    if let Err(e) = crate::storage::tasks::ensure_local_task(&hash, &git_root, &name) {
        eprintln!(
            "[warning] Failed to ensure Local Task for {}: {}",
            git_root, e
        );
        return;
    }
    if let Err(e) = crate::storage::taskgroups::ensure_task_assignment(
        &hash,
        crate::storage::tasks::LOCAL_TASK_ID,
        true,
    ) {
        eprintln!(
            "[warning] Failed to assign Local Task for {} to Local group: {}",
            git_root, e
        );
    }
}

/// 添加指定类型的项目
pub fn add_project_with_type(name: &str, path: &str, project_type: ProjectType) -> Result<()> {
    // Buddy creation must atomically include its persona, Segment and Memory.
    // Do not let ordinary registration create an incomplete Buddy or route it
    // through Studio's virtual-directory setup.
    if project_type == ProjectType::Buddy {
        return Err(crate::error::GroveError::invalid_data(
            "Buddy projects must be created through the Buddy lifecycle",
        ));
    }
    let resolved_path = if project_type == ProjectType::Studio {
        // Studio 项目不走 git 路径解析，直接用传入路径
        path.to_string()
    } else {
        resolve_project_path(path)?
    };
    let hash = project_hash(&resolved_path);

    let conn = crate::storage::database::try_connection()?;

    // 检查是否已存在
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM projects WHERE hash = ?1 LIMIT 1",
            rusqlite::params![&hash],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if exists {
        return Err(crate::error::GroveError::storage(
            "Project already registered",
        ));
    }

    let is_git = if project_type == ProjectType::Studio {
        false
    } else {
        git::repo_root(&resolved_path).is_ok()
    };
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO projects (hash, name, path, is_git_repo, added_at, project_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![&hash, name, &resolved_path, is_git, &now, project_type.as_str()],
    )?;
    drop(conn);

    if project_type == ProjectType::Repo {
        crate::storage::tasks::ensure_local_task(&hash, &resolved_path, name)?;
        crate::storage::taskgroups::ensure_task_assignment(
            &hash,
            crate::storage::tasks::LOCAL_TASK_ID,
            true,
        )?;
    } else {
        crate::operations::tasks::ensure_studio_local_task(&resolved_path, &hash, name)?;
        crate::storage::taskgroups::ensure_task_assignment(
            &hash,
            crate::storage::tasks::LOCAL_TASK_ID,
            true,
        )?;
    }

    Ok(())
}

/// Upsert 项目元数据
/// - 如果不存在：创建新记录
/// - 如果存在：更新 name（保留原 added_at）
///
/// 自动处理 worktree:如果传入的路径是 worktree,会自动注册主 repo
pub fn upsert_project(name: &str, path: &str) -> Result<()> {
    let resolved_path = resolve_project_path(path)?;
    let hash = project_hash(&resolved_path);

    let conn = crate::storage::database::try_connection()?;

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM projects WHERE hash = ?1 LIMIT 1",
            rusqlite::params![&hash],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if exists {
        // 存在 → 更新 name，保留 added_at
        conn.execute(
            "UPDATE projects SET name = ?1 WHERE hash = ?2",
            rusqlite::params![name, &hash],
        )?;
    } else {
        // 不存在 → 新建
        let is_git = git::repo_root(&resolved_path).is_ok();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO projects (hash, name, path, is_git_repo, added_at, project_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![&hash, name, &resolved_path, is_git, &now, ProjectType::Repo.as_str()],
        )?;
    }
    drop(conn);
    // Both branches must call ensure_local_task — the existing-project
    // branch used to skip it on the assumption that a project row
    // implies a Local Task row, but that's not invariant: legacy DBs
    // pre-dating the eager-creation refactor could have a project row
    // without a Local Task. ensure_local_task is idempotent (checks
    // existence first), so the cost on the common path is one SELECT.
    crate::storage::tasks::ensure_local_task(&hash, &resolved_path, name)?;
    crate::storage::taskgroups::ensure_task_assignment(
        &hash,
        crate::storage::tasks::LOCAL_TASK_ID,
        true,
    )?;
    Ok(())
}

/// 删除项目（删除数据库记录和相关数据）
pub fn remove_project(path: &str) -> Result<()> {
    // Studio projects use virtual paths (studio://name) that cannot be resolved
    // via git. Use them as-is; the hash matches what was stored at registration.
    let resolved = if path.starts_with("studio://") {
        path.to_string()
    } else {
        resolve_project_path(path).unwrap_or_else(|_| path.to_string())
    };
    let hash = project_hash(&resolved);

    {
        let conn = crate::storage::database::try_connection()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM audio_config_project WHERE project_hash = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM audio_terms WHERE project_hash = ?1",
            rusqlite::params![&hash],
        )?;

        tx.execute(
            "DELETE FROM task_group_slots WHERE project_id = ?1",
            rusqlite::params![&hash],
        )?;

        // 删 tasks + session 等项目作用域行 —— 这些表没有 FK 到 projects,
        // 不显式删会留下孤儿。session 上有 FK ON DELETE CASCADE,所以
        // 删它会顺带带走 agent_edge / agent_pending_message。
        tx.execute(
            "DELETE FROM session WHERE project = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM tasks WHERE project = ?1",
            rusqlite::params![&hash],
        )?;

        // Project-level Automations and Memory have no FK to `projects`.
        // Remove the Memory-owned association first (it intentionally
        // RESTRICTs deleting its linked Automation), then the generic Runs
        // and Automations, followed by the remaining Memory projections/logs.
        tx.execute(
            "DELETE FROM memory_project_configs WHERE project_id = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM automation_runs
             WHERE automation_id IN (SELECT id FROM automations WHERE project = ?1)",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM automations WHERE project = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM memory_relations WHERE project_id = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM memory_entities WHERE project_id = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM memory_logs WHERE project_id = ?1",
            rusqlite::params![&hash],
        )?;

        tx.execute(
            "DELETE FROM projects WHERE hash = ?1",
            rusqlite::params![&hash],
        )?;
        tx.commit()?;
    }

    // Filesystem cleanup
    let project_dir = grove_dir().join("projects").join(&hash);
    if project_dir.exists() {
        std::fs::remove_dir_all(&project_dir)?;
    }

    let worktree_dir = grove_dir().join("worktrees").join(&hash);
    if worktree_dir.exists() {
        std::fs::remove_dir_all(&worktree_dir)?;
    }

    let studio_dir = grove_dir().join("studios").join(&hash);
    if studio_dir.exists() {
        std::fs::remove_dir_all(&studio_dir)?;
    }

    Ok(())
}

/// 检查项目是否已注册
///
/// 自动处理 worktree:如果传入的路径是 worktree,会检查主 repo 是否已注册
pub fn is_project_registered(path: &str) -> Result<bool> {
    let resolved_path = resolve_project_path(path)?;
    let hash = project_hash(&resolved_path);

    let conn = crate::storage::database::try_connection()?;
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM projects WHERE hash = ?1 LIMIT 1",
            rusqlite::params![&hash],
            |_| Ok(true),
        )
        .unwrap_or(false);

    Ok(exists)
}

/// 创建 Studio 项目目录结构
/// 返回创建的项目路径
pub fn create_studio_project(name: &str) -> Result<String> {
    // 用名称生成 hash 作为目录名（Studio 没有真实文件系统路径）
    let virtual_path = format!("studio://{}", name);
    let hash = project_hash(&virtual_path);

    // Check DB first — before touching the filesystem — so we fail fast and
    // avoid leaving orphaned directories when a project with the same name
    // already exists.
    // NOTE: DbGuard holds the global Mutex. It must be dropped before calling
    // add_project_with_type, which acquires the same Mutex (Mutex is not reentrant).
    {
        let conn = crate::storage::database::try_connection()?;
        let already_exists: bool = conn
            .query_row(
                "SELECT 1 FROM projects WHERE hash = ?1 LIMIT 1",
                rusqlite::params![&hash],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if already_exists {
            return Err(crate::error::GroveError::storage(
                "A Studio project with that name already exists",
            ));
        }
    } // DbGuard dropped here — Mutex released before add_project_with_type

    let project_dir = grove_dir().join("studios").join(&hash);
    std::fs::create_dir_all(project_dir.join("resource"))?;

    // 创建空的 instructions.md
    let instructions_path = project_dir.join("instructions.md");
    if !instructions_path.exists() {
        std::fs::write(&instructions_path, "")?;
    }

    // 注册到数据库
    add_project_with_type(name, &virtual_path, ProjectType::Studio)?;

    Ok(virtual_path)
}

/// 获取 Studio 项目的文件系统目录
pub fn studio_project_dir(project_path: &str) -> std::path::PathBuf {
    let hash = project_hash(project_path);
    grove_dir().join("studios").join(hash)
}

/// Return the real filesystem directory backing a registered Project.
/// Studio Projects use a virtual registration path, so callers that need to
/// access files must resolve them through the Studio storage directory.
pub fn project_directory(project: &RegisteredProject) -> std::path::PathBuf {
    match &project.project_type {
        ProjectType::Studio => studio_project_dir(&project.path),
        ProjectType::Repo | ProjectType::Buddy => std::path::PathBuf::from(&project.path),
    }
}

pub fn rename_project(hash: &str, new_name: &str) -> Result<()> {
    let conn = crate::storage::database::try_connection()?;
    let changes = conn.execute(
        "UPDATE projects SET name = ?1 WHERE hash = ?2",
        rusqlite::params![new_name, hash],
    )?;
    if changes == 0 {
        return Err(crate::error::GroveError::storage("Project not found"));
    }
    Ok(())
}

/// Toggle whether a project appears in normal project discovery.
///
/// This updates only the project row. Tasks and every other project-scoped
/// resource keep their existing state.
pub fn set_project_archived(hash: &str, archived: bool) -> Result<()> {
    let conn = crate::storage::database::try_connection()?;
    let changed = conn.execute(
        "UPDATE projects SET archived = ?1 WHERE hash = ?2",
        rusqlite::params![archived, hash],
    )?;
    if changed == 0 {
        return Err(crate::error::GroveError::storage("Project not found"));
    }
    Ok(())
}

/// 设置项目的 is_git_repo 标志
pub fn set_is_git_repo(path: &str, is_git: bool) -> Result<()> {
    let resolved = resolve_project_path(path).unwrap_or_else(|_| path.to_string());
    let hash = project_hash(&resolved);

    let conn = crate::storage::database::try_connection()?;
    conn.execute(
        "UPDATE projects SET is_git_repo = ?1 WHERE hash = ?2",
        rusqlite::params![is_git, &hash],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        buddies::{self, test_support},
        database,
    };

    #[test]
    fn buddy_type_round_trips_without_changing_unknown_type_fallback() {
        assert_eq!(ProjectType::Buddy.as_str(), "buddy");
        assert_eq!("buddy".parse::<ProjectType>().unwrap(), ProjectType::Buddy);
        assert_eq!(
            serde_json::to_string(&ProjectType::Buddy).unwrap(),
            "\"buddy\""
        );
        assert_eq!(
            serde_json::from_str::<ProjectType>("\"buddy\"").unwrap(),
            ProjectType::Buddy
        );
        assert_eq!("unknown".parse::<ProjectType>().unwrap(), ProjectType::Repo);
    }

    #[test]
    fn discovery_hides_buddies_but_identity_and_repair_queries_keep_them() {
        let _lock = database::test_lock().blocking_lock();
        let _store = test_support::Store::new();
        let conn = database::try_connection().unwrap();
        let buddy = test_support::seed_buddy(&conn, "buddy");
        let archived = test_support::seed_buddy(&conn, "archived-buddy");
        buddies::archive(&conn, &archived.id).unwrap();
        for (name, kind, is_archived) in [
            ("repo", "repo", false),
            ("studio", "studio", false),
            ("archived-repo", "repo", true),
            ("archived-studio", "studio", true),
        ] {
            let path = format!("/test/{name}");
            conn.execute(
                "INSERT INTO projects (hash,name,path,project_type,archived,added_at)
                VALUES (?1,?2,?3,?4,?5,'2026-10-30T00:00:00Z')",
                rusqlite::params![project_hash(&path), name, path, kind, is_archived],
            )
            .unwrap();
        }
        drop(conn);
        assert_eq!(load_projects().unwrap().len(), 4);
        let active = load_active_projects().unwrap();
        assert_eq!(active.len(), 2);
        assert!(active
            .iter()
            .all(|p| !p.archived && p.project_type != ProjectType::Buddy));
        let inactive = load_archived_projects().unwrap();
        assert_eq!(inactive.len(), 2);
        assert!(inactive
            .iter()
            .all(|p| p.archived && p.project_type != ProjectType::Buddy));
        let buddies = load_buddy_projects().unwrap();
        assert_eq!(buddies.len(), 2);
        assert!(buddies
            .iter()
            .all(|p| p.project_type == ProjectType::Buddy && !p.is_git_repo));
        let project = load_project_by_hash(&buddy.project_hash).unwrap().unwrap();
        let directory = buddies::project_directory(&buddy.id).unwrap();
        assert!(directory.is_absolute());
        assert_eq!(project_directory(&project), directory);
        assert_eq!(project_hash(&project.path), buddy.project_hash);
        assert!(
            load_project_by_hash(&archived.project_hash)
                .unwrap()
                .unwrap()
                .archived
        );
        assert!(load_project_hashes()
            .unwrap()
            .contains(&archived.project_hash));
        assert_eq!(load_project_hashes().unwrap().len(), 6);
        assert!(load_project_by_hash("missing").unwrap().is_none());
    }

    #[test]
    fn ordinary_registration_cannot_create_partial_buddy_or_studio_directory() {
        let _lock = database::test_lock().blocking_lock();
        let _store = test_support::Store::new();
        let path = buddies::project_directory("new").unwrap();
        assert!(add_project_with_type("new", &path.to_string_lossy(), ProjectType::Buddy).is_err());
        assert!(load_buddy_projects().unwrap().is_empty());
        assert!(!path.exists());
        assert!(!grove_dir().join("studios").exists());
    }
}
