//! Difit review session 持久化
//!
//! 将正在运行的 difit server 信息保存到磁盘，
//! 支持 Grove 重启后恢复 reviewing 状态。
//! 每个 task 独立一个 session 文件，支持多 task 并发 review。

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
    /// PID of the Grove process monitoring this session
    #[serde(default)]
    pub monitor_pid: Option<u32>,
}

fn sessions_dir(project_key: &str) -> io::Result<PathBuf> {
    let dir = ensure_project_dir(project_key)?;
    let sessions_dir = dir.join("difit_sessions");
    std::fs::create_dir_all(&sessions_dir)?;
    Ok(sessions_dir)
}

fn session_path(project_key: &str, task_id: &str) -> io::Result<PathBuf> {
    let dir = sessions_dir(project_key)?;
    Ok(dir.join(format!("{}.toml", task_id)))
}

pub fn load_session(project_key: &str, task_id: &str) -> Option<DifitSession> {
    let path = session_path(project_key, task_id).ok()?;
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    toml::from_str(&content).ok()
}

pub fn save_session(project_key: &str, task_id: &str, session: &DifitSession) -> io::Result<()> {
    let path = session_path(project_key, task_id)?;
    let content = toml::to_string_pretty(session)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, content)
}

pub fn remove_session(project_key: &str, task_id: &str) {
    if let Ok(path) = session_path(project_key, task_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// Load all existing difit sessions for a project (for recovery on startup)
pub fn load_all_sessions(project_key: &str) -> Vec<DifitSession> {
    let dir = match sessions_dir(project_key) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "toml") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(session) = toml::from_str::<DifitSession>(&content) {
                    sessions.push(session);
                }
            }
        }
    }
    sessions
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

impl DifitSession {
    /// Check if the difit process is still running
    pub fn is_difit_alive(&self) -> bool {
        is_process_alive(self.pid)
    }

    /// Check if there's a live Grove process monitoring this session
    pub fn is_being_monitored(&self) -> bool {
        self.monitor_pid
            .map(is_process_alive)
            .unwrap_or(false)
    }

    /// Check if this session needs reattach (difit alive but no monitor)
    pub fn needs_reattach(&self) -> bool {
        self.is_difit_alive() && !self.is_being_monitored()
    }
}
