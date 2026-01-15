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

use std::io;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{ensure_project_dir, grove_dir};

/// 注册的项目信息（存储在 project.toml）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredProject {
    /// 项目名称（目录名）
    pub name: String,
    /// 项目路径（绝对路径）
    pub path: String,
    /// 添加时间
    pub added_at: DateTime<Utc>,
}

/// 根据项目路径生成唯一的目录名（hash）
pub fn project_hash(path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// 获取项目的 project.toml 路径
fn project_file_path(project_hash: &str) -> PathBuf {
    grove_dir()
        .join("projects")
        .join(project_hash)
        .join("project.toml")
}

/// 加载单个项目的元数据
fn load_project_metadata(project_hash: &str) -> io::Result<Option<RegisteredProject>> {
    let path = project_file_path(project_hash);

    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path)?;
    let project: RegisteredProject = toml::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(Some(project))
}

/// 保存项目元数据
fn save_project_metadata(project_hash: &str, project: &RegisteredProject) -> io::Result<()> {
    ensure_project_dir(project_hash)?;
    let path = project_file_path(project_hash);

    let content = toml::to_string_pretty(project)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    std::fs::write(&path, content)?;
    Ok(())
}

/// 加载所有注册的项目列表
/// 通过扫描 ~/.grove/projects/*/project.toml 获取
pub fn load_projects() -> io::Result<Vec<RegisteredProject>> {
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
                        // 验证项目路径仍然存在
                        if std::path::Path::new(&project.path).exists() {
                            projects.push(project);
                        }
                    }
                }
            }
        }
    }

    // 按添加时间排序（最近添加的在前）
    projects.sort_by(|a, b| b.added_at.cmp(&a.added_at));

    Ok(projects)
}

/// 添加项目
pub fn add_project(name: &str, path: &str) -> io::Result<()> {
    let hash = project_hash(path);

    // 检查是否已存在
    if let Some(_) = load_project_metadata(&hash)? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Project already registered",
        ));
    }

    let project = RegisteredProject {
        name: name.to_string(),
        path: path.to_string(),
        added_at: Utc::now(),
    };

    save_project_metadata(&hash, &project)
}

/// 删除项目（仅删除元数据，不删除实际目录）
pub fn remove_project(path: &str) -> io::Result<()> {
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
pub fn is_project_registered(path: &str) -> io::Result<bool> {
    let hash = project_hash(path);
    let project_toml = project_file_path(&hash);
    Ok(project_toml.exists())
}

/// Upsert 项目元数据
/// - 如果不存在：创建新记录
/// - 如果存在：更新 name（保留原 added_at）
pub fn upsert_project(name: &str, path: &str) -> io::Result<()> {
    let hash = project_hash(path);

    let project = if let Some(existing) = load_project_metadata(&hash)? {
        // 存在 → 更新 name，保留 added_at
        RegisteredProject {
            name: name.to_string(),
            path: path.to_string(),
            added_at: existing.added_at,
        }
    } else {
        // 不存在 → 新建
        RegisteredProject {
            name: name.to_string(),
            path: path.to_string(),
            added_at: Utc::now(),
        }
    };

    save_project_metadata(&hash, &project)
}

