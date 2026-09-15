use async_trait::async_trait;
use lark_channel::card::{Card, CardElement};
use lark_channel::lark_openapi::{
    OpenApiClient, OpenApiTransport, ReqwestOpenApiTransport, TokioTungsteniteWebSocketTransport,
    WebSocketEventAck,
};
use lark_channel::{
    ChannelConfig, ChannelEvent, Domain, EventLoop, EventLoopOptions, MessageChatType, MessageId,
    MessageSender, OpenApiWebSocketEventConnector, ReceivedEvent,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::storage::connects::Connect;

use super::adapter::{
    ActionResult, AdapterRef, ConnectAdapter, ConnectionStatus, InboundAction, InboundMessage,
    NoticeLevel,
};
use super::commands::{
    AgentOption, CardSpec, ConfigCard, ElicitationCard, ElicitationFieldKind, PermissionCard,
    TargetCard,
};

static CONNECTIONS: once_cell::sync::Lazy<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static STATUSES: once_cell::sync::Lazy<Mutex<HashMap<String, ConnectionStatus>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn set_status(id: &str, state: &str, detail: Option<String>) {
    STATUSES.lock().unwrap().insert(
        id.to_owned(),
        ConnectionStatus {
            state: state.to_owned(),
            detail,
        },
    );
}

const RECONNECT_COUNT_KEY: &str = "reconnect_count";
const RECONNECT_INTERVAL_KEY: &str = "reconnect_interval_secs";
const HEARTBEAT_TIMEOUT_KEY: &str = "heartbeat_timeout_secs";

fn optional_integer(value: &Value, key: &str) -> Result<Option<i64>, String> {
    let Some(raw) = value.get(key) else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    if let Some(text) = raw.as_str() {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        return text
            .parse::<i64>()
            .map(Some)
            .map_err(|_| format!("adapter_config.{key} must be an integer"));
    }
    raw.as_i64()
        .map(Some)
        .ok_or_else(|| format!("adapter_config.{key} must be an integer"))
}

fn validate_transport_config(value: &Value) -> Result<(), String> {
    let reconnect_count = optional_integer(value, RECONNECT_COUNT_KEY)?;
    if reconnect_count.is_some_and(|count| count < -1) {
        return Err(format!(
            "adapter_config.{RECONNECT_COUNT_KEY} must be -1 or greater"
        ));
    }
    for key in [RECONNECT_INTERVAL_KEY, HEARTBEAT_TIMEOUT_KEY] {
        if optional_integer(value, key)?.is_some_and(|seconds| seconds <= 0) {
            return Err(format!("adapter_config.{key} must be greater than 0"));
        }
    }
    Ok(())
}

fn event_loop_options(value: &Value) -> Result<EventLoopOptions, String> {
    validate_transport_config(value)?;
    let reconnect_count = optional_integer(value, RECONNECT_COUNT_KEY)?;
    let reconnect_interval = optional_integer(value, RECONNECT_INTERVAL_KEY)?;
    let heartbeat_timeout = optional_integer(value, HEARTBEAT_TIMEOUT_KEY)?;

    let mut options = EventLoopOptions::new();
    if reconnect_count.is_some() || reconnect_interval.is_some() {
        // Explicit local reconnect settings opt out of the server-provided
        // policy. Keep the other value aligned with the Feishu SDK default.
        options = match reconnect_count.unwrap_or(-1) {
            -1 => options.with_unlimited_reconnects(),
            count => options.with_max_reconnects(count as usize),
        };
        options = options
            .with_reconnect_delay(Duration::from_secs(reconnect_interval.unwrap_or(120) as u64));
    }
    if let Some(seconds) = heartbeat_timeout {
        options = options.with_heartbeat_timeout(Some(Duration::from_secs(seconds as u64)));
    }
    Ok(options)
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use lark_channel::EventReconnectLimit;

    #[test]
    fn empty_config_keeps_server_reconnect_policy_and_default_heartbeat() {
        let options = event_loop_options(&json!({})).unwrap();

        assert!(options.use_server_reconnect_config());
        assert_eq!(options.reconnect_limit(), EventReconnectLimit::Limited(3));
        assert_eq!(options.reconnect_delay(), Duration::from_secs(1));
        assert_eq!(options.heartbeat_timeout(), None);
    }

    #[test]
    fn custom_config_overrides_reconnect_and_heartbeat_defaults() {
        let options = event_loop_options(&json!({
            RECONNECT_COUNT_KEY: 4,
            RECONNECT_INTERVAL_KEY: "20",
            HEARTBEAT_TIMEOUT_KEY: 300,
        }))
        .unwrap();

        assert!(!options.use_server_reconnect_config());
        assert_eq!(options.reconnect_limit(), EventReconnectLimit::Limited(4));
        assert_eq!(options.reconnect_delay(), Duration::from_secs(20));
        assert_eq!(options.heartbeat_timeout(), Some(Duration::from_secs(300)));
    }

    #[test]
    fn negative_or_zero_transport_values_are_rejected() {
        assert!(event_loop_options(&json!({ RECONNECT_COUNT_KEY: -2 })).is_err());
        assert!(event_loop_options(&json!({ RECONNECT_INTERVAL_KEY: 0 })).is_err());
        assert!(event_loop_options(&json!({ HEARTBEAT_TIMEOUT_KEY: 0 })).is_err());
    }
}

pub fn statuses() -> HashMap<String, ConnectionStatus> {
    STATUSES.lock().unwrap().clone()
}

pub fn stop(id: &str) {
    if let Some(task) = CONNECTIONS.lock().unwrap().remove(id) {
        task.abort();
    }
    STATUSES.lock().unwrap().remove(id);
}

pub fn start(connect: Connect) {
    stop(&connect.id);
    if !connect.enabled {
        return;
    }
    let id = connect.id.clone();
    let task = tokio::spawn(async move {
        let (app_id, app_secret) = match credentials(&connect.adapter_config) {
            Ok(credentials) => credentials,
            Err(error) => {
                set_status(&connect.id, "error", Some(error));
                return;
            }
        };
        if app_id.is_empty() || app_secret.is_empty() {
            set_status(
                &connect.id,
                "error",
                Some("Missing Feishu App ID or App Secret".into()),
            );
            return;
        }
        set_status(&connect.id, "connecting", None);
        let mut config = ChannelConfig::new(app_id, app_secret);
        config.domain = if connect.domain == "lark" {
            Domain::Lark
        } else {
            Domain::Feishu
        };
        let openapi = OpenApiClient::new(config, ReqwestOpenApiTransport::new());
        if let Err(error) = openapi.tenant_access_token().await {
            set_status(&connect.id, "error", Some(error.to_string()));
            return;
        }
        let adapter = Arc::new(FeishuAdapter::new(openapi.clone()));
        let connector =
            OpenApiWebSocketEventConnector::new(openapi, TokioTungsteniteWebSocketTransport::new());
        let options = match event_loop_options(&connect.adapter_config) {
            Ok(options) => options,
            Err(error) => {
                set_status(&connect.id, "error", Some(error));
                return;
            }
        };
        let mut event_loop = EventLoop::with_options(connector, options);
        set_status(&connect.id, "online", None);
        let connection_id = connect.id.clone();
        let outcome = event_loop
            .run(move |event| {
                let connection_id = connection_id.clone();
                let adapter = adapter.clone();
                async move { handle_event(connection_id, adapter, event).await }
            })
            .await;
        match outcome {
            Ok(exit) => set_status(
                &connect.id,
                "offline",
                Some(format!("Event stream stopped ({exit:?}); retry manually")),
            ),
            Err(error) => set_status(&connect.id, "error", Some(error.to_string())),
        }
    });
    CONNECTIONS.lock().unwrap().insert(id, task);
}

pub fn validate_config(domain: &str, value: &Value, existing: bool) -> Result<(), String> {
    if !matches!(domain, "feishu" | "lark") {
        return Err("domain must be feishu or lark".into());
    }
    let (app_id, app_secret) = credentials(value)?;
    if app_id.trim().is_empty() {
        return Err("adapter_config.app_id is required".into());
    }
    if !existing && app_secret.trim().is_empty() {
        return Err("adapter_config.app_secret is required".into());
    }
    validate_transport_config(value)?;
    Ok(())
}

pub fn public_config(domain: &str, value: &Value) -> Value {
    let app_id = value
        .get("app_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut public = json!({
        "domain": domain,
        "app_id": app_id,
        "has_app_secret": value.get("app_secret").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
    });
    if let Some(object) = public.as_object_mut() {
        for key in [
            RECONNECT_COUNT_KEY,
            RECONNECT_INTERVAL_KEY,
            HEARTBEAT_TIMEOUT_KEY,
        ] {
            if let Some(config) = value.get(key) {
                object.insert(key.to_owned(), config.clone());
            }
        }
    }
    public
}

