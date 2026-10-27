//! ACP v1 metadata patches update the session list, never the conversation.
use super::*;
use agent_client_protocol::schema::MaybeUndefined;

impl AcpSessionHandle {
    pub(super) fn apply_session_info(&self, update: acp::SessionInfoUpdate) -> acp::Result<()> {
        let Some(chat_id) = self.chat_id.as_deref() else {
            return Ok(());
        };
        let title = match &update.title {
            MaybeUndefined::Value(value) => Some(value.as_str()),
            MaybeUndefined::Null => Some(""),
            MaybeUndefined::Undefined => None,
        };
        let updated_at = match &update.updated_at {
            MaybeUndefined::Value(value) => DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| Some(value.with_timezone(&Utc))),
            MaybeUndefined::Null => Some(None),
            MaybeUndefined::Undefined => None,
        };
        let changed = crate::storage::tasks::update_chat_session_info(
            &self.project_key,
            &self.task_id,
            chat_id,
            title,
            updated_at,
        )
        .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
        if changed {
            crate::radio::publish(crate::radio::RadioEvent::ChatListChanged {
                project_id: self.project_key.clone(),
                task_id: self.task_id.clone(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{chat_history, tasks};
    use serde_json::{json, Value};

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

    #[tokio::test]
    async fn v1_session_info_patches_refresh_the_list_without_changing_activity() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_owned()));
        let _restore = RestoreStorage;
        let project = format!("session-info-{}", uuid::Uuid::new_v4());
        tasks::add_chat_session(
            &project,
            "task",
            tasks::ChatSession {
                id: "chat".into(),
                title: "Original".into(),
                agent: "test".into(),
                acp_session_id: Some("root".into()),
                created_at: Utc::now(),
                duty: None,
                launch_mode: "acp".into(),
            },
        )
        .unwrap();
        let key = format!("{project}:task:chat");
        let (handle, mut updates, _guard) = new_handle_for_test(&key, &project, "task", "chat");
        *handle.agent_info.write().unwrap() = Some(("root".into(), "Test".into(), "1".into()));
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let state = super::super::tests::client_state_for_test(
            handle.clone(),
            Arc::new(Mutex::new(HashMap::new())),
        );
        let mut radio = crate::radio::subscribe();
        let title = || {
            tasks::get_chat_session(&project, "task", "chat")
                .unwrap()
                .unwrap()
                .title
        };
        let timestamp = || {
            crate::storage::database::connection()
                .query_row(
                    "SELECT updated_at FROM session WHERE session_id = 'chat'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
        };
        let original_time = timestamp();

        notify(
            &state,
            "other",
            json!({"sessionUpdate":"session_info_update", "title":"Wrong session"}),
        )
        .await;
        assert_eq!(title(), "Original");
        notify(
            &state,
            "root",
            json!({"sessionUpdate":"session_info_update", "title":"Agent title"}),
        )
        .await;
        assert_eq!(title(), "Agent title");
        assert_eq!(timestamp(), original_time);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while let Some(event) = radio.recv().await {
                if matches!(event, crate::radio::RadioEvent::ChatListChanged { project_id, task_id }
                    if project_id == project && task_id == "task")
                {
                    return;
                }
            }
            panic!("session metadata change did not refresh the session list");
        })
        .await
        .unwrap();

        notify(
            &state,
            "root",
            json!({"sessionUpdate":"session_info_update", "updatedAt":"2026-10-27T08:00:00Z"}),
        )
        .await;
        assert_eq!(title(), "Agent title");
        assert_eq!(timestamp().as_deref(), Some("2026-10-27T08:00:00+00:00"));
        notify(
            &state,
            "root",
            json!({"sessionUpdate":"session_info_update", "updatedAt":"invalid"}),
        )
        .await;
        assert_eq!(timestamp().as_deref(), Some("2026-10-27T08:00:00+00:00"));
        notify(
            &state,
            "root",
            json!({"sessionUpdate":"session_info_update", "title":null}),
        )
        .await;
        assert_eq!(title(), "");
        assert_eq!(timestamp().as_deref(), Some("2026-10-27T08:00:00+00:00"));
        notify(
            &state,
            "root",
            json!({"sessionUpdate":"session_info_update", "updatedAt":null}),
        )
        .await;
        assert_eq!(timestamp(), None);
        assert!(tasks::archive_chat_session(&project, "task", "chat").unwrap());
        notify(
            &state,
            "root",
            json!({"sessionUpdate":"session_info_update", "title":"Archived title"}),
        )
        .await;
        assert!(tasks::load_chat_sessions(&project, "task")
            .unwrap()
            .is_empty());
        assert_eq!(
            tasks::load_archived_chat_sessions(&project, "task").unwrap()[0].title,
            "Archived title"
        );
        assert!(handle.is_busy.load(std::sync::atomic::Ordering::Relaxed));
        assert!(updates.try_recv().is_err());
        assert!(chat_history::load_history(&project, "task", "chat").is_empty());
    }

