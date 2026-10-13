//! Built-in personal WeChat/iLink adapter. All WeChat presentation stays here.
mod api;
mod interaction;
mod registration;
mod state;

use crate::{
    connect::{
        adapter::{
            AdapterRef, ConnectAdapter, ConnectionStatus, InboundAction, InboundMessage, Platform,
        },
        commands::CardSpec,
        platform::{ConfigField, PlatformCapabilities, PlatformDefinition},
        registration::RegistrationView,
    },
    storage::connects::Connect,
};
use api::{Api, BASE_URL};
use async_trait::async_trait;
use interaction::Response;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use state::{Message, Store};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct WeixinPlatform;
pub static PLATFORM: WeixinPlatform = WeixinPlatform;
struct Runtime {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
static CONNECTIONS: Lazy<Mutex<HashMap<String, Runtime>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static STATUSES: Lazy<Mutex<HashMap<String, ConnectionStatus>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn status(id: &str, state: &str, detail: Option<String>) {
    STATUSES.lock().unwrap().insert(
        id.into(),
        ConnectionStatus {
            state: state.into(),
            detail,
        },
    );
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn scope(connection: &Connect) -> String {
    format!(
        "{}\0{}\0{}",
        connection.project_id, connection.task_id, connection.session_id
    )
}

pub fn validate_config(domain: &str, config: &Value, existing: bool) -> Result<(), String> {
    if domain != "weixin" {
        return Err("WeChat domain must be weixin".into());
    }
    if !config.is_object() {
        return Err("adapter_config must be a JSON object".into());
    }
    for key in ["bot_token", "bot_id", "user_id"] {
        if text(config, key).trim().is_empty() && !(existing && key == "bot_token") {
            return Err(format!("WeChat {key} is required"));
        }
    }
    api::validated_base(config["base_url"].as_str().unwrap_or(BASE_URL))?;
    Ok(())
}

impl Platform for WeixinPlatform {
    fn definitions(&self) -> Vec<PlatformDefinition> {
        vec![PlatformDefinition {
            id: "weixin".into(),
            name: "WeChat".into(),
            description: "Personal WeChat via ClawBot".into(),
            available: true,
            setup_modes: vec!["qr".into(), "manual".into()],
            config_fields: [
                ("bot_token", "Bot token", true),
                ("bot_id", "Bot ID", false),
                ("user_id", "Authorizing user ID", false),
            ]
            .into_iter()
            .map(|(key, label, secret)| ConfigField {
                key: key.into(),
                label: label.into(),
                secret,
                required: true,
                placeholder: String::new(),
            })
            .collect(),
            capabilities: PlatformCapabilities {
                private_chat: true,
                qr_registration: true,
                ..Default::default()
            },
        }]
    }
    fn validate_config(&self, domain: &str, config: &Value, existing: bool) -> Result<(), String> {
        validate_config(domain, config, existing)
    }
    fn merge_config(
        &self,
        _domain: &str,
        current: Option<&Value>,
        incoming: &Value,
    ) -> Result<Value, String> {
        let mut merged = current.cloned().unwrap_or_else(|| json!({}));
        let target = merged
            .as_object_mut()
            .ok_or("adapter_config must be an object")?;
        for (key, value) in incoming
            .as_object()
            .ok_or("adapter_config must be an object")?
        {
            if key != "bot_token" || value.as_str().is_some_and(|value| !value.is_empty()) {
                target.insert(key.clone(), value.clone());
            }
        }
        Ok(merged)
    }
    fn public_config(&self, _domain: &str, config: &Value) -> Value {
        let mut public = config.clone();
        if let Some(object) = public.as_object_mut() {
            object.remove("bot_token");
        }
        public
    }
    fn start(&self, connection: Connect) {
        start(connection);
    }
    fn stop(&self, id: &str) {
        stop(id);
    }
    fn statuses(&self) -> HashMap<String, ConnectionStatus> {
        STATUSES.lock().unwrap().clone()
    }
    fn begin_registration<'a>(
        &'a self,
        _platform: &'a str,
        _domain: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<RegistrationView, String>> {
        Box::pin(registration::begin())
    }
    fn registration_status(&self, id: &str) -> Option<RegistrationView> {
        registration::get(id)
    }
    fn claim_registration(&self, id: &str) -> Option<(String, Value, String, String)> {
        registration::claim(id)
    }
    fn release_registration(&self, id: &str) {
        registration::release(id);
    }
    fn finish_registration(&self, id: &str) {
        registration::finish(id);
    }
    fn submit_registration<'a>(
        &'a self,
        id: &'a str,
        input: Value,
    ) -> futures::future::BoxFuture<'a, Result<RegistrationView, String>> {
        Box::pin(async move { registration::submit(id, input) })
    }
    fn verify_config<'a>(
        &'a self,
        domain: &'a str,
        config: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            validate_config(domain, config, false)?;
            let api = Api::new(
                config["base_url"].as_str().unwrap_or(BASE_URL),
                Some(text(config, "bot_token").into()),
            )?;
            api.post(
                "/ilink/bot/getconfig",
                json!({"ilink_user_id": text(config, "user_id")}),
                Duration::from_secs(10),
                true,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

fn stop(id: &str) {
    if let Some(runtime) = CONNECTIONS.lock().unwrap().remove(id) {
        runtime.cancel.cancel();
        runtime.task.abort();
    }
    STATUSES.lock().unwrap().remove(id);
}

fn start(connection: Connect) {
    stop(&connection.id);
    if !connection.enabled {
        return;
    }
    let id = connection.id.clone();
    let runtime_id = id.clone();
    status(&id, "connecting", None);
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        let result = tokio::select! {
            _ = worker_cancel.cancelled() => return,
            result = run(connection, worker_cancel.clone()) => result,
        };
        if !worker_cancel.is_cancelled() {
            if let Err(error) = result {
                status(&id, "error", Some(error));
            }
        }
    });
    CONNECTIONS
        .lock()
        .unwrap()
        .insert(runtime_id, Runtime { cancel, task });
}

