use crate::storage::{buddies::Buddy, tasks};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct Preview {
    pub status: String,
    pub last_message_preview: Option<String>,
    pub last_activity_at: String,
}
static CACHE: Lazy<Mutex<HashMap<String, Preview>>> = Lazy::new(Mutex::default);

pub(crate) fn invalidate(session: &str) {
    CACHE.lock().unwrap().remove(session);
}

pub fn get(buddy: &Buddy) -> Preview {
    let Some(chat) = buddy.active_session_id.as_deref() else {
        return Preview {
            status: "idle".into(),
            last_message_preview: None,
            last_activity_at: buddy.created_at.clone(),
        };
    };
    let status = match super::tools::session_status(&buddy.project_hash, tasks::LOCAL_TASK_ID, chat)
    {
        "running" => "working",
        "waiting" => "waiting",
        _ => "idle",
    };
    let mut cache = CACHE.lock().unwrap();
    if let Some(preview) = cache.get(chat) {
        let mut preview = preview.clone();
        preview.status = status.into();
        return preview;
    }
    let path = crate::storage::chat_history::history_file_path(
        &buddy.project_hash,
        tasks::LOCAL_TASK_ID,
        chat,
    );
    let last_activity_at = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
        .unwrap_or_else(|_| buddy.created_at.clone());
    let text = super::recent_text(&buddy.project_hash, tasks::LOCAL_TASK_ID, chat, 1)
        .pop()
        .map(|text| {
            let mut text = text
                .split_once(": ")
                .map(|(_, body)| body)
                .unwrap_or(&text)
                .to_owned();
            while let Some(start) = text.find("<grove-meta>") {
                let Some(end) = text[start..].find("</grove-meta>") else {
                    break;
                };
                text.replace_range(start..start + end + "</grove-meta>".len(), "");
            }
            text.trim().chars().take(200).collect::<String>()
        })
        .filter(|text| !text.is_empty());
    let preview = Preview {
        status: status.into(),
        last_message_preview: text,
        last_activity_at,
    };
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(chat.into(), preview.clone());
    preview
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        buddies::test_support::{seed_buddy, Store},
        database,
    };
    #[tokio::test]
    async fn acp_events_invalidate_preview_and_status_comes_from_live_handle() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "preview");
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, _, _guard) =
            crate::acp::new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        invalidate(chat);
        assert_eq!(get(&buddy).last_message_preview, None);
        handle.emit(crate::acp::AcpUpdate::MessageChunk {
            message_id: None,
            text: "<grove-meta>{\"kind\":\"test\"}</grove-meta>\n你好".into(),
        });
        assert_eq!(get(&buddy).last_message_preview.as_deref(), Some("你好"));
        handle.emit(crate::acp::AcpUpdate::MessageChunk {
            message_id: None,
            text: "，队友".into(),
        });
        assert_eq!(
            get(&buddy).last_message_preview.as_deref(),
            Some("你好，队友")
        );
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(get(&buddy).status, "working");
        handle
            .is_busy
            .store(false, std::sync::atomic::Ordering::Release);
        assert_eq!(get(&buddy).status, "idle");
    }
}