    #[tokio::test]
    async fn v1_message_ids_survive_notification_storage_and_compaction() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_owned()));
        let _restore = RestoreStorage;
        let key = format!("message-ids-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        *handle.agent_info.write().unwrap() = Some(("root".into(), "Test".into(), "1".into()));
        handle
            .replay_user_messages
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let state = super::super::tests::client_state_for_test(
            handle.clone(),
            Arc::new(Mutex::new(HashMap::new())),
        );
        for update in [
            json!({"sessionUpdate":"user_message_chunk","messageId":"u1","content":{"type":"text","text":"first"}}),
            json!({"sessionUpdate":"user_message_chunk","messageId":"u2","content":{"type":"text","text":"second"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":"one"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":" two"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"b","content":{"type":"text","text":"three"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"b","content":{"type":"image","data":"pixels","mimeType":"image/png"}}),
            json!({"sessionUpdate":"agent_thought_chunk","messageId":"b","content":{"type":"text","text":"reason"}}),
            json!({"sessionUpdate":"agent_thought_chunk","messageId":"c","content":{"type":"text","text":"new reason"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"legacy"}}),
        ] {
            notify(&state, "root", update).await;
        }
        let live: Vec<_> = std::iter::from_fn(|| updates.try_recv().ok()).collect();
        let values = serde_json::to_value(&live).unwrap();
        assert_eq!(values[0]["message_id"], "u1");
        assert_eq!(values[1]["message_id"], "u2");
        assert_eq!(values[5]["message_id"], "b");
        assert!(values[8].get("message_id").is_none());
        let expected = serde_json::to_value(chat_history::compact_events(live)).unwrap();
        chat_history::compact_history("project", "task", "chat");
        let restored = chat_history::load_history("project", "task", "chat");
        assert_eq!(serde_json::to_value(&restored).unwrap(), expected);
        assert_eq!(expected[2]["text"], "one two");
        assert_eq!(expected[2]["message_id"], "a");
        assert_eq!(expected[3]["text"], "three");
        assert_eq!(expected[3]["message_id"], "b");
        assert_eq!(expected.as_array().unwrap().len(), 8);
        assert_eq!(
            serde_json::to_value(chat_history::compact_events(restored)).unwrap(),
            expected
        );
        let legacy: AcpUpdate =
            serde_json::from_value(json!({"type":"message_chunk","text":"old history"})).unwrap();
        assert!(serde_json::to_value(legacy)
            .unwrap()
            .get("message_id")
            .is_none());
    }

    #[tokio::test]
    async fn v1_child_ids_and_metadata_do_not_modify_the_root_session() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_owned()));
        let _restore = RestoreStorage;
        let key = format!("child-info-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        *handle.agent_info.write().unwrap() = Some(("root".into(), "Test".into(), "1".into()));
        let state = super::super::tests::client_state_for_test(
            handle.clone(),
            Arc::new(Mutex::new(HashMap::new())),
        );
        notify(&state, "root", json!({"sessionUpdate":"subagent_update","sessionId":"child","title":"Initial","state":{"state":"running"}})).await;
        notify(
            &state,
            "child",
            json!({"sessionUpdate":"session_info_update","title":"Reviewer"}),
        )
        .await;
        assert_eq!(handle.child_title("child").as_deref(), Some("Reviewer"));
        notify(
            &state,
            "child",
            json!({"sessionUpdate":"session_info_update","updatedAt":"2026-10-27T08:00:00Z"}),
        )
        .await;
        assert_eq!(handle.child_title("child").as_deref(), Some("Reviewer"));
        notify(&state, "child", json!({"sessionUpdate":"agent_message_chunk","messageId":"shared","content":{"type":"text","text":"child"}})).await;
        notify(&state, "root", json!({"sessionUpdate":"agent_message_chunk","messageId":"shared","content":{"type":"text","text":"root"}})).await;
        notify(
            &state,
            "child",
            json!({"sessionUpdate":"session_info_update","title":null}),
        )
        .await;
        assert_eq!(handle.child_title("child").as_deref(), Some("Subagent"));
        let events = serde_json::to_value(
            std::iter::from_fn(|| updates.try_recv().ok()).collect::<Vec<_>>(),
        )
        .unwrap();
        let child = events
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["type"] == "subagent_event")
            .unwrap();
        assert_eq!(child["event"]["message_id"], "shared");
        assert!(events
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "message_chunk" && event["message_id"] == "shared"));
    }
}
