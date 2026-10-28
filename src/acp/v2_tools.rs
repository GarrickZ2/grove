//! ACP v2 tool calls are upserts; their content chunks append until replaced.

use std::collections::HashMap;

use agent_client_protocol::schema::{v2, MaybeUndefined};

#[derive(Default)]
pub struct Tools {
    calls: HashMap<String, v2::ToolCallUpdate>,
}

impl Tools {
    pub fn contains(&self, id: &str) -> bool {
        self.calls.contains_key(id)
    }
    pub fn update(&mut self, update: v2::ToolCallUpdate) -> &v2::ToolCallUpdate {
        let id = update.tool_call_id.to_string();
        let call = self
            .calls
            .entry(id)
            .or_insert_with(|| v2::ToolCallUpdate::new(update.tool_call_id.clone()));
        call.apply_update(update);
        call
    }

    pub fn chunk(&mut self, chunk: &v2::ToolCallContentChunk) -> &v2::ToolCallUpdate {
        let call = self
            .calls
            .entry(chunk.tool_call_id.to_string())
            .or_insert_with(|| v2::ToolCallUpdate::new(chunk.tool_call_id.clone()));
        if !matches!(call.content, MaybeUndefined::Value(_)) {
            call.content = MaybeUndefined::Value(Vec::new());
        }
        if let MaybeUndefined::Value(content) = &mut call.content {
            content.push(chunk.content.clone());
        }
        call
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chunks_append_and_later_snapshot_or_null_replaces_content() {
        let mut tools = Tools::default();
        let initial: v2::ToolCallUpdate =
            serde_json::from_value(json!({"toolCallId":"a", "title":"Search", "content":[]}))
                .unwrap();
        tools.update(initial);
        let chunk: v2::ToolCallContentChunk = serde_json::from_value(json!({"toolCallId":"a", "content":{"type":"content", "content":{"type":"text", "text":"result"}}})).unwrap();
        assert!(
            matches!(&tools.chunk(&chunk).content, MaybeUndefined::Value(items) if items.len() == 1)
        );
        let replace: v2::ToolCallUpdate =
            serde_json::from_value(json!({"toolCallId":"a", "title":null, "content":[]})).unwrap();
        let call = tools.update(replace);
        assert!(matches!(&call.content, MaybeUndefined::Value(items) if items.is_empty()));
        assert_eq!(call.title, MaybeUndefined::Null);
        let clear: v2::ToolCallUpdate =
            serde_json::from_value(json!({"toolCallId":"a", "content":null})).unwrap();
        assert_eq!(tools.update(clear).content, MaybeUndefined::Null);
    }
}