struct WeixinAdapter {
    id: String,
    api: Api,
    cancel: CancellationToken,
    store: Mutex<Store>,
    ui: Mutex<interaction::Ui>,
    outgoing: tokio::sync::Mutex<()>,
}

impl WeixinAdapter {
    async fn post(&self, endpoint: &str, body: Value, timeout: Duration) -> Result<Value, String> {
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("WeChat connection stopped".into()),
            result = self.api.post(endpoint, body, timeout, true) => result,
        };
        result.map_err(|error| {
            if matches!(error, api::Error::Expired) {
                status(&self.id, "error", Some(error.to_string()));
                self.cancel.cancel();
            }
            error.to_string()
        })
    }

    fn current(&self) -> Result<Connect, String> {
        crate::storage::connects::get(&self.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Connection no longer exists".into())
    }

    async fn send(&self, message_id: &str, body: &str) -> Result<(), String> {
        let _guard = self.outgoing.lock().await;
        let message = self
            .store
            .lock()
            .unwrap()
            .data
            .replies
            .get(message_id)
            .cloned()
            .ok_or("WeChat reply context is unavailable")?;
        if message.context_token.is_empty() {
            return Err("WeChat reply context token is unavailable; send a new message".into());
        }
        for chunk in chunks(body, 3500) {
            self.post("/ilink/bot/sendmessage", json!({"msg": {
                "from_user_id": "", "to_user_id": message.peer, "client_id": format!("grove-{}", uuid::Uuid::new_v4()),
                "message_type": 2, "message_state": 2, "context_token": message.context_token,
                "item_list": [{"type": 1, "text_item": {"text": chunk}}]
            }}), Duration::from_secs(15)).await?;
        }
        Ok(())
    }

    async fn inbound(self: &Arc<Self>, message: Message) -> Result<(), String> {
        let current = self.current()?;
        if !current.enabled {
            return Err("Connection disabled".into());
        }
        if !crate::storage::connects::bind_private_chat(&self.id, &message.peer, &message.peer)
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
        let inbound = |body: String| InboundMessage {
            external_message_id: message.id.clone(),
            conversation_id: message.peer.clone(),
            sender_id: message.peer.clone(),
            text: body,
            attachments: vec![],
        };
        let adapter: AdapterRef = self.clone();
        let target_scope = scope(&current);
        if message.unsupported_media {
            let _ = self
                .ui
                .lock()
                .unwrap()
                .command("", &message.id, &target_scope);
            return self.send(&message.id, "This version supports text and voice transcriptions provided by WeChat. Please send images, files, or untranscribed voice messages as text.").await;
        }
        let parts: Vec<_> = message.text.split_whitespace().collect();
        let command = parts
            .first()
            .copied()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let kind = match command.as_str() {
            "/new" | "/clear" => Some("new_session"),
            "/target" => Some("target"),
            "/config" => Some("config"),
            _ => None,
        };
        if let Some(kind) = kind.filter(|_| parts.len() > 1) {
            let available = self.ui.lock().unwrap().has_menu(kind, &target_scope);
            if !available {
                crate::connect::core::handle_message(
                    &self.id,
                    adapter.clone(),
                    inbound(command.clone()),
                )
                .await;
            }
        }
        if command == "/help" && parts.len() == 1 {
            let _ = self
                .ui
                .lock()
                .unwrap()
                .command("", &message.id, &target_scope);
            return self.send(&message.id, "/new [agent_id] — Create a session\n/target [project|task|session] [option] — Switch target\n/config [setting] [option] — Configure the session\n/status — Current status\n/cancel — Cancel the agent's current turn\n/skill <name> [prompt] — Run a skill\n/respond <request_id> <option> — Respond to a permission request\n/answer <request_id> <field_id> <answer> — Save a draft form answer\n/submit <request_id> — Submit a form\n/decline <request_id> — Decline a form\nOther messages are sent to the agent. Incomplete target selections do not take effect.").await;
        }
        let response = self
            .ui
            .lock()
            .unwrap()
            .command(&message.text, &message.id, &target_scope);
        let response = match response {
            Ok(response) => response,
            Err(error) => return self.send(&message.id, &error).await,
        };
        match response {
            Response::Pass => {
                crate::connect::core::handle_message(
                    &self.id,
                    adapter,
                    inbound(message.text.clone()),
                )
                .await
            }
            Response::Text(text) => self.send(&message.id, &text).await?,
            Response::RefreshTarget { fields, stage } => {
                let result = crate::connect::core::handle_action(
                    &self.id,
                    adapter,
                    InboundAction {
                        conversation_id: message.peer.clone(),
                        sender_id: message.peer.clone(),
                        source_message_id: Some(message.id.clone()),
                        name: Some("update_options_btn".into()),
                        fields,
                    },
                )
                .await?;
                if let Some(card) = result.card {
                    self.ui
                        .lock()
                        .unwrap()
                        .render(&card, &message.id, &target_scope)?;
                    let text = self.ui.lock().unwrap().next_target(&stage);
                    self.send(&message.id, &text).await?;
                }
            }
            Response::Action {
                name,
                fields,
                source,
            } => {
                let result = crate::connect::core::handle_action(
                    &self.id,
                    adapter,
                    InboundAction {
                        conversation_id: message.peer.clone(),
                        sender_id: message.peer.clone(),
                        source_message_id: Some(source),
                        name: Some(name.clone()),
                        fields: fields.clone(),
                    },
                )
                .await;
                match result {
                    Ok(result) => {
                        if result.notice.as_ref().is_some_and(|(level, _)| {
                            matches!(
                                level,
                                crate::connect::adapter::NoticeLevel::Success
                                    | crate::connect::adapter::NoticeLevel::Info
                            )
                        }) {
                            self.ui.lock().unwrap().action_completed(&name, &fields);
                        }
                        if let Some(card) = result.card {
                            if !matches!(&card, CardSpec::Notice(_)) {
                                if let Some((_, text)) = result.notice {
                                    self.send(&message.id, &text).await?;
                                }
                            }
                            self.reply_card(&message.id, &card).await?;
                        } else if let Some((_, text)) = result.notice {
                            self.send(&message.id, &text).await?;
                        }
                    }
                    Err(error) => self.send(&message.id, &error).await?,
                }
            }
        }
        Ok(())
    }
}

