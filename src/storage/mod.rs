pub mod config;
pub mod tasks;
pub mod workspace;

use std::io;
use std::path::PathBuf;

/// 获取 ~/.grove/ 目录路径
pub fn grove_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot find home directory")
        .join(".grove")
}

/// 确保项目配置目录存在: ~/.grove/projects/{project}/
pub fn ensure_project_dir(project: &str) -> io::Result<PathBuf> {
    let path = grove_dir().join("projects").join(project);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// 确保 worktree 目录存在: ~/.grove/worktrees/{project}/
pub fn ensure_worktree_dir(project: &str) -> io::Result<PathBuf> {
    let path = grove_dir().join("worktrees").join(project);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}
