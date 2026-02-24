//! ACP Chat 历史持久化（JSONL 格式，实时 append）
//!
//! 每个 chat 的历史存储在：
//! `~/.grove/projects/{project}/tasks/{task_id}/chats/{chat_id}/history.jsonl`
//!
//! 每条可持久化事件在 emit 时直接 append 到磁盘，避免 agent 中途断开丢失数据。
//! - `Busy`、`Error`、`SessionEnded`、`SessionReady`、`AvailableCommands`、`QueueUpdate` 不持久化

use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use crate::acp::AcpUpdate;

/// 获取 history.jsonl 路径
fn history_file_path(project: &str, task_id: &str, chat_id: &str) -> PathBuf {
    super::grove_dir()
        .join("projects")
        .join(project)
        .join("tasks")
        .join(task_id)
        .join("chats")
        .join(chat_id)
        .join("history.jsonl")
}

/// 判断事件是否应该持久化
pub fn should_persist(update: &AcpUpdate) -> bool {
    !matches!(
        update,
        AcpUpdate::Busy { .. }
            | AcpUpdate::Error { .. }
            | AcpUpdate::SessionEnded
            | AcpUpdate::SessionReady { .. }
            | AcpUpdate::AvailableCommands { .. }
            | AcpUpdate::QueueUpdate { .. }
    )
}

/// 实时追加单条事件到 history.jsonl
pub fn append_event(project: &str, task_id: &str, chat_id: &str, event: &AcpUpdate) {
    let path = history_file_path(project, task_id, chat_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file = fs::OpenOptions::new().create(true).append(true).open(&path);

    match file {
        Ok(mut f) => {
            if let Ok(json) = serde_json::to_string(event) {
                let _ = writeln!(f, "{}", json);
            }
        }
        Err(e) => {
            eprintln!("[chat_history] Failed to open {}: {}", path.display(), e);
        }
    }
}

/// 从磁盘加载完整 chat 历史
pub fn load_history(project: &str, task_id: &str, chat_id: &str) -> Vec<AcpUpdate> {
    let path = history_file_path(project, task_id, chat_id);
    let file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let reader = std::io::BufReader::new(file);
    let mut history = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AcpUpdate>(&line) {
            Ok(update) => history.push(update),
            Err(e) => {
                eprintln!("[chat_history] Failed to parse line: {} — {}", line, e);
            }
        }
    }

    history
}

/// 清空 chat 历史文件（新 session 时调用）
pub fn clear_history(project: &str, task_id: &str, chat_id: &str) {
    let path = history_file_path(project, task_id, chat_id);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
}
