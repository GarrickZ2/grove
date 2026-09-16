use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use once_cell::sync::Lazy;

use crate::acp::ContentBlockData;
use crate::radio::{RadioEvent, TurnEvent, TurnForm, TurnFormFieldKind};
use crate::storage::connects::{self, Connect};

use super::adapter::{AdapterRef, InboundAttachment, InboundAttachmentKind, InboundMessage};
use super::commands::{
    CardSpec, ElicitationCard, ElicitationField, ElicitationFieldKind, PermissionCard,
    PermissionCardOption,
};

/// Runtime-only correlation between Grove-owned message ids and adapter-owned
/// reply references. Completed routes stay in a bounded in-memory history so
/// a late permission/form event can still be sent to its original conversation.
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
const COMPLETED_TURN_HISTORY_LIMIT: usize = 5;
type SessionKey = (String, String, String);
static COMPLETED_TURNS: Lazy<Mutex<HashMap<SessionKey, VecDeque<Vec<String>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const ASK_FORM_PENDING_LIMIT: usize = 32;
const ASK_FORM_PENDING_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, PartialEq, Eq)]
enum AskFormState {
    Open,
    Submitting,
}

#[derive(Clone)]
struct PendingAskForm {
    definition: crate::agent_graph::ask_form::AskFormInput,
    state: AskFormState,
    created_at: Instant,
}

/// Rendered-but-unanswered AskForm definitions, keyed by form_id. IM cards
/// are stateless on the wire — the submit callback only returns raw field
/// values — so the definition is needed here to reconstruct semantic answers
/// (option labels for choices, number/rating validation for numeric fields).
static ASK_FORM_PENDING: Lazy<Mutex<HashMap<String, PendingAskForm>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn remove_from_completed_history(message_ids: &[String]) {
    if message_ids.is_empty() {
        return;
    }
    let mut history = COMPLETED_TURNS.lock().unwrap();
    for turns in history.values_mut() {
        for ids in turns.iter_mut() {
            ids.retain(|id| !message_ids.iter().any(|candidate| candidate == id));
        }
        turns.retain(|ids| !ids.is_empty());
    }
    history.retain(|_, turns| !turns.is_empty());
}

fn retain_completed_routes(
    project_id: &str,
    task_id: &str,
    session_id: &str,
    message_ids: &[String],
) -> Vec<MessageMapping> {
    let mut routes = Vec::new();
    {
        let mut mappings = MESSAGE_MAPPINGS.lock().unwrap();
        for id in message_ids {
            let Some(mapping) = mappings.get_mut(id) else {
                continue;
            };
            if mapping.project_id != project_id
                || mapping.task_id != task_id
                || mapping.session_id != session_id
            {
                continue;
            }
            routes.push((id.clone(), mapping.clone()));
            // The external status is cleared below, while the mapping itself
            // remains available for a late PermissionRequired/AskForm event.
            mapping.status = None;
        }
    }
    if routes.is_empty() {
        return Vec::new();
    }

    let retained_ids: Vec<String> = routes.iter().map(|(id, _)| id.clone()).collect();
    let key = (
        project_id.to_owned(),
        task_id.to_owned(),
        session_id.to_owned(),
    );
    let mut expired_ids = Vec::new();
    {
        let mut history = COMPLETED_TURNS.lock().unwrap();
        let turns = history.entry(key).or_default();
        turns.retain(|ids| !ids.iter().any(|id| retained_ids.contains(id)));
        turns.push_back(retained_ids);
        while turns.len() > COMPLETED_TURN_HISTORY_LIMIT {
            if let Some(ids) = turns.pop_front() {
                expired_ids.extend(ids);
            }
        }
    }
    if !expired_ids.is_empty() {
        let mut mappings = MESSAGE_MAPPINGS.lock().unwrap();
        for id in expired_ids {
            mappings.remove(&id);
        }
    }
    routes.into_iter().map(|(_, route)| route).collect()
}

