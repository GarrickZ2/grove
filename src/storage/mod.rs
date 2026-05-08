pub mod agent_graph;
pub mod ai;
pub mod chat_attachments;
pub mod chat_history;
pub mod comments;
pub mod config;
pub mod custom_agent;
pub mod database;
pub mod migrate_chats;
pub mod notes;
pub mod sketch_checkpoints;
pub mod sketches;
pub mod skills;
pub mod taskgroups;
pub mod tasks;
pub mod token_usage;
pub mod workspace;

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use crate::error::Result;

thread_local! {
    static GROVE_DIR_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Override the grove directory for the current thread (used in tests).
#[cfg(test)]
pub fn set_grove_dir_override(path: Option<PathBuf>) {
    GROVE_DIR_OVERRIDE.with(|o| *o.borrow_mut() = path);
}

/// 获取 ~/.grove/ 目录路径
pub fn grove_dir() -> PathBuf {
    if let Some(path) = GROVE_DIR_OVERRIDE.with(|o| o.borrow().clone()) {
        return path;
    }
    dirs::home_dir()
        .expect("Cannot find home directory")
        .join(".grove")
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

/// 确保 task 数据目录存在: ~/.grove/projects/{project}/tasks/{task_id}/
pub fn ensure_task_data_dir(project: &str, task_id: &str) -> Result<PathBuf> {
    let path = grove_dir()
        .join("projects")
        .join(project)
        .join("tasks")
        .join(task_id);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// 删除 task 数据目录: rm -rf tasks/{task_id}/
pub fn delete_task_data(project: &str, task_id: &str) -> Result<()> {
    let path = grove_dir()
        .join("projects")
        .join(project)
        .join("tasks")
        .join(task_id);
    if path.exists() {
        std::fs::remove_dir_all(&path)?;
    }
    Ok(())
}