pub async fn verify_config(domain: &str, value: &Value) -> Result<(), String> {
    validate_config(domain, value, false)?;
    let (app_id, app_secret) = credentials(value)?;
    let mut config = ChannelConfig::new(app_id, app_secret);
    config.domain = if domain == "lark" {
        Domain::Lark
    } else {
        Domain::Feishu
    };
    OpenApiClient::new(config, ReqwestOpenApiTransport::new())
        .tenant_access_token()
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn credentials(value: &Value) -> Result<(String, String), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "adapter_config must be a JSON object".to_owned())?;
    let app_id = object
        .get("app_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let app_secret = object
        .get("app_secret")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok((app_id, app_secret))
}

async fn handle_event<T>(
    connection_id: String,
    adapter: Arc<FeishuAdapter<T>>,
    event: ReceivedEvent,
) -> lark_channel::Result<WebSocketEventAck>
where
    T: OpenApiTransport + Clone + Send + Sync + 'static,
{
    match event.event {
        ChannelEvent::Message(message) => {
            if message.chat_type != MessageChatType::P2p || message.text.trim().is_empty() {
                return Ok(WebSocketEventAck::ok());
            }
            let inbound = InboundMessage {
                external_message_id: message.message_id,
                conversation_id: message.chat_id,
                sender_id: message.sender_id,
                text: message.text.trim().to_owned(),
            };
            tokio::spawn(async move {
                let adapter: AdapterRef = adapter;
                super::core::handle_message(&connection_id, adapter, inbound).await;
            });
            Ok(WebSocketEventAck::ok())
        }
        ChannelEvent::CardAction(action) => {
            let action = *action;
            let callback_token = action.token.clone();
            let fields = action
                .action
                .form_value
                .unwrap_or(Value::Null)
                .as_object()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_owned()))
                        })
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default();
            let mut fields = fields;
            if let Some(values) = action.action.value.as_object() {
                for (key, value) in values {
                    if key != "action" {
                        if let Some(value) = value.as_str() {
                            fields.insert(key.clone(), value.to_owned());
                        }
                    }
                }
            }
            let name = action
                .action
                .value
                .get("action")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(action.action.name);
            let inbound = InboundAction {
                conversation_id: action
                    .card_context
                    .clone()
                    .and_then(|context| context.open_chat_id)
                    .unwrap_or_default(),
                sender_id: action.operator.open_id.unwrap_or_default(),
                source_message_id: action
                    .card_context
                    .and_then(|context| context.open_message_id),
                name,
                fields,
            };
            // Feishu requires callback ACKs quickly. Core work can include
            // SQLite reads or an ACP request, so acknowledge first and use
            // the callback token to update the original card afterwards.
            let core_adapter: AdapterRef = adapter.clone();
            tokio::spawn(async move {
                let result = super::core::handle_action(&connection_id, core_adapter, inbound)
                    .await
                    .unwrap_or_else(|error| ActionResult::notice(error, NoticeLevel::Error));
                if let Err(error) = adapter
                    .apply_action_result(callback_token.as_deref(), result)
                    .await
                {
                    eprintln!("[connect] failed to apply Feishu card action result: {error}");
                }
            });
            Ok(WebSocketEventAck::ok())
        }
        ChannelEvent::Unknown { .. } => Ok(WebSocketEventAck::ok()),
    }
}