pub fn shutdown(connection_id: &str) {
    let ids = {
        let mappings = MESSAGE_MAPPINGS.lock().unwrap();
        mappings
            .iter()
            .filter(|(_, mapping)| mapping.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    let removed = take_routes(&ids);
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

fn stash_ask_form(form_id: &str, definition: &crate::agent_graph::ask_form::AskFormInput) {
    let mut pending = ASK_FORM_PENDING.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, form| now.duration_since(form.created_at) < ASK_FORM_PENDING_TTL);
    // Bounded: drop the oldest entry when a flood of forms outlives their
    // answers. Terminal actions remove entries explicitly; the TTL handles
    // cards that are abandoned without a callback.
    if pending.len() >= ASK_FORM_PENDING_LIMIT {
        if let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, form)| form.created_at)
            .map(|(form_id, _)| form_id.clone())
        {
            pending.remove(&oldest);
        }
    }
    pending.insert(
        form_id.to_string(),
        PendingAskForm {
            definition: definition.clone(),
            state: AskFormState::Open,
            created_at: now,
        },
    );
}

fn open_ask_form_definition(
    form_id: &str,
) -> Result<Option<crate::agent_graph::ask_form::AskFormInput>, String> {
    let mut pending = ASK_FORM_PENDING.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, form| now.duration_since(form.created_at) < ASK_FORM_PENDING_TTL);
    let Some(form) = pending.get(form_id) else {
        return Ok(None);
    };
    if form.state == AskFormState::Submitting {
        return Err("This form is already being submitted.".into());
    }
    Ok(Some(form.definition.clone()))
}

/// Atomically claim a known form for delivery. Unknown forms are allowed to
/// use the restart-compatible raw-field fallback, but known forms can only be
/// submitted once at a time.
fn claim_ask_form(form_id: &str) -> Result<bool, String> {
    let mut pending = ASK_FORM_PENDING.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, form| now.duration_since(form.created_at) < ASK_FORM_PENDING_TTL);
    let Some(form) = pending.get_mut(form_id) else {
        return Ok(false);
    };
    if form.state == AskFormState::Submitting {
        return Err("This form is already being submitted.".into());
    }
    form.state = AskFormState::Submitting;
    Ok(true)
}

pub(crate) fn complete_ask_form(form_id: &str) {
    ASK_FORM_PENDING.lock().unwrap().remove(form_id);
}

pub(crate) fn reopen_ask_form(form_id: &str) {
    let mut pending = ASK_FORM_PENDING.lock().unwrap();
    if let Some(form) = pending.get_mut(form_id) {
        if form.state == AskFormState::Submitting {
            form.state = AskFormState::Open;
            form.created_at = Instant::now();
        }
    }
}

pub(crate) fn dismiss_ask_form(form_id: &str) {
    complete_ask_form(form_id);
}

pub(crate) fn pending_ask_form_card(form_id: &str) -> Option<CardSpec> {
    let mut pending = ASK_FORM_PENDING.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, form| now.duration_since(form.created_at) < ASK_FORM_PENDING_TTL);
    let form = pending.get(form_id)?;
    if form.state != AskFormState::Open {
        return None;
    }
    Some(CardSpec::AskForm(super::commands::AskFormCard {
        form_id: form_id.to_owned(),
        definition: form.definition.clone(),
    }))
}

/// Turn the raw IM-card field values of an AskForm back into semantic answer
/// text the agent can read: choice ids → labels, MultiChoice numeric picks
/// ("1,3") → labels, booleans → Yes/No, Number/Rating validated as numeric.
/// Falls back to the raw `field: value` dump when the definition is unknown
/// (e.g. Grove restarted between render and submit).
pub(crate) fn ask_form_response_text(
    form_id: &str,
    fields: &HashMap<String, String>,
) -> Result<String, String> {
    // Single-choice button fast path (answer carries the label directly).
    if let Some(answer) = fields
        .get("answer")
        .filter(|value| !value.trim().is_empty())
    {
        let _ = claim_ask_form(form_id)?;
        return Ok(format!("I choose option {answer} for form {form_id}."));
    }

    let definition = open_ask_form_definition(form_id)?;
    let Some(definition) = definition else {
        return Ok(raw_form_dump(form_id, fields));
    };

    let mut answers: Vec<String> = Vec::new();
    for question in &definition.questions {
        let Some(raw) = fields
            .get(question_id(question))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let title = question_title(question);
        let answer = semantic_answer(question, raw)?;
        answers.push(format!("{title}: {answer}"));
    }
    if answers.is_empty() {
        claim_ask_form(form_id)?;
        return Ok(format!(
            "I submitted form {form_id} without additional answers."
        ));
    }
    claim_ask_form(form_id)?;
    Ok(format!(
        "Here are my answers to form {form_id}:\n{}",
        answers.join("\n")
    ))
}

