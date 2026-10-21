//! Child sessions share a transport, never the parent's transcript or controls.
use super::*;
use agent_client_protocol::schema::MaybeUndefined;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SubagentUpdateData {
    pub session_id: String,
    pub parent_session_id: String,
    /// Transport reconciliation, not a new delegation in the transcript.
    #[serde(default)]
    pub snapshot: bool,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub title: MaybeUndefined<String>,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub description: MaybeUndefined<String>,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub capabilities: MaybeUndefined<Value>,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub state: MaybeUndefined<Value>,
}

struct Child {
    parent: String,
    title: Option<String>,
    cancel: bool,
    cancellation: CancellationToken,
    snapshot: SubagentUpdateData,
}

#[derive(Default)]
pub(super) struct SubagentRegistry {
    children: HashMap<String, Child>,
    // Request IDs are Grove-generated for children; tool IDs are only session-local.
    pub(super) owners: HashMap<String, String>,
}

impl SubagentRegistry {
    pub(super) fn has_active_children(&self) -> bool {
        self.children
            .values()
            .any(|child| match &child.snapshot.state {
                MaybeUndefined::Value(state) => !matches!(
                    state["state"].as_str(),
                    Some("idle" | "_completed" | "_failed" | "_cancelled")
                ),
                _ => true,
            })
    }
}

impl AcpSessionHandle {
    pub(super) fn is_subagent(&self, id: &str) -> bool {
        self.subagents.lock().unwrap().children.contains_key(id)
    }

    fn root_session_id(&self) -> Option<String> {
        self.agent_info
            .read()
            .ok()?
            .as_ref()
            .map(|info| info.0.clone())
    }

    pub(super) fn validate_session(&self, id: &str) -> acp::Result<()> {
        if self.root_session_id().as_deref() == Some(id) || self.is_subagent(id) {
            Ok(())
        } else {
            Err(acp::Error::invalid_params().data("Unknown session on this connection"))
        }
    }

    pub(super) fn child_cancellation(&self, id: &str) -> CancellationToken {
        self.subagents
            .lock()
            .unwrap()
            .children
            .get(id)
            .map(|child| child.cancellation.clone())
            .unwrap_or_default()
    }

    pub(super) fn own_child_request(&self, key: &str, session: &str) {
        let mut registry = self.subagents.lock().unwrap();
        if registry.children.contains_key(session) {
            registry.owners.insert(key.to_owned(), session.to_owned());
        }
    }

    pub(super) fn child_title(&self, session: &str) -> Option<String> {
        self.subagents
            .lock()
            .unwrap()
            .children
            .get(session)
            .map(|child| child.title.clone().unwrap_or_else(|| "Subagent".to_owned()))
    }

    pub(super) fn register_subagent(&self, parent: &str, update: acp::SubagentUpdate) {
        let id = update.session_id.to_string();
        if id == parent || self.root_session_id().as_deref() == Some(&id) {
            return;
        }
        let mut registry = self.subagents.lock().unwrap();
        // Ownership is immutable; reject cycles/reparenting and cross-session injection.
        if let Some(child) = registry.children.get(&id) {
            if child.parent != parent {
                return;
            }
        }
        let child = registry
            .children
            .entry(id.clone())
            .or_insert_with(|| Child {
                parent: parent.to_owned(),
                title: None,
                cancel: false,
                cancellation: CancellationToken::new(),
                snapshot: SubagentUpdateData {
                    session_id: id.clone(),
                    parent_session_id: parent.to_owned(),
                    snapshot: false,
                    title: MaybeUndefined::Undefined,
                    description: MaybeUndefined::Undefined,
                    capabilities: MaybeUndefined::Undefined,
                    state: MaybeUndefined::Undefined,
                },
            });
        match &update.title {
            MaybeUndefined::Value(title) => child.title = Some(title.clone()),
            MaybeUndefined::Null => child.title = None,
            _ => {}
        }
        match &update.capabilities {
            MaybeUndefined::Value(capabilities) => child.cancel = capabilities.cancel.is_some(),
            MaybeUndefined::Null => child.cancel = false,
            _ => {}
        }
        let data = SubagentUpdateData {
            session_id: id,
            parent_session_id: parent.to_owned(),
            snapshot: false,
            title: update.title,
            description: update.description,
            capabilities: update
                .capabilities
                .map_value(|value| serde_json::to_value(value).unwrap()),
            state: update
                .state
                .map_value(|value| serde_json::to_value(value).unwrap()),
        };
        macro_rules! patch {
            ($field:ident) => {
                if !data.$field.is_undefined() {
                    child.snapshot.$field = data.$field.clone();
                }
            };
        }
        patch!(title);
        patch!(description);
        patch!(capabilities);
        patch!(state);
        // A reusable child can re-enter a truncated history window. Carry its
        // identity on live updates even when the Agent sends only a state patch.
        let data = child.snapshot.clone();
        drop(registry);
        self.emit(AcpUpdate::SubagentUpdate { update: data });
    }

