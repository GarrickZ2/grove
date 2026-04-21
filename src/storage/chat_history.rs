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

use chrono::{DateTime, Utc};

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
///
/// 把 JSON 和换行拼成一个 buffer 后一次 `write_all` 写出，利用 `O_APPEND`
/// 单次 write 的原子落尾保证：并发 emit 时不会出现 `{a}{b}\n\n` 这种
/// 两个事件挤同一行的情况（历史上 `writeln!` 会拆成 json+`\n` 两次
/// write，两次之间会被别的线程插入）。
pub fn append_event(project: &str, task_id: &str, chat_id: &str, event: &AcpUpdate) {
    let path = history_file_path(project, task_id, chat_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            append_json_line(&mut f, event);
        }
        Err(e) => {
            eprintln!("[chat_history] Failed to open {}: {}", path.display(), e);
        }
    }
}

/// 原子 append 一条 JSONL 事件：先把 `json + \n` 拼成单个 buffer，再一次
/// `write_all` 落盘。`O_APPEND` 保证单次 write 原子写到文件尾部，并发 append
/// 不会让两条 JSON 撞在同一行。
fn append_json_line(f: &mut fs::File, event: &AcpUpdate) {
    if let Ok(mut json) = serde_json::to_string(event) {
        json.push('\n');
        let _ = f.write_all(json.as_bytes());
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
        // 容错：旧版本存在并发 append 竞态，可能把多个 JSON 对象写到同一行
        // （`{a}{b}` 这种），用 StreamDeserializer 把一行里所有能解出的对象都拿到。
        let stream = serde_json::Deserializer::from_str(&line).into_iter::<AcpUpdate>();
        let mut parsed_any = false;
        let mut last_err: Option<serde_json::Error> = None;
        for item in stream {
            match item {
                Ok(update) => {
                    history.push(update);
                    parsed_any = true;
                }
                Err(e) => {
                    last_err = Some(e);
                    break;
                }
            }
        }
        if !parsed_any {
            if let Some(e) = last_err {
                eprintln!("[chat_history] Failed to parse line: {} — {}", line, e);
            }
        }
    }

    history
}

/// On reconnect/history replay, unresolved permission requests, tool calls, and terminal
/// executions are treated as cancelled. Append synthetic cancellation events so replayed
/// history is self-consistent.
pub fn cancel_unresolved_events(project: &str, task_id: &str, chat_id: &str) -> usize {
    let history = load_history(project, task_id, chat_id);
    if history.is_empty() {
        return 0;
    }

    let mut unresolved_permissions = 0usize;
    let mut unresolved_tools: std::collections::HashMap<String, Vec<(String, Option<u32>)>> =
        std::collections::HashMap::new();
    let mut unresolved_terminals = 0usize;

    for event in &history {
        match event {
            AcpUpdate::PermissionRequest { .. } => unresolved_permissions += 1,
            AcpUpdate::PermissionResponse { .. } if unresolved_permissions > 0 => {
                unresolved_permissions -= 1;
            }
            AcpUpdate::ToolCall { id, locations, .. } => {
                unresolved_tools.insert(id.clone(), locations.clone());
            }
            AcpUpdate::ToolCallUpdate { id, status, .. }
                if matches!(
                    status.as_str(),
                    "completed" | "failed" | "error" | "cancelled"
                ) =>
            {
                unresolved_tools.remove(id);
            }
            AcpUpdate::TerminalExecute { .. } => unresolved_terminals += 1,
            AcpUpdate::TerminalComplete { .. } if unresolved_terminals > 0 => {
                unresolved_terminals -= 1;
            }
            _ => {}
        }
    }

    let unresolved_total = unresolved_permissions + unresolved_tools.len() + unresolved_terminals;
    if unresolved_total == 0 {
        return 0;
    }

    let path = history_file_path(project, task_id, chat_id);
    let file = fs::OpenOptions::new().create(true).append(true).open(&path);
    match file {
        Ok(mut f) => {
            for _ in 0..unresolved_permissions {
                append_json_line(
                    &mut f,
                    &AcpUpdate::PermissionResponse {
                        option_id: "Cancelled".to_string(),
                    },
                );
            }
            for (id, locations) in unresolved_tools {
                append_json_line(
                    &mut f,
                    &AcpUpdate::ToolCallUpdate {
                        id,
                        status: "cancelled".to_string(),
                        content: None,
                        locations,
                    },
                );
            }
            for _ in 0..unresolved_terminals {
                append_json_line(&mut f, &AcpUpdate::TerminalComplete { exit_code: Some(1) });
            }
        }
        Err(e) => {
            eprintln!(
                "[chat_history] Failed to append cancelled replay events to {}: {}",
                path.display(),
                e
            );
            return 0;
        }
    }

    unresolved_total
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
    timestamp: Option<DateTime<Utc>>,
}

