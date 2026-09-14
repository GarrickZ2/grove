use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use flate2::{write::GzEncoder, Compression};
use once_cell::sync::Lazy;
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::json;

const FEISHU_ACCOUNTS: &str = "https://accounts.feishu.cn";
const LARK_ACCOUNTS: &str = "https://accounts.larksuite.com";
const REGISTRATION_PATH: &str = "/oauth/v1/app/registration";

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationView {
    pub id: String,
    pub platform: String,
    pub state: String,
    pub verification_url: String,
    pub qr_svg: String,
    pub expires_at: i64,
    pub domain: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct RegistrationFlow {
    view: RegistrationView,
    app_id: Option<String>,
    app_secret: Option<String>,
    /// Open id of the user who authorized the QR flow. Pre-seeded onto the
    /// connection so a bot visible to the whole tenant cannot be captured by
    /// whichever tenant member messages first.
    user_open_id: Option<String>,
    finishing: bool,
}

#[derive(Debug, Deserialize)]
struct BeginResponse {
    device_code: String,
    verification_uri_complete: String,
    #[serde(default = "default_interval")]
    interval: u64,
    #[serde(default = "default_expiry", alias = "expire_in")]
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct PollResponse {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    user_info: Option<UserInfo>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    tenant_brand: Option<String>,
    /// The authorizing user — requested via `request_user_info: "open_id"`.
    #[serde(default)]
    open_id: Option<String>,
}

static FLOWS: Lazy<Mutex<HashMap<String, RegistrationFlow>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn default_interval() -> u64 {
    5
}
fn default_expiry() -> i64 {
    600
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn addons() -> Result<String, String> {
    let payload = json!({
        "preset": false,
        "scopes": { "tenant": ["im:message", "im:message:send_as_bot", "im:message.reactions:write_only"] },
        "events": { "items": { "tenant": ["im.message.receive_v1"] } }
    });
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    let compressed = encoder.finish().map_err(|error| error.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(compressed))
}

pub async fn begin(platform: &str, domain: &str) -> Result<RegistrationView, String> {
    FLOWS
        .lock()
        .unwrap()
        .retain(|_, flow| flow.view.expires_at + 600 > now());
    let platform = if platform == "lark" { "lark" } else { "feishu" };
    let domain = if domain == "lark" { "lark" } else { "feishu" };
    let accounts_domain = if domain == "lark" {
        LARK_ACCOUNTS
    } else {
        FEISHU_ACCOUNTS
    };
    let response = reqwest::Client::new()
        .post(format!("{accounts_domain}{REGISTRATION_PATH}"))
        .form(&[
            ("action", "begin"),
            ("archetype", "PersonalAgent"),
            ("auth_method", "client_secret"),
            ("request_user_info", "open_id"),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<BeginResponse>()
        .await
        .map_err(|error| error.to_string())?;
    if response.device_code.is_empty() || response.verification_uri_complete.is_empty() {
        return Err("Feishu returned an incomplete registration response".into());
    }
    let mut url =
        url::Url::parse(&response.verification_uri_complete).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("from", "sdk")
        .append_pair("tp", "sdk")
        .append_pair("source", "rust-sdk/grove")
        .append_pair("name", "Grove Assistant")
        .append_pair("desc", "Control a Grove Agent from Feishu or Lark")
        .append_pair("addons", &addons()?);
    let verification_url = url.to_string();
    let qr_svg = QrCode::new(verification_url.as_bytes())
        .map_err(|error| error.to_string())?
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();
    let id = uuid::Uuid::new_v4().to_string();
    let view = RegistrationView {
        id: id.clone(),
        platform: platform.into(),
        state: "waiting_for_scan".into(),
        verification_url,
        qr_svg,
        expires_at: now() + response.expires_in.max(60),
        domain: domain.into(),
        error: None,
    };
    FLOWS.lock().unwrap().insert(
        id.clone(),
        RegistrationFlow {
            view: view.clone(),
            app_id: None,
            app_secret: None,
            user_open_id: None,
            finishing: false,
        },
    );
    tokio::spawn(poll(
        id,
        response.device_code,
        accounts_domain,
        domain,
        response.interval.max(1),
        response.expires_in.max(60),
    ));
    Ok(view)
}

async fn poll(
    id: String,
    device_code: String,
    initial_accounts_domain: &'static str,
    requested_domain: &'static str,
    mut interval: u64,
    expires_in: i64,
) {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(expires_in.max(60) as u64);
    let mut domain = initial_accounts_domain;
    let mut switched = requested_domain == "lark";
    loop {
        if tokio::time::Instant::now() >= deadline {
            fail(&id, "QR code expired");
            return;
        }
        let response = client
            .post(format!("{domain}{REGISTRATION_PATH}"))
            .form(&[("action", "poll"), ("device_code", device_code.as_str())])
            .send()
            .await;
        let result = match response {
            Ok(response) => response.json::<PollResponse>().await,
            Err(error) => {
                eprintln!("[connect] registration poll failed, retrying: {error}");
                tokio::time::sleep(Duration::from_secs(interval)).await;
                continue;
            }
        };
        let response = match result {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[connect] invalid registration poll response, retrying: {error}");
                tokio::time::sleep(Duration::from_secs(interval)).await;
                continue;
            }
        };
        if response
            .user_info
            .as_ref()
            .and_then(|info| info.tenant_brand.as_deref())
            == Some("lark")
            && !switched
        {
            domain = LARK_ACCOUNTS;
            switched = true;
            continue;
        }
        if !response.client_id.is_empty() && !response.client_secret.is_empty() {
            if let Some(flow) = FLOWS.lock().unwrap().get_mut(&id) {
                flow.view.state = "authorized".into();
                let resolved_domain = if switched { "lark" } else { "feishu" };
                flow.view.domain = resolved_domain.into();
                // Feishu and Lark share the implementation today, but they
                // remain distinct connection identities in storage.
                flow.view.platform = resolved_domain.into();
                flow.app_id = Some(response.client_id);
                flow.app_secret = Some(response.client_secret);
                flow.user_open_id = response
                    .user_info
                    .as_ref()
                    .and_then(|info| info.open_id.clone());
            }
            return;
        }
        match response.error.as_deref() {
            Some("slow_down") => interval += 5,
            Some("access_denied") => {
                fail(&id, "Authorization was denied");
                return;
            }
            Some("expired_token") => {
                fail(&id, "QR code expired");
                return;
            }
            Some("authorization_pending") | None => {}
            Some(code) => {
                fail(&id, response.error_description.as_deref().unwrap_or(code));
                return;
            }
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

fn fail(id: &str, message: &str) {
    if let Some(flow) = FLOWS.lock().unwrap().get_mut(id) {
        flow.view.state = "error".into();
        flow.view.error = Some(message.into());
    }
}

pub fn get(id: &str) -> Option<RegistrationView> {
    FLOWS.lock().unwrap().get(id).map(|flow| flow.view.clone())
}

/// Credentials plus the authorizing user's open id (empty when the platform
/// did not return one) for the connection about to be created.
pub fn claim_credentials(id: &str) -> Option<(String, serde_json::Value, String, String)> {
    let mut flows = FLOWS.lock().unwrap();
    let flow = flows.get_mut(id)?;
    if flow.finishing || flow.view.state != "authorized" {
        return None;
    }
    flow.finishing = true;
    Some((
        flow.view.platform.clone(),
        serde_json::json!({
            "app_id": flow.app_id.clone()?,
            "app_secret": flow.app_secret.clone()?,
        }),
        flow.view.domain.clone(),
        flow.user_open_id.clone().unwrap_or_default(),
    ))
}

pub fn release_credentials(id: &str) {
    if let Some(flow) = FLOWS.lock().unwrap().get_mut(id) {
        flow.finishing = false;
    }
}

pub fn finish(id: &str) {
    FLOWS.lock().unwrap().remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_credentials_have_one_finish_owner() {
        let id = uuid::Uuid::new_v4().to_string();
        FLOWS.lock().unwrap().insert(
            id.clone(),
            RegistrationFlow {
                view: RegistrationView {
                    id: id.clone(),
                    platform: "feishu".into(),
                    state: "authorized".into(),
                    verification_url: String::new(),
                    qr_svg: String::new(),
                    expires_at: now() + 60,
                    domain: "feishu".into(),
                    error: None,
                },
                app_id: Some("app".into()),
                app_secret: Some("secret".into()),
                user_open_id: Some("user".into()),
                finishing: false,
            },
        );

        assert!(claim_credentials(&id).is_some());
        assert!(claim_credentials(&id).is_none());
        release_credentials(&id);
        assert!(claim_credentials(&id).is_some());
        finish(&id);
    }
}