    pub(crate) fn subagent_snapshots(&self) -> Vec<AcpUpdate> {
        let mut pending = Vec::new();
        if let Some((id, _)) = self.pending_permission.lock().unwrap().as_ref() {
            pending.push(id.clone());
        }
        if let Some(request) = self.pending_elicitation_snapshot() {
            pending.push(request.request_id);
        }
        pending.extend(
            self.active_url_elicitation_snapshots()
                .into_iter()
                .map(|request| request.request_id),
        );
        let registry = self.subagents.lock().unwrap();
        let needs_input: std::collections::HashSet<_> = pending
            .iter()
            .filter_map(|id| registry.owners.get(id))
            .cloned()
            .collect();
        let mut snapshots = Vec::new();
        fn visit(
            parent: &str,
            registry: &SubagentRegistry,
            needs_input: &std::collections::HashSet<String>,
            snapshots: &mut Vec<AcpUpdate>,
        ) {
            for child in registry
                .children
                .values()
                .filter(|child| child.parent == parent)
            {
                let mut update = child.snapshot.clone();
                update.snapshot = true;
                if needs_input.contains(&update.session_id) {
                    update.state = MaybeUndefined::Value(json!({"state": "requires_action"}));
                }
                snapshots.push(AcpUpdate::SubagentUpdate { update });
                visit(&child.snapshot.session_id, registry, needs_input, snapshots);
            }
        }
        if let Some(root) = self.root_session_id() {
            visit(&root, &registry, &needs_input, &mut snapshots);
        }
        snapshots
    }

    pub(super) fn emit_child(&self, session: &str, event: AcpUpdate) {
        self.emit(AcpUpdate::SubagentEvent {
            session_id: session.to_owned(),
            event: Box::new(event),
        });
    }

    pub(crate) fn scope_subagent_event(&self, event: AcpUpdate) -> AcpUpdate {
        let key = match &event {
            AcpUpdate::PermissionRequest { id, .. } | AcpUpdate::PermissionResponse { id, .. } => {
                Some(id.as_str())
            }
            AcpUpdate::ElicitationRequest { snapshot } => Some(snapshot.request_id.as_str()),
            AcpUpdate::ElicitationResolved { request_id, .. }
            | AcpUpdate::ElicitationValidationError { request_id, .. } => Some(request_id.as_str()),
            AcpUpdate::ElicitationComplete { elicitation_id } => Some(elicitation_id.as_str()),
            AcpUpdate::TerminalOutputUpdate { terminal_id, .. } => Some(terminal_id.as_str()),
            _ => None,
        };
        let session = key.and_then(|key| self.subagents.lock().unwrap().owners.get(key).cloned());
        if let Some(session_id) = session {
            AcpUpdate::SubagentEvent {
                session_id,
                event: Box::new(event),
            }
        } else {
            event
        }
    }

    pub fn cancel_subagent(&self, session: &str) -> std::result::Result<(), String> {
        let mut registry = self.subagents.lock().unwrap();
        let child = registry
            .children
            .get_mut(session)
            .ok_or("Unknown subagent")?;
        if !child.cancel {
            return Err("Subagent does not support cancellation".into());
        }
        let connection = self.subagent_connection.lock().unwrap();
        let connection = connection.as_ref().ok_or("Agent is disconnected")?;
        connection
            .send_notification(acp::CancelNotification::new(session.to_owned()))
            .map_err(|error| error.to_string())?;
        // Cancel queued and visible requests for this child, never another child.
        child.cancellation.cancel();
        child.cancellation = CancellationToken::new();
        Ok(())
    }

