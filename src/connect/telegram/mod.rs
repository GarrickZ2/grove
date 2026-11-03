//! Built-in Telegram adapter over the Bot API (`getUpdates` long polling, so
//! Grove needs no public URL). Only the paired owner's private chat is served.
//! Menus and forms use the shared text UI; its suggested replies become
//! inline keyboard buttons.
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
        platform::{ConfigField, PlatformCapabilities, PlatformDefinition},
        registration::RegistrationView,
        text_driver::{self, Inbound, TextChannel},
        text_ui::{Button, Ui},
        turn_text::{TurnCards, TurnMessages},
    },
    storage::connects::Connect,
};
use api::{Api, Error};
use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub struct TelegramPlatform;
pub static PLATFORM: TelegramPlatform = TelegramPlatform;
struct Runtime {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
static CONNECTIONS: Lazy<Mutex<HashMap<String, Runtime>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static STATUSES: Lazy<Mutex<HashMap<String, ConnectionStatus>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const MESSAGE_BYTES: usize = 3500;
const CALLBACK_TTL: Duration = Duration::from_secs(15 * 60);
const WAITING: &str = "👀";
const WORKING: &str = "👨‍💻";
const UNSUPPORTED: &str = "Grove accepts text, photos, files, and voice messages from Telegram. Send this content as text or a file instead.";

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
    if domain != "telegram" {
        return Err("Telegram domain must be telegram".into());
    }
    if !config.is_object() {
        return Err("adapter_config must be a JSON object".into());
    }
    let token = text(config, "bot_token").trim();
    if !(existing && token.is_empty()) && !api::valid_token(token) {
        return Err("A valid Telegram bot token is required".into());
    }
    let user = text(config, "user_id");
    if user.is_empty() || !user.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Telegram user_id is required; pair the bot from Grove".into());
    }
    Ok(())
}

impl Platform for TelegramPlatform {
    fn definitions(&self) -> Vec<PlatformDefinition> {
        vec![PlatformDefinition {
            id: "telegram".into(),
            name: "Telegram".into(),
            description: "Your own bot via @BotFather".into(),
            available: true,
            setup_modes: vec!["qr".into()],
            config_fields: vec![ConfigField {
                key: "bot_token".into(),
                label: "Bot token".into(),
                secret: true,
                required: true,
                placeholder: "123456:ABC…".into(),
            }],
            capabilities: PlatformCapabilities {
                private_chat: true,
                reactions: true,
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
        Box::pin(registration::submit(id, input))
    }
    fn verify_config<'a>(
        &'a self,
        domain: &'a str,
        config: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            validate_config(domain, config, false)?;
            Api::new(text(config, "bot_token"))?
                .call("getMe", json!({}), Duration::from_secs(10))
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

/// Last processed update, so a restart does not replay delivered prompts.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Checkpoint {
    bot_id: String,
    offset: i64,
}

impl Checkpoint {
    fn path(connection_id: &str) -> PathBuf {
        crate::storage::grove_dir()
            .join("connect")
            .join("telegram")
            .join(format!("{connection_id}.json"))
    }

    fn load(path: &PathBuf, bot_id: &str) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|checkpoint| checkpoint.bot_id == bot_id)
            .unwrap_or_else(|| Self {
                bot_id: bot_id.into(),
                offset: 0,
            })
    }

    fn save(&self, path: &PathBuf) -> Result<(), String> {
        use std::io::Write;
        let directory = path.parent().ok_or("Invalid Telegram state path")?;
        std::fs::create_dir_all(directory)
            .map_err(|_| "Could not create Telegram state directory")?;
        let temporary = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not write Telegram checkpoint")?;
        file.write_all(&serde_json::to_vec(self).map_err(|_| "Could not encode Telegram state")?)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not persist Telegram checkpoint")?;
        std::fs::rename(temporary, path).map_err(|_| "Could not replace Telegram checkpoint")?;
        Ok(())
    }
}

struct TelegramAdapter {
    id: String,
    api: Api,
    /// Private chat id; equal to the owner's user id in Telegram.
    owner: i64,
    username: String,
    cancel: CancellationToken,
    ui: Mutex<Ui>,
    /// Inline button tokens → the text command they replay. callback_data is
    /// limited to 64 bytes, so commands never travel through Telegram.
    callbacks: Mutex<HashMap<String, (String, Instant)>>,
    turns: TurnCards,
    outgoing: tokio::sync::Mutex<()>,
}

impl TelegramAdapter {
    async fn call(&self, method: &str, body: Value) -> Result<Value, Error> {
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(Error::Transport("Telegram connection stopped".into())),
            result = self.api.call_retrying(method, body, Duration::from_secs(20)) => result,
        };
        if matches!(result, Err(Error::Unauthorized)) {
            status(&self.id, "error", Some(Error::Unauthorized.to_string()));
            self.cancel.cancel();
        }
        result
    }

