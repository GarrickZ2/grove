//! Normalize agent-owned terminal metadata at the adapter boundary. These are
//! display snapshots, never process handles or terminals Grove may execute in.
use std::collections::{HashMap, VecDeque};

use super::{acp, TerminalExitStatusData, ToolCallContentData};

#[derive(Debug)]
pub enum AgentTerminalEvent {
    Open(String),
    Append(String, String),
    Exit(String, TerminalExitStatusData),
}

/// Codex and Claude use the Zed metadata convention. Both output keys carry
/// chunks (including a single final chunk for replay), not cumulative snapshots.
pub fn parse_terminal_meta(meta: Option<&acp::Meta>) -> Vec<AgentTerminalEvent> {
    let Some(meta) = meta else { return Vec::new() };
    let mut events = Vec::new();
    let id = |value: &serde_json::Value| {
        value
            .get("terminal_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if let Some(terminal) = meta.get("terminal_info") {
        if let Some(id) = id(terminal) {
            events.push(AgentTerminalEvent::Open(id));
        }
    }
    // Prefer the explicit delta if a sender supplies both compatibility keys.
    if let Some(output) = meta
        .get("terminal_output_delta")
        .or_else(|| meta.get("terminal_output"))
    {
        if let (Some(id), Some(data)) = (id(output), output.get("data").and_then(|v| v.as_str())) {
            events.push(AgentTerminalEvent::Append(id, data.to_owned()));
        }
    }
    if let Some(exit) = meta.get("terminal_exit") {
        if let Some(id) = id(exit) {
            let status = TerminalExitStatusData {
                exit_code: exit
                    .get("exit_code")
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u32::try_from(v).ok()),
                signal: exit
                    .get("signal")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
            };
            if status.exit_code.is_some() || status.signal.is_some() {
                events.push(AgentTerminalEvent::Exit(id, status));
            }
        }
    }
    events
}

const OUTPUT_LIMIT: usize = 32 * 1024;
const CACHE_LIMIT: usize = 128;

#[derive(Default)]
pub struct AgentTerminalCache {
    tools: HashMap<String, Vec<ToolCallContentData>>,
    order: VecDeque<String>,
}

impl AgentTerminalCache {
    pub fn reset(&mut self, tool_id: &str) {
        self.tools.remove(tool_id);
        self.order.retain(|id| id != tool_id);
    }

    pub fn contains(&self, tool_id: &str) -> bool {
        self.tools.contains_key(tool_id)
    }

    pub fn snapshot(&self, tool_id: &str) -> Option<Vec<ToolCallContentData>> {
        self.tools.get(tool_id).cloned()
    }

