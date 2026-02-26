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

/// Turn 结束后 compact history.jsonl：合并碎片化的 chunk 事件
pub fn compact_history(project: &str, task_id: &str, chat_id: &str) {
    let events = load_history(project, task_id, chat_id);
    if events.is_empty() {
        return;
    }

    let compacted = compact_events(events);
    write_history(project, task_id, chat_id, &compacted);
}

/// 原子性重写 history.jsonl
fn write_history(project: &str, task_id: &str, chat_id: &str, events: &[AcpUpdate]) {
    let path = history_file_path(project, task_id, chat_id);
    let tmp = path.with_extension("jsonl.tmp");

    if let Some(parent) = tmp.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file = match fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[chat_history] compact: failed to create tmp: {}", e);
            return;
        }
    };

    let mut writer = std::io::BufWriter::new(file);
    for event in events {
        if let Ok(json) = serde_json::to_string(event) {
            let _ = writeln!(writer, "{}", json);
        }
    }
    drop(writer);

    // 原子替换
    if let Err(e) = fs::rename(&tmp, &path) {
        eprintln!("[chat_history] compact: failed to rename: {}", e);
        let _ = fs::remove_file(&tmp);
    }
}

/// 合并后的 tool 状态
struct ToolCompactState {
    title: String,
    status: String,
    content: Option<String>,
    locations: Vec<(String, Option<u32>)>,
}

