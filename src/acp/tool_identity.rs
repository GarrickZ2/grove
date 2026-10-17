//! Optional programmatic tool identities, kept separate from display titles.
use super::*;

#[derive(Clone)]
pub(super) struct ToolIdentity {
    name: Option<String>,
    title: String,
    kind: String,
    locations: Vec<(String, Option<u32>)>,
    started_at: std::time::Instant,
}

impl Default for ToolIdentity {
    fn default() -> Self {
        Self {
            name: None,
            title: String::new(),
            kind: "other".into(),
            locations: Vec::new(),
            started_at: std::time::Instant::now(),
        }
    }
}

impl ToolIdentity {
    fn edits_files(&self) -> bool {
        match self.kind.as_str() {
            "edit" => return true,
            "read" | "search" | "execute" | "fetch" | "delete" | "move" | "think"
            | "switch_mode" => return false,
            _ => {}
        }
        if let Some(name) = &self.name {
            return matches!(
                name.to_ascii_lowercase().as_str(),
                "write"
                    | "write_file"
                    | "writefile"
                    | "create_file"
                    | "edit"
                    | "edit_file"
                    | "editfile"
                    | "multiedit"
                    | "apply_patch"
                    | "replace"
                    | "str_replace_editor"
            );
        }
        self.title.starts_with("Write") || self.title.starts_with("Edit")
    }
}

fn grove_tool_name(name: &str) -> Option<String> {
    let normalized = name.to_ascii_lowercase();
    let normalized = ["mcp__", "mcp.", "mcp/", "mcp:"]
        .iter()
        .find_map(|prefix| normalized.strip_prefix(prefix))
        .unwrap_or(&normalized);
    [
        "grove_agent__",
        "grove_agent.",
        "grove_agent/",
        "grove_agent:",
    ]
    .iter()
    .find_map(|prefix| normalized.strip_prefix(prefix))
    .filter(|tool| tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
    .map(str::to_owned)
}

pub(crate) fn is_grove_memory_read_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("memory_read")
        || grove_tool_name(name).is_some_and(|name| name == "memory_read")
}

pub(super) fn is_short_memory_tool_named(name: Option<&str>, title: &str) -> bool {
    match name {
        Some(name) if !name.is_empty() => {
            grove_tool_name(name).is_some_and(|name| name.starts_with("memory_"))
        }
        _ => is_short_memory_tool(title),
    }
}

