//! Slack setup: the user creates the app from Grove's manifest, pastes the
//! bot and app-level tokens, then DMs the bot a one-time code. Whoever sends
//! the code becomes the connection owner; the rest of the workspace cannot
//! claim the bot by messaging it first.
use super::api::{self, Api, Socket};
use crate::connect::registration::RegistrationView;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
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
        platform: "slack".into(),
        domain: "slack".into(),
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
    let raw = uuid::Uuid::new_v4().simple().to_string().to_uppercase();
    format!("{}-{}", &raw[..4], &raw[4..8])
}

/// Bot identity and workspace for a token pair, checked before pairing.
pub struct Identity {
    pub bot: Api,
    pub app: Api,
    pub team_id: String,
    pub bot_user_id: String,
    pub app_id: String,
}

pub async fn identify(bot_token: &str, app_token: &str) -> Result<Identity, String> {
    if !api::valid_bot_token(bot_token) {
        return Err("The bot token must start with xoxb-".into());
    }
    if !api::valid_app_token(app_token) {
        return Err("The app-level token must start with xapp-".into());
    }
    let bot = Api::new(bot_token)?;
    let app = Api::new(app_token)?;
    let auth = bot
        .call("auth.test", &[])
        .await
        .map_err(|e| e.to_string())?;
    let bot_id = auth["bot_id"].as_str().unwrap_or_default().to_owned();
    let app_id = match bot.call("bots.info", &[("bot", bot_id)]).await {
        Ok(info) => info["bot"]["app_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        Err(_) => String::new(),
    };
    Ok(Identity {
        bot,
        app,
        team_id: auth["team_id"].as_str().unwrap_or_default().into(),
        bot_user_id: auth["user_id"].as_str().unwrap_or_default().into(),
        app_id,
    })
}

pub async fn submit(id: &str, input: Value) -> Result<RegistrationView, String> {
    let bot_token = input["bot_token"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let app_token = input["app_token"]
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
            return Err("This authorization flow is not waiting for Slack tokens".into());
        }
        flow.submitting = true;
        flow.cancel.clone()
    };
    let result = async {
        let identity = identify(&bot_token, &app_token).await?;
        // Opening the socket proves the app-level token and Socket Mode.
        let socket = Socket::open(&identity.app)
            .await
            .map_err(|error| match error {
                api::Error::Rejected(code) if code == "not_allowed_token_type" => {
                    "The app-level token needs the connections:write scope".to_owned()
                }
                error => error.to_string(),
            })?;
        Ok::<_, String>((identity, socket))
    }
    .await;
    let mut flows = FLOWS.lock().unwrap();
    let flow = flows.get_mut(id).ok_or("Authorization flow not found")?;
    flow.submitting = false;
    let (identity, socket) = result?;
    let code = pairing_code();
    flow.view.verification_url = if identity.app_id.is_empty() {
        format!("https://slack.com/app_redirect?team={}", identity.team_id)
    } else {
        format!(
            "https://slack.com/app_redirect?app={}&team={}",
            identity.app_id, identity.team_id
        )
    };
    flow.view.code = Some(code.clone());
    flow.view.state = "waiting_for_scan".into();
    flow.view.error = None;
    flow.config = Some(json!({
        "bot_token": bot_token,
        "app_token": app_token,
        "team_id": identity.team_id,
        "bot_user_id": identity.bot_user_id,
        "app_id": identity.app_id,
    }));
    tokio::spawn(poll(id.to_owned(), identity.bot, socket, code, cancel));
    Ok(flow.view.clone())
}

/// `message.im` from a human (not a bot, not an edit or join notice).
pub fn human_message(event: &Value) -> bool {
    event["type"] == "message"
        && event["channel_type"] == "im"
        && event["bot_id"].is_null()
        && matches!(event["subtype"].as_str(), None | Some("file_share"))
        && event["user"].is_string()
}

pub fn matches_code(text: &str, code: &str) -> bool {
    text.trim().trim_matches('`').eq_ignore_ascii_case(code)
}

