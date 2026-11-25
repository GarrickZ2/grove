//! ACP session cursors. Grove uses the ones that lie right before a user
//! message: a Chat can be forked at the end of the reply that precedes it.
//! A cursor's position comes from its anchor; one that Grove cannot place is
//! ignored, never guessed.
use super::{acp, AcpSessionHandle, AcpUpdate};
use agent_client_protocol::schema::MaybeUndefined;
use std::collections::HashSet;

/// An entity of the session's timeline: its type and ID.
type Entity = (&'static str, String);

#[derive(Default)]
pub(crate) struct CursorTracker {
    /// The last entity the Agent reported on this connection.
    last: Option<Entity>,
    /// `last` when the latest user message was shown.
    before_user: Option<Entity>,
    /// The Agent's ID for the latest user message that Grove shows.
    user_message: Option<String>,
    seen_user_messages: HashSet<String>,
    /// The prompt Grove sent has no output yet, so an unshown user message is its echo.
    awaiting_echo: bool,
    /// Cursors already offered on this connection.
    placed: HashSet<String>,
}

impl CursorTracker {
    /// Grove showed and is sending the user's prompt.
    pub(super) fn prompt_started(&mut self) {
        self.before_user = self.last.clone();
        self.user_message = None;
        self.awaiting_echo = true;
    }

    /// A message joined the running turn: no cursor lies before it.
    pub(super) fn steered(&mut self) {
        self.before_user = None;
        self.user_message = None;
        self.awaiting_echo = false;
    }

    /// The Agent reported a user message that Grove shows.
    pub(super) fn user_message(&mut self, id: &str) {
        if self.seen_user_messages.insert(id.to_owned()) {
            self.user_message = Some(id.to_owned());
        }
    }

    /// Follow a v1 session update. `replaying`: user messages are shown as they arrive.
    pub(super) fn observe(&mut self, update: &acp::SessionUpdate, replaying: bool) {
        let message = |id: &Option<acp::MessageId>| id.as_ref().map(ToString::to_string);
        let entity = match update {
            acp::SessionUpdate::UserMessageChunk(chunk) => {
                let Some(id) = message(&chunk.message_id) else {
                    return;
                };
                let entity = ("user_message", id.clone());
                if replaying && self.last.as_ref() != Some(&entity) {
                    self.before_user = self.last.clone();
                }
                if replaying || self.awaiting_echo {
                    self.user_message(&id);
                }
                self.last = Some(entity);
                return;
            }
            acp::SessionUpdate::AgentMessageChunk(chunk) => {
                message(&chunk.message_id).map(|id| ("agent_message", id))
            }
            acp::SessionUpdate::AgentThoughtChunk(chunk) => {
                message(&chunk.message_id).map(|id| ("agent_thought", id))
            }
            acp::SessionUpdate::ToolCall(call) => {
                Some(("tool_call", call.tool_call_id.to_string()))
            }
            acp::SessionUpdate::CompactionUpdate(update) => {
                Some(("compaction", update.compaction_id.to_string()))
            }
            _ => return,
        };
        self.awaiting_echo = false;
        if entity.is_some() {
            self.last = entity;
        }
    }

    /// Whether `anchor` is the position right before the latest user message.
    fn before_latest_user_message(&self, anchor: &acp::CursorAnchor) -> bool {
        use acp::{CursorAnchor, CursorAnchorPosition as Position};
        let (entity, position): (Entity, _) = match anchor {
            CursorAnchor::UserMessage(a) => {
                (("user_message", a.message_id.to_string()), &a.position)
            }
            CursorAnchor::AgentMessage(a) => {
                (("agent_message", a.message_id.to_string()), &a.position)
            }
            CursorAnchor::AgentThought(a) => {
                (("agent_thought", a.message_id.to_string()), &a.position)
            }
            CursorAnchor::ToolCall(a) => (("tool_call", a.tool_call_id.to_string()), &a.position),
            CursorAnchor::Compaction(a) => {
                (("compaction", a.compaction_id.to_string()), &a.position)
            }
            _ => return false,
        };
        match position {
            Position::Before => {
                entity.0 == "user_message" && self.user_message.as_ref() == Some(&entity.1)
            }
            Position::After => self.before_user.as_ref() == Some(&entity),
            _ => false,
        }
    }

    /// The history event for `update`, when it changes where the Chat can be forked.
    pub(super) fn apply(&mut self, update: &acp::CursorUpdate) -> Option<AcpUpdate> {
        let cursor_id = update.cursor_id.to_string();
        let available = match &update.capabilities {
            MaybeUndefined::Undefined => return None,
            MaybeUndefined::Null => false,
            MaybeUndefined::Value(capabilities) => capabilities.fork.is_some(),
        };
        if available {
            let anchor = update.anchor.as_ref()?;
            if !self.before_latest_user_message(anchor) || !self.placed.insert(cursor_id.clone()) {
                return None;
            }
        }
        Some(AcpUpdate::ForkPoint {
            cursor_id,
            available,
        })
    }
}

impl AcpSessionHandle {
    /// A prompt is about to be sent: what the Agent announced for the idle
    /// session no longer applies.
    pub(super) fn prompt_started(&self) {
        self.stop_requested
            .store(false, std::sync::atomic::Ordering::Release);
        self.cursors.lock().unwrap().prompt_started();
        self.set_prompt_suggestions(Vec::new());
    }

    pub(super) fn apply_cursor_update(&self, update: &acp::CursorUpdate) {
        let event = self.cursors.lock().unwrap().apply(update);
        if let Some(event) = event {
            self.emit(event);
        }
    }

    /// The Agent answered that it no longer accepts `cursor_id`: stop offering it.
    pub(super) fn drop_rejected_cursor(&self, cursor_id: Option<String>, code: i32) {
        if let (Some(cursor_id), -32602) = (cursor_id, code) {
            self.emit(AcpUpdate::ForkPoint {
                cursor_id,
                available: false,
            });
        }
    }

    /// Replace the prompts the Agent suggests next; emits only when they changed.
    pub(super) fn set_prompt_suggestions(&self, suggestions: Vec<String>) {
        let mut current = self.prompt_suggestions.lock().unwrap();
        if *current == suggestions {
            return;
        }
        *current = suggestions.clone();
        drop(current);
        self.emit(AcpUpdate::PromptSuggestions { suggestions });
    }

    /// Keeps the suggestions made of text alone: the composer shows text.
    pub(super) fn apply_prompt_suggestions(&self, update: acp::PromptSuggestionsUpdate) {
        let suggestions = update
            .suggestions
            .into_iter()
            .filter_map(|suggestion| {
                let text = suggestion
                    .prompt
                    .iter()
                    .map(|block| match block {
                        acp::ContentBlock::Text(text) => Some(text.text.as_str()),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()?
                    .join("\n");
                let text = text.trim();
                (!text.is_empty()).then(|| text.to_owned())
            })
            .collect();
        self.set_prompt_suggestions(suggestions);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn observe(tracker: &mut CursorTracker, update: Value, replaying: bool) {
        tracker.observe(&serde_json::from_value(update).unwrap(), replaying);
    }

    fn message(kind: &str, id: &str) -> Value {
        json!({"sessionUpdate": kind, "messageId": id, "content": {"type": "text", "text": "x"}})
    }

    fn cursor(id: &str, capabilities: Value, anchor: Value) -> acp::CursorUpdate {
        serde_json::from_value(
            json!({"cursorId": id, "capabilities": capabilities, "anchor": anchor}),
        )
        .unwrap()
    }

    fn after_agent(id: &str) -> Value {
        json!({"type": "agent_message", "messageId": id, "position": "after"})
    }

    fn offered(update: Option<AcpUpdate>) -> Option<(String, bool)> {
        match update {
            Some(AcpUpdate::ForkPoint {
                cursor_id,
                available,
            }) => Some((cursor_id, available)),
            None => None,
            _ => panic!("expected a fork point"),
        }
    }

    #[test]
    fn a_live_cursor_is_placed_before_the_prompt_that_follows_its_anchor() {
        let mut tracker = CursorTracker::default();
        tracker.prompt_started();
        observe(&mut tracker, message("agent_message_chunk", "a1"), false);
        // Nothing follows a1 yet, so this is not a position before a user message.
        let fork = json!({"fork": {}});
        assert!(tracker
            .apply(&cursor("early", fork.clone(), after_agent("a1")))
            .is_none());
        tracker.prompt_started();
        assert_eq!(
            offered(tracker.apply(&cursor("c1", fork.clone(), after_agent("a1")))),
            Some(("c1".into(), true))
        );
        // Offered once, and never for an anchor that lies elsewhere.
        assert!(tracker
            .apply(&cursor("c1", fork.clone(), after_agent("a1")))
            .is_none());
        assert!(tracker
            .apply(&cursor("c2", fork.clone(), after_agent("a0")))
            .is_none());
        assert!(tracker
            .apply(&cursor("c3", json!({}), after_agent("a1")))
            .is_some_and(|event| matches!(
                event,
                AcpUpdate::ForkPoint {
                    available: false,
                    ..
                }
            )));
        assert!(tracker
            .apply(&cursor(
                "c4",
                fork,
                json!({"type": "future", "position": "after"})
            ))
            .is_none());
    }

    #[test]
    fn a_replayed_cursor_is_placed_before_its_own_user_message() {
        let mut tracker = CursorTracker::default();
        let before =
            |id: &str| json!({"type": "user_message", "messageId": id, "position": "before"});
        let fork = json!({"fork": {}});
        observe(&mut tracker, message("user_message_chunk", "u1"), true);
        observe(&mut tracker, message("agent_message_chunk", "a1"), true);
        observe(&mut tracker, message("user_message_chunk", "u2"), true);
        assert!(tracker
            .apply(&cursor("c1", fork.clone(), before("u1")))
            .is_none());
        assert_eq!(
            offered(tracker.apply(&cursor("c2", fork, before("u2")))),
            Some(("c2".into(), true))
        );
    }

    #[test]
    fn a_user_message_grove_does_not_show_is_no_fork_point() {
        let mut tracker = CursorTracker::default();
        tracker.prompt_started();
        observe(&mut tracker, message("agent_message_chunk", "a1"), false);
        observe(&mut tracker, message("user_message_chunk", "hidden"), false);
        assert!(tracker
            .apply(&cursor(
                "c1",
                json!({"fork": {}}),
                json!({"type": "user_message", "messageId": "hidden", "position": "before"}),
            ))
            .is_none());
    }
}