#[derive(Clone)]
pub struct FeishuAdapter<T> {
    openapi: OpenApiClient<T>,
    sender: MessageSender<T>,
}

impl<T: OpenApiTransport> FeishuAdapter<T> {
    pub fn new(openapi: OpenApiClient<T>) -> Self {
        Self {
            sender: MessageSender::new(openapi.clone()),
            openapi,
        }
    }

    async fn apply_action_result(
        &self,
        callback_token: Option<&str>,
        result: ActionResult,
    ) -> Result<(), String> {
        let ActionResult { card, notice } = result;
        let Some(spec) = card else {
            return Ok(());
        };
        let token = callback_token.ok_or_else(|| {
            "Feishu card callback did not include a token for asynchronous update".to_owned()
        })?;
        let mut card = render_card(&spec)?;
        if !matches!(spec, CardSpec::Notice(_)) {
            if let Some((level, text)) = notice {
                let prefix = match level {
                    NoticeLevel::Info => "ℹ️",
                    NoticeLevel::Success => "✅",
                    NoticeLevel::Warning => "⚠️",
                    NoticeLevel::Error => "❌",
                };
                let mut value = card.into_value();
                let elements = value
                    .pointer_mut("/body/elements")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "rendered card has no body elements".to_owned())?;
                elements.insert(
                    0,
                    json!({
                        "tag": "markdown",
                        "content": format!("{prefix} {text}"),
                    }),
                );
                card = Card::from_value(value).map_err(|error| error.to_string())?;
            }
        }
        self.openapi
            .update_message_card_with_callback_token(token, &card)
            .await
            .map_err(|error| error.to_string())
    }

    async fn add_reaction(&self, message_id: &str, emoji_type: &str) -> Option<String> {
        let path = format!("/open-apis/im/v1/messages/{message_id}/reactions");
        let response: Value = self
            .openapi
            .post_tenant_json(
                &path,
                &json!({
                    "reaction_type": { "emoji_type": emoji_type }
                }),
            )
            .await
            .ok()?;
        response
            .pointer("/data/reaction_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    async fn delete_reaction_once(
        &self,
        message_id: &str,
        reaction_id: &str,
    ) -> Result<(), String> {
        let Ok(token) = self.openapi.tenant_access_token().await else {
            return Err("failed to obtain tenant token for reaction cleanup".into());
        };
        let Ok(url) = self.openapi.config().base_url().join(&format!(
            "/open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}"
        )) else {
            return Err("failed to build reaction cleanup URL".into());
        };
        let response = reqwest::Client::new()
            .delete(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("reaction cleanup returned HTTP {status}"));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("invalid reaction cleanup response: {error}"))?;
        match body.get("code").and_then(Value::as_i64) {
            None | Some(0) => Ok(()),
            Some(code) => Err(format!(
                "reaction cleanup returned code {code}: {}",
                body.get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            )),
        }
    }

    async fn delete_reaction(&self, message_id: &str, reaction_id: &str) {
        if let Err(first) = self.delete_reaction_once(message_id, reaction_id).await {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if let Err(second) = self.delete_reaction_once(message_id, reaction_id).await {
                eprintln!(
                    "[connect] failed to clear reaction {reaction_id} from {message_id}: {first}; retry: {second}"
                );
            }
        }
    }
}

