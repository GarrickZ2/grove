use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::radio::{RadioEvent, TurnEvent, TurnForm, TurnFormFieldKind};
use crate::storage::connects::{self, Connect};

use super::adapter::{AdapterRef, InboundMessage};
use super::commands::{
    CardSpec, ElicitationCard, ElicitationField, ElicitationFieldKind, PermissionCard,
    PermissionCardOption,
};

/// Runtime-only correlation between Grove-owned message ids and adapter-owned
/// reply references. A terminal Grove event removes the mapping.
#[derive(Clone)]
struct MessageMapping {
    connection_id: String,
    external_message_id: String,
    project_id: String,
    task_id: String,
    session_id: String,
    adapter: AdapterRef,
    status: Option<String>,
}

static MESSAGE_MAPPINGS: Lazy<Mutex<HashMap<String, MessageMapping>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
pub fn shutdown(connection_id: &str) {
    let removed = {
        let mut mappings = MESSAGE_MAPPINGS.lock().unwrap();
        let ids: Vec<String> = mappings
            .iter()
            .filter(|(_, mapping)| mapping.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| mappings.remove(&id))
            .collect::<Vec<_>>()
    };
    for mapping in removed {
        tokio::spawn(async move {
            mapping
                .adapter
                .clear_status(&mapping.external_message_id, &mapping.status)
                .await;
        });
    }
}

fn session_handle(connect: &Connect) -> Result<crate::grove::Session, String> {
    if connect.project_id.is_empty() || connect.task_id.is_empty() || connect.session_id.is_empty()
    {
        return Err("No active Grove session for this connection.".into());
    }
    crate::grove::session(&connect.project_id, &connect.task_id, &connect.session_id)
        .ok_or_else(|| "The Grove session is no longer running.".into())
}

pub fn respond_permission(
    connect: &Connect,
    request_id: &str,
    option_id: &str,
) -> Result<(), String> {
    let handle = session_handle(connect)?;
    if !handle.pending_permission_accepts(request_id, option_id) {
        return Err("This permission response is no longer valid.".into());
    }
    if handle.respond_permission(option_id.to_owned()) {
        Ok(())
    } else {
        Err("This permission request is no longer active.".into())
    }
}

pub fn respond_elicitation(
    connect: &Connect,
    request_id: &str,
    accept: bool,
    fields: &HashMap<String, String>,
) -> Result<(), String> {
    session_handle(connect)?.respond_turn_form(request_id, accept, fields)
}

fn form_card(form: TurnForm) -> CardSpec {
    CardSpec::Elicitation(ElicitationCard {
        request_id: form.request_id,
        message: form.message,
        fields: form
            .fields
            .into_iter()
            .map(|field| ElicitationField {
                name: field.name,
                label: field.label,
                description: field.description,
                required: field.required,
                kind: match field.kind {
                    TurnFormFieldKind::Text => ElicitationFieldKind::Text,
                    TurnFormFieldKind::Integer => ElicitationFieldKind::Integer,
                    TurnFormFieldKind::Number => ElicitationFieldKind::Number,
                    TurnFormFieldKind::Boolean => ElicitationFieldKind::Boolean,
                    TurnFormFieldKind::StringArray => ElicitationFieldKind::StringArray,
                },
                options: field.options,
            })
            .collect(),
    })
}

pub fn pending_elicitation_card(connect: &Connect, request_id: &str) -> Option<CardSpec> {
    session_handle(connect)
        .ok()?
        .pending_turn_form(request_id)
        .map(form_card)
}