    fn keyboard(&self, buttons: &[Button]) -> Value {
        let mut callbacks = self.callbacks.lock().unwrap();
        callbacks.retain(|_, (_, created)| created.elapsed() < CALLBACK_TTL);
        if callbacks.len() > 512 {
            callbacks.clear();
        }
        let entries: Vec<Value> = buttons
            .iter()
            .map(|button| {
                let token = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
                callbacks.insert(token.clone(), (button.command.clone(), Instant::now()));
                json!({"text": button.label, "callback_data": format!("g:{token}")})
            })
            .collect();
        let per_row = if buttons
            .iter()
            .all(|button| button.label.chars().count() <= 18)
        {
            2
        } else {
            1
        };
        let rows: Vec<Value> = entries
            .chunks(per_row)
            .map(|row| Value::Array(row.to_vec()))
            .collect();
        json!({"inline_keyboard": rows})
    }

    /// `sendMessage` / `editMessageText` with Markdown rendered as HTML.
    async fn send_chunk(
        &self,
        method: &str,
        mut body: Value,
        chunk: &str,
    ) -> Result<Value, String> {
        body["text"] = json!(format::html(chunk));
        body["parse_mode"] = json!("HTML");
        let result = match self.call(method, body.clone()).await {
            // Formatting is best effort: resend the original Markdown as text.
            Err(Error::Rejected(description)) if description.contains("parse entities") => {
                body["text"] = json!(chunk);
                body.as_object_mut().unwrap().remove("parse_mode");
                self.call(method, body).await
            }
            result => result,
        };
        match result {
            Ok(value) => Ok(value),
            // An edit that changes nothing (a retried final) already holds.
            Err(Error::Rejected(description))
                if description.contains("message is not modified") =>
            {
                Ok(Value::Null)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    async fn react(&self, message_id: &str, emoji: Option<&str>) -> bool {
        let Ok(message_id) = message_id.parse::<i64>() else {
            return false;
        };
        let reaction = emoji
            .map(|emoji| json!([{"type": "emoji", "emoji": emoji}]))
            .unwrap_or_else(|| json!([]));
        self.call(
            "setMessageReaction",
            json!({"chat_id": self.owner, "message_id": message_id, "reaction": reaction}),
        )
        .await
        .is_ok()
    }

    fn normalize_command(&self, text: &str) -> String {
        // In menus Telegram appends the bot name: "/new@GroveBot".
        let (first, rest) = match text.split_once(char::is_whitespace) {
            Some((first, rest)) => (first, Some(rest)),
            None => (text, None),
        };
        let command = match first.split_once('@') {
            Some((command, bot))
                if command.starts_with('/') && bot.eq_ignore_ascii_case(&self.username) =>
            {
                command
            }
            Some(_) => return text.into(),
            None => first,
        };
        // /start is Telegram's greeting (and the pairing link). It is never a
        // prompt, even with a payload, so a replayed pairing code stays local.
        if command.eq_ignore_ascii_case("/start") {
            return "/help".into();
        }
        match rest {
            Some(rest) if command != first => format!("{command} {rest}"),
            _ if command != first => command.into(),
            _ => text.into(),
        }
    }

    async fn attachments(&self, message: &Value) -> Result<Vec<InboundAttachment>, String> {
        let mut files = Vec::new();
        if let Some(photo) = message["photo"].as_array().and_then(|sizes| sizes.last()) {
            files.push((photo, "photo.jpg".to_owned(), Some("image/jpeg".to_owned())));
        }
        for (key, fallback, mime) in [
            ("document", "file", None),
            ("voice", "voice.ogg", Some("audio/ogg")),
            ("audio", "audio", None),
        ] {
            let file = &message[key];
            if file.is_object() {
                let name = file["file_name"].as_str().unwrap_or(fallback).to_owned();
                let mime = file["mime_type"].as_str().or(mime).map(str::to_owned);
                files.push((file, name, mime));
            }
        }
        let mut attachments = Vec::new();
        for (file, name, mime_type) in files {
            if file["file_size"].as_u64().unwrap_or(0) > api::MAX_DOWNLOAD {
                return Err("Telegram bots can only download files up to 20 MB.".into());
            }
            let bytes = self
                .api
                .download(text(file, "file_id"))
                .await
                .map_err(|e| format!("Could not download the Telegram attachment: {e}"))?;
            let kind = match mime_type.as_deref() {
                Some(mime) if mime.starts_with("image/") => InboundAttachmentKind::Image,
                Some(mime) if mime.starts_with("audio/") => InboundAttachmentKind::Audio,
                _ => InboundAttachmentKind::File,
            };
            attachments.push(InboundAttachment {
                kind,
                name,
                mime_type,
                bytes,
            });
        }
        Ok(attachments)
    }

    async fn on_message(self: &Arc<Self>, message: &Value) -> Result<(), String> {
        if message["chat"]["type"] != "private"
            || message["chat"]["id"].as_i64() != Some(self.owner)
            || message["from"]["id"].as_i64() != Some(self.owner)
        {
            return Ok(());
        }
        let Some(message_id) = message["message_id"].as_i64() else {
            return Ok(());
        };
        let body = message["text"]
            .as_str()
            .or_else(|| message["caption"].as_str())
            .unwrap_or_default();
        let (attachments, mut unsupported) = match self.attachments(message).await {
            Ok(attachments) => (attachments, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        if unsupported.is_none() && body.trim().is_empty() && attachments.is_empty() {
            unsupported = Some(UNSUPPORTED.into());
        }
        let owner = self.owner.to_string();
        text_driver::dispatch(
            self.clone(),
            Inbound {
                id: message_id.to_string(),
                conversation: owner.clone(),
                sender: owner,
                text: self.normalize_command(body),
                attachments,
                unsupported,
            },
        )
        .await
    }

    async fn on_callback(self: &Arc<Self>, query: &Value) -> Result<(), String> {
        let _ = self
            .call(
                "answerCallbackQuery",
                json!({"callback_query_id": query["id"]}),
            )
            .await;
        let message_id = query["message"]["message_id"].as_i64();
        if query["from"]["id"].as_i64() != Some(self.owner)
            || query["message"]["chat"]["id"].as_i64() != Some(self.owner)
        {
            return Ok(());
        }
        let Some(message_id) = message_id else {
            return Ok(());
        };
        // Options are single-use: the reply carries the next step.
        let _ = self
            .call(
                "editMessageReplyMarkup",
                json!({"chat_id": self.owner, "message_id": message_id, "reply_markup": {"inline_keyboard": []}}),
            )
            .await;
        let command = text(query, "data")
            .strip_prefix("g:")
            .and_then(|token| self.callbacks.lock().unwrap().remove(token))
            .map(|(command, _)| command);
        let Some(command) = command else {
            return self
                .send(
                    &message_id.to_string(),
                    "These options have expired. Send the command again.",
                    Vec::new(),
                )
                .await;
        };
        let owner = self.owner.to_string();
        text_driver::dispatch(
            self.clone(),
            Inbound {
                id: message_id.to_string(),
                conversation: owner.clone(),
                sender: owner,
                text: command,
                attachments: Vec::new(),
                unsupported: None,
            },
        )
        .await
    }
}

#[async_trait]
impl TextChannel for TelegramAdapter {
    fn connection_id(&self) -> &str {
        &self.id
    }
    fn ui(&self) -> &Mutex<Ui> {
        &self.ui
    }
    async fn send(&self, message_id: &str, text: &str, buttons: Vec<Button>) -> Result<(), String> {
        let _guard = self.outgoing.lock().await;
        let mut chunks = markdown::chunk(text, MESSAGE_BYTES);
        if chunks.is_empty() {
            if buttons.is_empty() {
                return Ok(());
            }
            chunks.push("Choose an option:".into());
        }
        let last = chunks.len() - 1;
        for (index, chunk) in chunks.iter().enumerate() {
            let mut body =
                json!({"chat_id": self.owner, "link_preview_options": {"is_disabled": true}});
            if let (0, Ok(parent)) = (index, message_id.parse::<i64>()) {
                body["reply_parameters"] =
                    json!({"message_id": parent, "allow_sending_without_reply": true});
            }
            if index == last && !buttons.is_empty() {
                body["reply_markup"] = self.keyboard(&buttons);
            }
            self.send_chunk("sendMessage", body, chunk).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl TurnMessages for TelegramAdapter {
    fn max_bytes(&self) -> usize {
        MESSAGE_BYTES
    }
    fn edit_interval(&self) -> Duration {
        // Telegram allows about one message per second per chat.
        Duration::from_secs(1)
    }
    async fn post(&self, parent: &str, markdown: &str) -> Result<String, String> {
        let _guard = self.outgoing.lock().await;
        let mut body =
            json!({"chat_id": self.owner, "link_preview_options": {"is_disabled": true}});
        if let Ok(parent) = parent.parse::<i64>() {
            body["reply_parameters"] =
                json!({"message_id": parent, "allow_sending_without_reply": true});
        }
        let message = self.send_chunk("sendMessage", body, markdown).await?;
        message["message_id"]
            .as_i64()
            .map(|id| id.to_string())
            .ok_or_else(|| "Telegram returned no message id".into())
    }
    async fn edit(&self, message_id: &str, markdown: &str) -> Result<(), String> {
        let message_id: i64 = message_id
            .parse()
            .map_err(|_| "Invalid Telegram message id")?;
        let body = json!({"chat_id": self.owner, "message_id": message_id, "link_preview_options": {"is_disabled": true}});
        self.send_chunk("editMessageText", body, markdown)
            .await
            .map(|_| ())
    }
}

#[async_trait]
impl ConnectAdapter for TelegramAdapter {
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
        self.react(message_id, Some(WAITING))
            .await
            .then(|| WAITING.into())
    }
    async fn mark_working(&self, message_id: &str, _waiting: &Option<String>) -> Option<String> {
        let _ = self
            .call(
                "sendChatAction",
                json!({"chat_id": self.owner, "action": "typing"}),
            )
            .await;
        self.react(message_id, Some(WORKING))
            .await
            .then(|| WORKING.into())
    }
    async fn clear_status(&self, message_id: &str, receipt: &Option<String>) {
        if receipt.is_some() {
            self.react(message_id, None).await;
        }
    }
    async fn reply_text(&self, message_id: &str, text: &str) -> Result<(), String> {
        TextChannel::send(self, message_id, text, Vec::new()).await
    }
    async fn reply_card(&self, message_id: &str, spec: &CardSpec) -> Result<(), String> {
        text_driver::reply_card(self, message_id, spec).await
    }
}

async fn run(connection: Connect, cancel: CancellationToken) -> Result<(), String> {
    validate_config(&connection.domain, &connection.adapter_config, false)?;
    let config = &connection.adapter_config;
    let api = Api::new(text(config, "bot_token"))?;
    let owner: i64 = text(config, "user_id")
        .parse()
        .map_err(|_| "Invalid Telegram user_id")?;
    let mut failures = 0u32;
    let me = loop {
        match api.call("getMe", json!({}), Duration::from_secs(15)).await {
            Ok(me) => break me,
            Err(Error::Unauthorized) => return Err(Error::Unauthorized.to_string()),
            Err(error) => {
                failures = failures.saturating_add(1);
                status(&connection.id, "connecting", Some(error.to_string()));
                tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(failures.min(5)))).await;
            }
        }
    };
    let bot_id = me["id"].as_i64().unwrap_or_default().to_string();
    let adapter = Arc::new(TelegramAdapter {
        id: connection.id.clone(),
        api: api.clone(),
        owner,
        username: text(&me, "username").into(),
        cancel: cancel.clone(),
        ui: Mutex::new(Ui::default()),
        callbacks: Mutex::new(HashMap::new()),
        turns: TurnCards::default(),
        outgoing: tokio::sync::Mutex::new(()),
    });
    // Command menu in the private chat (best effort; does not affect routing).
    let commands: Vec<Value> = crate::connect::commands::COMMANDS
        .iter()
        .map(|command| json!({"command": command.name, "description": command.summary}))
        .collect();
    let _ = api
        .call(
            "setMyCommands",
            json!({"commands": commands, "scope": {"type": "chat", "chat_id": owner}}),
            Duration::from_secs(15),
        )
        .await;
    let path = Checkpoint::path(&connection.id);
    let mut checkpoint = Checkpoint::load(&path, &bot_id);
    failures = 0;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let mut body = json!({"timeout": 30, "allowed_updates": ["message", "callback_query"]});
        if checkpoint.offset > 0 {
            body["offset"] = json!(checkpoint.offset);
        }
        match api.call("getUpdates", body, Duration::from_secs(45)).await {
            Ok(updates) => {
                failures = 0;
                status(&connection.id, "online", None);
                for update in updates.as_array().map(Vec::as_slice).unwrap_or_default() {
                    let Some(update_id) = update["update_id"].as_i64() else {
                        continue;
                    };
                    if update_id < checkpoint.offset {
                        continue;
                    }
                    // A crash between delivery and this checkpoint may replay
                    // one update; Connect has no durable submission receipt.
                    let result = if update["message"].is_object() {
                        adapter.on_message(&update["message"]).await
                    } else if update["callback_query"].is_object() {
                        adapter.on_callback(&update["callback_query"]).await
                    } else {
                        Ok(())
                    };
                    if let Err(error) = result {
                        eprintln!("[connect:telegram] update delivery failed: {error}");
                    }
                    checkpoint.offset = update_id + 1;
                    checkpoint.save(&path)?;
                }
            }
            Err(Error::Unauthorized) => return Err(Error::Unauthorized.to_string()),
            Err(Error::Transport(error)) if error == "Telegram request timed out" => {}
            Err(error) => {
                failures = failures.saturating_add(1);
                status(&connection.id, "connecting", Some(error.to_string()));
                tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(failures.min(5)))).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";

    #[test]
    fn config_requires_a_paired_owner_and_hides_the_token() {
        let config = json!({"bot_token": TOKEN, "user_id": "42", "bot_username": "GroveBot"});
        assert!(validate_config("telegram", &config, false).is_ok());
        assert!(validate_config("telegram", &json!({"bot_token": TOKEN}), false).is_err());
        assert!(validate_config("weixin", &config, false).is_err());
        assert!(PLATFORM
            .public_config("telegram", &config)
            .get("bot_token")
            .is_none());
        let merged = PLATFORM
            .merge_config(
                "telegram",
                Some(&config),
                &json!({"bot_token": "", "user_id": "42"}),
            )
            .unwrap();
        assert_eq!(merged["bot_token"], TOKEN);
    }

    #[test]
    fn checkpoint_resets_when_the_bot_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        Checkpoint {
            bot_id: "1".into(),
            offset: 99,
        }
        .save(&path)
        .unwrap();
        assert_eq!(Checkpoint::load(&path, "1").offset, 99);
        assert_eq!(Checkpoint::load(&path, "2").offset, 0);
    }

    #[test]
    fn commands_addressed_to_this_bot_are_normalized() {
        let adapter = TelegramAdapter {
            id: "c".into(),
            api: Api::new(TOKEN).unwrap(),
            owner: 42,
            username: "GroveBot".into(),
            cancel: CancellationToken::new(),
            ui: Mutex::new(Ui::default()),
            callbacks: Mutex::new(HashMap::new()),
            turns: TurnCards::default(),
            outgoing: tokio::sync::Mutex::new(()),
        };
        assert_eq!(adapter.normalize_command("/new@grovebot"), "/new");
        assert_eq!(
            adapter.normalize_command("/target@GroveBot project 2"),
            "/target project 2"
        );
        assert_eq!(adapter.normalize_command("/new@OtherBot"), "/new@OtherBot");
        assert_eq!(adapter.normalize_command("mail a@b.c"), "mail a@b.c");
        assert_eq!(adapter.normalize_command("/start 0123abcd"), "/help");
        assert_eq!(adapter.normalize_command("/start@GroveBot"), "/help");
        assert_eq!(adapter.normalize_command("/new claude"), "/new claude");
        let keyboard = adapter.keyboard(&[Button {
            label: "Allow".into(),
            command: "/respond P1 allow".into(),
        }]);
        let data = keyboard["inline_keyboard"][0][0]["callback_data"]
            .as_str()
            .unwrap();
        assert!(data.len() <= 64);
        let token = data.strip_prefix("g:").unwrap();
        assert_eq!(
            adapter.callbacks.lock().unwrap()[token].0,
            "/respond P1 allow"
        );
    }
}