fn question_id(question: &crate::agent_graph::ask_form::FormQuestion) -> &str {
    match question {
        crate::agent_graph::ask_form::FormQuestion::SingleChoice { id, .. }
        | crate::agent_graph::ask_form::FormQuestion::MultiChoice { id, .. }
        | crate::agent_graph::ask_form::FormQuestion::Text { id, .. }
        | crate::agent_graph::ask_form::FormQuestion::Textarea { id, .. }
        | crate::agent_graph::ask_form::FormQuestion::Number { id, .. }
        | crate::agent_graph::ask_form::FormQuestion::Rating { id, .. }
        | crate::agent_graph::ask_form::FormQuestion::Boolean { id, .. } => id,
    }
}

fn question_title(question: &crate::agent_graph::ask_form::FormQuestion) -> &str {
    match question {
        crate::agent_graph::ask_form::FormQuestion::SingleChoice { title, .. }
        | crate::agent_graph::ask_form::FormQuestion::MultiChoice { title, .. }
        | crate::agent_graph::ask_form::FormQuestion::Text { title, .. }
        | crate::agent_graph::ask_form::FormQuestion::Textarea { title, .. }
        | crate::agent_graph::ask_form::FormQuestion::Number { title, .. }
        | crate::agent_graph::ask_form::FormQuestion::Rating { title, .. }
        | crate::agent_graph::ask_form::FormQuestion::Boolean { title, .. } => title,
    }
}

/// Map one raw field value to its human-readable answer per question type.
fn semantic_answer(
    question: &crate::agent_graph::ask_form::FormQuestion,
    raw: &str,
) -> Result<String, String> {
    use crate::agent_graph::ask_form::FormQuestion;
    match question {
        FormQuestion::SingleChoice { options, .. } => Ok(lookup_option_label(options, raw)),
        FormQuestion::MultiChoice { options, .. } => {
            let labels: Vec<String> = raw
                .split([',', ';', ' '])
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(|token| {
                    // Numeric tokens index the rendered option list (1-based);
                    // anything else is matched against labels verbatim.
                    match token.parse::<usize>() {
                        Ok(index) if index >= 1 && index <= options.len() => {
                            options[index - 1].label.clone()
                        }
                        _ => lookup_option_label(options, token),
                    }
                })
                .collect();
            if labels.is_empty() {
                return Err("Pick at least one option (e.g. \"1,3\").".into());
            }
            Ok(labels.join(", "))
        }
        FormQuestion::Number { .. } => match raw.parse::<f64>() {
            Ok(value) if value.fract() == 0.0 => Ok(format!("{}", value as i64)),
            Ok(value) => Ok(value.to_string()),
            Err(_) => Err(format!("\"{raw}\" is not a valid number.")),
        },
        FormQuestion::Rating { .. } => match raw.parse::<i64>() {
            Ok(value) => Ok(value.to_string()),
            Err(_) => Err(format!(
                "\"{raw}\" is not a valid rating — use a whole number."
            )),
        },
        FormQuestion::Boolean { .. } => Ok(match raw.to_ascii_lowercase().as_str() {
            "true" | "yes" => "Yes".to_string(),
            "false" | "no" => "No".to_string(),
            other => other.to_string(),
        }),
        FormQuestion::Text { .. } | FormQuestion::Textarea { .. } => Ok(raw.to_string()),
    }
}

