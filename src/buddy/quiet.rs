//! Quiet turns: a Buddy deciding that what just woke it isn't worth the user's
//! attention. The turn runs and is kept in history, but the user isn't
//! interrupted by it. People always get an answer, and so does bad news.
use crate::acp::AcpUpdate;
use crate::error::{GroveError, Result};
use crate::storage::{buddies::Buddy, chat_history};
use serde_json::Value;

/// Whether a turn started by this prompt may stay quiet.
fn may_stay_quiet(sender: Option<&str>, text: &str) -> Result<()> {
    if sender.is_some_and(|s| s.starts_with("group:") && s.ends_with(":must")) {
        return Err(GroveError::invalid_data(
            "The user is asking you directly: answer them.",
        ));
    }
    let woken_by_others = sender.is_some_and(|s| {
        s.starts_with("buddy:") || s.starts_with("automation:") || s.starts_with("group:")
    });
    if !woken_by_others {
        return Err(GroveError::invalid_data(
            "The user is talking to you: answer them.",
        ));
    }
    let needs_the_user = text.split("<grove-meta>").skip(1).any(|rest| {
        let body = rest.split("</grove-meta>").next().unwrap_or_default();
        let envelope: Option<Value> = serde_json::from_str(body).ok();
        let status = envelope.as_ref().and_then(|e| e["data"]["status"].as_str());
        matches!(status, Some("failed" | "waiting"))
    });
    if needs_the_user {
        return Err(GroveError::invalid_data(
            "A Session failed or is waiting: tell the user.",
        ));
    }
    Ok(())
}

/// Mark the running turn quiet, if what started it allows that.
pub fn stay_quiet(buddy: &Buddy, session: &str, reason: &str) -> Result<()> {
    if reason.trim().is_empty() {
        return Err(GroveError::invalid_data("reason is required"));
    }
    let task = super::group::session_task(session);
    let history = chat_history::load_history(&buddy.project_hash, &task, session);
    let started_by = history.iter().rev().find_map(|update| match update {
        AcpUpdate::UserMessage { text, sender, .. } => Some((sender.as_deref(), text.as_str())),
        _ => None,
    });
    let (sender, text) = started_by.unwrap_or((None, ""));
    may_stay_quiet(sender, text)?;
    let key = format!("{}:{task}:{session}", buddy.project_hash);
    let handle = crate::acp::get_session_handle(&key)
        .ok_or_else(|| GroveError::not_found("Buddy runtime is no longer active"))?;
    handle.mark_quiet_turn(reason.trim().to_owned());
    Ok(())
}

/// Where the history the user was meant to see ends: trailing quiet turns,
/// and the prompts that started them, fall outside it.
pub(crate) fn seen_end(history: &[AcpUpdate]) -> usize {
    let mut end = history.len();
    while let Some(start) = history[..end]
        .iter()
        .rposition(|update| matches!(update, AcpUpdate::UserMessage { .. }))
    {
        let quiet = history[start..end]
            .iter()
            .any(|update| matches!(update, AcpUpdate::QuietTurn { .. }));
        if !quiet {
            break;
        }
        end = start;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(status: &str) -> String {
        format!(
            r#"<grove-meta>{{"v":1,"type":"buddy_message","data":{{"status":"{status}"}},"system-prompt":"x"}}</grove-meta>
Follow-up"#
        )
    }
    fn user(text: &str) -> AcpUpdate {
        AcpUpdate::UserMessage {
            message_id: None,
            text: text.into(),
            client_message_id: None,
            attachments: Vec::new(),
            sender: None,
            terminal: false,
        }
    }
    fn quiet() -> AcpUpdate {
        AcpUpdate::QuietTurn {
            reason: "nothing new".into(),
        }
    }

    #[test]
    fn people_and_bad_news_always_get_an_answer() {
        assert!(may_stay_quiet(None, "hi").is_err());
        assert!(may_stay_quiet(Some("connect"), "hi").is_err());
        assert!(may_stay_quiet(Some("buddy:a"), &prompt("failed")).is_err());
        assert!(may_stay_quiet(Some("buddy:a"), &prompt("waiting")).is_err());
        assert!(may_stay_quiet(Some("buddy:a"), &prompt("done")).is_ok());
        assert!(may_stay_quiet(Some("automation:r"), "check").is_ok());
        assert!(may_stay_quiet(Some("group:g:open"), "hi").is_ok());
        assert!(may_stay_quiet(Some("group:g:must"), "hi").is_err());
    }

    #[test]
    fn seen_history_stops_before_trailing_quiet_turns() {
        let seen = [user("one"), user("two")];
        assert_eq!(seen_end(&seen), 2);
        let history = [
            user("one"),
            user("routine"),
            quiet(),
            user("again"),
            quiet(),
        ];
        assert_eq!(seen_end(&history), 1);
    }
}
