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
    /// The latest turn stayed quiet: nothing here is new for the user.
    pub last_turn_quiet: bool,
}
static CACHE: Lazy<Mutex<HashMap<String, Preview>>> = Lazy::new(Mutex::default);
/// Agents can narrate each automatic approval decision as plain reply text;
/// the timeline hides these too.
static APPROVAL_NOTE: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(
        r"(?i)Automatic approval review[ \t]+\w+[ \t]*(?:\([^)\n]*\)[ \t]*:?|:)[^.!?\n]*[.!?]?[ \t]*\n*",
    )
    .unwrap()
});

pub(crate) fn invalidate(session: &str) {
    CACHE.lock().unwrap().remove(session);
}

pub fn get(buddy: &Buddy) -> Preview {
    let Some(chat) = buddy.active_session_id.as_deref() else {
        return Preview {
            status: "idle".into(),
            last_message_preview: None,
            last_activity_at: buddy.created_at.clone(),
            last_turn_quiet: false,
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
    let mut history =
        crate::storage::chat_history::load_history(&buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
    // Quiet turns add nothing for the user: not the text, and not unread activity.
    let seen = super::quiet::seen_end(&history);
    let last_turn_quiet = seen < history.len();
    history.truncate(seen);
    let last_activity_at = if last_turn_quiet {
        history
            .iter()
            .rev()
            .find_map(|update| match update {
                crate::acp::AcpUpdate::Complete {
                    end_ts: Some(end), ..
                } => chrono::DateTime::from_timestamp(*end, 0),
                _ => None,
            })
            .map_or_else(|| buddy.created_at.clone(), |time| time.to_rfc3339())
    } else {
        last_activity_at
    };
    let text = super::entries_of(history, false)
        .pop()
        .map(|entry| {
            let mut text = entry.text;
            while let Some(start) = text.find("<grove-meta>") {
                let Some(end) = text[start..].find("</grove-meta>") else {
                    break;
                };
                text.replace_range(start..start + end + "</grove-meta>".len(), "");
            }
            APPROVAL_NOTE
                .replace_all(&text, "")
                .trim()
                .chars()
                .take(200)
                .collect::<String>()
        })
        .filter(|text| !text.is_empty());
    let preview = Preview {
        status: status.into(),
        last_message_preview: text,
        last_activity_at,
        last_turn_quiet,
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
    async fn quiet_turns_leave_the_preview_on_what_the_user_last_saw() {
        use crate::acp::AcpUpdate;
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "quiet-preview");
        let chat = buddy.active_session_id.clone().unwrap();
        let user = |text: &str, sender: Option<&str>| AcpUpdate::UserMessage {
            message_id: None,
            text: text.into(),
            client_message_id: None,
            attachments: Vec::new(),
            sender: sender.map(Into::into),
            terminal: false,
        };
        let reply = |text: &str, end: i64| {
            [
                AcpUpdate::MessageChunk {
                    message_id: None,
                    text: text.into(),
                },
                AcpUpdate::Complete {
                    stop_reason: "end_turn".into(),
                    usage: None,
                    start_ts: None,
                    end_ts: Some(end),
                    cost: None,
                },
            ]
        };
        let mut events = vec![user("hello", None)];
        events.extend(reply("Seen reply", 1_700_000_000));
        events.push(user("routine", Some("automation:r")));
        events.push(AcpUpdate::QuietTurn {
            reason: "nothing new".into(),
        });
        events.extend(reply("All clear", 1_700_000_500));
        for event in &events {
            assert!(crate::storage::chat_history::should_persist(event));
            crate::storage::chat_history::append_event(
                &buddy.project_hash,
                tasks::LOCAL_TASK_ID,
                &chat,
                event,
            );
        }
        invalidate(&chat);
        let preview = get(&buddy);
        assert!(preview.last_turn_quiet);
        assert_eq!(preview.last_message_preview.as_deref(), Some("Seen reply"));
        assert!(preview.last_activity_at.starts_with("2023-11-14T22:13:20"));
    }

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
