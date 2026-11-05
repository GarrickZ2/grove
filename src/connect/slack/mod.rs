//! Built-in Slack adapter over Socket Mode, so Grove needs no public URL.
//! Only the paired owner's DM with the bot is served. Menus and forms use the
//! shared text UI; its suggested replies become Block Kit buttons, and typed
//! commands arrive through the `/grove` slash command.
mod api;
mod format;
mod registration;

use crate::{
    connect::{
        adapter::TurnView,
        adapter::{
            ConnectAdapter, ConnectionStatus, InboundAttachment, InboundAttachmentKind, Platform,
        },
        commands::CardSpec,
        markdown,
        platform::{PlatformCapabilities, PlatformDefinition},
        registration::RegistrationView,
        text_driver::{self, Inbound, TextChannel},
        text_ui::{Button, Ui},
        turn_text::{TurnCards, TurnMessages},
    },
    storage::connects::Connect,
};
use api::{Api, Error, Socket};
use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct SlackPlatform;
pub static PLATFORM: SlackPlatform = SlackPlatform;
struct Runtime {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
static CONNECTIONS: Lazy<Mutex<HashMap<String, Runtime>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static STATUSES: Lazy<Mutex<HashMap<String, ConnectionStatus>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const MESSAGE_BYTES: usize = 3500;
/// A section block holds 3000 characters after escaping.
const SECTION_BYTES: usize = 2400;
const BUTTONS_PER_BLOCK: usize = 25;
const WAITING: &str = "eyes";
const WORKING: &str = "hourglass_flowing_sand";
const SECRETS: [&str; 2] = ["bot_token", "app_token"];

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

pub fn validate_config(domain: &str, config: &Value, existing: bool) -> Result<(), String> {
    if domain != "slack" {
        return Err("Slack domain must be slack".into());
    }
    if !config.is_object() {
        return Err("adapter_config must be a JSON object".into());
    }
    let bot = text(config, "bot_token").trim();
    if !(existing && bot.is_empty()) && !api::valid_bot_token(bot) {
        return Err("A Slack bot token (xoxb-) is required".into());
    }
    let app = text(config, "app_token").trim();
    if !(existing && app.is_empty()) && !api::valid_app_token(app) {
        return Err("A Slack app-level token (xapp-) is required".into());
    }
    for key in ["user_id", "channel_id"] {
        if text(config, key).is_empty() {
            return Err(format!("Slack {key} is required; pair the bot from Grove"));
        }
    }
    Ok(())
}

impl Platform for SlackPlatform {
    fn definitions(&self) -> Vec<PlatformDefinition> {
        vec![PlatformDefinition {
            id: "slack".into(),
            name: "Slack".into(),
            description: "Your own Slack app via Socket Mode".into(),
            available: true,
            setup_modes: vec!["qr".into()],
            config_fields: Vec::new(),
            capabilities: PlatformCapabilities {
                private_chat: true,
                reactions: true,
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
            if !SECRETS.contains(&key.as_str())
                || value.as_str().is_some_and(|value| !value.is_empty())
            {
                target.insert(key.clone(), value.clone());
            }
        }
        Ok(merged)
    }
    fn public_config(&self, _domain: &str, config: &Value) -> Value {
        let mut public = config.clone();
        if let Some(object) = public.as_object_mut() {
            for key in SECRETS {
                object.remove(key);
            }
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
        Box::pin(registration::submit(id, input))
    }
    fn verify_config<'a>(
        &'a self,
        domain: &'a str,
        config: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            validate_config(domain, config, false)?;
            registration::identify(text(config, "bot_token"), text(config, "app_token")).await?;
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

struct SlackAdapter {
    id: String,
    bot: Api,
    owner: String,
    /// The owner's DM with the bot; every reply goes here.
    channel: String,
    cancel: CancellationToken,
    ui: Mutex<Ui>,
    /// Socket Mode may redeliver an event after a reconnect.
    seen: Mutex<VecDeque<String>>,
    turns: TurnCards,
    outgoing: tokio::sync::Mutex<()>,
}

fn button_blocks(text: &str, buttons: &[Button]) -> Value {
    let mut blocks = vec![json!({"type": "section", "text": {"type": "mrkdwn", "text": text}})];
    for (block, group) in buttons.chunks(BUTTONS_PER_BLOCK).enumerate() {
        let elements: Vec<Value> = group
            .iter()
            .enumerate()
            .map(|(index, button)| {
                let label: String = button.label.chars().take(75).collect();
                json!({
                    "type": "button",
                    "text": {"type": "plain_text", "text": label, "emoji": true},
                    "action_id": format!("grove_{block}_{index}"),
                    "value": button.command,
                })
            })
            .collect();
        blocks.push(json!({"type": "actions", "elements": elements}));
    }
    Value::Array(blocks)
}

impl SlackAdapter {
    async fn call(&self, method: &str, params: &[(&str, String)]) -> Result<Value, Error> {
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(Error::Transport("Slack connection stopped".into())),
            result = self.bot.call_retrying(method, params) => result,
        };
        if let Err(error @ Error::Unauthorized(_)) = &result {
            status(&self.id, "error", Some(error.to_string()));
            self.cancel.cancel();
        }
        result
    }

    async fn reaction(&self, method: &str, message_id: &str, name: &str) -> bool {
        // Slash commands have no message to react to.
        if message_id.starts_with("slash-") {
            return false;
        }
        self.call(
            method,
            &[
                ("channel", self.channel.clone()),
                ("timestamp", message_id.into()),
                ("name", name.into()),
            ],
        )
        .await
        .is_ok()
    }

    fn first_delivery(&self, key: &str) -> bool {
        let mut seen = self.seen.lock().unwrap();
        if seen.iter().any(|entry| entry == key) {
            return false;
        }
        seen.push_back(key.into());
        if seen.len() > 256 {
            seen.pop_front();
        }
        true
    }

    async fn attachments(&self, event: &Value) -> Result<Vec<InboundAttachment>, String> {
        let mut attachments = Vec::new();
        for file in event["files"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if file["size"].as_u64().unwrap_or(0) > api::MAX_DOWNLOAD {
                return Err("Grove accepts Slack files up to 20 MB.".into());
            }
            let url = file["url_private_download"]
                .as_str()
                .or_else(|| file["url_private"].as_str())
                .ok_or("This Slack file cannot be downloaded.")?;
            let bytes = self
                .bot
                .download(url)
                .await
                .map_err(|e| format!("Could not download the Slack file: {e}"))?;
            let mime_type = file["mimetype"].as_str().map(str::to_owned);
            let kind = match mime_type.as_deref() {
                Some(mime) if mime.starts_with("image/") => InboundAttachmentKind::Image,
                Some(mime) if mime.starts_with("audio/") => InboundAttachmentKind::Audio,
                _ => InboundAttachmentKind::File,
            };
            attachments.push(InboundAttachment {
                kind,
                name: file["name"].as_str().unwrap_or("file").into(),
                mime_type,
                bytes,
            });
        }
        Ok(attachments)
    }

    fn inbound(&self, id: String, text: String) -> Inbound {
        Inbound {
            id,
            conversation: self.channel.clone(),
            sender: self.owner.clone(),
            text,
            attachments: Vec::new(),
            unsupported: None,
        }
    }

    async fn on_event(self: &Arc<Self>, event: &Value) -> Result<(), String> {
        if !registration::human_message(event)
            || text(event, "user") != self.owner
            || text(event, "channel") != self.channel
        {
            return Ok(());
        }
        let ts = text(event, "ts").to_owned();
        if ts.is_empty() || !self.first_delivery(&ts) {
            return Ok(());
        }
        let mut inbound = self.inbound(ts, format::plain(text(event, "text")));
        match self.attachments(event).await {
            Ok(attachments) => inbound.attachments = attachments,
            Err(error) => inbound.unsupported = Some(error),
        }
        text_driver::dispatch(self.clone(), inbound).await
    }

    async fn on_interactive(self: &Arc<Self>, payload: &Value) -> Result<(), String> {
        if payload["type"] != "block_actions"
            || payload["user"]["id"].as_str() != Some(&self.owner)
            || payload["channel"]["id"].as_str() != Some(&self.channel)
        {
            return Ok(());
        }
        let Some(command) = payload["actions"][0]["value"].as_str() else {
            return Ok(());
        };
        let ts = payload["container"]["message_ts"]
            .as_str()
            .or_else(|| payload["message"]["ts"].as_str())
            .unwrap_or_default()
            .to_owned();
        if ts.is_empty() {
            return Ok(());
        }
        // Options are single-use: drop the buttons, keep the text.
        let message = &payload["message"];
        let blocks: Vec<Value> = message["blocks"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|block| block["type"] != "actions")
            .cloned()
            .collect();
        let _ = self
            .call(
                "chat.update",
                &[
                    ("channel", self.channel.clone()),
                    ("ts", ts.clone()),
                    ("text", text(message, "text").into()),
                    ("blocks", Value::Array(blocks).to_string()),
                ],
            )
            .await;
        text_driver::dispatch(self.clone(), self.inbound(ts, command.into())).await
    }

    async fn on_slash(self: &Arc<Self>, payload: &Value) -> Result<(), String> {
        if text(payload, "user_id") != self.owner {
            return Ok(());
        }
        let id = format!("slash-{}", uuid::Uuid::new_v4().simple());
        let command = format::slash_command(text(payload, "text"));
        text_driver::dispatch(self.clone(), self.inbound(id, command)).await
    }

    async fn handle(self: &Arc<Self>, envelope: api::Envelope) {
        let result = match envelope.kind.as_str() {
            "events_api" => self.on_event(&envelope.payload["event"]).await,
            "interactive" => self.on_interactive(&envelope.payload).await,
            "slash_commands" => self.on_slash(&envelope.payload).await,
            _ => Ok(()),
        };
        if let Err(error) = result {
            eprintln!("[connect:slack] event delivery failed: {error}");
        }
    }
}

#[async_trait]
impl TextChannel for SlackAdapter {
    fn connection_id(&self) -> &str {
        &self.id
    }
    fn ui(&self) -> &Mutex<Ui> {
        &self.ui
    }
    async fn send(
        &self,
        _message_id: &str,
        text: &str,
        buttons: Vec<Button>,
    ) -> Result<(), String> {
        let _guard = self.outgoing.lock().await;
        let limit = if buttons.is_empty() {
            MESSAGE_BYTES
        } else {
            SECTION_BYTES
        };
        let mut chunks = markdown::chunk(text, limit);
        if chunks.is_empty() {
            if buttons.is_empty() {
                return Ok(());
            }
            chunks.push("Choose an option:".into());
        }
        let last = chunks.len() - 1;
        for (index, chunk) in chunks.iter().enumerate() {
            let body = format::mrkdwn(chunk);
            let mut params = vec![
                ("channel", self.channel.clone()),
                ("text", body.clone()),
                ("unfurl_links", "false".into()),
            ];
            if index == last && !buttons.is_empty() {
                params.push(("blocks", button_blocks(&body, &buttons).to_string()));
            }
            self.call("chat.postMessage", &params)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[async_trait]
impl TurnMessages for SlackAdapter {
    fn max_bytes(&self) -> usize {
        MESSAGE_BYTES
    }
    fn edit_interval(&self) -> Duration {
        // chat.update is Tier 3 (~50 per minute).
        Duration::from_secs(2)
    }
    async fn post(&self, _parent: &str, markdown: &str) -> Result<String, String> {
        let _guard = self.outgoing.lock().await;
        let result = self
            .call(
                "chat.postMessage",
                &[
                    ("channel", self.channel.clone()),
                    ("text", format::mrkdwn(markdown)),
                    ("unfurl_links", "false".into()),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        result["ts"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Slack returned no message ts".into())
    }
    async fn edit(&self, message_id: &str, markdown: &str) -> Result<(), String> {
        self.call(
            "chat.update",
            &[
                ("channel", self.channel.clone()),
                ("ts", message_id.into()),
                ("text", format::mrkdwn(markdown)),
            ],
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}

#[async_trait]
impl ConnectAdapter for SlackAdapter {
    fn supports_turn_cards(&self) -> bool {
        true
    }
    async fn create_turn_card(&self, view: &TurnView) -> Result<String, String> {
        Ok(self.turns.create(view))
    }
    async fn send_turn_card(
        &self,
        message_id: &str,
        card_id: &str,
        _uuid: &str,
    ) -> Result<String, String> {
        self.turns.send(self, message_id, card_id).await
    }
    async fn update_turn_card(
        &self,
        card_id: &str,
        view: &TurnView,
        _sequence: u32,
    ) -> Result<(), String> {
        self.turns.update(self, card_id, view).await
    }
    async fn replace_turn_card(&self, message_id: &str, view: &TurnView) -> Result<(), String> {
        self.turns.replace(self, message_id, view).await
    }
    async fn mark_waiting(&self, message_id: &str) -> Option<String> {
        self.reaction("reactions.add", message_id, WAITING)
            .await
            .then(|| WAITING.into())
    }
    async fn mark_working(&self, message_id: &str, waiting: &Option<String>) -> Option<String> {
        if let Some(name) = waiting {
            self.reaction("reactions.remove", message_id, name).await;
        }
        self.reaction("reactions.add", message_id, WORKING)
            .await
            .then(|| WORKING.into())
    }
    async fn clear_status(&self, message_id: &str, receipt: &Option<String>) {
        if let Some(name) = receipt {
            self.reaction("reactions.remove", message_id, name).await;
        }
    }
    async fn reply_text(&self, message_id: &str, text: &str) -> Result<(), String> {
        TextChannel::send(self, message_id, text, Vec::new()).await
    }
    async fn reply_card(&self, message_id: &str, spec: &CardSpec) -> Result<(), String> {
        text_driver::reply_card(self, message_id, spec).await
    }
    async fn push_text(&self, _chat_id: Option<&str>, text: &str) -> Result<(), String> {
        TextChannel::send(self, "", text, Vec::new()).await
    }
}

async fn run(connection: Connect, cancel: CancellationToken) -> Result<(), String> {
    validate_config(&connection.domain, &connection.adapter_config, false)?;
    let config = &connection.adapter_config;
    let bot = Api::new(text(config, "bot_token"))?;
    let app = Api::new(text(config, "app_token"))?;
    let adapter = Arc::new(SlackAdapter {
        id: connection.id.clone(),
        bot,
        owner: text(config, "user_id").into(),
        channel: text(config, "channel_id").into(),
        cancel: cancel.clone(),
        ui: Mutex::new(Ui::default()),
        seen: Mutex::new(VecDeque::new()),
        turns: TurnCards::default(),
        outgoing: tokio::sync::Mutex::new(()),
    });
    crate::connect::grove::register_adapter(&connection.id, adapter.clone());
    // Events are acked by the reader and handled in order by a worker, so a
    // slow delivery never delays an ack past Slack's 3-second retry window.
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<api::Envelope>();
    let worker = adapter.clone();
    let worker_task = tokio::spawn(async move {
        while let Some(envelope) = receiver.recv().await {
            worker.handle(envelope).await;
        }
    });
    let _worker_guard = AbortOnDrop(worker_task);
    let mut failures = 0u32;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let mut socket = match Socket::open(&app).await {
            Ok(socket) => socket,
            Err(error @ Error::Unauthorized(_)) => return Err(error.to_string()),
            Err(error) => {
                failures = failures.saturating_add(1);
                status(&connection.id, "connecting", Some(error.to_string()));
                tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(failures.min(5)))).await;
                continue;
            }
        };
        status(&connection.id, "online", None);
        loop {
            match socket.next().await {
                Ok(Some(envelope)) => {
                    failures = 0;
                    let _ = sender.send(envelope);
                }
                // Slack rotates Socket Mode connections; reconnect at once.
                Ok(None) => break,
                Err(error) => {
                    failures = failures.saturating_add(1);
                    status(&connection.id, "connecting", Some(error.to_string()));
                    tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(failures.min(5))))
                        .await;
                    break;
                }
            }
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Value {
        json!({
            "bot_token": "xoxb-1234567890-abcdefghij",
            "app_token": "xapp-1-A123-456-abcdefghij",
            "user_id": "U1",
            "channel_id": "D1",
            "team_id": "T1",
        })
    }

    #[test]
    fn config_requires_both_tokens_and_a_paired_dm_and_hides_secrets() {
        assert!(validate_config("slack", &config(), false).is_ok());
        let mut unpaired = config();
        unpaired.as_object_mut().unwrap().remove("channel_id");
        assert!(validate_config("slack", &unpaired, false).is_err());
        let public = PLATFORM.public_config("slack", &config());
        assert!(public.get("bot_token").is_none() && public.get("app_token").is_none());
        let merged = PLATFORM
            .merge_config(
                "slack",
                Some(&config()),
                &json!({"bot_token": "", "app_token": "", "user_id": "U1", "channel_id": "D1"}),
            )
            .unwrap();
        assert_eq!(merged, config());
        assert!(
            validate_config("slack", &json!({"user_id": "U1", "channel_id": "D1"}), true).is_ok()
        );
    }

    #[test]
    fn buttons_are_grouped_into_valid_action_blocks() {
        let buttons: Vec<_> = (0..30)
            .map(|index| Button {
                label: "x".repeat(100),
                command: format!("/target task {index}"),
            })
            .collect();
        let blocks = button_blocks("Choose", &buttons);
        let blocks = blocks.as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[1]["elements"].as_array().unwrap().len(), 25);
        assert_eq!(blocks[2]["elements"][4]["value"], "/target task 29");
        assert_eq!(
            blocks[1]["elements"][0]["text"]["text"]
                .as_str()
                .unwrap()
                .len(),
            75
        );
        assert_ne!(
            blocks[1]["elements"][0]["action_id"],
            blocks[2]["elements"][0]["action_id"]
        );
    }
}