/// Renders a platform-neutral card spec into a CardKit 2.0 card. Form data
/// comes back through `card.action.trigger` as `action.form_value` keyed by
/// the select elements' `name` fields.
pub(crate) fn render_card(spec: &CardSpec) -> Result<Card, String> {
    match spec {
        CardSpec::Notice(text) => render_notice(text),
        CardSpec::NewSession { agents, current } => {
            let mut builder = Card::builder()
                .header("New session")
                .markdown("Pick the agent for the new session, then submit.");
            builder = builder.element(form(
                "new_session_form",
                vec![select(
                    "agent",
                    "Agent",
                    true,
                    current.as_deref(),
                    options(agents),
                )],
                &[("new_session_btn", "Create session", true)],
            ));
            builder.build().map_err(|error| error.to_string())
        }
        CardSpec::Target(target) => render_target(target),
        CardSpec::Config(config) => render_config(config),
        CardSpec::Permission(permission) => render_permission(permission),
        CardSpec::Elicitation(elicitation) => render_elicitation(elicitation),
        CardSpec::AskForm(form) => render_ask_form(form),
    }
}

fn render_permission(permission: &PermissionCard) -> Result<Card, String> {
    let mut builder = Card::builder()
        .header("Permission required")
        .markdown(permission.description.clone());
    for option in &permission.options {
        let primary = option.kind.starts_with("allow");
        builder = builder.element(action_button(
            &option.label,
            primary,
            json!({
                "action": "permission",
                "request_id": permission.request_id,
                "option_id": option.id,
            }),
        ));
    }
    builder.build().map_err(|error| error.to_string())
}

