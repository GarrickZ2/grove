//! Workspace 数据存储
//! 管理 ~/.grove/projects/<hash>/project.toml 中的项目元数据
//!
//! 目录结构：
//! ~/.grove/
//! ├── config.toml           # 全局配置
//! └── projects/
//!     └── <hash>/           # 项目路径的 hash
//!         ├── project.toml  # 项目元数据
//!         ├── tasks.toml    # 活跃任务
//!         └── archived.toml # 归档任务

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{ensure_project_dir, grove_dir};
use crate::error::Result;
use crate::git;

/// 注册的项目信息（存储在 project.toml）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredProject {
    /// 项目名称（目录名）
    pub name: String,
    /// 项目路径（绝对路径）
    pub path: String,
    /// 添加时间
    pub added_at: DateTime<Utc>,
    /// 是否为 git 仓库
    /// 默认 true 以兼容老数据(老版本只支持 git 项目)
    #[serde(default = "default_is_git_repo")]
    pub is_git_repo: bool,
}

fn default_is_git_repo() -> bool {
    true
}

/// 将 `~` 或 `~/...` 前缀展开为绝对路径(HOME 下)
///
/// 如果不是 `~` / `~/` 形式或 HOME 无法取得,则原样返回。TUI 的对话框和 API
/// 的 handler 都应该用此函数预处理用户输入,保持行为一致。(`~user/` 未支持)
pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
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

/// 获取项目的 project.toml 路径
fn project_file_path(project_hash: &str) -> PathBuf {
    grove_dir()
        .join("projects")
        .join(project_hash)
        .join("project.toml")
}

/// 加载单个项目的元数据
fn load_project_metadata(project_hash: &str) -> Result<Option<RegisteredProject>> {
    let path = project_file_path(project_hash);

    if !path.exists() {
        return Ok(None);
    }

    let project: RegisteredProject = super::load_toml(&path)?;
    Ok(Some(project))
}

pub fn load_project_by_hash(project_hash: &str) -> Result<Option<RegisteredProject>> {
    load_project_metadata(project_hash)
}

/// 保存项目元数据
fn save_project_metadata(project_hash: &str, project: &RegisteredProject) -> Result<()> {
    ensure_project_dir(project_hash)?;
    let path = project_file_path(project_hash);
    super::save_toml(&path, project)
}

/// 解析项目路径,处理 worktree 情况
///
/// - 如果是 git 仓库:获取 repo root,worktree 情况下返回主 repo 路径
/// - 如果不是 git 仓库:返回规范化后的绝对路径
fn resolve_project_path(path: &str) -> Result<String> {
    if git::is_git_repo(path) {
        // 获取 repo root(规范化路径)
        let repo_root = git::repo_root(path)?;
        // 如果是 worktree,返回主 repo 路径;否则返回 repo_root
        git::get_main_repo_path(&repo_root).or(Ok(repo_root))
    } else {
        // 非 git 项目:存在则规范化;不存在则原路返回(避免 canonicalize 在
        // 恢复/注册临时不存在路径的场景下失败)
        let p = std::path::Path::new(path);
        if p.exists() {
            let abs = p
                .canonicalize()
                .map_err(|e| crate::error::GroveError::storage(format!("Invalid path: {}", e)))?;
            abs.to_str()
                .map(|s| s.to_string())
                .ok_or_else(|| crate::error::GroveError::storage("Invalid path encoding"))
        } else {
            Ok(path.to_string())
        }
    }
}

