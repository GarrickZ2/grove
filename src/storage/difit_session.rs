//! Difit review session 持久化
//!
//! 将正在运行的 difit server 信息保存到磁盘，
//! 支持 Grove 重启后恢复 reviewing 状态。

use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;
use std::process::Command;

use super::ensure_project_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DifitSession {
    /// PID of the sh process wrapping difit
    pub pid: u32,
    /// Task ID being reviewed
    pub task_id: String,
    /// Project key (path hash)
    pub project_key: String,
    /// Difit server URL (parsed from output once available)
    pub url: Option<String>,
    /// Path to the temp output file
    pub temp_file: String,
}

fn session_path(project_key: &str) -> io::Result<PathBuf> {
    let dir = ensure_project_dir(project_key)?;
    Ok(dir.join("difit_session.toml"))
}

pub fn load_session(project_key: &str) -> Option<DifitSession> {
    let path = session_path(project_key).ok()?;
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    toml::from_str(&content).ok()
}

pub fn save_session(project_key: &str, session: &DifitSession) -> io::Result<()> {
    let path = session_path(project_key)?;
    let content = toml::to_string_pretty(session)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, content)
}

pub fn remove_session(project_key: &str) {
    if let Ok(path) = session_path(project_key) {
        let _ = std::fs::remove_file(path);
    }
}

/// Check if a process with the given PID is still alive
pub fn is_process_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
