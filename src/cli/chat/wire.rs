//! Client → server chat WebSocket messages.
//!
//! Built as JSON in the server's `ClientMessage` shape; the tests below parse
//! each one with the server's own deserializer so the two cannot drift.

use serde_json::{json, Value};

pub fn new_message_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A prompt, or — while the agent is busy — a queued message.
pub fn prompt(text: &str, client_message_id: &str, queue: bool, config: Option<Value>) -> Value {
    let mut message = json!({
        "type": if queue { "queue_message" } else { "prompt" },
        "text": text,
        "client_message_id": client_message_id,
        "sent_at": now_ms(),
    });
    if let Some(config) = config {
        message["config"] = config;
    }
    message
}

pub fn cancel() -> Value {
    json!({ "type": "cancel" })
}

pub fn permission(id: &str, option_id: &str) -> Value {
    json!({ "type": "permission_response", "id": id, "option_id": option_id })
}

pub fn set_mode(mode_id: &str) -> Value {
    json!({ "type": "set_mode", "mode_id": mode_id })
}

pub fn set_config_option(config_id: &str, value: &str) -> Value {
    json!({ "type": "set_config_option", "config_id": config_id, "value": value })
}

pub fn dequeue(id: &str) -> Value {
    json!({ "type": "dequeue_message", "id": id })
}

pub fn shell(command: &str) -> Value {
    json!({ "type": "terminal_execute", "command": command })
}

/// Answer an elicitation: `accept` (with `content` for a form), `decline`
/// or `cancel`.
pub fn elicitation(id: &str, action: &str, content: Option<Value>) -> Value {
    let mut message = json!({ "type": "elicitation_response", "id": id, "action": action });
    if let Some(content) = content {
        message["content"] = content;
    }
    message
}

/// Close an `ask_form` (answered, or dismissed without answering).
pub fn ask_form_resolved(id: &str) -> Value {
    json!({ "type": "ask_form_resolved", "id": id })
}

/// Retry after the user finished the agent's own sign-in elsewhere.
pub fn retry_authentication() -> Value {
    json!({ "type": "retry_authentication" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parses(message: Value) {
        serde_json::from_value::<crate::api::handlers::acp::ClientMessage>(message.clone())
            .unwrap_or_else(|e| panic!("server rejects {message}: {e}"));
    }

    #[test]
    fn server_accepts_every_cli_message() {
        parses(prompt("hi", "id", false, None));
        parses(prompt("hi", "id", true, Some(json!({ "model": "opus" }))));
        parses(cancel());
        parses(permission("p", "allow"));
        parses(set_mode("plan"));
        parses(set_config_option("model", "opus"));
        parses(dequeue("q"));
        parses(shell("ls"));
        parses(retry_authentication());
        parses(elicitation(
            "e",
            "accept",
            Some(json!({ "a": "x", "n": 2, "b": true, "m": ["y"] })),
        ));
        parses(elicitation("e", "decline", None));
        parses(elicitation("e", "cancel", None));
        parses(ask_form_resolved("f"));
    }
}
