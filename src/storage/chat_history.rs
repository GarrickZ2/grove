//! ACP Chat 历史持久化（JSONL 格式 + turn 级 compaction）
//!
//! 每个 chat 的历史存储在：
//! `~/.grove/projects/{project}/tasks/{task_id}/chats/{chat_id}/history.jsonl`
//!
//! Compaction 策略：
//! - 连续 `MessageChunk` 合并为一条
//! - 连续 `ThoughtChunk` 合并为一条
//! - `ToolCall` + 所有 `ToolCallUpdate` 合并为最终状态
//! - `UserMessage`、`Complete`、`ModeChanged`、`PlanUpdate` 直接保留
//! - `Busy`、`Error`、`SessionEnded`、`SessionReady`、`PermissionRequest`、`AvailableCommands` 不持久化

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

/// 对一个 turn 的事件流执行 compaction，返回压缩后的事件列表
fn compact_turn(events: &[AcpUpdate]) -> Vec<AcpUpdate> {
    let mut result: Vec<AcpUpdate> = Vec::new();
    let mut pending_message: Option<String> = None;
    let mut pending_thought: Option<String> = None;

    // Flush accumulated message chunks
    let flush_message = |pending: &mut Option<String>, out: &mut Vec<AcpUpdate>| {
        if let Some(text) = pending.take() {
            out.push(AcpUpdate::MessageChunk { text });
        }
    };
    // Flush accumulated thought chunks
    let flush_thought = |pending: &mut Option<String>, out: &mut Vec<AcpUpdate>| {
        if let Some(text) = pending.take() {
            out.push(AcpUpdate::ThoughtChunk { text });
        }
    };

    for event in events {
        if !should_persist(event) {
            continue;
        }
        match event {
            AcpUpdate::MessageChunk { text } => {
                // Flush thought if switching type
                flush_thought(&mut pending_thought, &mut result);
                match &mut pending_message {
                    Some(acc) => acc.push_str(text),
                    None => pending_message = Some(text.clone()),
                }
            }
            AcpUpdate::ThoughtChunk { text } => {
                flush_message(&mut pending_message, &mut result);
                match &mut pending_thought {
                    Some(acc) => acc.push_str(text),
                    None => pending_thought = Some(text.clone()),
                }
            }
            AcpUpdate::ToolCall {
                id,
                title,
                locations,
            } => {
                flush_message(&mut pending_message, &mut result);
                flush_thought(&mut pending_thought, &mut result);
                // Push ToolCall as-is; ToolCallUpdates will merge into it
                result.push(AcpUpdate::ToolCall {
                    id: id.clone(),
                    title: title.clone(),
                    locations: locations.clone(),
                });
            }
            AcpUpdate::ToolCallUpdate {
                id,
                status,
                content,
                locations,
            } => {
                // Find matching entry by index (ToolCall or already-merged ToolCallUpdate)
                let idx = result.iter().rposition(|u| match u {
                    AcpUpdate::ToolCall { id: tid, .. }
                    | AcpUpdate::ToolCallUpdate { id: tid, .. } => tid == id,
                    _ => false,
                });
                if let Some(idx) = idx {
                    let final_locs = if locations.is_empty() {
                        match &result[idx] {
                            AcpUpdate::ToolCall { locations: l, .. }
                            | AcpUpdate::ToolCallUpdate { locations: l, .. } => l.clone(),
                            _ => vec![],
                        }
                    } else {
                        locations.clone()
                    };
                    let update = AcpUpdate::ToolCallUpdate {
                        id: id.clone(),
                        status: status.clone(),
                        content: content.clone(),
                        locations: final_locs,
                    };
                    if matches!(&result[idx], AcpUpdate::ToolCall { .. }) {
                        // Keep the ToolCall (preserves title), insert ToolCallUpdate after it
                        result.insert(idx + 1, update);
                    } else {
                        // Replace existing ToolCallUpdate with latest state
                        result[idx] = update;
                    }
                }
            }
            // Directly preserved events
            other => {
                flush_message(&mut pending_message, &mut result);
                flush_thought(&mut pending_thought, &mut result);
                result.push(other.clone());
            }
        }
    }

    // Flush any remaining
    flush_message(&mut pending_message, &mut result);
    flush_thought(&mut pending_thought, &mut result);

    result
}

/// 将一个 turn 的事件 compact 后追加到磁盘
pub fn append_turn(project: &str, task_id: &str, chat_id: &str, turn: &[AcpUpdate]) {
    let compacted = compact_turn(turn);
    if compacted.is_empty() {
        return;
    }

    let path = history_file_path(project, task_id, chat_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file = fs::OpenOptions::new().create(true).append(true).open(&path);

    match file {
        Ok(mut f) => {
            for event in &compacted {
                if let Ok(json) = serde_json::to_string(event) {
                    let _ = writeln!(f, "{}", json);
                }
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