#[async_trait]
impl ConnectAdapter for WeixinAdapter {
    async fn mark_waiting(&self, _message_id: &str) -> Option<String> {
        None
    }
    async fn mark_working(&self, message_id: &str, _waiting: &Option<String>) -> Option<String> {
        let message = self
            .store
            .lock()
            .unwrap()
            .data
            .replies
            .get(message_id)
            .cloned()?;
        let result = self
            .post(
                "/ilink/bot/getconfig",
                json!({"ilink_user_id": message.peer, "context_token": message.context_token}),
                Duration::from_secs(10),
            )
            .await
            .ok()?;
        let ticket = result["typing_ticket"].as_str()?;
        self.post(
            "/ilink/bot/sendtyping",
            json!({"ilink_user_id": message.peer, "typing_ticket": ticket, "status": 1}),
            Duration::from_secs(10),
        )
        .await
        .ok()?;
        Some(ticket.into())
    }
    async fn clear_status(&self, message_id: &str, receipt: &Option<String>) {
        let message = self
            .store
            .lock()
            .unwrap()
            .data
            .replies
            .get(message_id)
            .cloned();
        if let (Some(message), Some(ticket)) = (message, receipt) {
            let _ = self
                .post(
                    "/ilink/bot/sendtyping",
                    json!({"ilink_user_id": message.peer, "typing_ticket": ticket, "status": 2}),
                    Duration::from_secs(10),
                )
                .await;
        }
    }
    async fn reply_text(&self, message_id: &str, text: &str) -> Result<(), String> {
        self.send(message_id, text).await
    }
    async fn reply_card(&self, message_id: &str, spec: &CardSpec) -> Result<(), String> {
        let text = self
            .ui
            .lock()
            .unwrap()
            .render(spec, message_id, &scope(&self.current()?))?;
        self.send(message_id, &text).await
    }
}

