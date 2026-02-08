pub mod comments;
pub mod config;
pub mod notes;
pub mod tasks;
pub mod workspace;

use std::path::{Path, PathBuf};

use crate::error::Result;

/// 获取 ~/.grove/ 目录路径
pub fn grove_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot find home directory")
        .join(".grove")
}

/// 确保项目配置目录存在: ~/.grove/projects/{project}/
pub fn ensure_project_dir(project: &str) -> Result<PathBuf> {
    let path = grove_dir().join("projects").join(project);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// 确保 worktree 目录存在: ~/.grove/worktrees/{project}/
pub fn ensure_worktree_dir(project: &str) -> Result<PathBuf> {
    let path = grove_dir().join("worktrees").join(project);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// 从 TOML 文件加载反序列化数据
pub fn load_toml<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let content = std::fs::read_to_string(path)?;
    let data = toml::from_str(&content)?;
    Ok(data)
}

/// 将数据序列化后保存到 TOML 文件
pub fn save_toml<T: serde::Serialize>(path: &Path, data: &T) -> Result<()> {
    let content = toml::to_string_pretty(data)?;
    std::fs::write(path, content)?;
    Ok(())
}
