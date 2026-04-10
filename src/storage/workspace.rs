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
}

impl ProjectType {
    pub fn as_str(&self) -> &str {
        match self {
            ProjectType::Repo => "repo",
            ProjectType::Studio => "studio",
        }
    }
}

impl std::str::FromStr for ProjectType {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Ok(match s {
            "studio" => ProjectType::Studio,
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

/// 加载所有注册的项目列表
pub fn load_projects() -> Result<Vec<RegisteredProject>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT hash, name, path, is_git_repo, added_at, project_type FROM projects ORDER BY added_at DESC",
    )?;
    let projects = stmt
        .query_map(rusqlite::params![], |row| {
            let name: String = row.get(1)?;
            let path: String = row.get(2)?;
            let is_git: bool = row.get(3)?;
            let added_at_str: String = row.get(4)?;
            let project_type_str: String = row.get(5)?;
            let added_at = DateTime::parse_from_rfc3339(&added_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            Ok(RegisteredProject {
                name,
                path,
                added_at,
                is_git_repo: is_git,
                project_type: project_type_str.parse().unwrap_or_default(),
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(projects)
}

/// 根据 hash 加载单个项目
pub fn load_project_by_hash(hash: &str) -> Result<Option<RegisteredProject>> {
    let conn = crate::storage::database::connection();
    let result = conn.query_row(
        "SELECT name, path, is_git_repo, added_at, project_type FROM projects WHERE hash = ?1",
        rusqlite::params![hash],
        |row| {
            let name: String = row.get(0)?;
            let path: String = row.get(1)?;
            let is_git: bool = row.get(2)?;
            let added_at_str: String = row.get(3)?;
            let project_type_str: String = row.get(4)?;
            let added_at = DateTime::parse_from_rfc3339(&added_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            Ok(RegisteredProject {
                name,
                path,
                added_at,
                is_git_repo: is_git,
                project_type: project_type_str.parse().unwrap_or_default(),
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

/// 添加指定类型的项目
pub fn add_project_with_type(name: &str, path: &str, project_type: ProjectType) -> Result<()> {
    let resolved_path = if project_type == ProjectType::Studio {
        // Studio 项目不走 git 路径解析，直接用传入路径
        path.to_string()
    } else {
        resolve_project_path(path)?
    };
    let hash = project_hash(&resolved_path);

    let conn = crate::storage::database::connection();

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

    let conn = crate::storage::database::connection();

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

    Ok(())
}

/// 删除项目（删除数据库记录和相关数据）
pub fn remove_project(path: &str) -> Result<()> {
    let resolved = resolve_project_path(path).unwrap_or_else(|_| path.to_string());
    let hash = project_hash(&resolved);

    {
        let conn = crate::storage::database::connection();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM audio_config_project WHERE project_hash = ?1",
            rusqlite::params![&hash],
        )?;
        tx.execute(
            "DELETE FROM audio_terms WHERE project_hash = ?1",
            rusqlite::params![&hash],
        )?;

        // Find affected groups before deleting slots
        let affected_groups: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT DISTINCT group_id FROM task_group_slots WHERE project_id = ?1")?;
            let rows = stmt.query_map(rusqlite::params![&hash], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        tx.execute(
            "DELETE FROM task_group_slots WHERE project_id = ?1",
            rusqlite::params![&hash],
        )?;

        // Renumber positions for each affected group
        for gid in &affected_groups {
            let slots: Vec<(i64, String, String, Option<String>)> = {
                let mut stmt = tx.prepare(
                    "SELECT position, project_id, task_id, target_chat_id \
                     FROM task_group_slots WHERE group_id = ?1 ORDER BY position",
                )?;
                let rows = stmt.query_map(rusqlite::params![gid], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
                rows.filter_map(|r| r.ok()).collect()
            };
            tx.execute(
                "DELETE FROM task_group_slots WHERE group_id = ?1",
                rusqlite::params![gid],
            )?;
            for (i, (_, proj, task, chat)) in slots.iter().enumerate() {
                tx.execute(
                    "INSERT INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![gid, (i + 1) as i64, proj, task, chat],
                )?;
            }
        }

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

    let conn = crate::storage::database::connection();
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
    let conn = crate::storage::database::connection();
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

/// 设置项目的 is_git_repo 标志
pub fn set_is_git_repo(path: &str, is_git: bool) -> Result<()> {
    let resolved = resolve_project_path(path).unwrap_or_else(|_| path.to_string());
    let hash = project_hash(&resolved);

    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE projects SET is_git_repo = ?1 WHERE hash = ?2",
        rusqlite::params![is_git, &hash],
    )?;

    Ok(())
}
