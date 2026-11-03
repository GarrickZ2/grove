//! Telegram setup: the user pastes a @BotFather token, then proves ownership
//! by pressing Start on a one-time deep link. The account that sends the
//! code becomes the connection owner, so nobody else who discovers the bot
//! can claim it by messaging first.
use super::api::{Api, Error};
use crate::connect::registration::RegistrationView;
use once_cell::sync::Lazy;
use qrcode::{render::svg, QrCode};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio_util::sync::CancellationToken;

const TTL_SECONDS: i64 = 15 * 60;

struct Flow {
    view: RegistrationView,
    config: Option<Value>,
    user: String,
    finishing: bool,
    submitting: bool,
    cancel: CancellationToken,
}
static FLOWS: Lazy<Mutex<HashMap<String, Flow>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub async fn begin() -> Result<RegistrationView, String> {
    FLOWS.lock().unwrap().retain(|_, flow| {
        let keep = flow.view.expires_at > now();
        if !keep {
            flow.cancel.cancel();
        }
        keep
    });
    let view = RegistrationView {
        id: uuid::Uuid::new_v4().to_string(),
        platform: "telegram".into(),
        domain: "telegram".into(),
        state: "waiting_for_input".into(),
        verification_url: String::new(),
        qr_svg: String::new(),
        expires_at: now() + TTL_SECONDS,
        error: None,
        code: None,
    };
    FLOWS.lock().unwrap().insert(
        view.id.clone(),
        Flow {
            view: view.clone(),
            config: None,
            user: String::new(),
            finishing: false,
            submitting: false,
            cancel: CancellationToken::new(),
        },
    );
    Ok(view)
}

fn pairing_code() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_owned()
}

/// The pairing message: `/start <code>` from the deep link, or the code
/// typed by hand.
pub fn matches_code(text: &str, code: &str) -> bool {
    let mut parts = text.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(first), Some(second), None) => {
            first
                .split('@')
                .next()
                .is_some_and(|command| command.eq_ignore_ascii_case("/start"))
                && second == code
        }
        (Some(only), None, None) => only == code,
        _ => false,
    }
}