fn render_elicitation(elicitation: &ElicitationCard) -> Result<Card, String> {
    let mut elements = vec![CardElement::markdown(elicitation.message.clone())];
    for field in &elicitation.fields {
        if let Some(description) = &field.description {
            elements.push(CardElement::markdown(format!(
                "**{}**\n{}",
                field.label, description
            )));
        }
        let element = match field.kind {
            ElicitationFieldKind::Boolean => select(
                &field.name,
                &field.label,
                field.required,
                None,
                vec![
                    AgentOption {
                        id: "true".into(),
                        name: "Yes".into(),
                    },
                    AgentOption {
                        id: "false".into(),
                        name: "No".into(),
                    },
                ],
            ),
            _ if !field.options.is_empty() => select(
                &field.name,
                &field.label,
                field.required,
                None,
                field
                    .options
                    .iter()
                    .map(|(id, label)| AgentOption {
                        id: id.clone(),
                        name: label.clone(),
                    })
                    .collect(),
            ),
            _ => text_input(&field.name, &field.label, field.required),
        };
        elements.push(element);
    }
    Card::builder()
        .header("Input required")
        .element(form(
            "elicitation_form",
            elements,
            &[(
                &format!("elicitation_submit:{}", elicitation.request_id),
                "Submit",
                true,
            )],
        ))
        .element(action_button(
            "Decline",
            false,
            json!({ "action": format!("elicitation_decline:{}", elicitation.request_id) }),
        ))
        .build()
        .map_err(|error| error.to_string())
}