fn lookup_option_label(
    options: &[crate::agent_graph::ask_form::FormOption],
    value: &str,
) -> String {
    options
        .iter()
        .find(|option| option.id == value || option.label == value)
        .map(|option| option.label.clone())
        .unwrap_or_else(|| value.to_string())
}

fn raw_form_dump(form_id: &str, fields: &HashMap<String, String>) -> String {
    let mut values: Vec<_> = fields
        .iter()
        .filter(|(name, value)| name.as_str() != "action" && !value.trim().is_empty())
        .collect();
    values.sort_by_key(|(name, _)| *name);
    if values.is_empty() {
        return format!("I submitted form {form_id} without additional answers.");
    }
    let answers = values
        .into_iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("Here are my answers to form {form_id}:\n{answers}")
}

pub fn pending_elicitation_card(connect: &Connect, request_id: &str) -> Option<CardSpec> {
    session_handle(connect)
        .ok()?
        .pending_turn_form(request_id)
        .map(form_card)
}

fn store_inbound_attachments(
    connect: &Connect,
    session_id: &str,
    attachments: Vec<InboundAttachment>,
) -> Result<Vec<ContentBlockData>, String> {
    let project = crate::storage::workspace::load_project_by_hash(&connect.project_id)
        .map_err(|error| error.to_string())?;
    let mut blocks = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let mime_type = attachment.mime_type.unwrap_or_else(|| {
            match attachment.kind {
                InboundAttachmentKind::Image => "image/png",
                InboundAttachmentKind::Audio => "audio/mpeg",
                InboundAttachmentKind::File => "application/octet-stream",
            }
            .to_owned()
        });
        let stored = if let Some(project) = project.as_ref() {
            if project.project_type == crate::storage::workspace::ProjectType::Studio {
                let input_dir = crate::storage::workspace::studio_project_dir(&project.path)
                    .join("tasks")
                    .join(&connect.task_id)
                    .join("input");
                crate::storage::chat_attachments::store_attachment_bytes_to_dir(
                    &input_dir,
                    &attachment.name,
                    Some(&mime_type),
                    &attachment.bytes,
                )
            } else {
                crate::storage::chat_attachments::store_attachment_bytes(
                    &connect.project_id,
                    &connect.task_id,
                    session_id,
                    &attachment.name,
                    Some(&mime_type),
                    &attachment.bytes,
                )
            }
        } else {
            crate::storage::chat_attachments::store_attachment_bytes(
                &connect.project_id,
                &connect.task_id,
                session_id,
                &attachment.name,
                Some(&mime_type),
                &attachment.bytes,
            )
        }
        .map_err(|error| error.to_string())?;

        match attachment.kind {
            InboundAttachmentKind::Image => blocks.push(ContentBlockData::Image {
                data: base64::engine::general_purpose::STANDARD.encode(&attachment.bytes),
                mime_type,
                uri: Some(stored.uri),
                label: Some(stored.name),
            }),
            InboundAttachmentKind::Audio => blocks.push(ContentBlockData::Audio {
                data: base64::engine::general_purpose::STANDARD.encode(&attachment.bytes),
                mime_type,
                label: Some(stored.name),
            }),
            InboundAttachmentKind::File => {
                let name = stored.name;
                blocks.push(ContentBlockData::ResourceLink {
                    uri: stored.uri,
                    name: name.clone(),
                    mime_type: stored.mime_type,
                    size: Some(stored.size),
                    title: Some(name.clone()),
                    description: Some("Feishu attachment".to_owned()),
                    label: Some(name),
                });
            }
        }
    }
    Ok(blocks)
}