/// Compact 事件列表：合并连续 chunk，合并同 id 的 tool 事件
fn compact_events(events: Vec<AcpUpdate>) -> Vec<AcpUpdate> {
    let mut result: Vec<AcpUpdate> = Vec::new();
    let mut msg_buf = String::new();
    let mut thought_buf = String::new();
    // tool_call 合并：按 id 跟踪，保持插入顺序
    let mut tool_order: Vec<String> = Vec::new();
    let mut tool_map: std::collections::HashMap<String, ToolCompactState> =
        std::collections::HashMap::new();

    /// Flush accumulated message chunks
    fn flush_messages(buf: &mut String, result: &mut Vec<AcpUpdate>) {
        if !buf.is_empty() {
            result.push(AcpUpdate::MessageChunk {
                text: std::mem::take(buf),
            });
        }
    }

    /// Flush accumulated thought chunks
    fn flush_thoughts(buf: &mut String, result: &mut Vec<AcpUpdate>) {
        if !buf.is_empty() {
            result.push(AcpUpdate::ThoughtChunk {
                text: std::mem::take(buf),
            });
        }
    }

    /// Flush accumulated tool states as ToolCall + ToolCallUpdate pairs
    fn flush_tools(
        order: &mut Vec<String>,
        map: &mut std::collections::HashMap<String, ToolCompactState>,
        result: &mut Vec<AcpUpdate>,
    ) {
        for id in order.drain(..) {
            if let Some(state) = map.remove(&id) {
                result.push(AcpUpdate::ToolCall {
                    id: id.clone(),
                    title: state.title,
                    locations: state.locations.clone(),
                });
                result.push(AcpUpdate::ToolCallUpdate {
                    id,
                    status: state.status,
                    content: state.content,
                    locations: state.locations,
                });
            }
        }
    }

    for event in events {
        match &event {
            AcpUpdate::MessageChunk { text } => {
                flush_thoughts(&mut thought_buf, &mut result);
                flush_tools(&mut tool_order, &mut tool_map, &mut result);
                msg_buf.push_str(text);
            }
            AcpUpdate::ThoughtChunk { text } => {
                flush_messages(&mut msg_buf, &mut result);
                flush_tools(&mut tool_order, &mut tool_map, &mut result);
                thought_buf.push_str(text);
            }
            AcpUpdate::ToolCall {
                id,
                title,
                locations,
            } => {
                flush_messages(&mut msg_buf, &mut result);
                flush_thoughts(&mut thought_buf, &mut result);
                if let Some(state) = tool_map.get_mut(id) {
                    // 后续 ToolCall（同 id）更新 title/locations
                    if !title.is_empty() {
                        state.title = title.clone();
                    }
                    if !locations.is_empty() {
                        state.locations = locations.clone();
                    }
                } else {
                    tool_order.push(id.clone());
                    tool_map.insert(
                        id.clone(),
                        ToolCompactState {
                            title: title.clone(),
                            status: String::new(),
                            content: None,
                            locations: locations.clone(),
                        },
                    );
                }
            }
            AcpUpdate::ToolCallUpdate {
                id,
                status,
                content,
                locations,
            } => {
                if let Some(state) = tool_map.get_mut(id) {
                    if !status.is_empty() {
                        state.status = status.clone();
                    }
                    if content.is_some() {
                        state.content = content.clone();
                    }
                    if !locations.is_empty() {
                        state.locations = locations.clone();
                    }
                } else {
                    // Orphan ToolCallUpdate（没有对应的 ToolCall），直接保留
                    flush_messages(&mut msg_buf, &mut result);
                    flush_thoughts(&mut thought_buf, &mut result);
                    flush_tools(&mut tool_order, &mut tool_map, &mut result);
                    result.push(event);
                }
            }
            _ => {
                // 其他事件：flush 所有 buffer，原样保留
                flush_messages(&mut msg_buf, &mut result);
                flush_thoughts(&mut thought_buf, &mut result);
                flush_tools(&mut tool_order, &mut tool_map, &mut result);
                result.push(event);
            }
        }
    }

    // Flush 尾部
    flush_messages(&mut msg_buf, &mut result);
    flush_thoughts(&mut thought_buf, &mut result);
    flush_tools(&mut tool_order, &mut tool_map, &mut result);

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compact_merges_message_chunks() {
        let events = vec![
            AcpUpdate::MessageChunk {
                text: "Hello ".into(),
            },
            AcpUpdate::MessageChunk {
                text: "World".into(),
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        assert_eq!(result.len(), 2);
        match &result[0] {
            AcpUpdate::MessageChunk { text } => assert_eq!(text, "Hello World"),
            _ => panic!("Expected MessageChunk"),
        }
    }

    #[test]
    fn test_compact_merges_thought_chunks() {
        let events = vec![
            AcpUpdate::ThoughtChunk {
                text: "Think ".into(),
            },
            AcpUpdate::ThoughtChunk {
                text: "deep".into(),
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        assert_eq!(result.len(), 2);
        match &result[0] {
            AcpUpdate::ThoughtChunk { text } => assert_eq!(text, "Think deep"),
            _ => panic!("Expected ThoughtChunk"),
        }
    }

    #[test]
    fn test_compact_merges_tool_events() {
        let events = vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "Read foo.rs".into(),
                locations: vec![],
            },
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "Read foo.rs".into(),
                locations: vec![("foo.rs".into(), Some(1))],
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "completed".into(),
                content: Some("file content".into()),
                locations: vec![("foo.rs".into(), Some(1))],
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        // ToolCall + ToolCallUpdate + Complete = 3
        assert_eq!(result.len(), 3);
        match &result[0] {
            AcpUpdate::ToolCall { id, locations, .. } => {
                assert_eq!(id, "t1");
                assert_eq!(locations.len(), 1);
            }
            _ => panic!("Expected ToolCall"),
        }
        match &result[1] {
            AcpUpdate::ToolCallUpdate {
                id,
                status,
                content,
                ..
            } => {
                assert_eq!(id, "t1");
                assert_eq!(status, "completed");
                assert_eq!(content.as_deref(), Some("file content"));
            }
            _ => panic!("Expected ToolCallUpdate"),
        }
    }

    #[test]
    fn test_compact_mixed_sequence() {
        let events = vec![
            AcpUpdate::ThoughtChunk { text: "t1".into() },
            AcpUpdate::ThoughtChunk { text: "t2".into() },
            AcpUpdate::MessageChunk { text: "m1".into() },
            AcpUpdate::MessageChunk { text: "m2".into() },
            AcpUpdate::ToolCall {
                id: "tool1".into(),
                title: "Write x".into(),
                locations: vec![],
            },
            AcpUpdate::ToolCallUpdate {
                id: "tool1".into(),
                status: "completed".into(),
                content: None,
                locations: vec![],
            },
            AcpUpdate::MessageChunk { text: "m3".into() },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        // ThoughtChunk("t1t2") + MessageChunk("m1m2") + ToolCall + ToolCallUpdate + MessageChunk("m3") + Complete
        assert_eq!(result.len(), 6);
        match &result[0] {
            AcpUpdate::ThoughtChunk { text } => assert_eq!(text, "t1t2"),
            _ => panic!("Expected ThoughtChunk"),
        }
        match &result[1] {
            AcpUpdate::MessageChunk { text } => assert_eq!(text, "m1m2"),
            _ => panic!("Expected MessageChunk"),
        }
        match &result[4] {
            AcpUpdate::MessageChunk { text } => assert_eq!(text, "m3"),
            _ => panic!("Expected MessageChunk"),
        }
    }

    #[test]
    fn test_compact_preserves_user_message() {
        let events = vec![
            AcpUpdate::UserMessage {
                text: "hello".into(),
                attachments: vec![],
            },
            AcpUpdate::MessageChunk { text: "hi".into() },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        assert_eq!(result.len(), 3);
        assert!(matches!(&result[0], AcpUpdate::UserMessage { .. }));
    }

    #[test]
    fn test_compact_empty_input() {
        let result = compact_events(vec![]);
        assert!(result.is_empty());
    }
}
