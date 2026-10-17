//! ACP compaction events retain their identity and patch semantics all the way
//! to local history and the frontend; they are not model message content.
use super::{acp, content_block_to_data, AcpClientState, AcpUpdate, ContentBlockData};
pub use agent_client_protocol::schema::MaybeUndefined;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompactionUpdateData {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub summary: MaybeUndefined<Vec<ContentBlockData>>,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub error: MaybeUndefined<String>,
    #[serde(default, skip_serializing_if = "MaybeUndefined::is_undefined")]
    pub metadata: MaybeUndefined<serde_json::Value>,
}

impl AcpClientState {
    pub(super) fn handle_compaction_update(&self, update: acp::CompactionUpdate) {
        let status = match update.status {
            acp::CompactionStatus::InProgress => "in_progress".to_owned(),
            acp::CompactionStatus::Completed => "completed".to_owned(),
            acp::CompactionStatus::Failed => "failed".to_owned(),
            acp::CompactionStatus::Cancelled => "cancelled".to_owned(),
            acp::CompactionStatus::Other(status) => status,
            _ => "unknown".to_owned(),
        };
        self.handle.emit(AcpUpdate::CompactionUpdate {
            update: CompactionUpdateData {
                id: update.compaction_id.to_string(),
                status,
                summary: update
                    .summary
                    .map_value(|blocks| blocks.iter().filter_map(content_block_to_data).collect()),
                error: update.error,
                metadata: update.meta.map_value(serde_json::Value::Object),
            },
        });
    }

    pub(super) fn handle_compaction_summary_chunk(&self, chunk: acp::CompactionSummaryChunk) {
        if let Some(content) = content_block_to_data(&chunk.content) {
            self.handle.emit(AcpUpdate::CompactionSummaryChunk {
                id: chunk.compaction_id.to_string(),
                content,
                metadata: chunk.meta.map(serde_json::Value::Object),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        grove_client_capabilities, handle_session_notification, new_handle_for_test,
        tests::client_state_for_test,
    };
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    #[tokio::test]
    async fn compaction_patches_and_chunks_survive_local_history_and_wire() {
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
        let capabilities = serde_json::to_value(grove_client_capabilities()).unwrap();
        assert!(capabilities["session"]["compaction"].is_object());
        let key = format!("compaction-test-{}", uuid::Uuid::new_v4());
        let (handle, mut updates, _guard) = new_handle_for_test(&key, "project", "task", "chat");
        *handle.agent_info.write().unwrap() = Some(("session".into(), "Agent".into(), "1".into()));
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let state = client_state_for_test(handle.clone(), Arc::new(Mutex::new(HashMap::new())));
        handle.emit(AcpUpdate::MessageChunk {
            text: "before".into(),
        });
        let wire = [
            serde_json::json!({"sessionUpdate":"compaction_update", "compactionId":"c", "status":"in_progress", "summary":[{"type":"text","text":"initial"}],"_meta":{"a":1}}),
            serde_json::json!({"sessionUpdate":"compaction_summary_chunk", "compactionId":"c", "content":{"type":"text","text":"chunk"},"_meta":{"chunk":true}}),
            serde_json::json!({"sessionUpdate":"compaction_update", "compactionId":"c", "status":"failed", "error":"network failure"}),
            serde_json::json!({"sessionUpdate":"compaction_update", "compactionId":"c", "status":"cancelled", "summary":null, "error":null,"_meta":null}),
            serde_json::json!({"sessionUpdate":"compaction_update", "compactionId":"c", "status":"_future", "summary":[]}),
            serde_json::json!({"sessionUpdate":"compaction_summary_chunk", "compactionId":"c", "content":{"type":"image","data":"image","mimeType":"image/png"}}),
            serde_json::json!({"sessionUpdate":"compaction_update", "compactionId":"c", "status":"completed"}),
        ];
        for value in wire {
            handle_session_notification(
                &state,
                acp::SessionNotification::new("session", serde_json::from_value(value).unwrap()),
            )
            .await
            .unwrap();
        }
        handle.emit(AcpUpdate::MessageChunk {
            text: "after".into(),
        });
        assert!(handle.is_busy.load(std::sync::atomic::Ordering::Relaxed));
        assert!(handle.last_assistant_text.lock().unwrap().is_empty());
        let live: Vec<_> = std::iter::from_fn(|| updates.try_recv().ok()).collect();
        crate::storage::chat_history::compact_history("project", "task", "chat");
        let restored = crate::storage::chat_history::load_history("project", "task", "chat");
        assert_eq!(
            serde_json::to_value(&live).unwrap(),
            serde_json::to_value(&restored).unwrap()
        );
        let json = serde_json::to_value(&restored).unwrap();
        assert!(json[3].get("summary").is_none());
        assert!(json[4]["summary"].is_null());
        assert!(json[4]["error"].is_null());
        assert!(json[4]["metadata"].is_null());
        assert_eq!(json[5]["status"], "_future");
        assert_eq!(json[6]["content"]["mime_type"], "image/png");
        assert_eq!(json[0]["text"], "before");
        assert_eq!(json[8]["text"], "after");
    }
}