async fn poll(id: String, bot: Api, mut socket: Socket, code: String, cancel: CancellationToken) {
    let deadline = get(&id).map(|view| view.expires_at).unwrap_or_default();
    let remaining = std::time::Duration::from_secs((deadline - now()).max(0) as u64);
    let wait = async {
        loop {
            let envelope = match socket.next().await {
                Ok(Some(envelope)) => envelope,
                // Slack rotates sockets; reconnect for the rest of the window.
                Ok(None) | Err(_) => match reopen(&id).await {
                    Some(next) => {
                        socket = next;
                        continue;
                    }
                    None => return None,
                },
            };
            let event = &envelope.payload["event"];
            if envelope.kind == "events_api"
                && human_message(event)
                && matches_code(event["text"].as_str().unwrap_or_default(), &code)
            {
                return Some((
                    event["user"].as_str().unwrap_or_default().to_owned(),
                    event["channel"].as_str().unwrap_or_default().to_owned(),
                ));
            }
        }
    };
    let paired = tokio::select! {
        _ = cancel.cancelled() => return,
        _ = tokio::time::sleep(remaining) => None,
        paired = wait => paired,
    };
    let Some((user, channel)) = paired else {
        fail(
            &id,
            "Pairing timed out or the Slack connection dropped. Start again.",
        );
        return;
    };
    let _ = bot
        .call(
            "chat.postMessage",
            &[
                ("channel", channel.clone()),
                ("text", "Connected to Grove. Choose a target in Grove, then send messages here. Type `/grove help` for commands.".into()),
            ],
        )
        .await;
    if let Some(flow) = FLOWS.lock().unwrap().get_mut(&id) {
        if let Some(config) = flow.config.as_mut() {
            config["user_id"] = json!(user);
            config["channel_id"] = json!(channel);
        }
        flow.user = user;
        flow.view.state = "authorized".into();
        flow.view.error = None;
    }
}

async fn reopen(flow_id: &str) -> Option<Socket> {
    let token = FLOWS.lock().unwrap().get(flow_id)?.config.as_ref()?["app_token"]
        .as_str()?
        .to_owned();
    Socket::open(&Api::new(&token).ok()?).await.ok()
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
    Some(("slack".into(), config, "slack".into(), flow.user.clone()))
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
    fn pairing_accepts_only_a_human_dm_with_the_exact_code() {
        let event = json!({"type": "message", "channel_type": "im", "user": "U1", "text": "ab12-cd34", "channel": "D1"});
        assert!(human_message(&event));
        assert!(matches_code("`AB12-CD34` ", "AB12-CD34"));
        assert!(!matches_code("AB12-CD3", "AB12-CD34"));
        let mut bot = event.clone();
        bot["bot_id"] = json!("B1");
        assert!(!human_message(&bot));
        let mut channel = event.clone();
        channel["channel_type"] = json!("channel");
        assert!(!human_message(&channel));
        let mut edit = event;
        edit["subtype"] = json!("message_changed");
        assert!(!human_message(&edit));
    }

    #[tokio::test]
    async fn malformed_tokens_keep_the_flow_open_and_secrets_stay_private() {
        let view = begin().await.unwrap();
        let error = submit(
            &view.id,
            json!({"bot_token": "xapp-wrong-kind-of-token", "app_token": "xapp-1-A1-2-abcdefghijk"}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("xoxb-"));
        assert_eq!(get(&view.id).unwrap().state, "waiting_for_input");
        {
            let mut flows = FLOWS.lock().unwrap();
            let flow = flows.get_mut(&view.id).unwrap();
            flow.config = Some(json!({"bot_token": "xoxb-secret", "app_token": "xapp-secret"}));
            flow.user = "U1".into();
            flow.view.state = "authorized".into();
        }
        assert!(!serde_json::to_string(&get(&view.id).unwrap())
            .unwrap()
            .contains("secret"));
        assert_eq!(claim(&view.id).unwrap().3, "U1");
        finish(&view.id);
        assert!(claim(&view.id).is_none());
    }
}