    pub(super) fn end_subagents(&self) {
        let updates = {
            let mut registry = self.subagents.lock().unwrap();
            registry
                .children
                .values_mut()
                .map(|child| {
                    child.cancellation.cancel();
                    child.cancel = false;
                    child.snapshot.capabilities = MaybeUndefined::Null;
                    let known = match &child.snapshot.state {
                        MaybeUndefined::Value(value) => matches!(
                            value["state"].as_str(),
                            Some("idle" | "_completed" | "_failed" | "_cancelled")
                        ),
                        _ => false,
                    };
                    if !known {
                        child.snapshot.state = MaybeUndefined::Value(json!({"state":"unknown"}));
                    }
                    let mut update = child.snapshot.clone();
                    update.snapshot = true;
                    update
                })
                .collect::<Vec<_>>()
        };
        for update in updates {
            self.emit(AcpUpdate::SubagentUpdate { update });
        }
    }
}

pub(super) fn session_message(message: acp::SessionMessage) -> AcpUpdate {
    AcpUpdate::SessionMessage {
        id: message.message_id.to_string(),
        sender: message.sender_session_id.map(|id| id.to_string()),
        recipient: message.recipient_session_id.map(|id| id.to_string()),
        content: message
            .content
            .map_value(|blocks| blocks.iter().filter_map(content_block_to_data).collect()),
        append: false,
    }
}

pub(super) fn session_message_chunk(chunk: acp::SessionMessageChunk) -> AcpUpdate {
    AcpUpdate::SessionMessage {
        id: chunk.message_id.to_string(),
        sender: chunk.sender_session_id.map(|id| id.to_string()),
        recipient: chunk.recipient_session_id.map(|id| id.to_string()),
        content: MaybeUndefined::Value(content_block_to_data(&chunk.content).into_iter().collect()),
        append: true,
    }
}

