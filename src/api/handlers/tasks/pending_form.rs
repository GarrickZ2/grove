//! Answer a chat's pending native ACP elicitation from outside the chat UI
//! (Orbit Dashboard "Needs you").
//!
//! Uses the same session-handle primitives as the IM connectors and Buddy
//! delegations (`pending_turn_form` / `respond_turn_form`), which validate the
//! answer against the requested schema and resolve the one-shot request
//! atomically: a request the chat already answered comes back stale, and the
//! chat is told about an answer from here through the usual
//! `ElicitationResolved` update.
//!
//! Only trivially simple forms are offered inline — a single boolean, choice
//! or plain short-text field. Grove `ask_form` requests (answered as a chat
//! prompt) and URL-mode elicitations are never offered; they open the session.

use std::collections::HashMap;

use axum::{extract::Path, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::api::error::ApiError;
use crate::radio::TurnFormFieldKind;

use super::linked_projects::api_error;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InlineFieldKind {
    Boolean,
    Choice,
    Text,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct InlineField {
    pub name: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: InlineFieldKind,
    pub options: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct InlineForm {
    pub request_id: String,
    pub agent_name: String,
    pub message: String,
    pub field: InlineField,
}

#[derive(Debug, Serialize)]
pub struct PendingFormResponse {
    /// None when nothing is pending or the request isn't simple enough.
    pub form: Option<InlineForm>,
}

#[derive(Debug, Deserialize)]
pub struct AnswerPendingFormRequest {
    pub request_id: String,
    /// "accept" or "decline".
    pub action: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AnswerPendingFormResponse {
    pub status: &'static str,
}

/// Schema keywords that make a single string field more than "short text".
const COMPLEX_STRING_KEYWORDS: [&str; 7] = [
    "oneOf",
    "anyOf",
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "default",
];

/// The inline form for a pending elicitation, or None when it must be
/// answered in the session (URL mode, several fields, arrays, numbers,
/// constrained strings).
pub fn inline_form(snapshot: &crate::acp::ElicitationRequestSnapshot) -> Option<InlineForm> {
    let form = crate::acp::turn_form(snapshot)?;
    let [field] = form.fields.as_slice() else {
        return None;
    };
    let request = serde_json::to_value(&snapshot.request).ok()?;
    let property = request
        .get("requestedSchema")
        .or_else(|| request.get("requested_schema"))?
        .get("properties")?
        .get(&field.name)?;
    let kind = match field.kind {
        TurnFormFieldKind::Boolean => InlineFieldKind::Boolean,
        TurnFormFieldKind::Text
            if COMPLEX_STRING_KEYWORDS
                .iter()
                .all(|key| property.get(key).is_none()) =>
        {
            if field.options.is_empty() {
                InlineFieldKind::Text
            } else {
                InlineFieldKind::Choice
            }
        }
        _ => return None,
    };
    Some(InlineForm {
        request_id: form.request_id,
        agent_name: snapshot.agent_name.clone(),
        message: form.message,
        field: InlineField {
            name: field.name.clone(),
            label: field.label.clone(),
            description: field.description.clone(),
            required: field.required,
            kind,
            options: field
                .options
                .iter()
                .map(|(value, _)| value.clone())
                .collect(),
        },
    })
}

fn session_handle(
    project_id: &str,
    task_id: &str,
    chat_id: &str,
) -> Option<std::sync::Arc<crate::acp::AcpSessionHandle>> {
    crate::acp::get_session_handle(&format!("{project_id}:{task_id}:{chat_id}"))
}

/// GET /projects/{id}/tasks/{taskId}/chats/{chatId}/pending-form
pub async fn get_pending_form(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
) -> Json<PendingFormResponse> {
    let form = session_handle(&project_id, &task_id, &chat_id)
        .and_then(|handle| handle.pending_elicitation_snapshot())
        .and_then(|snapshot| inline_form(&snapshot));
    Json(PendingFormResponse { form })
}

/// POST /projects/{id}/tasks/{taskId}/chats/{chatId}/pending-form
pub async fn answer_pending_form(
    Path((project_id, task_id, chat_id)): Path<(String, String, String)>,
    Json(request): Json<AnswerPendingFormRequest>,
) -> Result<Json<AnswerPendingFormResponse>, (StatusCode, Json<ApiError>)> {
    let accept = match request.action.as_str() {
        "accept" => true,
        "decline" => false,
        _ => return Err(api_error(StatusCode::BAD_REQUEST, "Unknown action")),
    };
    let handle = session_handle(&project_id, &task_id, &chat_id)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "The session is no longer running."))?;
    let stale = || api_error(StatusCode::CONFLICT, "This request was already answered.");
    let snapshot = handle
        .pending_elicitation_snapshot()
        .filter(|snapshot| snapshot.request_id == request.request_id)
        .ok_or_else(stale)?;
    // Only what this endpoint offered may be answered here.
    let form = inline_form(&snapshot).ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "This request needs the session to answer.",
        )
    })?;
    let mut fields = HashMap::new();
    if accept {
        if let Some(value) = request.value {
            fields.insert(form.field.name, value);
        }
    }
    handle
        .respond_turn_form(&request.request_id, accept, &fields)
        .map_err(|message| {
            if handle.pending_elicitation_snapshot().is_none() {
                stale()
            } else {
                api_error(StatusCode::BAD_REQUEST, message)
            }
        })?;
    Ok(Json(AnswerPendingFormResponse { status: "ok" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::v1::schema as acp;

    fn snapshot(schema: acp::ElicitationSchema) -> crate::acp::ElicitationRequestSnapshot {
        crate::acp::ElicitationRequestSnapshot {
            request_id: "request-1".into(),
            agent_name: "Test Agent".into(),
            request: acp::CreateElicitationRequest::new(
                acp::ElicitationFormMode::new(
                    acp::ElicitationSessionScope::new("session-test"),
                    schema,
                ),
                "Pick one",
            ),
            opened: false,
        }
    }

    #[test]
    fn only_single_simple_fields_are_inline() {
        let choice = acp::ElicitationSchema::new().property(
            "env",
            acp::StringPropertySchema::new()
                .enum_values(vec!["staging".to_string(), "production".to_string()]),
            true,
        );
        let form = inline_form(&snapshot(choice)).expect("choice is inline");
        assert_eq!(form.request_id, "request-1");
        assert_eq!(form.message, "Pick one");
        assert_eq!(form.field.kind, InlineFieldKind::Choice);
        assert_eq!(form.field.options, ["staging", "production"]);
        assert!(form.field.required);

        let text = acp::ElicitationSchema::new().string("name", false);
        assert_eq!(
            inline_form(&snapshot(text)).unwrap().field.kind,
            InlineFieldKind::Text
        );
        let boolean = acp::ElicitationSchema::new().boolean("ok", true);
        assert_eq!(
            inline_form(&snapshot(boolean)).unwrap().field.kind,
            InlineFieldKind::Boolean
        );

        let two = acp::ElicitationSchema::new()
            .string("a", true)
            .string("b", true);
        assert!(inline_form(&snapshot(two)).is_none());
        let number = acp::ElicitationSchema::new().integer("n", 1, 9, true);
        assert!(inline_form(&snapshot(number)).is_none());
    }

    #[tokio::test]
    async fn answers_go_through_the_session_and_stale_ones_conflict() {
        let project = format!("pending-form-{}", uuid::Uuid::new_v4());
        let key = format!("{project}:task:chat");
        let (handle, _updates, _guard) =
            crate::acp::new_handle_for_test(&key, &project, "task", "chat");
        let path = || Path((project.clone(), "task".to_string(), "chat".to_string()));

        // Nothing pending.
        assert!(get_pending_form(path()).await.0.form.is_none());

        let response = handle.set_pending_elicitation_for_test(snapshot(
            acp::ElicitationSchema::new().property(
                "env",
                acp::StringPropertySchema::new()
                    .enum_values(vec!["staging".to_string(), "production".to_string()]),
                true,
            ),
        ));
        let form = get_pending_form(path()).await.0.form.expect("form offered");
        assert_eq!(form.field.name, "env");

        // A value outside the schema is rejected and keeps the form pending.
        let invalid = answer_pending_form(
            path(),
            Json(AnswerPendingFormRequest {
                request_id: "request-1".into(),
                action: "accept".into(),
                value: Some("moon".into()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
        assert!(handle.pending_elicitation_snapshot().is_some());

        let accepted = answer_pending_form(
            path(),
            Json(AnswerPendingFormRequest {
                request_id: "request-1".into(),
                action: "accept".into(),
                value: Some("staging".into()),
            }),
        )
        .await
        .expect("accepted");
        assert_eq!(accepted.0.status, "ok");
        assert!(matches!(
            response.await.unwrap(),
            crate::acp::ElicitationResponseData::Accept { .. }
        ));

        // Answering again (e.g. the chat got there first) is a conflict.
        let stale = answer_pending_form(
            path(),
            Json(AnswerPendingFormRequest {
                request_id: "request-1".into(),
                action: "accept".into(),
                value: Some("staging".into()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(stale.0, StatusCode::CONFLICT);

        // Unknown session.
        let missing = answer_pending_form(
            Path(("nope".into(), "task".into(), "chat".into())),
            Json(AnswerPendingFormRequest {
                request_id: "request-1".into(),
                action: "accept".into(),
                value: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
    }
}