/// 加载所有注册的项目列表
/// 通过扫描 ~/.grove/projects/*/project.toml 获取
pub fn load_projects() -> Result<Vec<RegisteredProject>> {
    let projects_dir = grove_dir().join("projects");

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();

    for entry in std::fs::read_dir(&projects_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            let project_toml = path.join("project.toml");
            if project_toml.exists() {
                if let Ok(content) = std::fs::read_to_string(&project_toml) {
                    if let Ok(project) = toml::from_str::<RegisteredProject>(&content) {
                        // 注意:即使 project.path 已经不存在(用户手动删了目录),
                        // 也要返回它。API 层会用 `exists` 字段告诉前端这是 missing
                        // 状态,让用户能看到孤儿项目并主动 Delete 清理元数据。
                        projects.push(project);
                    }
                }
            }
        }
    }

    // 按添加时间排序（最近添加的在前）
    projects.sort_by(|a, b| b.added_at.cmp(&a.added_at));

    // 按路径去重（保留较新的，即排序后的第一个）
    let mut seen = std::collections::HashSet::new();
    projects.retain(|p| seen.insert(p.path.clone()));

    Ok(projects)
}

/// 添加项目
///
/// 自动处理 worktree:如果传入的路径是 worktree,会自动注册主 repo
pub fn add_project(name: &str, path: &str) -> Result<()> {
    // 解析项目路径(处理 worktree)
    let resolved_path = resolve_project_path(path)?;
    let hash = project_hash(&resolved_path);

    // 检查是否已存在
    if load_project_metadata(&hash)?.is_some() {
        return Err(crate::error::GroveError::storage(
            "Project already registered",
        ));
    }

    let is_git_repo = git::is_git_repo(&resolved_path);
    let project = RegisteredProject {
        name: name.to_string(),
        path: resolved_path,
        added_at: Utc::now(),
        is_git_repo,
    };

    save_project_metadata(&hash, &project)
}

/// 更新已注册项目的 is_git_repo 标志
pub fn set_is_git_repo(path: &str, is_git_repo: bool) -> Result<()> {
    let hash = project_hash(path);
    let mut project = load_project_metadata(&hash)?
        .ok_or_else(|| crate::error::GroveError::storage("Project not found"))?;
    project.is_git_repo = is_git_repo;
    save_project_metadata(&hash, &project)
}

/// 删除项目（仅删除元数据，不删除实际目录）
pub fn remove_project(path: &str) -> Result<()> {
    let hash = project_hash(path);
    let project_dir = grove_dir().join("projects").join(&hash);

    if project_dir.exists() {
        std::fs::remove_dir_all(&project_dir)?;
    }

    // 同时清理 worktrees 目录
    let worktree_dir = grove_dir().join("worktrees").join(&hash);
    if worktree_dir.exists() {
        std::fs::remove_dir_all(&worktree_dir)?;
    }

    Ok(())
}

/// 检查项目是否已注册
///
/// 自动处理 worktree:如果传入的路径是 worktree,会检查主 repo 是否已注册
pub fn is_project_registered(path: &str) -> Result<bool> {
    // 解析项目路径(处理 worktree)
    let resolved_path = resolve_project_path(path)?;
    let hash = project_hash(&resolved_path);
    let project_toml = project_file_path(&hash);
    Ok(project_toml.exists())
}

/// Upsert 项目元数据
/// - 如果不存在：创建新记录
/// - 如果存在：更新 name（保留原 added_at）
///
/// 自动处理 worktree:如果传入的路径是 worktree,会自动注册主 repo
pub fn upsert_project(name: &str, path: &str) -> Result<()> {
    // 解析项目路径(处理 worktree)
    let resolved_path = resolve_project_path(path)?;
    let hash = project_hash(&resolved_path);

    let is_git_repo = git::is_git_repo(&resolved_path);
    let project = if let Some(existing) = load_project_metadata(&hash)? {
        // 存在 → 更新 name 和 is_git_repo，保留 added_at
        RegisteredProject {
            name: name.to_string(),
            path: resolved_path,
            added_at: existing.added_at,
            is_git_repo,
        }
    } else {
        // 不存在 → 新建
        RegisteredProject {
            name: name.to_string(),
            path: resolved_path,
            added_at: Utc::now(),
            is_git_repo,
        }
    };

    save_project_metadata(&hash, &project)
}