    /// Explicit ACP content replaces the collection; metadata-only updates
    /// preserve it. Snapshots of matching terminal references survive a later
    /// reference-only content replacement, as they do in the frontend reducer.
    pub fn normalize(
        &mut self,
        tool_id: &str,
        output: Option<Vec<ToolCallContentData>>,
        events: Vec<AgentTerminalEvent>,
    ) -> Option<Vec<ToolCallContentData>> {
        if events.is_empty() && !self.tools.contains_key(tool_id) {
            return output;
        }
        let changed = output.is_some() || !events.is_empty();
        let previous = self.tools.remove(tool_id).unwrap_or_default();
        let mut next = match output {
            Some(mut output) => {
                for item in &mut output {
                    if let ToolCallContentData::Terminal {
                        terminal_id,
                        output,
                        truncated,
                        exit_status,
                    } = item
                    {
                        if let Some(ToolCallContentData::Terminal { output: old, truncated: was_truncated, exit_status: status, .. }) = previous.iter().find(|v| matches!(v, ToolCallContentData::Terminal { terminal_id: id, .. } if id == terminal_id)) {
                            if output.is_none() { *output = old.clone(); *truncated = *was_truncated; }
                            if exit_status.is_none() { *exit_status = status.clone(); }
                        }
                    }
                }
                output
            }
            None => previous,
        };
        for event in events {
            let id = match &event {
                AgentTerminalEvent::Open(id)
                | AgentTerminalEvent::Append(id, _)
                | AgentTerminalEvent::Exit(id, _) => id,
            };
            let index = next.iter().position(|v| matches!(v, ToolCallContentData::Terminal { terminal_id, .. } if terminal_id == id));
            let index = index.unwrap_or_else(|| {
                next.push(ToolCallContentData::Terminal {
                    terminal_id: id.clone(),
                    output: Some(String::new()),
                    truncated: false,
                    exit_status: None,
                });
                next.len() - 1
            });
            if let ToolCallContentData::Terminal {
                output,
                truncated,
                exit_status,
                ..
            } = &mut next[index]
            {
                match event {
                    AgentTerminalEvent::Open(_) => {
                        output.get_or_insert_with(String::new);
                    }
                    AgentTerminalEvent::Append(_, chunk) => {
                        let text = output.get_or_insert_with(String::new);
                        text.push_str(&chunk);
                        if text.len() > OUTPUT_LIMIT {
                            let mut cut = text.len() - OUTPUT_LIMIT;
                            while !text.is_char_boundary(cut) {
                                cut += 1;
                            }
                            text.drain(..cut);
                            *truncated = true;
                        }
                    }
                    AgentTerminalEvent::Exit(_, status) => {
                        *exit_status = Some(status);
                    }
                }
            }
        }
        self.order.retain(|id| id != tool_id);
        self.order.push_back(tool_id.to_owned());
        self.tools.insert(tool_id.to_owned(), next.clone());
        while self.order.len() > CACHE_LIMIT {
            if let Some(id) = self.order.pop_front() {
                self.tools.remove(&id);
            }
        }
        changed.then_some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::super::adapter::resolve_adapter;
    use super::*;

    fn meta(value: serde_json::Value) -> acp::Meta {
        serde_json::from_value(value).unwrap()
    }
    fn terminal(output: &[ToolCallContentData]) -> (&str, bool, Option<&TerminalExitStatusData>) {
        match &output[0] {
            ToolCallContentData::Terminal {
                output,
                truncated,
                exit_status,
                ..
            } => (
                output.as_deref().unwrap_or_default(),
                *truncated,
                exit_status.as_ref(),
            ),
            _ => panic!("expected terminal snapshot"),
        }
    }

    #[test]
    fn agent_selection_and_malformed_metadata_are_isolated() {
        let metadata =
            meta(serde_json::json!({"terminal_output_delta":{"terminal_id":"t","data":"hello"}}));
        for (name, command) in [
            ("codex", "codex"),
            ("@agentclientprotocol/codex-acp", "npx"),
            ("custom", "/bin/codex-acp"),
            ("claude", "claude"),
            ("custom", "claude-agent-acp"),
        ] {
            let adapter = resolve_adapter(name, command);
            assert!(adapter.supports_terminal_metadata());
            assert_eq!(adapter.terminal_events(Some(&metadata)).len(), 1);
        }
        let default = resolve_adapter("other", "other");
        assert!(!default.supports_terminal_metadata());
        assert!(default.terminal_events(Some(&metadata)).is_empty());
        assert!(parse_terminal_meta(Some(&meta(serde_json::json!({"terminal_info":{},"terminal_output_delta":{"terminal_id":"t","data":7},"terminal_exit":{"terminal_id":"t","exit_code":-1}})))).is_empty());
    }

    #[test]
    fn chunks_preserve_identical_text_and_exit_and_reference_replacements() {
        let mut cache = AgentTerminalCache::default();
        let initial = cache
            .normalize(
                "tool",
                None,
                parse_terminal_meta(Some(&meta(
                    serde_json::json!({"terminal_info":{"terminal_id":"t","cwd":"/tmp"}}),
                ))),
            )
            .unwrap();
        assert_eq!(terminal(&initial), ("", false, None));
        for key in ["terminal_output_delta", "terminal_output"] {
            cache.normalize(
                "tool",
                None,
                parse_terminal_meta(Some(&meta(
                    serde_json::json!({key:{"terminal_id":"t","data":"same\n"}}),
                ))),
            );
        }
        let output = cache.normalize("tool", Some(vec![ToolCallContentData::Terminal { terminal_id: "t".into(), output: None, truncated: false, exit_status: None }]), parse_terminal_meta(Some(&meta(serde_json::json!({"terminal_exit":{"terminal_id":"t","exit_code":0,"signal":null}}))))).unwrap();
        assert_eq!(
            terminal(&output),
            (
                "same\nsame\n",
                false,
                Some(&TerminalExitStatusData {
                    exit_code: Some(0),
                    signal: None
                })
            )
        );
        assert!(cache.normalize("tool", None, vec![]).is_none());
        assert!(cache
            .normalize("tool", Some(vec![]), vec![])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn output_is_bounded_on_utf8_boundaries_and_calls_do_not_mix() {
        let mut cache = AgentTerminalCache::default();
        let output = cache
            .normalize(
                "a",
                None,
                vec![AgentTerminalEvent::Append(
                    "t-a".into(),
                    "你好".repeat(OUTPUT_LIMIT),
                )],
            )
            .unwrap();
        let (text, truncated, _) = terminal(&output);
        assert!(text.len() <= OUTPUT_LIMIT);
        assert!(truncated);
        let b = cache
            .normalize(
                "b",
                None,
                vec![AgentTerminalEvent::Exit(
                    "t-b".into(),
                    TerminalExitStatusData {
                        exit_code: None,
                        signal: Some("SIGTERM".into()),
                    },
                )],
            )
            .unwrap();
        assert_eq!(terminal(&b).0, "");
        assert_eq!(terminal(&b).2.unwrap().signal.as_deref(), Some("SIGTERM"));
        for i in 0..CACHE_LIMIT + 1 {
            cache.normalize(
                &i.to_string(),
                None,
                vec![AgentTerminalEvent::Open(i.to_string())],
            );
        }
        assert_eq!(cache.tools.len(), CACHE_LIMIT);
        assert!(!cache.tools.contains_key("a"));
    }

    #[tokio::test]
    async fn codex_notifications_normalize_to_replayable_generic_tool_events() {
        use super::super::{
            handle_session_notification, new_handle_for_test, tests::client_state_for_test,
            AcpUpdate,
        };
        use std::sync::{Arc, Mutex};
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        struct RestoreStorage;
        impl Drop for RestoreStorage {
            fn drop(&mut self) {
                crate::storage::set_grove_dir_override(None);
            }
        }
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _restore = RestoreStorage;
        let key = format!("codex-terminal-test-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        let mut state = client_state_for_test(handle, Arc::new(Mutex::new(HashMap::new())));
        Arc::get_mut(&mut state).unwrap().adapter = resolve_adapter("codex", "codex-acp");
        let wire = [
            serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"exec-1","name":"exec_command","title":"pwd","kind":"execute","status":"in_progress","content":[{"type":"terminal","terminalId":"exec-1"}],"_meta":{"terminal_info":{"terminal_id":"exec-1","cwd":"/tmp"}}}),
            serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"exec-1","_meta":{"terminal_output_delta":{"terminal_id":"exec-1","data":"/tm"}}}),
            serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"exec-1","_meta":{"terminal_output":{"terminal_id":"exec-1","data":"p\n"}}}),
            serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"exec-1","status":"completed","_meta":{"terminal_exit":{"terminal_id":"exec-1","exit_code":0,"signal":null}}}),
        ];
        for value in wire {
            let notification = acp::SessionNotification::new(
                "session-test",
                serde_json::from_value(value).unwrap(),
            );
            handle_session_notification(&state, notification)
                .await
                .unwrap();
        }
        let events: Vec<_> = std::iter::from_fn(|| updates.try_recv().ok()).collect();
        assert!(events.iter().any(|event| matches!(event, AcpUpdate::TerminalOutputUpdate { output, .. } if output == "/tmp\n")));
        let persisted = crate::storage::chat_history::load_history("project", "task", "chat");
        let events = crate::storage::chat_history::compact_events(persisted);
        // Round-trip the same representation persisted by history.jsonl.
        let replay: Vec<AcpUpdate> =
            serde_json::from_str(&serde_json::to_string(&events).unwrap()).unwrap();
        let output = replay
            .iter()
            .find_map(|event| match event {
                AcpUpdate::ToolCallUpdateV1 {
                    status: Some(status),
                    output: Some(output),
                    ..
                } if status == "completed" => Some(output),
                _ => None,
            })
            .expect("completed command preserves output");
        let (text, truncated, exit) = terminal(output);
        assert_eq!(text, "/tmp\n");
        assert!(!truncated);
        assert_eq!(exit.unwrap().exit_code, Some(0));
    }
}