impl AcpClientState {
    pub(super) fn handle_child_notification(
        &self,
        notification: acp::SessionNotification,
    ) -> acp::Result<()> {
        let session = notification.session_id.to_string();
        let event = match notification.update {
            acp::SessionUpdate::SubagentUpdate(update) => {
                self.handle.register_subagent(&session, update);
                return Ok(());
            }
            acp::SessionUpdate::SessionMessage(message) => session_message(message),
            acp::SessionUpdate::SessionMessageChunk(chunk) => session_message_chunk(chunk),
            acp::SessionUpdate::AgentMessageChunk(chunk) => {
                if let acp::ContentBlock::Text(text) = chunk.content {
                    AcpUpdate::MessageChunk { text: text.text }
                } else if let Some(content) = content_block_to_data(&chunk.content) {
                    AcpUpdate::MessageContentChunk { content }
                } else {
                    return Ok(());
                }
            }
            acp::SessionUpdate::UserMessageChunk(chunk) => {
                let (text, attachments) = content_block_to_user_message(&chunk.content);
                AcpUpdate::UserMessage {
                    text,
                    attachments,
                    client_message_id: None,
                    sender: None,
                    terminal: false,
                }
            }
            acp::SessionUpdate::AgentThoughtChunk(chunk) => AcpUpdate::ThoughtChunk {
                text: content_block_to_text(&chunk.content),
            },
            acp::SessionUpdate::ToolCall(call) => {
                let key = format!("{}:{}", session.len(), session) + &call.tool_call_id.to_string();
                let output = tool_output_to_data(
                    self.adapter.as_ref(),
                    &call.content,
                    call.raw_output.as_ref(),
                    Some(&self.terminals),
                );
                let output = {
                    let mut cache = self.agent_terminals.lock().unwrap();
                    cache.reset(&key);
                    cache
                        .normalize(
                            &key,
                            Some(output),
                            self.adapter.terminal_events(call.meta.as_ref()),
                        )
                        .unwrap_or_default()
                };
                AcpUpdate::ToolCallV1 {
                    id: call.tool_call_id.to_string(),
                    name: call.name,
                    title: call.title,
                    kind: tool_kind_name(&call.kind).into(),
                    status: tool_status_name(&call.status).into(),
                    content: tool_output_display_text(&output),
                    input: tool_input_to_data(call.raw_input.as_ref()),
                    legacy_raw_input: None,
                    legacy_raw_output: None,
                    output,
                    locations: call
                        .locations
                        .iter()
                        .map(|location| (location.path.display().to_string(), location.line))
                        .collect(),
                    timestamp: Some(Utc::now()),
                }
            }
            acp::SessionUpdate::ToolCallUpdate(call) => {
                let key = format!("{}:{}", session.len(), session) + &call.tool_call_id.to_string();
                let output = if call.fields.content.is_some() || call.fields.raw_output.is_some() {
                    Some(tool_output_to_data(
                        self.adapter.as_ref(),
                        call.fields.content.as_deref().unwrap_or_default(),
                        call.fields.raw_output.as_ref(),
                        Some(&self.terminals),
                    ))
                } else {
                    None
                };
                let explicit_output = output.is_some();
                let finished = call.fields.status.as_ref().is_some_and(|status| {
                    matches!(
                        status,
                        acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed
                    )
                });
                let events = self.adapter.terminal_events(call.meta.as_ref());
                let has_events = !events.is_empty();
                let mut output = {
                    let mut cache = self.agent_terminals.lock().unwrap();
                    let normalized = cache.normalize(&key, output, events);
                    if finished {
                        normalized.or_else(|| cache.snapshot(&key))
                    } else {
                        normalized
                    }
                };
                if has_events && !explicit_output && !finished {
                    for item in output.as_deref().unwrap_or_default() {
                        if let ToolCallContentData::Terminal {
                            terminal_id,
                            output: Some(output),
                            truncated,
                            exit_status,
                        } = item
                        {
                            self.handle.emit_child(
                                &session,
                                AcpUpdate::TerminalOutputUpdate {
                                    terminal_id: terminal_id.clone(),
                                    output: output.clone(),
                                    truncated: *truncated,
                                    exit_status: exit_status.clone(),
                                },
                            );
                        }
                    }
                    output = None;
                }
                AcpUpdate::ToolCallUpdateV1 {
                    id: call.tool_call_id.to_string(),
                    name: call.fields.name,
                    title: call.fields.title,
                    kind: call
                        .fields
                        .kind
                        .as_ref()
                        .map(|kind| tool_kind_name(kind).into()),
                    status: call
                        .fields
                        .status
                        .as_ref()
                        .map(|status| tool_status_name(status).into()),
                    display_content: output
                        .as_ref()
                        .and_then(|output| tool_output_display_text(output)),
                    output,
                    locations: call.fields.locations.map(|locations| {
                        locations
                            .iter()
                            .map(|location| (location.path.display().to_string(), location.line))
                            .collect()
                    }),
                    input: call
                        .fields
                        .raw_input
                        .as_ref()
                        .map(|input| tool_input_to_data(Some(input))),
                    legacy_raw_input: None,
                    legacy_raw_output: None,
                    legacy_content: None,
                }
            }
            acp::SessionUpdate::PlanUpdate(update) => {
                let Some(plan) = plans::convert(update.plan) else {
                    return Ok(());
                };
                AcpUpdate::PlanDocumentUpdate { plan }
            }
            acp::SessionUpdate::PlanRemoved(update) => AcpUpdate::PlanDocumentRemoved {
                plan_id: update.plan_id.to_string(),
            },
            acp::SessionUpdate::Plan(plan) => AcpUpdate::PlanUpdate {
                entries: plan
                    .entries
                    .iter()
                    .map(|entry| PlanEntryData {
                        content: entry.content.clone(),
                        priority: Some(plan_priority_name(&entry.priority).into()),
                        status: plan_status_name(&entry.status).into(),
                    })
                    .collect(),
            },
            acp::SessionUpdate::Notice(notice) => AcpUpdate::SessionNotice {
                severity: serde_json::to_value(notice.severity)
                    .unwrap()
                    .as_str()
                    .unwrap_or("info")
                    .to_owned(),
                title: notice.title,
                description: notice.description,
            },
            acp::SessionUpdate::CompactionUpdate(update) => compaction::compaction_update(update),
            acp::SessionUpdate::CompactionSummaryChunk(chunk) => {
                match compaction::compaction_chunk(chunk) {
                    Some(event) => event,
                    None => return Ok(()),
                }
            }
            _ => return Ok(()),
        };
        self.handle.emit_child(&session, event);
        Ok(())
    }
}

