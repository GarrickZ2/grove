//! Workspace 数据存储
//! 管理 ~/.grove/workspace.toml 中的项目列表

use std::io;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::grove_dir;

/// 注册的项目信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredProject {
    /// 项目名称（目录名）
    pub name: String,
    /// 项目路径（绝对路径）
    pub path: String,
    /// 添加时间
    pub added_at: DateTime<Utc>,
}

/// workspace.toml 文件结构
#[derive(Debug, Default, Serialize, Deserialize)]
struct WorkspaceFile {
    #[serde(default)]
    projects: Vec<RegisteredProject>,
}

/// 获取 workspace.toml 文件路径
fn workspace_file_path() -> PathBuf {
    grove_dir().join("workspace.toml")
}

/// 加载项目列表
pub fn load_projects() -> io::Result<Vec<RegisteredProject>> {
    let path = workspace_file_path();

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)?;
    let workspace: WorkspaceFile = toml::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(workspace.projects)
}

/// 保存项目列表
pub fn save_projects(projects: &[RegisteredProject]) -> io::Result<()> {
    let path = workspace_file_path();

    // 确保目录存在
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let workspace = WorkspaceFile {
        projects: projects.to_vec(),
    };

    let content = toml::to_string_pretty(&workspace)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    std::fs::write(&path, content)?;
    Ok(())
}

/// 添加项目
pub fn add_project(name: &str, path: &str) -> io::Result<()> {
    let mut projects = load_projects()?;

    // 检查是否已存在
    if projects.iter().any(|p| p.path == path) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Project already registered",
        ));
    }

    projects.push(RegisteredProject {
        name: name.to_string(),
        path: path.to_string(),
        added_at: Utc::now(),
    });

    save_projects(&projects)
}

/// 删除项目
pub fn remove_project(path: &str) -> io::Result<()> {
    let mut projects = load_projects()?;
    projects.retain(|p| p.path != path);
    save_projects(&projects)
}

/// 检查项目是否已注册
pub fn is_project_registered(path: &str) -> io::Result<bool> {
    let projects = load_projects()?;
    Ok(projects.iter().any(|p| p.path == path))
}
