//! Shared inbound dispatch for text-first IM adapters (WeChat, Telegram,
//! Slack). Adapters decode their native events into [`Inbound`] and supply a
//! [`TextChannel`]; staged menus, forms and Core hand-off live here once.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;

use super::{
    adapter::{
        AdapterRef, ConnectAdapter, InboundAction, InboundAttachment, InboundMessage, NoticeLevel,
    },
    commands::CardSpec,
    text_ui::{Button, Response, Ui},
};
use crate::storage::connects::Connect;

pub const HELP: &str = "/new [agent_id] — Create a session\n/target [project|task|session] [option] — Switch target\n/config [setting] [option] — Configure the session\n/status — Current status\n/cancel — Cancel the agent's current turn\n/skill <name> [prompt] — Run a skill\n/respond <request_id> <option> — Respond to a permission request\n/answer <request_id> <field_id> <answer> — Save a draft form answer\n/submit <request_id> — Submit a form\n/decline <request_id> — Decline a form\nOther messages are sent to the agent. Incomplete target selections do not take effect.";

/// One owner message (or a pressed button replaying its command).
pub struct Inbound {
    /// Platform message id; replies and status markers attach to it.
    pub id: String,
    pub conversation: String,
    pub sender: String,
    pub text: String,
    pub attachments: Vec<InboundAttachment>,
    /// When set, the message carried content this adapter cannot deliver;
    /// the notice is sent instead and pending menus are cancelled.
    pub unsupported: Option<String>,
}

// async_trait emits #[must_use] on boxed futures; see ConnectAdapter.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait TextChannel: ConnectAdapter + Sized {
    fn connection_id(&self) -> &str;
    fn ui(&self) -> &Mutex<Ui>;
    /// Sends `text` in reply to `message_id`. Adapters without buttons ignore
    /// `buttons`; every button command is also spelled out in `text`.
    async fn send(&self, message_id: &str, text: &str, buttons: Vec<Button>) -> Result<(), String>;
}

pub fn scope(connection: &Connect) -> String {
    format!(
        "{}\0{}\0{}",
        connection.project_id, connection.task_id, connection.session_id
    )
}

fn current(id: &str) -> Result<Connect, String> {
    crate::storage::connects::get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Connection no longer exists".into())
}

/// `ConnectAdapter::reply_card` for text adapters.
pub async fn reply_card<T: TextChannel>(
    channel: &T,
    message_id: &str,
    spec: &CardSpec,
) -> Result<(), String> {
    let scope = scope(&current(channel.connection_id())?);
    let (text, buttons) = {
        let mut ui = channel.ui().lock().unwrap();
        let text = ui.render(spec, message_id, &scope)?;
        (text, ui.take_buttons())
    };
    channel.send(message_id, &text, buttons).await
}

async fn send_plain<T: TextChannel>(
    channel: &T,
    message_id: &str,
    text: &str,
) -> Result<(), String> {
    channel.send(message_id, text, Vec::new()).await
}

pub async fn dispatch<T: TextChannel>(channel: Arc<T>, message: Inbound) -> Result<(), String> {
    let id = channel.connection_id().to_owned();
    let current = current(&id)?;
    if !current.enabled {
        return Err("Connection disabled".into());
    }
    if !crate::storage::connects::bind_private_chat(&id, &message.conversation, &message.sender)
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let inbound = |body: String, attachments: Vec<InboundAttachment>| InboundMessage {
        external_message_id: message.id.clone(),
        conversation_id: message.conversation.clone(),
        sender_id: message.sender.clone(),
        text: body,
        attachments,
    };
    let adapter: AdapterRef = channel.clone();
    let target_scope = scope(&current);
    if let Some(notice) = &message.unsupported {
        let _ = channel
            .ui()
            .lock()
            .unwrap()
            .command("", &message.id, &target_scope);
        return send_plain(&*channel, &message.id, notice).await;
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
        let available = channel.ui().lock().unwrap().has_menu(kind, &target_scope);
        if !available {
            // Open the menu first so a one-shot "/target project 2" resolves.
            crate::connect::core::handle_message(
                &id,
                adapter.clone(),
                inbound(command.clone(), Vec::new()),
            )
            .await;
        }
    }
    if command == "/help" && parts.len() == 1 {
        let _ = channel
            .ui()
            .lock()
            .unwrap()
            .command("", &message.id, &target_scope);
        return send_plain(&*channel, &message.id, HELP).await;
    }
    let (response, buttons) = {
        let mut ui = channel.ui().lock().unwrap();
        let response = ui.command(&message.text, &message.id, &target_scope);
        (response, ui.take_buttons())
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => return send_plain(&*channel, &message.id, &error).await,
    };
    match response {
        Response::Pass => {
            crate::connect::core::handle_message(
                &id,
                adapter,
                inbound(message.text.clone(), message.attachments.clone()),
            )
            .await
        }
        Response::Text(text) => channel.send(&message.id, &text, buttons).await?,
        Response::RefreshTarget { fields, stage } => {
            let result = crate::connect::core::handle_action(
                &id,
                adapter,
                InboundAction {
                    conversation_id: message.conversation.clone(),
                    sender_id: message.sender.clone(),
                    source_message_id: Some(message.id.clone()),
                    name: Some("update_options_btn".into()),
                    fields,
                },
            )
            .await?;
            if let Some(card) = result.card {
                let (text, buttons) = {
                    let mut ui = channel.ui().lock().unwrap();
                    ui.render(&card, &message.id, &target_scope)?;
                    let text = ui.next_target(&stage);
                    (text, ui.take_buttons())
                };
                channel.send(&message.id, &text, buttons).await?;
            }
        }
        Response::Action {
            name,
            fields,
            source,
        } => {
            action(&*channel, adapter, &message, name, fields, source).await?;
        }
    }
    Ok(())
}

async fn action<T: TextChannel>(
    channel: &T,
    adapter: AdapterRef,
    message: &Inbound,
    name: String,
    fields: HashMap<String, String>,
    source: String,
) -> Result<(), String> {
    let result = crate::connect::core::handle_action(
        channel.connection_id(),
        adapter,
        InboundAction {
            conversation_id: message.conversation.clone(),
            sender_id: message.sender.clone(),
            source_message_id: Some(source),
            name: Some(name.clone()),
            fields: fields.clone(),
        },
    )
    .await;
    match result {
        Ok(result) => {
            if result
                .notice
                .as_ref()
                .is_some_and(|(level, _)| matches!(level, NoticeLevel::Success | NoticeLevel::Info))
            {
                channel
                    .ui()
                    .lock()
                    .unwrap()
                    .action_completed(&name, &fields);
            }
            if let Some(card) = result.card {
                if !matches!(&card, CardSpec::Notice(_)) {
                    if let Some((_, text)) = result.notice {
                        send_plain(channel, &message.id, &text).await?;
                    }
                }
                reply_card(channel, &message.id, &card).await?;
            } else if let Some((_, text)) = result.notice {
                send_plain(channel, &message.id, &text).await?;
            }
        }
        Err(error) => send_plain(channel, &message.id, &error).await?,
    }
    Ok(())
}
