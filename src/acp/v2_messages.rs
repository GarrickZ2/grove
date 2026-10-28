//! ACP v2 message projection. Message identities are scoped by message type;
//! chunks from different messages may interleave and a later snapshot replaces
//! previously received content rather than appending to it.

use std::collections::HashMap;

use agent_client_protocol::schema::{v2, MaybeUndefined};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MessageKind {
    User,
    Agent,
    Thought,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub kind: MessageKind,
    pub id: String,
    pub content: Vec<v2::ContentBlock>,
    pub meta: MaybeUndefined<v2::Meta>,
}

#[derive(Debug, Default)]
pub struct Messages {
    ordered: Vec<Message>,
    indices: HashMap<(MessageKind, String), usize>,
}

impl Messages {
    /// Apply message updates without consuming unrelated session events.
    /// The same projection can be used for live traffic and history replay.
    pub fn apply(&mut self, update: &v2::SessionUpdate) -> bool {
        match update {
            v2::SessionUpdate::UserMessageChunk(chunk) => self.chunk(MessageKind::User, chunk),
            v2::SessionUpdate::AgentMessageChunk(chunk) => self.chunk(MessageKind::Agent, chunk),
            v2::SessionUpdate::AgentThoughtChunk(chunk) => self.chunk(MessageKind::Thought, chunk),
            v2::SessionUpdate::UserMessage(message) => self.upsert(
                MessageKind::User,
                &message.message_id.to_string(),
                &message.content,
                &message.meta,
            ),
            v2::SessionUpdate::AgentMessage(message) => self.upsert(
                MessageKind::Agent,
                &message.message_id.to_string(),
                &message.content,
                &message.meta,
            ),
            v2::SessionUpdate::AgentThought(message) => self.upsert(
                MessageKind::Thought,
                &message.message_id.to_string(),
                &message.content,
                &message.meta,
            ),
            _ => return false,
        }
        true
    }

    pub fn entries(&self) -> &[Message] {
        &self.ordered
    }

    fn get_or_insert(&mut self, kind: MessageKind, id: &str) -> &mut Message {
        let key = (kind, id.to_owned());
        let index = *self.indices.entry(key).or_insert_with(|| {
            self.ordered.push(Message {
                kind,
                id: id.to_owned(),
                content: Vec::new(),
                meta: MaybeUndefined::Undefined,
            });
            self.ordered.len() - 1
        });
        &mut self.ordered[index]
    }

    pub fn chunk(&mut self, kind: MessageKind, chunk: &v2::ContentChunk) {
        self.get_or_insert(kind, &chunk.message_id.to_string())
            .content
            .push(chunk.content.clone());
    }

    pub fn upsert(
        &mut self,
        kind: MessageKind,
        id: &str,
        content: &MaybeUndefined<Vec<v2::ContentBlock>>,
        meta: &MaybeUndefined<v2::Meta>,
    ) {
        let message = self.get_or_insert(kind, id);
        match content {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => message.content.clear(),
            MaybeUndefined::Value(value) => message.content.clone_from(value),
        }
        v2::apply_meta_update(&mut message.meta, meta.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(id: &str, text: &str) -> v2::ContentChunk {
        serde_json::from_value(json!({
            "messageId": id, "content": {"type": "text", "text": text}
        }))
        .unwrap()
    }

    fn text(content: &v2::ContentBlock) -> &str {
        match content {
            v2::ContentBlock::Text(block) => &block.text,
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn interleaved_chunks_keep_identity_and_first_appearance_order() {
        let mut messages = Messages::default();
        messages.chunk(MessageKind::Agent, &chunk("a", "one"));
        messages.chunk(MessageKind::Agent, &chunk("b", "two"));
        messages.chunk(MessageKind::Thought, &chunk("a", "thinking"));
        messages.chunk(MessageKind::Agent, &chunk("a", "three"));
        assert_eq!(messages.entries().len(), 3);
        assert_eq!(messages.entries()[0].id, "a");
        assert_eq!(
            messages.entries()[0]
                .content
                .iter()
                .map(text)
                .collect::<Vec<_>>(),
            ["one", "three"]
        );
        assert_eq!(messages.entries()[1].id, "b");
        assert_eq!(messages.entries()[2].kind, MessageKind::Thought);
    }

    #[test]
    fn snapshot_replaces_chunks_omission_preserves_and_null_clears() {
        let mut messages = Messages::default();
        messages.chunk(MessageKind::Agent, &chunk("a", "old"));
        let replacement = vec![chunk("a", "replacement").content];
        messages.upsert(
            MessageKind::Agent,
            "a",
            &MaybeUndefined::Value(replacement),
            &MaybeUndefined::Undefined,
        );
        messages.chunk(MessageKind::Agent, &chunk("a", "tail"));
        messages.upsert(
            MessageKind::Agent,
            "a",
            &MaybeUndefined::Undefined,
            &MaybeUndefined::Undefined,
        );
        assert_eq!(
            messages.entries()[0]
                .content
                .iter()
                .map(text)
                .collect::<Vec<_>>(),
            ["replacement", "tail"]
        );
        messages.upsert(
            MessageKind::Agent,
            "a",
            &MaybeUndefined::Null,
            &MaybeUndefined::Undefined,
        );
        assert!(messages.entries()[0].content.is_empty());
    }

    #[test]
    fn wire_updates_replace_content_and_patch_metadata() {
        let mut messages = Messages::default();
        for update in [
            json!({"sessionUpdate":"agent_message_chunk", "messageId":"a", "content":{"type":"text", "text":"old"}}),
            json!({"sessionUpdate":"agent_message", "messageId":"a", "content":[{"type":"text", "text":"new"}], "_meta":{"one":1,"two":2}}),
            json!({"sessionUpdate":"agent_message", "messageId":"a", "_meta":{"one":null,"three":3}}),
            json!({"sessionUpdate":"agent_message_chunk", "messageId":"a", "content":{"type":"text", "text":"tail"}}),
        ] {
            let parsed: v2::SessionUpdate = serde_json::from_value(update).unwrap();
            assert!(messages.apply(&parsed));
        }
        let message = &messages.entries()[0];
        assert_eq!(
            message.content.iter().map(text).collect::<Vec<_>>(),
            ["new", "tail"]
        );
        assert_eq!(
            message.meta,
            MaybeUndefined::Value(serde_json::from_value(json!({"two":2,"three":3})).unwrap())
        );
    }
}
