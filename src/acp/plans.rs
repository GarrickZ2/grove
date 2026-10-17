use super::*;

/// Grove's stable wire/history representation of native ACP plans. Legacy
/// `PlanUpdate` stays separate so native document updates cannot clear Todos.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlanDocument {
    Items {
        plan_id: String,
        entries: Vec<PlanEntryData>,
    },
    Markdown {
        plan_id: String,
        content: String,
    },
    File {
        plan_id: String,
        uri: String,
    },
}

impl PlanDocument {
    pub fn id(&self) -> &str {
        match self {
            Self::Items { plan_id, .. }
            | Self::Markdown { plan_id, .. }
            | Self::File { plan_id, .. } => plan_id,
        }
    }
}

pub(super) fn convert(plan: acp::PlanUpdateContent) -> Option<PlanDocument> {
    Some(match plan {
        acp::PlanUpdateContent::Items(plan) => PlanDocument::Items {
            plan_id: plan.plan_id.to_string(),
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
        acp::PlanUpdateContent::Markdown(plan) => PlanDocument::Markdown {
            plan_id: plan.plan_id.to_string(),
            content: plan.content,
        },
        acp::PlanUpdateContent::File(plan) => PlanDocument::File {
            plan_id: plan.plan_id.to_string(),
            uri: plan.uri,
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::client_state_for_test;
    use super::*;
    use serde_json::json;

    struct RestoreStorage;
    impl Drop for RestoreStorage {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    #[tokio::test]
    async fn native_plans_are_negotiated_scoped_and_persisted() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _restore = RestoreStorage;
        let (handle, mut updates, _guard) =
            new_handle_for_test(&uuid::Uuid::new_v4().to_string(), "project", "task", "chat");
        let state = client_state_for_test(handle.clone(), Arc::new(Mutex::default()));
        assert_eq!(
            serde_json::to_value(grove_client_capabilities()).unwrap()["plan"],
            json!({})
        );
        handle.register_subagent(
            "session-test",
            serde_json::from_value(json!({"sessionId":"child", "title":"Research"})).unwrap(),
        );
        for (session, update) in [
            (
                "session-test",
                json!({"sessionUpdate":"plan_update", "plan":{"type":"markdown", "planId":"same", "content":"# Parent plan"}}),
            ),
            (
                "child",
                json!({"sessionUpdate":"plan_update", "plan":{"type":"items", "planId":"same", "entries":[{"content":"Inspect","status":"in_progress","priority":"high"}]}}),
            ),
            (
                "session-test",
                json!({"sessionUpdate":"plan_update", "plan":{"type":"file", "planId":"file", "uri":"file:///workspace/plan.md"}}),
            ),
            (
                "child",
                json!({"sessionUpdate":"plan_removed", "planId":"same"}),
            ),
            (
                "session-test",
                json!({"sessionUpdate":"plan", "entries":[{"content":"Legacy Todo","status":"pending","priority":"medium"}]}),
            ),
        ] {
            handle_session_notification(
                &state,
                acp::SessionNotification::new(
                    session.to_string(),
                    serde_json::from_value(update).unwrap(),
                ),
            )
            .await
            .unwrap();
        }
        assert!(state
            .native_plans_seen
            .load(std::sync::atomic::Ordering::Relaxed));
        let live: Vec<_> = std::iter::from_fn(|| updates.try_recv().ok()).collect();
        assert!(live.iter().any(|event| matches!(event, AcpUpdate::PlanDocumentUpdate { plan: PlanDocument::Markdown { plan_id, content } } if plan_id == "same" && content == "# Parent plan")));
        assert!(live.iter().any(|event| matches!(event, AcpUpdate::SubagentEvent { session_id, event } if session_id == "child" && matches!(event.as_ref(), AcpUpdate::PlanDocumentRemoved { plan_id } if plan_id == "same"))));
        let stored = crate::storage::chat_history::load_history("project", "task", "chat");
        assert_eq!(
            stored
                .iter()
                .filter(|event| matches!(event, AcpUpdate::PlanDocumentUpdate { .. }))
                .count(),
            2
        );
        assert!(stored.iter().any(|event| matches!(event, AcpUpdate::PlanUpdate { entries } if entries[0].content == "Legacy Todo")));
        assert!(stored.iter().any(|event| matches!(event, AcpUpdate::SubagentEvent { event, .. } if matches!(event.as_ref(), AcpUpdate::PlanDocumentUpdate { plan: PlanDocument::Items { entries, .. } } if entries[0].status == "in_progress" && entries[0].priority.as_deref() == Some("high")))));
    }
}