pub async fn submit(id: &str, input: Value) -> Result<RegistrationView, String> {
    let token = input["bot_token"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let cancel = {
        let mut flows = FLOWS.lock().unwrap();
        let flow = flows.get_mut(id).ok_or("Authorization flow not found")?;
        if flow.view.state != "waiting_for_input"
            || flow.submitting
            || flow.view.expires_at <= now()
        {
            return Err("This authorization flow is not waiting for a bot token".into());
        }
        flow.submitting = true;
        flow.cancel.clone()
    };
    let result = prepare(&token).await;
    let mut flows = FLOWS.lock().unwrap();
    let flow = flows.get_mut(id).ok_or("Authorization flow not found")?;
    flow.submitting = false;
    let (api, bot) = result?;
    let code = pairing_code();
    let username = bot["username"].as_str().unwrap_or_default().to_owned();
    let link = format!("https://t.me/{username}?start={code}");
    flow.view.qr_svg = QrCode::new(link.as_bytes())
        .map_err(|_| "Invalid Telegram link")?
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();
    flow.view.verification_url = link;
    flow.view.code = Some(code.clone());
    flow.view.state = "waiting_for_scan".into();
    flow.view.error = None;
    flow.config = Some(json!({
        "bot_token": token,
        "bot_id": bot["id"].as_i64().map(|id| id.to_string()).unwrap_or_default(),
        "bot_username": username,
    }));
    tokio::spawn(poll(id.to_owned(), api, code, cancel));
    Ok(flow.view.clone())
}

async fn prepare(token: &str) -> Result<(Api, Value), String> {
    let api = Api::new(token)?;
    let bot = api
        .call("getMe", json!({}), Duration::from_secs(15))
        .await
        .map_err(|e| e.to_string())?;
    if bot["is_bot"].as_bool() != Some(true) || bot["username"].as_str().is_none() {
        return Err("This token does not belong to a Telegram bot".into());
    }
    // getUpdates and webhooks are mutually exclusive. This bot is being
    // dedicated to Grove, so take over delivery explicitly.
    api.call(
        "deleteWebhook",
        json!({"drop_pending_updates": false}),
        Duration::from_secs(15),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok((api, bot))
}

async fn poll(id: String, api: Api, code: String, cancel: CancellationToken) {
    let mut offset: Option<i64> = None;
    loop {
        if get(&id).is_none_or(|view| view.expires_at <= now()) {
            fail(&id, "The pairing link expired. Start again.");
            return;
        }
        let mut body = json!({"timeout": 20, "allowed_updates": ["message"]});
        if let Some(offset) = offset {
            body["offset"] = json!(offset);
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => return,
            result = api.call("getUpdates", body, Duration::from_secs(30)) => result,
        };
        let updates = match result {
            Ok(updates) => updates,
            Err(Error::Unauthorized) => {
                fail(&id, &Error::Unauthorized.to_string());
                return;
            }
            // A running connection for the same bot (re-pairing) also polls;
            // keep retrying until the window closes.
            Err(_) => {
                tokio::select! { _ = cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
                continue;
            }
        };
        for update in updates.as_array().map(Vec::as_slice).unwrap_or_default() {
            let Some(update_id) = update["update_id"].as_i64() else {
                continue;
            };
            offset = Some(update_id + 1);
            let message = &update["message"];
            let private = message["chat"]["type"] == "private";
            let user = message["from"]["id"].as_i64();
            let text = message["text"].as_str().unwrap_or_default();
            let (Some(user), true) = (user, private && matches_code(text, &code)) else {
                continue;
            };
            // Confirm the pairing update so the connection does not replay it.
            let _ = api
                .call(
                    "getUpdates",
                    json!({"offset": update_id + 1, "timeout": 0, "allowed_updates": ["message"]}),
                    Duration::from_secs(15),
                )
                .await;
            let _ = api
                .call(
                    "sendMessage",
                    json!({"chat_id": user, "text": "Connected to Grove. Choose a target in Grove, then send messages here. Send /help for commands."}),
                    Duration::from_secs(15),
                )
                .await;
            if let Some(flow) = FLOWS.lock().unwrap().get_mut(&id) {
                if let Some(config) = flow.config.as_mut() {
                    config["user_id"] = json!(user.to_string());
                }
                flow.user = user.to_string();
                flow.view.state = "authorized".into();
                flow.view.error = None;
            }
            return;
        }
    }
}

fn fail(id: &str, error: &str) {
    if let Some(flow) = FLOWS.lock().unwrap().get_mut(id) {
        flow.view.state = "error".into();
        flow.view.error = Some(error.into());
    }
}

pub fn get(id: &str) -> Option<RegistrationView> {
    FLOWS.lock().unwrap().get(id).map(|flow| flow.view.clone())
}

pub fn claim(id: &str) -> Option<(String, Value, String, String)> {
    let mut flows = FLOWS.lock().unwrap();
    let flow = flows.get_mut(id)?;
    if flow.finishing || flow.view.state != "authorized" || flow.view.expires_at <= now() {
        return None;
    }
    let config = flow.config.clone()?;
    flow.finishing = true;
    Some((
        "telegram".into(),
        config,
        "telegram".into(),
        flow.user.clone(),
    ))
}
pub fn release(id: &str) {
    if let Some(flow) = FLOWS.lock().unwrap().get_mut(id) {
        flow.finishing = false;
    }
}
pub fn finish(id: &str) {
    if let Some(flow) = FLOWS.lock().unwrap().remove(id) {
        flow.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_code_pairs() {
        assert!(matches_code("/start abc123", "abc123"));
        assert!(matches_code("/start@GroveBot abc123", "abc123"));
        assert!(matches_code("abc123", "abc123"));
        assert!(!matches_code("/start", "abc123"));
        assert!(!matches_code("/start abc12", "abc123"));
        assert!(!matches_code("hello abc123", "abc123"));
        assert!(!matches_code("/start abc123 extra", "abc123"));
    }

    #[tokio::test]
    async fn token_is_required_and_never_exposed_in_the_view() {
        let view = begin().await.unwrap();
        assert_eq!(view.state, "waiting_for_input");
        assert!(submit(&view.id, json!({"bot_token": "nope"}))
            .await
            .is_err());
        // A failed token leaves the flow open for another attempt.
        assert_eq!(get(&view.id).unwrap().state, "waiting_for_input");
        assert!(claim(&view.id).is_none());
        {
            let mut flows = FLOWS.lock().unwrap();
            let flow = flows.get_mut(&view.id).unwrap();
            flow.config = Some(json!({"bot_token": "123:secret", "user_id": "42"}));
            flow.user = "42".into();
            flow.view.state = "authorized".into();
        }
        assert!(!serde_json::to_string(&get(&view.id).unwrap())
            .unwrap()
            .contains("secret"));
        assert_eq!(claim(&view.id).unwrap().3, "42");
        assert!(claim(&view.id).is_none());
        finish(&view.id);
        assert!(get(&view.id).is_none());
    }
}