/// Legacy adapters send untyped draft variants. Normalize before SDK deserialization;
/// the standard SDK intentionally cannot decode these legacy enum variants.
fn normalize_legacy(value: &mut Value) {
    if value["method"] != "session/update" {
        return;
    }
    let Some(update) = value.pointer_mut("/params/update") else {
        return;
    };
    let Some(id) = update["subagentSessionId"].as_str().map(str::to_owned) else {
        return;
    };
    match update["sessionUpdate"].as_str() {
        Some("subagent_spawned") => {
            *update = json!({"sessionUpdate":"subagent_update", "sessionId":id,
                "title":update["name"], "description":update["task"],
                "capabilities": if update["capabilities"]["cancel"] == true { json!({"cancel":{}}) } else { json!({}) },
                "state":{"state":"running"}});
        }
        Some("subagent_state_update") => {
            let state = match update["state"].as_str() {
                Some("completed") => "_completed",
                Some("failed") => "_failed",
                Some("cancelled") => "_cancelled",
                _ => "unknown",
            };
            *update =
                json!({"sessionUpdate":"subagent_update", "sessionId":id, "state":{"state":state}});
        }
        _ => {}
    }
}

pub(super) fn adapt_reader(
    reader: Box<dyn futures::AsyncRead + Send + Unpin>,
    legacy: bool,
) -> Box<dyn futures::AsyncRead + Send + Unpin> {
    if !legacy {
        return reader;
    }
    use tokio::io::AsyncWriteExt;
    use tokio_util::compat::FuturesAsyncReadCompatExt;
    let (output, mut input) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(reader.compat());
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                _ => {}
            }
            if let Ok(mut value) = serde_json::from_slice::<Value>(&line) {
                if matches!(
                    value
                        .pointer("/params/update/sessionUpdate")
                        .and_then(Value::as_str),
                    Some("subagent_spawned" | "subagent_state_update")
                ) {
                    normalize_legacy(&mut value);
                    line = serde_json::to_vec(&value).unwrap();
                    line.push(b'\n');
                }
            }
            if input.write_all(&line).await.is_err() {
                break;
            }
        }
    });
    Box::new(output.compat())
}

#[cfg(test)]
mod tests {
    use super::super::{new_handle_for_test, tests::client_state_for_test};
    use super::*;
    use tokio::io::AsyncWriteExt;

    struct RestoreStorage;
    impl Drop for RestoreStorage {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    async fn notify(state: &AcpClientState, session: &str, update: Value) {
        handle_session_notification(
            state,
            acp::SessionNotification::new(
                session.to_owned(),
                serde_json::from_value(update).unwrap(),
            ),
        )
        .await
        .unwrap();
    }

    fn child(id: &str) -> acp::SubagentUpdate {
        serde_json::from_value(json!({"sessionId":id,"title":id,"capabilities":{"cancel":{}},"state":{"state":"running"}})).unwrap()
    }