async fn run(connection: Connect, cancel: CancellationToken) -> Result<(), String> {
    validate_config(&connection.domain, &connection.adapter_config, false)?;
    let config = &connection.adapter_config;
    let token = text(config, "bot_token");
    let api = Api::new(
        config["base_url"].as_str().unwrap_or(BASE_URL),
        Some(token.into()),
    )?;
    let path = crate::storage::grove_dir()
        .join("connect")
        .join("weixin")
        .join(format!("{}.json", connection.id));
    let store = Store::load(path, token)?;
    let adapter = Arc::new(WeixinAdapter {
        id: connection.id.clone(),
        api: api.clone(),
        cancel: cancel.clone(),
        store: Mutex::new(store),
        ui: Mutex::new(interaction::Ui::default()),
        outgoing: tokio::sync::Mutex::new(()),
    });
    let _ = api
        .post(
            "/ilink/bot/msg/notifystart",
            json!({}),
            Duration::from_secs(10),
            true,
        )
        .await;
    let mut timeout = Duration::from_secs(40);
    let mut failures = 0u32;
    loop {
        loop {
            let pending = adapter.store.lock().unwrap().data.pending.front().cloned();
            let Some(message) = pending else {
                break;
            };
            // A crash between Grove submission and this checkpoint may replay
            // one message; Connect does not expose durable submission receipts.
            if let Err(error) = adapter.inbound(message.clone()).await {
                eprintln!("[connect:weixin] message delivery failed: {error}");
            }
            adapter.store.lock().unwrap().complete(&message.id)?;
        }
        if cancel.is_cancelled() {
            return Ok(());
        }
        let cursor = adapter.store.lock().unwrap().data.cursor.clone();
        let result = api
            .post(
                "/ilink/bot/getupdates",
                json!({"get_updates_buf": cursor}),
                timeout,
                true,
            )
            .await;
        match result {
            Ok(response) => {
                failures = 0;
                status(&connection.id, "online", None);
                if let Some(milliseconds) = response["longpolling_timeout_ms"].as_u64() {
                    timeout = Duration::from_millis(milliseconds.clamp(1000, 90_000) + 5000);
                }
                let messages = response["msgs"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|message| parse_message(message, text(config, "user_id")))
                    .collect();
                adapter
                    .store
                    .lock()
                    .unwrap()
                    .accept(messages, response["get_updates_buf"].as_str())?;
            }
            Err(api::Error::Expired) => return Err(api::Error::Expired.to_string()),
            Err(api::Error::Transport(error)) if error == "WeChat request timed out" => {}
            Err(error) => {
                failures = failures.saturating_add(1);
                status(&connection.id, "connecting", Some(error.to_string()));
                tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(failures.min(5)))).await;
            }
        }
    }
}