fn render_ask_form(ask_form: &super::commands::AskFormCard) -> Result<Card, String> {
    use crate::agent_graph::ask_form::FormQuestion;

    let mut builder = Card::builder().header(ask_form.definition.title.clone());
    if let Some(description) = &ask_form.definition.description {
        builder = builder.element(CardElement::markdown(description.clone()));
    }

    // A one-question choice is the common confirmation flow (for example
    // “Implement this plan?”). Render it as direct action buttons so the
    // answer is one tap and the card stays compact.
    if ask_form.definition.questions.len() == 1 {
        if let FormQuestion::SingleChoice {
            options,
            description,
            ..
        } = &ask_form.definition.questions[0]
        {
            if let Some(description) = description {
                builder = builder.element(CardElement::markdown(description.clone()));
            }
            for option in options {
                // The label (not the id) rides on the action — the answer text
                // the agent reads should name the choice the user tapped.
                builder = builder.element(action_button(
                    &option.label,
                    true,
                    json!({
                        "action": format!("ask_form_submit:{}", ask_form.form_id),
                        "answer": option.label,
                    }),
                ));
            }
            builder = builder.element(action_button(
                "Dismiss",
                false,
                json!({ "action": format!("ask_form_decline:{}", ask_form.form_id) }),
            ));
            return builder.build().map_err(|error| error.to_string());
        }
    }

    // IM cards are plain input/select primitives — the semantic half of each
    // question lives in the markdown block above the field: title,
    // description, and for MultiChoice a numbered option list the user picks
    // from by number ("1,3"). `ask_form_response_text` maps the numbers back
    // to labels on submit.
    let mut elements: Vec<CardElement> = Vec::new();
    for question in &ask_form.definition.questions {
        let element = match question {
            FormQuestion::SingleChoice {
                id,
                title,
                description,
                options,
            } => {
                elements.extend(question_intro(title, description.as_deref(), None));
                select(
                    id,
                    title,
                    false,
                    None,
                    options
                        .iter()
                        .map(|option| AgentOption {
                            id: option.id.clone(),
                            name: option.label.clone(),
                        })
                        .collect(),
                )
            }
            FormQuestion::MultiChoice {
                id,
                title,
                description,
                options,
            } => {
                let listing = options
                    .iter()
                    .enumerate()
                    .map(|(index, option)| match &option.description {
                        Some(extra) => format!("{}. **{}** — {}", index + 1, option.label, extra),
                        None => format!("{}. **{}**", index + 1, option.label),
                    })
                    .collect::<Vec<_>>()
                    .join("  \n");
                elements.extend(question_intro(title, description.as_deref(), Some(listing)));
                text_input(id, "Pick numbers, e.g. 1,3", false)
            }
            FormQuestion::Text {
                id,
                title,
                description,
            } => {
                elements.extend(question_intro(title, description.as_deref(), None));
                text_input(id, "Your answer", false)
            }
            FormQuestion::Textarea {
                id,
                title,
                description,
            } => {
                elements.extend(question_intro(title, description.as_deref(), None));
                text_input(id, "Your answer", false)
            }
            FormQuestion::Number {
                id,
                title,
                description,
            } => {
                elements.extend(question_intro(title, description.as_deref(), None));
                text_input(id, "A number, e.g. 42", false)
            }
            FormQuestion::Rating {
                id,
                title,
                description,
            } => {
                elements.extend(question_intro(title, description.as_deref(), None));
                text_input(id, "A whole number", false)
            }
            FormQuestion::Boolean {
                id,
                title,
                description,
            } => {
                elements.extend(question_intro(title, description.as_deref(), None));
                select(
                    id,
                    title,
                    false,
                    None,
                    vec![
                        AgentOption {
                            id: "true".into(),
                            name: "Yes".into(),
                        },
                        AgentOption {
                            id: "false".into(),
                            name: "No".into(),
                        },
                    ],
                )
            }
        };
        elements.push(element);
    }
    let elements = elements;
    builder = builder.element(form(
        "ask_form",
        elements,
        &[
            (
                &format!("ask_form_submit:{}", ask_form.form_id),
                "Submit",
                true,
            ),
            (
                &format!("ask_form_decline:{}", ask_form.form_id),
                "Dismiss",
                false,
            ),
        ],
    ));
    builder.build().map_err(|error| error.to_string())
}

fn action_button(label: &str, primary: bool, value: Value) -> CardElement {
    CardElement::raw(json!({
        "tag": "button",
        "text": { "tag": "plain_text", "content": label },
        "type": if primary { "primary_filled" } else { "default" },
        "behaviors": [{ "type": "callback", "value": value }],
    }))
    .expect("action button")
}

fn text_input(name: &str, placeholder: &str, required: bool) -> CardElement {
    CardElement::raw(json!({
        "tag": "input",
        "name": name,
        "placeholder": { "tag": "plain_text", "content": placeholder },
        "required": required,
    }))
    .expect("input element")
}