    #[test]
    fn legacy_codex_and_claude_drafts_preserve_terminal_semantics() {
        let mut value = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"root","update":{"sessionUpdate":"subagent_spawned","subagentSessionId":"child","name":"Research","task":"Investigate","capabilities":{"cancel":true,"close":true}}}});
        normalize_legacy(&mut value);
        let notification: acp::SessionNotification =
            serde_json::from_value(value["params"].clone()).unwrap();
        assert!(
            matches!(notification.update, acp::SessionUpdate::SubagentUpdate(update) if matches!(&update.capabilities, MaybeUndefined::Value(c) if c.cancel.is_some()))
        );
        for (state, expected) in [
            ("completed", "_completed"),
            ("failed", "_failed"),
            ("cancelled", "_cancelled"),
            ("disconnected", "unknown"),
        ] {
            value["params"]["update"] = json!({"sessionUpdate":"subagent_state_update","subagentSessionId":"child","state":state});
            normalize_legacy(&mut value);
            assert_eq!(value["params"]["update"]["state"]["state"], expected);
            assert!(
                serde_json::from_value::<acp::SessionNotification>(value["params"].clone()).is_ok()
            );
        }
    }

    #[tokio::test]
    async fn legacy_transport_translates_only_draft_notifications() {
        use futures::AsyncReadExt;
        let input = concat!(
            "{\"method\":\"session/update\",\"params\":{\"sessionId\":\"root\",\"update\":{\"sessionUpdate\":\"subagent_spawned\",\"subagentSessionId\":\"child\",\"name\":\"Research\",\"task\":\"Test\",\"capabilities\":{}}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"unchanged\":true}}\n"
        );
        let mut output = String::new();
        adapt_reader(
            Box::new(futures::io::Cursor::new(input.as_bytes().to_vec())),
            true,
        )
        .read_to_string(&mut output)
        .await
        .unwrap();
        let lines: Vec<Value> = output
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines[0]["params"]["update"]["sessionUpdate"],
            "subagent_update"
        );
        assert_eq!(
            lines[1],
            json!({"jsonrpc":"2.0","id":1,"result":{"unchanged":true}})
        );
    }

    #[tokio::test]
    async fn subagent_processes_and_terminal_ids_are_isolated_and_persisted() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _restore = RestoreStorage;
        let (handle, mut updates, _guard) =
            new_handle_for_test(&uuid::Uuid::new_v4().to_string(), "project", "task", "chat");
        let mut state = client_state_for_test(handle.clone(), Arc::new(Mutex::new(HashMap::new())));
        Arc::get_mut(&mut state).unwrap().adapter = Box::new(adapter::CodexAdapter);
        handle.register_subagent("session-test", child("a"));
        handle.register_subagent("session-test", child("b"));
        for (id, text) in [("a", "first"), ("b", "second")] {
            notify(&state, id, json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})).await;
            notify(&state, id, json!({"sessionUpdate":"tool_call","toolCallId":"same","title":"exec_command","kind":"execute","status":"in_progress","content":[{"type":"terminal","terminalId":"same-terminal"}]})).await;
            notify(&state, id, json!({"sessionUpdate":"tool_call_update","toolCallId":"same","_meta":{"terminal_output_delta":{"terminal_id":"same-terminal","data":text}}})).await;
            notify(&state, id, json!({"sessionUpdate":"tool_call_update","toolCallId":"same","status":"completed"})).await;
        }
        notify(&state, "foreign", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"must be dropped"}})).await;
        assert!(handle.last_assistant_text.lock().unwrap().is_empty());
        assert!(handle.active_tool_calls.lock().unwrap().is_empty());
        let live: Vec<_> = std::iter::from_fn(|| updates.try_recv().ok()).collect();
        for (id, text) in [("a", "first"), ("b", "second")] {
            assert!(live.iter().any(|event| matches!(event, AcpUpdate::SubagentEvent { session_id, event } if session_id == id && matches!(event.as_ref(), AcpUpdate::ToolCallUpdateV1 { status: Some(status), output: Some(output), .. } if status == "completed" && matches!(&output[0], ToolCallContentData::Terminal { output: Some(value), .. } if value == text)))));
        }
        let history = crate::storage::chat_history::load_history("project", "task", "chat");
        assert_eq!(
            history
                .iter()
                .filter(|event| matches!(event, AcpUpdate::SubagentUpdate { .. }))
                .count(),
            2
        );
        assert!(!history
            .iter()
            .any(|event| matches!(event, AcpUpdate::MessageChunk { .. })));
        assert!(!history.iter().any(|event| matches!(event, AcpUpdate::SubagentEvent { event, .. } if matches!(event.as_ref(), AcpUpdate::TerminalOutputUpdate { exit_status: None, .. }))));
    }

    #[tokio::test]
    async fn child_capabilities_and_ownership_are_patched_without_reparenting() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _restore = RestoreStorage;
        let (handle, _updates, _guard) =
            new_handle_for_test(&uuid::Uuid::new_v4().to_string(), "project", "task", "chat");
        handle.register_subagent("session-test", child("a"));
        handle.register_subagent("a", child("b"));
        handle.register_subagent("b", child("a"));
        assert_eq!(
            handle.subagents.lock().unwrap().children["a"].parent,
            "session-test"
        );
        handle.register_subagent(
            "session-test",
            serde_json::from_value(
                json!({"sessionId":"a","title":null,"capabilities":null,"state":{"state":"idle"}}),
            )
            .unwrap(),
        );
        assert!(!handle.subagents.lock().unwrap().children["a"].cancel);
        assert!(handle
            .cancel_subagent("a")
            .unwrap_err()
            .contains("does not support"));
        assert!(handle.validate_session("foreign").is_err());
        // Live requests override a stale idle child snapshot and retain its UI entry.
        let (response, _receiver) = tokio::sync::oneshot::channel();
        *handle.pending_permission.lock().unwrap() = Some(("permission-a".into(), response));
        handle.own_child_request("permission-a", "a");
        assert!(handle.subagent_snapshots().iter().any(|event| matches!(event,
            AcpUpdate::SubagentUpdate { update } if update.session_id == "a"
                && matches!(&update.state, MaybeUndefined::Value(state) if state["state"] == "requires_action"))));
        handle.pending_permission.lock().unwrap().take();
        handle.end_subagents();
        let snapshots = handle.subagent_snapshots();
        assert!(snapshots
            .iter()
            .all(|event| matches!(event, AcpUpdate::SubagentUpdate { update } if update.snapshot)));
        assert!(snapshots
            .iter()
            .all(|event| !crate::storage::chat_history::should_persist(event)));
        assert!(
            matches!(&snapshots[0], AcpUpdate::SubagentUpdate { update } if update.session_id == "a" && matches!(&update.state, MaybeUndefined::Value(state) if state["state"] == "idle"))
        );
        assert!(
            matches!(&snapshots[1], AcpUpdate::SubagentUpdate { update } if update.session_id == "b")
        );
    }

    #[tokio::test]
    async fn subagent_permission_form_and_selective_cancel_work_over_jsonrpc() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _restore = RestoreStorage;
        let (handle, mut updates, _guard) =
            new_handle_for_test(&uuid::Uuid::new_v4().to_string(), "project", "task", "chat");
        handle.register_subagent("session-test", child("a"));
        handle.register_subagent("session-test", child("b"));
        let state = client_state_for_test(handle.clone(), Arc::new(Mutex::new(HashMap::new())));
        let (client_writer, peer_reader) = tokio::io::duplex(16384);
        let (mut peer_writer, client_reader) = tokio::io::duplex(16384);
        let client = acp::Client
            .builder()
            .on_receive_request(
                {
                    let state = state.clone();
                    async move |request: acp::RequestPermissionRequest, responder, cx| {
                        let cancel = state
                            .handle
                            .child_cancellation(&request.session_id.to_string());
                        let state = state.clone();
                        cx.spawn(async move {
                            match handle_request_permission(
                                &state,
                                request,
                                responder.cancellation(),
                                None,
                                cancel,
                            )
                            .await
                            {
                                Ok(response) => responder.respond(response),
                                Err(error) => responder.respond_with_error(error),
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let state = state.clone();
                    async move |request: acp::CreateElicitationRequest, responder, cx| {
                        let cancel = match request.scope() {
                            acp::ElicitationScope::Session(scope) => state
                                .handle
                                .child_cancellation(&scope.session_id.to_string()),
                            _ => Default::default(),
                        };
                        let state = state.clone();
                        cx.spawn(async move {
                            match handle_create_elicitation(
                                &state,
                                request,
                                responder.cancellation(),
                                None,
                                cancel,
                            )
                            .await
                            {
                                Ok(response) => responder.respond(response),
                                Err(error) => responder.respond_with_error(error),
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let saved_handle = handle.clone();
        let client_fut = client.connect_with(
            acp::ByteStreams::new(client_writer.compat_write(), client_reader.compat()),
            move |connection| async move {
                *saved_handle.subagent_connection.lock().unwrap() = Some(connection);
                futures::future::pending::<acp::Result<()>>().await
            },
        );
        let peer_fut = async {
            for (id, session) in [("permission-a", "a"), ("permission-b", "b")] {
                let request = json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":{"sessionId":session,"toolCall":{"toolCallId":"same","title":"command"},"options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"}]}});
                peer_writer
                    .write_all(format!("{request}\n").as_bytes())
                    .await
                    .unwrap();
            }
            let request = acp::CreateElicitationRequest::new(
                acp::ElicitationFormMode::new(
                    acp::ElicitationSessionScope::new("a"),
                    acp::ElicitationSchema::new().string("name", true),
                ),
                "Your name",
            );
            peer_writer.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":"form-a","method":"elicitation/create","params":request})).as_bytes()).await.unwrap();
            let mut permission_a = None;
            let mut form_a = None;
            while permission_a.is_none() || form_a.is_none() {
                if let AcpUpdate::SubagentEvent { session_id, event } =
                    updates.recv().await.unwrap()
                {
                    assert_eq!(session_id, "a");
                    match *event {
                        AcpUpdate::PermissionRequest { id, .. } => {
                            assert_ne!(id, "same");
                            permission_a = Some(id);
                        }
                        AcpUpdate::ElicitationRequest { snapshot } => {
                            assert_eq!(snapshot.agent_name, "a");
                            form_a = Some(snapshot.request_id);
                        }
                        _ => {}
                    }
                }
            }
            // Answer the form, validating that it goes to the child RPC rather
            // than becoming a prompt to the parent.
            assert!(matches!(
                handle.respond_elicitation(
                    form_a.as_deref().unwrap(),
                    ElicitationResponseData::Accept {
                        content: Some(BTreeMap::from([(
                            "name".into(),
                            ElicitationValueData::String("Ada".into())
                        )]))
                    }
                ),
                ElicitationResponseResult::Accepted
            ));
            handle.cancel_subagent("a").unwrap();
            let permission_b = loop {
                if let AcpUpdate::SubagentEvent { session_id, event } =
                    updates.recv().await.unwrap()
                {
                    if let AcpUpdate::PermissionRequest { id, .. } = *event {
                        assert_eq!(session_id, "b");
                        break id;
                    }
                }
            };
            assert_ne!(permission_a.as_ref().unwrap(), &permission_b);
            assert!(handle.pending_permission_accepts(&permission_b, "allow"));
            assert!(handle.respond_permission("allow".into()));
            let mut reader = tokio::io::BufReader::new(peer_reader);
            let mut responses = HashMap::new();
            let mut cancelled_sessions = Vec::new();
            while responses.len() < 3 || cancelled_sessions.is_empty() {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let response: Value = serde_json::from_str(&line).unwrap();
                if response["method"] == "session/cancel" {
                    cancelled_sessions.push(response["params"]["sessionId"].clone());
                } else if let Some(id) = response["id"].as_str() {
                    responses.insert(id.to_owned(), response);
                }
            }
            assert_eq!(cancelled_sessions, vec![json!("a")]);
            assert_eq!(
                responses["permission-a"]["result"]["outcome"]["outcome"],
                "cancelled"
            );
            assert_eq!(
                responses["permission-b"]["result"]["outcome"]["optionId"],
                "allow"
            );
            assert_eq!(responses["form-a"]["result"]["content"]["name"], "Ada");
            let history = crate::storage::chat_history::load_history("project", "task", "chat");
            assert!(crate::storage::chat_history::unresolved_permission_ids(&history).is_empty());
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::select! { _ = peer_fut => (), result = client_fut => panic!("unexpected connection end: {result:?}") }
        }).await.expect("child request flow must finish");
    }
}
