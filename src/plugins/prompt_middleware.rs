//! Synchronous, input-only Prompt hooks implemented by existing plugin backends.

use serde_json::{json, Value};

use crate::error::{GroveError, Result};

#[derive(Clone, Copy)]
pub enum Phase {
    Submit,
    Dispatch,
}

impl Phase {
    fn method(self) -> &'static str {
        match self {
            Self::Submit => "prompt.submit",
            Self::Dispatch => "prompt.dispatch",
        }
    }

    fn declaration(self) -> &'static str {
        match self {
            Self::Submit => "submit",
            Self::Dispatch => "dispatch",
        }
    }
}

/// Returns the text to carry forward. Plugin order is installation order.
pub async fn run(
    phase: Phase,
    project_id: &str,
    task_id: &str,
    chat_id: Option<&str>,
    message_ids: &[String],
    text: String,
    sender: Option<&str>,
) -> Result<String> {
    let mut text = text;
    for plugin in crate::storage::plugins::list()? {
        let manifest: Value = match std::fs::read_to_string(
            std::path::Path::new(&plugin.local_path).join("plugin.json"),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        {
            Some(value) => value,
            None => continue,
        };
        let permitted = manifest
            .get("permissions")
            .and_then(Value::as_array)
            .is_some_and(|permissions| {
                permissions
                    .iter()
                    .any(|value| value.as_str() == Some("prompt:middleware"))
            });
        let enabled = permitted
            && manifest
                .get("contributes")
                .and_then(|value| value.get("promptMiddleware"))
                .and_then(Value::as_array)
                .is_some_and(|hooks| {
                    hooks
                        .iter()
                        .any(|hook| hook.as_str() == Some(phase.declaration()))
                });
        if !enabled {
            continue;
        }
        let response = super::backend::invoke_boxed(
            &plugin.id,
            None,
            phase.method(),
            json!({
                "projectId": project_id,
                "taskId": task_id,
                "chatId": chat_id,
                "messageIds": message_ids,
                "text": text,
                "sender": sender,
            }),
            Some(5_000),
        )
        .await
        .map_err(|error| {
            GroveError::session(format!(
                "Plugin {} Prompt hook failed: {error}",
                plugin.name
            ))
        })?;
        text = apply_result(&plugin.name, text, &response)?;
    }
    Ok(text)
}

fn apply_result(plugin_name: &str, text: String, response: &Value) -> Result<String> {
    if response.get("allow").and_then(Value::as_bool) == Some(false) {
        let reason = response
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("Prompt rejected");
        return Err(GroveError::session(format!(
            "Plugin {plugin_name}: {reason}"
        )));
    }
    if response.get("allow").and_then(Value::as_bool) != Some(true) {
        return Err(GroveError::session(format!(
            "Plugin {plugin_name} returned an invalid Prompt hook result"
        )));
    }
    match response.get("text") {
        Some(Value::String(next)) => Ok(next.clone()),
        None => Ok(text),
        _ => Err(GroveError::session(format!(
            "Plugin {plugin_name} returned non-text Prompt content"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pass_through_modify_and_reject() {
        assert_eq!(
            apply_result("a", "one".into(), &json!({"allow": true})).unwrap(),
            "one"
        );
        assert_eq!(
            apply_result("a", "one".into(), &json!({"allow": true, "text": "two"})).unwrap(),
            "two"
        );
        assert!(apply_result(
            "a",
            "one".into(),
            &json!({"allow": false, "reason": "exercise more"})
        )
        .unwrap_err()
        .to_string()
        .contains("exercise more"));
        assert!(apply_result("a", "one".into(), &json!({"allow": true, "text": 12})).is_err());
    }
}