pub async fn deliver_prompt(
    connect: Connect,
    adapter: AdapterRef,
    inbound: InboundMessage,
    text: String,
) {
    if connect.project_id.is_empty() || connect.task_id.is_empty() {
        let _ = adapter
            .reply_text(
                &inbound.external_message_id,
                "This connection is not linked to a Grove task yet. Send /target to choose a target.",
            )
            .await;
        return;
    }
    let session_id = if connect.session_id.is_empty() {
        match create_session(&connect, None) {
            Ok(session_id) => session_id,
            Err(error) => {
                let _ = adapter
                    .reply_text(
                        &inbound.external_message_id,
                        &format!("Grove Connect error: {error}"),
                    )
                    .await;
                return;
            }
        }
    } else {
        connect.session_id.clone()
    };

    let waiting = adapter.mark_waiting(&inbound.external_message_id).await;
    let session = match crate::grove::ensure_session(
        &connect.project_id,
        &connect.task_id,
        &session_id,
    )
    .await
    {
        Ok(handle) => handle,
        Err(error) => {
            adapter
                .clear_status(&inbound.external_message_id, &waiting)
                .await;
            let _ = adapter
                .reply_text(
                    &inbound.external_message_id,
                    &format!("Grove Connect error: {error}"),
                )
                .await;
            return;
        }
    };
    let prompt = session.prepare_text_prompt(text, Some("connect".into()));
    let grove_message_id = prompt.id().to_owned();
    MESSAGE_MAPPINGS.lock().unwrap().insert(
        grove_message_id.clone(),
        MessageMapping {
            connection_id: connect.id.clone(),
            external_message_id: inbound.external_message_id.clone(),
            project_id: connect.project_id.clone(),
            task_id: connect.task_id.clone(),
            session_id,
            adapter: adapter.clone(),
            status: waiting,
        },
    );
    if let Err(error) = prompt.start().await {
        let failed_mapping = { MESSAGE_MAPPINGS.lock().unwrap().remove(&grove_message_id) };
        if let Some(mapping) = failed_mapping {
            mapping
                .adapter
                .clear_status(&mapping.external_message_id, &mapping.status)
                .await;
        }
        let _ = adapter
            .reply_text(
                &inbound.external_message_id,
                &format!("Grove Connect error: {error}"),
            )
            .await;
    }
}

pub fn create_session(connect: &Connect, agent_override: Option<&str>) -> Result<String, String> {
    if agent_override.is_none() {
        if let Ok(Some(fresh)) = connects::get(&connect.id) {
            if !fresh.session_id.is_empty() {
                return Ok(fresh.session_id);
            }
        }
    }
    let agent = match agent_override {
        Some(requested) => crate::storage::installed_agents::canonicalize_agent_id(requested),
        None => {
            let cfg = crate::storage::config::load_config();
            crate::storage::installed_agents::canonicalize_agent_id(
                cfg.acp
                    .agent_command
                    .clone()
                    .unwrap_or_else(|| "claude-acp".to_string())
                    .as_str(),
            )
        }
    };
    let now = chrono::Utc::now();
    let chat = crate::storage::tasks::ChatSession {
        id: crate::storage::tasks::generate_chat_id(),
        title: format!("IM Connect {}", now.format("%m-%d %H:%M")),
        agent,
        acp_session_id: None,
        created_at: now,
        duty: None,
        launch_mode: "acp".to_owned(),
    };
    crate::storage::tasks::add_chat_session(&connect.project_id, &connect.task_id, chat.clone())
        .map_err(|error| error.to_string())?;
    connects::set_session(&connect.id, &chat.id).map_err(|error| error.to_string())?;
    crate::radio::publish(RadioEvent::ChatListChanged {
        project_id: connect.project_id.clone(),
        task_id: connect.task_id.clone(),
    });
    Ok(chat.id)
}

fn routes(message_ids: &[String]) -> Vec<(String, MessageMapping)> {
    let mappings = MESSAGE_MAPPINGS.lock().unwrap();
    message_ids
        .iter()
        .filter_map(|id| {
            mappings
                .get(id)
                .cloned()
                .map(|mapping| (id.clone(), mapping))
        })
        .collect()
}