fn parse_message(value: &Value, owner: &str) -> Option<Message> {
    if text(value, "from_user_id") != owner
        || !text(value, "group_id").is_empty()
        || value["message_type"].as_u64() != Some(1)
    {
        return None;
    }
    let id = value["message_id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| value["message_id"].as_u64().map(|id| id.to_string()))?;
    let mut body = Vec::new();
    let mut unsupported_media = false;
    for item in value["item_list"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let content = match item["type"].as_u64() {
            Some(1) => item["text_item"]["text"].as_str(),
            Some(3) => {
                let transcript = item["voice_item"]["text"].as_str();
                unsupported_media |= transcript.is_none_or(str::is_empty);
                transcript
            }
            _ => {
                unsupported_media = true;
                None
            }
        };
        if let Some(content) = content.filter(|content| !content.is_empty()) {
            body.push(content);
        }
    }
    Some(Message {
        id,
        peer: owner.into(),
        unsupported_media: unsupported_media || body.is_empty(),
        text: body.join("\n"),
        context_token: text(value, "context_token").into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_owner_private_messages_without_rounding_large_ids() {
        let message: Value = serde_json::from_str(r#"{"message_id":18446744073709551615,"message_type":1,"from_user_id":"owner","context_token":"token","item_list":[{"type":1,"text_item":{"text":"hello"}}]}"#).unwrap();
        let parsed = parse_message(&message, "owner").unwrap();
        assert_eq!(parsed.id, "18446744073709551615");
        assert_eq!(parsed.text, "hello");
        assert!(!parsed.unsupported_media);
        assert!(parse_message(&message, "other-user").is_none());
        let mut group = message.clone();
        group["group_id"] = json!("group");
        assert!(parse_message(&group, "owner").is_none());
        let mut mixed = message.clone();
        mixed["item_list"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type": 2}));
        assert!(parse_message(&mixed, "owner").unwrap().unsupported_media);
        let mut voice = message.clone();
        voice["item_list"] = json!([{"type": 3, "voice_item": {"text": "transcribed"}}]);
        assert_eq!(parse_message(&voice, "owner").unwrap().text, "transcribed");
        voice["item_list"] = json!([{"type": 3, "voice_item": {}}]);
        assert!(parse_message(&voice, "owner").unwrap().unsupported_media);
        let mut bot = message;
        bot["message_type"] = json!(2);
        assert!(parse_message(&bot, "owner").is_none());
    }

    #[test]
    fn splits_unicode_without_corruption_or_exceeding_byte_limit() {
        let body = "\u{4E2D}\u{6587}🙂".repeat(1200);
        let parts = chunks(&body, 3500);
        assert_eq!(parts.join(""), body);
        assert!(parts.iter().all(|part| part.len() <= 3500));
    }

    #[test]
    fn credentials_are_hidden_and_preserved_when_settings_omit_the_token() {
        let config =
            json!({"bot_token":"secret", "bot_id":"bot", "user_id":"owner", "base_url":BASE_URL});
        assert!(PLATFORM
            .public_config("weixin", &config)
            .get("bot_token")
            .is_none());
        let merged = PLATFORM
            .merge_config(
                "weixin",
                Some(&config),
                &json!({"bot_token":"", "user_id":"owner"}),
            )
            .unwrap();
        assert_eq!(merged["bot_token"], "secret");
        assert!(validate_config("weixin", &merged, false).is_ok());
    }
}

fn chunks(text: &str, max_bytes: usize) -> Vec<&str> {
    let mut result = Vec::new();
    let mut remainder = text;
    while remainder.len() > max_bytes {
        let mut end = max_bytes;
        while !remainder.is_char_boundary(end) {
            end -= 1;
        }
        result.push(&remainder[..end]);
        remainder = &remainder[end..];
    }
    if !remainder.is_empty() {
        result.push(remainder);
    }
    result
}
