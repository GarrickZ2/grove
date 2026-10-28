//! v2 permission requests use a standalone title and optional subject.

use agent_client_protocol::{schema::v2, RequestCancellation};
use tokio_util::sync::CancellationToken;

use super::{acp, AcpClientState, AcpUpdate, PermOptionData, TurnOrigin};

pub(super) async fn request(
    state: &AcpClientState,
    request: v2::RequestPermissionRequest,
    cancellation: RequestCancellation,
    origin: Option<TurnOrigin>,
    child_cancel: CancellationToken,
) -> acp::Result<v2::RequestPermissionResponse> {
    state
        .handle
        .validate_session(&request.session_id.to_string())?;
    let cancelled = || v2::RequestPermissionResponse::new(v2::RequestPermissionOutcome::Cancelled);
    let _guard = tokio::select! {
        guard = state.handle.permission_lock.lock() => guard,
        _ = child_cancel.cancelled() => return Ok(cancelled()),
        _ = cancellation.cancelled() => return Err(acp::Error::request_cancelled()),
    };
    if child_cancel.is_cancelled()
        || (!state.handle.is_subagent(&request.session_id.to_string())
            && state
                .handle
                .cancel_requested
                .load(std::sync::atomic::Ordering::Relaxed))
    {
        return Ok(cancelled());
    }
    let request_id = format!("permission-{}", uuid::Uuid::new_v4());
    state
        .handle
        .own_child_request(&request_id, &request.session_id.to_string());
    let options: Vec<PermOptionData> = request
        .options
        .iter()
        .map(|option| PermOptionData {
            option_id: option.option_id.to_string(),
            name: option.name.clone(),
            kind: serde_json::to_value(&option.kind)
                .ok()
                .and_then(|kind| kind.as_str().map(str::to_owned))
                .unwrap_or_else(|| "unknown".to_string()),
        })
        .collect();
    let detail = permission_detail(request.description.as_deref(), &request.subject);
    let description = request.title.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .handle
        .pending_permission
        .lock()
        .unwrap()
        .replace((request_id.clone(), tx));
    state.handle.emit_with_origin(
        AcpUpdate::PermissionRequest {
            id: request_id.clone(),
            title: Some(request.title.clone()),
            detail,
            description: description.clone(),
            options: options.clone(),
        },
        origin,
    );
    if state.chat_id.is_some() {
        super::notify_acp_event(
            &state.project_key,
            &state.task_id,
            state.chat_id.as_deref(),
            "Permission Required",
            &description,
            super::AcpNotificationEvent::PermissionRequired,
            Some(&options),
        );
    }
    tokio::select! {
        result = rx => {
            match result {
                Ok(id) if options.iter().any(|option| option.option_id == id) => Ok(v2::RequestPermissionResponse::new(
                    v2::RequestPermissionOutcome::Selected(v2::SelectedPermissionOutcome::new(id))
                )),
                _ => Ok(cancelled()),
            }
        },
        _ = child_cancel.cancelled() => {
            state.handle.cancel_pending_permission(&request_id);
            Ok(cancelled())
        },
        _ = cancellation.cancelled() => {
            state.handle.cancel_pending_permission(&request_id);
            Err(acp::Error::request_cancelled())
        },
    }
}

fn permission_detail(
    description: Option<&str>,
    subject: &Option<v2::RequestPermissionSubject>,
) -> Option<String> {
    use agent_client_protocol::schema::MaybeUndefined;
    let mut parts = Vec::<String>::new();
    let mut add = |value: String| {
        if !value.trim().is_empty() && !parts.iter().any(|part| part.contains(&value)) {
            parts.push(value);
        }
    };
    if let Some(value) = description {
        add(value.to_owned());
    }
    match subject {
        Some(v2::RequestPermissionSubject::Command(command)) => {
            add(command.command.clone());
            add(command.cwd.0.display().to_string());
        }
        Some(v2::RequestPermissionSubject::ToolCall(subject)) => {
            let tool = &subject.tool_call;
            if let MaybeUndefined::Value(input) = &tool.raw_input {
                if let Some(detail) = super::permission_input_detail(&Some(input.clone())) {
                    add(detail);
                }
            }
            if let MaybeUndefined::Value(locations) = &tool.locations {
                for location in locations {
                    add(location.path.0.display().to_string());
                }
            }
        }
        _ => {}
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_permission_includes_the_operation_and_location() {
        let subject = serde_json::from_value(serde_json::json!({"type":"tool_call", "toolCall":{"toolCallId":"t", "title":"Run command", "rawInput":{"command":"ls"}, "locations":[{"path":"/tmp/file"}]}})).unwrap();
        let text = permission_detail(None, &Some(subject)).unwrap();
        assert!(text.contains("ls") && text.contains("/tmp/file"));
        assert!(!text.contains("rawInput"));
    }
}