fn take_routes(message_ids: &[String]) -> Vec<MessageMapping> {
    let mut mappings = MESSAGE_MAPPINGS.lock().unwrap();
    message_ids
        .iter()
        .filter_map(|id| mappings.remove(id))
        .collect()
}

async fn clear_routes(routes: &[MessageMapping]) {
    for route in routes {
        route
            .adapter
            .clear_status(&route.external_message_id, &route.status)
            .await;
    }
}

pub async fn handle_turn_event(
    project_id: String,
    task_id: String,
    session_id: String,
    message_ids: Vec<String>,
    event: TurnEvent,
) {
    match event {
        TurnEvent::Started => {
            for (id, route) in routes(&message_ids) {
                let working = route
                    .adapter
                    .mark_working(&route.external_message_id, &route.status)
                    .await;
                if let Some(current) = MESSAGE_MAPPINGS.lock().unwrap().get_mut(&id) {
                    current.status = working;
                }
            }
        }
        TurnEvent::PermissionRequired {
            request_id,
            permission,
        } => {
            let Some((_, route)) = routes(&message_ids).pop() else {
                return;
            };
            let card = CardSpec::Permission(PermissionCard {
                request_id,
                description: permission.description,
                options: permission
                    .options
                    .into_iter()
                    .map(|option| PermissionCardOption {
                        id: option.option_id,
                        label: option.name,
                        kind: option.kind,
                    })
                    .collect(),
            });
            if let Err(error) = route
                .adapter
                .reply_card(&route.external_message_id, &card)
                .await
            {
                eprintln!("[connect] failed to deliver permission card: {error}");
            }
        }
        TurnEvent::FormRequired { form } => {
            let Some((_, route)) = routes(&message_ids).pop() else {
                return;
            };
            let card = form_card(form);
            if let Err(error) = route
                .adapter
                .reply_card(&route.external_message_id, &card)
                .await
            {
                eprintln!("[connect] failed to deliver form card: {error}");
            }
        }
        TurnEvent::Completed {
            stop_reason,
            message,
        } => {
            let matched_routes = routes(&message_ids);
            let stopped = {
                let reason = stop_reason.to_ascii_lowercase();
                reason.contains("cancel") || reason == "killed"
            };
            if stopped {
                let removed = take_routes(&message_ids);
                clear_routes(&removed).await;
            } else if let Some((_, route)) = matched_routes.last() {
                let reply = if message.trim().is_empty() {
                    "Agent completed without a text response."
                } else {
                    message.trim()
                };
                match route
                    .adapter
                    .reply_text(&route.external_message_id, reply)
                    .await
                {
                    Ok(()) => {
                        let removed = take_routes(&message_ids);
                        clear_routes(&removed).await;
                    }
                    Err(error) => {
                        eprintln!("[connect] failed to deliver final reply: {error}");
                    }
                }
            }
        }
        TurnEvent::Failed { message } => {
            let matched_routes = routes(&message_ids);
            if let Some((_, route)) = matched_routes.last() {
                match route
                    .adapter
                    .reply_text(
                        &route.external_message_id,
                        &format!("Agent error: {message}"),
                    )
                    .await
                {
                    Ok(()) => {
                        let removed = take_routes(&message_ids);
                        clear_routes(&removed).await;
                    }
                    Err(error) => {
                        eprintln!("[connect] failed to deliver error reply: {error}");
                    }
                }
            }
        }
        TurnEvent::Removed => {
            let routes = take_routes(&message_ids);
            clear_routes(&routes).await;
        }
        TurnEvent::SessionEnded => {
            let routes = {
                let mut mappings = MESSAGE_MAPPINGS.lock().unwrap();
                let ids: Vec<String> = mappings
                    .iter()
                    .filter(|(_, route)| {
                        route.project_id == project_id
                            && route.task_id == task_id
                            && route.session_id == session_id
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| mappings.remove(&id))
                    .collect::<Vec<_>>()
            };
            clear_routes(&routes).await;
        }
    }
}