/// 把 new_locs 合并进 existing（按 (path,line) 去重、保序）。
fn merge_locations(existing: &mut Vec<(String, Option<u32>)>, new_locs: &[(String, Option<u32>)]) {
    for loc in new_locs {
        if !existing.iter().any(|e| e == loc) {
            existing.push(loc.clone());
        }
    }
}

/// Compact 事件列表：合并连续 chunk，合并同 id 的 tool 事件
pub fn compact_events(events: Vec<AcpUpdate>) -> Vec<AcpUpdate> {
    let mut result: Vec<AcpUpdate> = Vec::new();
    let mut msg_buf = String::new();
    let mut thought_buf = String::new();
    let mut terminal_buf = String::new();
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

    /// Flush accumulated terminal output chunks
    fn flush_terminal(buf: &mut String, result: &mut Vec<AcpUpdate>) {
        if !buf.is_empty() {
            result.push(AcpUpdate::TerminalChunk {
                output: std::mem::take(buf),
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
                    timestamp: state.timestamp,
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
                flush_terminal(&mut terminal_buf, &mut result);
                msg_buf.push_str(text);
            }
            AcpUpdate::ThoughtChunk { text } => {
                flush_messages(&mut msg_buf, &mut result);
                flush_tools(&mut tool_order, &mut tool_map, &mut result);
                flush_terminal(&mut terminal_buf, &mut result);
                thought_buf.push_str(text);
            }
            AcpUpdate::TerminalChunk { output } => {
                flush_messages(&mut msg_buf, &mut result);
                flush_thoughts(&mut thought_buf, &mut result);
                flush_tools(&mut tool_order, &mut tool_map, &mut result);
                terminal_buf.push_str(output);
            }
            AcpUpdate::ToolCall {
                id,
                title,
                locations,
                timestamp,
            } => {
                flush_messages(&mut msg_buf, &mut result);
                flush_thoughts(&mut thought_buf, &mut result);
                flush_terminal(&mut terminal_buf, &mut result);
                if let Some(state) = tool_map.get_mut(id) {
                    // 后续 ToolCall（同 id）更新 title/locations，timestamp 保留第一次的值
                    if !title.is_empty() {
                        state.title = title.clone();
                    }
                    // locations 也按增量合并而不是覆盖
                    merge_locations(&mut state.locations, locations);
                } else {
                    tool_order.push(id.clone());
                    tool_map.insert(
                        id.clone(),
                        ToolCompactState {
                            title: title.clone(),
                            status: String::new(),
                            content: None,
                            locations: locations.clone(),
                            timestamp: *timestamp,
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
                    // 按 ACP 规范：content block 是增量下发的，后续 update 是对
                    // 之前的补充而非替换。拼接而不是覆盖，避免最终只剩下最后
                    // 一条（例如把 bash 命令行覆盖成执行结果）。
                    //
                    // 但要处理三种 agent 行为：
                    //   1. 纯增量（每次只发 delta）→ 直接拼接
                    //   2. 累积快照（每次发全量历史，new 包含 old 作为前缀）
                    //      → 用 new 替换 existing，避免 O(n²) 自拼接
                    //   3. 重复广播（new 已整段在 existing 里）→ 跳过
                    if let Some(new_chunk) = content {
                        if !new_chunk.is_empty() {
                            match state.content.as_mut() {
                                Some(existing) if !existing.is_empty() => {
                                    if existing.contains(new_chunk.as_str()) {
                                        // case 3：已包含，跳过
                                    } else if new_chunk.starts_with(existing.as_str()) {
                                        // case 2：new 是 existing 的扩展，替换
                                        *existing = new_chunk.clone();
                                    } else {
                                        // case 1：纯增量，拼接
                                        if !existing.ends_with('\n') {
                                            existing.push('\n');
                                        }
                                        existing.push_str(new_chunk);
                                    }
                                }
                                _ => state.content = Some(new_chunk.clone()),
                            }
                        }
                    }
                    merge_locations(&mut state.locations, locations);
                } else {
                    // Orphan ToolCallUpdate（没有对应的 ToolCall），直接保留
                    flush_messages(&mut msg_buf, &mut result);
                    flush_thoughts(&mut thought_buf, &mut result);
                    flush_tools(&mut tool_order, &mut tool_map, &mut result);
                    flush_terminal(&mut terminal_buf, &mut result);
                    result.push(event);
                }
            }
            _ => {
                // 其他事件：flush 所有 buffer，原样保留
                flush_messages(&mut msg_buf, &mut result);
                flush_thoughts(&mut thought_buf, &mut result);
                flush_tools(&mut tool_order, &mut tool_map, &mut result);
                flush_terminal(&mut terminal_buf, &mut result);
                result.push(event);
            }
        }
    }

    // Flush 尾部
    flush_messages(&mut msg_buf, &mut result);
    flush_thoughts(&mut thought_buf, &mut result);
    flush_tools(&mut tool_order, &mut tool_map, &mut result);
    flush_terminal(&mut terminal_buf, &mut result);

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
                timestamp: None,
            },
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "Read foo.rs".into(),
                locations: vec![("foo.rs".into(), Some(1))],
                timestamp: None,
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
                timestamp: None,
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
                sender: None,
                terminal: false,
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

    /// 基本增量：两次 ToolCallUpdate 的 content 应拼接，不被覆盖。
    #[test]
    fn test_compact_merges_tool_content_incrementally() {
        let events = vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "bash".into(),
                locations: vec![],
                timestamp: None,
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "running".into(),
                content: Some("$ echo hi".into()),
                locations: vec![],
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "completed".into(),
                content: Some("hi".into()),
                locations: vec![],
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        let update = result
            .iter()
            .find_map(|e| match e {
                AcpUpdate::ToolCallUpdate { content, .. } => content.clone(),
                _ => None,
            })
            .expect("should have a compacted ToolCallUpdate");
        assert!(
            update.contains("$ echo hi") && update.contains("hi"),
            "expected both the command and output to be preserved, got: {}",
            update
        );
    }

    /// 重复广播：同一个 chunk 再次到达不应被重复拼接。
    #[test]
    fn test_compact_dedups_duplicate_tool_content() {
        let events = vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "bash".into(),
                locations: vec![],
                timestamp: None,
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "".into(),
                content: Some("payload-A".into()),
                locations: vec![],
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "completed".into(),
                content: Some("payload-A".into()),
                locations: vec![],
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        let update = result
            .iter()
            .find_map(|e| match e {
                AcpUpdate::ToolCallUpdate { content, .. } => content.clone(),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            update.matches("payload-A").count(),
            1,
            "duplicate broadcasts should dedup, got: {}",
            update
        );
    }

    /// 累积快照：每次下发的是"到目前为止的全量"（新 chunk 以旧 chunk 为前缀），
    /// 必须用新值替换而不是把自己拼在自己后面。
    #[test]
    fn test_compact_handles_cumulative_snapshot_tool_content() {
        let events = vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "bash".into(),
                locations: vec![],
                timestamp: None,
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "running".into(),
                content: Some("line1".into()),
                locations: vec![],
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "running".into(),
                content: Some("line1\nline2".into()),
                locations: vec![],
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "completed".into(),
                content: Some("line1\nline2\nline3".into()),
                locations: vec![],
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        let update = result
            .iter()
            .find_map(|e| match e {
                AcpUpdate::ToolCallUpdate { content, .. } => content.clone(),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            update, "line1\nline2\nline3",
            "cumulative snapshots should not self-concatenate"
        );
    }

    /// locations 合并：同 (path,line) 去重，不同的累加并保持插入顺序。
    #[test]
    fn test_compact_merges_tool_locations() {
        let events = vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "edit".into(),
                locations: vec![("a.rs".into(), Some(1))],
                timestamp: None,
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "".into(),
                content: None,
                locations: vec![("a.rs".into(), Some(1)), ("b.rs".into(), Some(2))],
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "completed".into(),
                content: None,
                locations: vec![("b.rs".into(), Some(2)), ("c.rs".into(), None)],
            },
            AcpUpdate::Complete {
                stop_reason: "end".into(),
            },
        ];
        let result = compact_events(events);
        let locs_from_update = match &result[1] {
            AcpUpdate::ToolCallUpdate { locations, .. } => locations.clone(),
            _ => panic!("expected ToolCallUpdate second"),
        };
        assert_eq!(
            locs_from_update,
            vec![
                ("a.rs".into(), Some(1)),
                ("b.rs".into(), Some(2)),
                ("c.rs".into(), None),
            ],
            "ToolCallUpdate flush should accumulate deduped locations in insertion order"
        );
    }
}