/// Markdown preamble for an AskForm question: bold title, description, and
/// (for MultiChoice) the numbered option list. Feishu inputs carry no label
/// element, so the question's semantics live in this block.
fn question_intro(
    title: &str,
    description: Option<&str>,
    listing: Option<String>,
) -> std::iter::Once<CardElement> {
    let mut parts = vec![format!("**{title}**")];
    if let Some(description) = description.map(str::trim).filter(|d| !d.is_empty()) {
        parts.push(description.to_string());
    }
    if let Some(listing) = listing {
        parts.push(listing);
    }
    std::iter::once(CardElement::markdown(parts.join("\n")))
}

fn render_notice(text: &str) -> Result<Card, String> {
    Card::builder()
        .header("Grove Connect")
        .markdown(text.to_owned())
        .build()
        .map_err(|error| error.to_string())
}

/// Auto New is a Session-level concept only (first message creates it) and
/// leads the session dropdown. Two form submit buttons: "Update options"
/// re-renders the card with child lists matching the picked project/task
/// (the callback ACK replaces the card in place), "Save target" applies the
/// selection. Everything rides on the form submit callback — no dependency
/// on select-change callbacks.
fn render_target(target: &TargetCard) -> Result<Card, String> {
    let project_options: Vec<AgentOption> = target
        .projects
        .iter()
        .map(|project| AgentOption {
            id: project.id.clone(),
            name: project.name.clone(),
        })
        .chain([AgentOption {
            id: String::new(),
            name: "Not routed".to_owned(),
        }])
        .collect();
    let task_options: Vec<AgentOption> = target
        .tasks
        .iter()
        .map(|task| AgentOption {
            id: task.id.clone(),
            name: task.name.clone(),
        })
        .collect();
    let session_options: Vec<AgentOption> = std::iter::once(AgentOption {
        id: String::new(),
        name: "Auto New (created on first message)".to_owned(),
    })
    .chain(target.sessions.iter().map(|session| AgentOption {
        id: session.id.clone(),
        name: session.name.clone(),
    }))
    .collect();
    let form_element = form(
        "target_form",
        vec![
            CardElement::markdown(
                "Pick a project and a task, then an existing session — or Auto New to create one on the first message.\n\
                 After changing a project or task, press **Update options** to refresh the lists.",
            ),
            select(
                "project",
                "Project",
                false,
                Some(&target.project_id),
                project_options,
            ),
            select("task", "Task", false, Some(&target.task_id), task_options),
            select(
                "session",
                "Session",
                false,
                Some(&target.session_id),
                session_options,
            ),
        ],
        &[
            ("update_options_btn", "Update options", false),
            ("save_target_btn", "Save target", true),
        ],
    );
    Card::builder()
        .header("Routing target")
        .element(form_element)
        .build()
        .map_err(|error| error.to_string())
}

/// A form submit button — form buttons identify themselves to the callback
/// by `name` and must not carry `behaviors`.
fn submit_button(name: &str, label: &str, primary: bool) -> Value {
    json!({
        "tag": "button",
        "text": { "tag": "plain_text", "content": label },
        "type": if primary { "primary_filled" } else { "default" },
        "name": name,
        "form_action_type": "submit",
    })
}

/// Renders the live session's config options (mode / model / effort / …) as
/// one dropdown each, preselected with the current value. Field names are
/// positional ("opt_0"…) and map back to the handle's selector list on
/// submit.
fn render_config(config: &ConfigCard) -> Result<Card, String> {
    let elements = config
        .selectors
        .iter()
        .map(|selector| {
            let options = selector
                .options
                .iter()
                .map(|(value, label)| AgentOption {
                    id: value.clone(),
                    name: label.clone(),
                })
                .collect();
            select(
                &selector.name,
                &selector.label,
                false,
                selector.current.as_deref(),
                options,
            )
        })
        .collect();
    Card::builder()
        .header("Session config")
        .element(form(
            "config_form",
            elements,
            &[("save_config_btn", "Apply", true)],
        ))
        .build()
        .map_err(|error| error.to_string())
}

