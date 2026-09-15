//! `grove_ask_form` — let the AI ask the user a structured form.
//!
//! ## Pipeline (backend-pushed event, not tool_call sniffing)
//!
//! 1. Agent calls `ask_form` over the agent-graph MCP HTTP transport.
//! 2. This handler resolves the caller chat → looks up its ACP session
//!    handle → `handle.emit(AcpUpdate::AskForm { form_id, definition })`.
//!    The handle's update broadcaster fans the event out to the chat
//!    WebSocket, which translates it to `ServerMessage::AskForm` and
//!    pushes it to every connected client.
//! 3. The frontend reducer receives a typed `ask_form` WS event (no
//!    `tool_call` raw_input duck-typing) and builds an `AskFormMessage`
//!    that renders as a `FormPill`.
//! 4. The user fills the form and submits; the FormPill ships the answers
//!    back through the regular user-prompt channel as a fresh turn — the
//!    agent reads them naturally on its next prompt cycle.
//!
//! `AcpUpdate::AskForm` is excluded from history persistence (see
//! `storage::chat_history::should_persist`) so the form is transient UI;
//! the user's actual answers are persisted as a normal user message.

use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::error::AgentGraphError;
use super::tools::ToolContext;
use crate::storage::tasks;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FormOption {
    /// Stable id used in the answer payload.
    pub id: String,
    /// Display label shown to the user.
    pub label: String,
    /// Optional one-liner shown beneath the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FormQuestion {
    SingleChoice {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        options: Vec<FormOption>,
    },
    MultiChoice {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        options: Vec<FormOption>,
    },
    Text {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    Textarea {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    Number {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    Rating {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    Boolean {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

impl FormQuestion {
    fn id(&self) -> &str {
        match self {
            FormQuestion::SingleChoice { id, .. }
            | FormQuestion::MultiChoice { id, .. }
            | FormQuestion::Text { id, .. }
            | FormQuestion::Textarea { id, .. }
            | FormQuestion::Number { id, .. }
            | FormQuestion::Rating { id, .. }
            | FormQuestion::Boolean { id, .. } => id,
        }
    }

    fn options(&self) -> Option<&[FormOption]> {
        match self {
            FormQuestion::SingleChoice { options, .. }
            | FormQuestion::MultiChoice { options, .. } => Some(options),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AskFormInput {
    /// Title shown at the top of the form (and in the collapsed pill).
    pub title: String,
    /// Optional paragraph shown below the title when expanded.
    #[serde(default)]
    pub description: Option<String>,
    /// Question list. At least one. Rendered as tabs in the UI — one
    /// question per page with Prev / Skip / Next controls.
    pub questions: Vec<FormQuestion>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AskFormOutput {
    /// Server-minted id; opaque to the agent, useful only for log correlation.
    pub form_id: String,
    /// Always `"created"`. The user's actual answers arrive separately as the
    /// next user prompt — there is no callback path here.
    pub status: String,
}

/// Dispatch a structured form to the caller chat's UI.
///
/// Resolves the caller's ACP session handle, emits `AcpUpdate::AskForm` so
/// the chat WebSocket pushes a typed event to the frontend, then returns
/// `{ form_id, status: "created" }` to the agent immediately. The agent's
/// turn ends normally; the user's answers travel back as a separate user
/// prompt in the next turn.
pub async fn grove_ask_form(
    cx: &ToolContext,
    input: AskFormInput,
) -> Result<AskFormOutput, AgentGraphError> {
    if input.title.trim().is_empty() {
        return Err(AgentGraphError::Internal(
            "ask_form: `title` must not be empty".into(),
        ));
    }
    if input.questions.is_empty() {
        return Err(AgentGraphError::Internal(
            "ask_form: `questions` must contain at least one entry".into(),
        ));
    }
    // Reject duplicate question ids — the frontend keys answers by `q.id`, so
    // duplicates would silently share one answer slot.
    let mut seen_qids = std::collections::HashSet::new();
    for q in &input.questions {
        if !seen_qids.insert(q.id()) {
            return Err(AgentGraphError::Internal(format!(
                "ask_form: duplicate question id `{}`",
                q.id()
            )));
        }
        if let Some(opts) = q.options() {
            let mut seen_oids = std::collections::HashSet::new();
            for opt in opts {
                if !seen_oids.insert(opt.id.as_str()) {
                    return Err(AgentGraphError::Internal(format!(
                        "ask_form: duplicate option id `{}` in question `{}`",
                        opt.id,
                        q.id()
                    )));
                }
            }
        }
    }

    // Resolve the caller chat (project, task) via the public storage API.
    // (`ToolContext::caller_context` is module-private to `tools.rs`.)
    let (project_key, task_id, _caller_chat) = tasks::find_chat_session(&cx.caller_chat_id)
        .map_err(AgentGraphError::from)?
        .ok_or(AgentGraphError::CallerUnknown)?;

    let session_key = format!("{}:{}:{}", project_key, task_id, cx.caller_chat_id);
    let handle = crate::acp::get_session_handle(&session_key).ok_or_else(|| {
        AgentGraphError::Internal(format!(
            "ask_form: no live ACP handle for caller chat {}",
            cx.caller_chat_id
        ))
    })?;

    let form_id = format!("form-{}", uuid::Uuid::new_v4());
    // Capture the originating turn before the event is emitted. AskForm is
    // delivered over a separate MCP request, so publishing it later must not
    // re-read a potentially newer ACP turn.
    let origin = handle.active_turn_origin();
    handle.emit_with_origin(
        crate::acp::AcpUpdate::AskForm {
            form_id: form_id.clone(),
            definition: input,
        },
        origin,
    );

    Ok(AskFormOutput {
        form_id,
        status: "created".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_round_trips_through_serde() {
        let raw = r#"{
            "title": "Deploy",
            "questions": [
                { "type": "single_choice", "id": "env", "title": "Env",
                  "options": [{"id":"prod","label":"Prod"}] },
                { "type": "boolean", "id": "smoke", "title": "Smoke?" },
                { "type": "rating", "id": "conf", "title": "Confidence" },
                { "type": "text", "id": "ticket", "title": "Ticket" },
                { "type": "textarea", "id": "notes", "title": "Notes" },
                { "type": "number", "id": "pct", "title": "Pct" },
                { "type": "multi_choice", "id": "regions", "title": "Regions",
                  "options": [{"id":"a","label":"A"},{"id":"b","label":"B"}] }
            ]
        }"#;
        let parsed: AskFormInput = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.title, "Deploy");
        assert!(parsed.description.is_none());
        assert_eq!(parsed.questions.len(), 7);
        // Spot check the discriminator handling for each variant.
        let kinds: Vec<&str> = parsed
            .questions
            .iter()
            .map(|q| match q {
                FormQuestion::SingleChoice { .. } => "single_choice",
                FormQuestion::MultiChoice { .. } => "multi_choice",
                FormQuestion::Text { .. } => "text",
                FormQuestion::Textarea { .. } => "textarea",
                FormQuestion::Number { .. } => "number",
                FormQuestion::Rating { .. } => "rating",
                FormQuestion::Boolean { .. } => "boolean",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "single_choice",
                "boolean",
                "rating",
                "text",
                "textarea",
                "number",
                "multi_choice",
            ]
        );
    }

    #[tokio::test]
    async fn rejects_empty_title() {
        let cx = ToolContext::new("any-chat".into());
        let input: AskFormInput = serde_json::from_str(
            r#"{"title":"   ","questions":[{"type":"text","id":"q1","title":"Q1"}]}"#,
        )
        .unwrap();
        let err = grove_ask_form(&cx, input).await.unwrap_err();
        assert!(matches!(err, AgentGraphError::Internal(_)));
        assert!(err.to_string().contains("title"));
    }

    #[tokio::test]
    async fn rejects_empty_questions() {
        let cx = ToolContext::new("any-chat".into());
        let input: AskFormInput = serde_json::from_str(r#"{"title":"t","questions":[]}"#).unwrap();
        let err = grove_ask_form(&cx, input).await.unwrap_err();
        assert!(matches!(err, AgentGraphError::Internal(_)));
        assert!(err.to_string().contains("questions"));
    }

    #[tokio::test]
    async fn rejects_unknown_caller() {
        // Validation passes; caller lookup fails because the chat id was
        // never registered in storage. End-to-end (real ACP handle) is
        // covered by the integration suite that spins up a mock agent —
        // the unit test here just pins the error code so a future regression
        // in `find_chat_session` doesn't silently turn this into a panic.
        let cx = ToolContext::new("ghost-chat-id-not-in-db".into());
        let input: AskFormInput = serde_json::from_str(
            r#"{"title":"t","questions":[{"type":"text","id":"q1","title":"Q1"}]}"#,
        )
        .unwrap();
        let err = grove_ask_form(&cx, input).await.unwrap_err();
        assert!(matches!(err, AgentGraphError::CallerUnknown));
    }
}