impl AcpClientState {
    /// Apply v1 metadata patch semantics before interpreting the call. Names
    /// omitted/null in updates leave the previous identity unchanged.
    pub(super) fn observe_tool_identity(
        &self,
        id: &str,
        name: Option<&str>,
        title: Option<&str>,
        kind: Option<&acp::ToolKind>,
        locations: Option<Vec<(String, Option<u32>)>>,
    ) {
        let active_calls = self.handle.active_tool_calls.lock().unwrap().clone();
        let active = active_calls.contains(id);
        let identity = {
            let mut identities = self.tool_identities.lock().unwrap();
            identities.retain(|key, _| key == id || active_calls.contains(key));
            let value = identities.entry(id.to_string()).or_default();
            if let Some(name) = name {
                value.name = Some(name.to_string());
            }
            if let Some(title) = title {
                value.title = title.to_string();
            }
            if let Some(kind) = kind {
                value.kind = tool_kind_name(kind).to_string();
            }
            if let Some(locations) = locations {
                value.locations = locations;
            }
            let value = value.clone();
            if !active {
                identities.remove(id);
            }
            value
        };
        let mut watches = self.handle.short_tool_watches.lock().unwrap();
        if active && is_short_memory_tool_named(identity.name.as_deref(), &identity.title) {
            let watch = watches
                .entry(id.to_string())
                .or_insert_with(|| ShortToolWatch {
                    title: identity.title.clone(),
                    started_at: identity.started_at,
                    deadline: identity.started_at + SHORT_MEMORY_TOOL_TIMEOUT,
                });
            watch.title = identity.title.clone();
        } else {
            watches.remove(id);
        }
        drop(watches);

        if identity.edits_files() {
            if let Some((path, _)) = identity.locations.first() {
                self.write_tool_paths
                    .lock()
                    .unwrap()
                    .insert(id.to_string(), path.clone());
                // A completed report cannot provide a trustworthy before-image.
                if active {
                    let path = PathBuf::from(path);
                    let mut snapshots = self.file_snapshots.lock().unwrap();
                    if snapshots
                        .get(id)
                        .is_none_or(|(previous, _)| previous != &path)
                    {
                        let old_content = std::fs::read_to_string(&path).ok();
                        snapshots.insert(id.to_string(), (path, old_content));
                    }
                }
            } else {
                self.write_tool_paths.lock().unwrap().remove(id);
                self.file_snapshots.lock().unwrap().remove(id);
            }
        } else {
            self.write_tool_paths.lock().unwrap().remove(id);
            self.file_snapshots.lock().unwrap().remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStorage(tempfile::TempDir);
    impl TestStorage {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            crate::storage::set_grove_dir_override(Some(dir.path().into()));
            Self(dir)
        }
    }
    impl Drop for TestStorage {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    fn state() -> (
        Arc<AcpClientState>,
        broadcast::Receiver<AcpUpdate>,
        TestSessionGuard,
    ) {
        let key = uuid::Uuid::new_v4().to_string();
        let (handle, updates, guard) = new_handle_for_test(&key, "project", "task", "chat");
        (
            super::super::tests::client_state_for_test(
                handle,
                Arc::new(Mutex::new(HashMap::new())),
            ),
            updates,
            guard,
        )
    }

    async fn notify(state: &AcpClientState, update: acp::SessionUpdate) {
        handle_session_notification(state, acp::SessionNotification::new("session-test", update))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn tool_names_can_arrive_late_and_correct_memory_watchdog_attribution() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _storage = TestStorage::new();
        let (state, mut updates, _guard) = state();
        notify(
            &state,
            acp::SessionUpdate::ToolCall(acp::ToolCall::new("tool", "正在读取")),
        )
        .await;
        assert!(state.handle.short_tool_watches.lock().unwrap().is_empty());
        notify(
            &state,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                "tool",
                acp::ToolCallUpdateFields::new().name("mcp__grove_agent__memory_read"),
            )),
        )
        .await;
        assert!(state
            .handle
            .short_tool_watches
            .lock()
            .unwrap()
            .contains_key("tool"));
        notify(
            &state,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                "tool",
                acp::ToolCallUpdateFields::new().title("Fetching context"),
            )),
        )
        .await;
        assert!(state
            .handle
            .short_tool_watches
            .lock()
            .unwrap()
            .contains_key("tool"));
        notify(
            &state,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                "tool",
                acp::ToolCallUpdateFields::new().name("mcp__other__memory_read"),
            )),
        )
        .await;
        assert!(state.handle.short_tool_watches.lock().unwrap().is_empty());
        let events = std::iter::from_fn(|| updates.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(event, AcpUpdate::ToolCallUpdateV1 { name: Some(name), .. } if name == "mcp__grove_agent__memory_read")));
        notify(
            &state,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                "tool",
                acp::ToolCallUpdateFields::new().status(acp::ToolCallStatus::Completed),
            )),
        )
        .await;
        assert!(state.tool_identities.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn late_named_edits_capture_before_images_and_publish_plan_updates() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _storage = TestStorage::new();
        let (state, mut updates, _guard) = state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plan.md");
        std::fs::write(&path, "old plan\n").unwrap();
        *state.handle.current_mode_id.lock().unwrap() = Some("plan".into());
        notify(
            &state,
            acp::SessionUpdate::ToolCall(acp::ToolCall::new("edit", "正在处理")),
        )
        .await;
        notify(
            &state,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                "edit",
                acp::ToolCallUpdateFields::new()
                    .name("write_file")
                    .locations(vec![acp::ToolCallLocation::new(path.clone())]),
            )),
        )
        .await;
        assert!(state.file_snapshots.lock().unwrap().contains_key("edit"));
        std::fs::write(&path, "new plan\n").unwrap();
        notify(
            &state,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                "edit",
                acp::ToolCallUpdateFields::new().status(acp::ToolCallStatus::Completed),
            )),
        )
        .await;
        let events = std::iter::from_fn(|| updates.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(event, AcpUpdate::ToolCallUpdateV1 { output: Some(output), .. } if output.iter().any(|item| matches!(item, ToolCallContentData::Diff { old_text: Some(old), new_text, .. } if old == "old plan\n" && new_text == "new plan\n")))));
        assert!(events.iter().any(|event| matches!(event, AcpUpdate::PlanFileUpdate { content: Some(content), .. } if content == "new plan\n")));
        assert!(state.file_snapshots.lock().unwrap().is_empty());
        assert!(state.write_tool_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn explicit_names_and_kinds_override_misleading_display_titles() {
        let mut identity = ToolIdentity {
            title: "Write file".into(),
            ..Default::default()
        };
        assert!(identity.edits_files());
        identity.name = Some("mcp__remote__write_file".into());
        assert!(!identity.edits_files());
        identity.name = Some("write_file".into());
        assert!(identity.edits_files());
        identity.kind = "read".into();
        assert!(!identity.edits_files());
        assert!(is_short_memory_tool_named(
            Some("mcp__grove_agent__memory_read"),
            "读取记忆"
        ));
        assert!(!is_short_memory_tool_named(
            Some("mcp__other__memory_read"),
            "grove_agent memory_read"
        ));
        assert!(is_short_memory_tool_named(None, "grove_agent memory_read"));
    }
}