/// Assembles a CardKit 2.0 form. Submit buttons identify themselves to the
/// callback by `name` — form buttons carry no `behaviors`/`value`; the form
/// data arrives as `action.form_value` keyed by element name.
fn form(name: &str, elements: Vec<CardElement>, submits: &[(&str, &str, bool)]) -> CardElement {
    let mut children: Vec<Value> = elements
        .into_iter()
        .map(|element| element.into_value())
        .collect();
    for (submit_name, label, primary) in submits {
        children.push(submit_button(submit_name, label, *primary));
    }
    CardElement::raw(json!({
        "tag": "form",
        "name": name,
        "elements": children,
    }))
    .expect("form element")
}

fn select(
    name: &str,
    placeholder: &str,
    required: bool,
    initial: Option<&str>,
    options: Vec<AgentOption>,
) -> CardElement {
    let options: Vec<Value> = options
        .into_iter()
        .map(|option| {
            json!({
                "text": { "tag": "plain_text", "content": option.name },
                "value": option.id,
            })
        })
        .collect();
    let mut element = json!({
        "tag": "select_static",
        "name": name,
        "placeholder": { "tag": "plain_text", "content": placeholder },
        "required": required,
        "options": options,
    });
    if let Some(initial) = initial {
        // Must equal one of the options' value to take effect.
        element["initial_option"] = Value::String(initial.to_owned());
    }
    CardElement::raw(element).expect("select element")
}

fn options(agents: &[AgentOption]) -> Vec<AgentOption> {
    agents.to_vec()
}

#[async_trait]
impl<T> ConnectAdapter for FeishuAdapter<T>
where
    T: OpenApiTransport + Clone + Send + Sync + 'static,
{
    async fn mark_waiting(&self, message_id: &str) -> Option<String> {
        self.add_reaction(message_id, "OneSecond").await
    }

    async fn mark_working(&self, message_id: &str, waiting: &Option<String>) -> Option<String> {
        if let Some(id) = waiting {
            self.delete_reaction(message_id, id).await;
        }
        self.add_reaction(message_id, "OnIt").await
    }

    async fn clear_status(&self, message_id: &str, receipt: &Option<String>) {
        if let Some(id) = receipt {
            self.delete_reaction(message_id, id).await;
        }
    }

    async fn reply_text(&self, message_id: &str, text: &str) -> Result<(), String> {
        self.sender
            .text_reply(MessageId(message_id.to_owned()), text.to_owned())
            // Transient Feishu API hiccups should not silently drop the
            // agent's answer.
            .max_attempts(3)
            .send()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn reply_card(&self, message_id: &str, spec: &CardSpec) -> Result<(), String> {
        let card = render_card(spec)?;
        let content =
            serde_json::to_string(&card.into_value()).map_err(|error| error.to_string())?;
        // The reply endpoint — receive_id_type on the send endpoint has no
        // "message_id" option (only open_id/user_id/union_id/email/chat_id).
        let payload = json!({
            "msg_type": "interactive",
            "content": content,
        });
        let Ok(token) = self.openapi.tenant_access_token().await else {
            return Err("failed to obtain tenant token for card send".into());
        };
        let Ok(url) = self
            .openapi
            .config()
            .base_url()
            .join(&format!("/open-apis/im/v1/messages/{message_id}/reply"))
        else {
            return Err("failed to build card send URL".into());
        };
        let response = reqwest::Client::new()
            .post(url)
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("invalid card send response (HTTP {status}): {error}"))?;
        let code = body.get("code").and_then(Value::as_i64);
        if status.is_success() && code.is_none_or(|code| code == 0) {
            return Ok(());
        }
        // The SDK's own error type drops the response body; going raw keeps
        // Feishu's validation message (the actual reason a card was rejected)
        // visible in the IM error reply and the logs.
        eprintln!("[connect] card send rejected (HTTP {status}): payload={content} body={body}");
        Err(format!(
            "card send failed (HTTP {status}): {}",
            body.get("msg")
                .and_then(Value::as_str)
                .unwrap_or(&body.to_string())
        ))
    }
}