pub async fn deliver_prompt(
    connect: Connect,
    adapter: AdapterRef,
    inbound: InboundMessage,
    text: String,
) -> Result<(), String> {
    if connect.project_id.is_empty() || connect.task_id.is_empty() {
        return Err(
            "This connection is not linked to a Grove task yet. Send /target to choose a target."
                .into(),
        );
    }
    let session_id = if connect.session_id.is_empty() {
        match create_session(&connect, None) {
            Ok(session_id) => session_id,
            Err(error) => return Err(format!("Grove Connect error: {error}")),
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
            return Err(format!("Grove Connect error: {error}"));
        }
    };
    let attachments = match store_inbound_attachments(&connect, &session_id, inbound.attachments) {
        Ok(attachments) => attachments,
        Err(error) => {
            adapter
                .clear_status(&inbound.external_message_id, &waiting)
                .await;
            return Err(format!("Grove Connect error: {error}"));
        }
    };
    let prompt = session.prepare_prompt(text, attachments, Some("connect".into()));
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
        return Err(format!("Grove Connect error: {error}"));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_graph::ask_form::{AskFormInput, FormQuestion};

    fn number_form() -> AskFormInput {
        AskFormInput {
            title: "Deploy".into(),
            description: None,
            questions: vec![FormQuestion::Number {
                id: "percentage".into(),
                title: "Percentage".into(),
                description: None,
            }],
        }
    }

    #[test]
    fn invalid_ask_form_response_keeps_form_open_for_retry() {
        let form_id = format!("test-form-{}", uuid::Uuid::new_v4());
        stash_ask_form(&form_id, &number_form());

        let fields = HashMap::from([(String::from("percentage"), String::from("not-a-number"))]);
        let error = ask_form_response_text(&form_id, &fields).expect_err("invalid number");
        assert!(error.contains("not a valid number"));
        assert!(pending_ask_form_card(&form_id).is_some());

        let fields = HashMap::from([(String::from("percentage"), String::from("80"))]);
        let text = ask_form_response_text(&form_id, &fields).expect("valid retry");
        assert!(text.contains("Percentage: 80"));
        assert!(pending_ask_form_card(&form_id).is_none());

        complete_ask_form(&form_id);
    }

    #[test]
    fn ask_form_submission_is_claimed_once_and_decline_cleans_up() {
        let form_id = format!("test-form-{}", uuid::Uuid::new_v4());
        stash_ask_form(&form_id, &number_form());

        let fields = HashMap::from([(String::from("percentage"), String::from("80"))]);
        ask_form_response_text(&form_id, &fields).expect("first submission");
        let error = ask_form_response_text(&form_id, &fields).expect_err("duplicate submission");
        assert!(error.contains("already being submitted"));
        complete_ask_form(&form_id);

        let declined_id = format!("test-form-{}", uuid::Uuid::new_v4());
        stash_ask_form(&declined_id, &number_form());
        dismiss_ask_form(&declined_id);
        assert!(pending_ask_form_card(&declined_id).is_none());
    }
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
    let removed = {
        let mut mappings = MESSAGE_MAPPINGS.lock().unwrap();
        message_ids
            .iter()
            .filter_map(|id| mappings.remove(id))
            .collect::<Vec<_>>()
    };
    remove_from_completed_history(message_ids);
    removed
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
        TurnEvent::AskFormRequired {
            form_id,
            definition,
        } => {
            let Some((_, route)) = routes(&message_ids).pop() else {
                return;
            };
            stash_ask_form(&form_id, &definition);
            let card = CardSpec::AskForm(super::commands::AskFormCard {
                form_id,
                definition,
            });
            if let Err(error) = route
                .adapter
                .reply_card(&route.external_message_id, &card)
                .await
            {
                eprintln!("[connect] failed to deliver ask form card: {error}");
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
                        let completed = retain_completed_routes(
                            &project_id,
                            &task_id,
                            &session_id,
                            &message_ids,
                        );
                        clear_routes(&completed).await;
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
            let ids = {
                let mappings = MESSAGE_MAPPINGS.lock().unwrap();
                mappings
                    .iter()
                    .filter(|(_, route)| {
                        route.project_id == project_id
                            && route.task_id == task_id
                            && route.session_id == session_id
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            };
            let routes = take_routes(&ids);
            clear_routes(&routes).await;
        }
    }
}
