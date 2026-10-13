use super::api::{Api, BASE_URL};
use crate::connect::registration::RegistrationView;
use once_cell::sync::Lazy;
use qrcode::{render::svg, QrCode};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio_util::sync::CancellationToken;

struct Flow {
    view: RegistrationView,
    config: Option<Value>,
    user: String,
    finishing: bool,
    code: Option<String>,
    cancel: CancellationToken,
    wake: std::sync::Arc<tokio::sync::Notify>,
}
static FLOWS: Lazy<Mutex<HashMap<String, Flow>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub async fn begin() -> Result<RegistrationView, String> {
    {
        let mut flows = FLOWS.lock().unwrap();
        flows.retain(|_, flow| {
            let keep = flow.view.expires_at > chrono::Utc::now().timestamp();
            if !keep {
                flow.cancel.cancel();
            }
            keep
        });
    }
    let api = Api::new(BASE_URL, None)?;
    let result = api
        .post(
            "/ilink/bot/get_bot_qrcode?bot_type=3",
            json!({"local_token_list": []}),
            Duration::from_secs(15),
            false,
        )
        .await
        .map_err(|e| e.to_string())?;
    let qrcode = result["qrcode"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("WeChat returned no QR code")?
        .to_owned();
    let verification_url = result["qrcode_img_content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("WeChat returned no QR content")?
        .to_owned();
    let qr_svg = QrCode::new(verification_url.as_bytes())
        .map_err(|_| "Invalid WeChat QR content")?
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();
    let view = RegistrationView {
        id: uuid::Uuid::new_v4().to_string(),
        platform: "weixin".into(),
        domain: "weixin".into(),
        state: "waiting_for_scan".into(),
        verification_url,
        qr_svg,
        expires_at: chrono::Utc::now().timestamp() + 480,
        error: None,
    };
    let cancel = CancellationToken::new();
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    FLOWS.lock().unwrap().insert(
        view.id.clone(),
        Flow {
            view: view.clone(),
            config: None,
            user: String::new(),
            finishing: false,
            code: None,
            cancel: cancel.clone(),
            wake: wake.clone(),
        },
    );
    tokio::spawn(poll(view.id.clone(), qrcode, api, cancel, wake));
    Ok(view)
}

async fn poll(
    id: String,
    qrcode: String,
    mut api: Api,
    cancel: CancellationToken,
    wake: std::sync::Arc<tokio::sync::Notify>,
) {
    loop {
        let Some(view) = get(&id) else {
            return;
        };
        if view.expires_at <= chrono::Utc::now().timestamp() {
            fail(&id, "QR code expired. Refresh to try again.");
            return;
        }
        let code = FLOWS
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|flow| flow.code.clone());
        if view.state == "waiting_for_input" && code.is_none() {
            tokio::select! { _ = cancel.cancelled() => return, _ = wake.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
            continue;
        }
        let response = tokio::select! {
            _ = cancel.cancelled() => return,
            result = api.qr_status(&qrcode, code.as_deref()) => result,
        };
        // Transient request failures retry until the QR flow expires.
        if let Ok(result) = response {
            match result["status"].as_str().unwrap_or_default() {
                "confirmed" => {
                    let config = json!({"bot_token": result["bot_token"], "bot_id": result["ilink_bot_id"], "base_url": result["baseurl"].as_str().unwrap_or(BASE_URL), "user_id": result["ilink_user_id"]});
                    if let Err(error) = super::validate_config("weixin", &config, false) {
                        fail(&id, &error);
                        return;
                    }
                    if let Some(flow) = FLOWS.lock().unwrap().get_mut(&id) {
                        flow.user = config["user_id"].as_str().unwrap_or_default().into();
                        flow.config = Some(config);
                        flow.code = None;
                        flow.view.state = "authorized".into();
                        flow.view.error = None;
                    }
                    return;
                }
                "need_verifycode" => {
                    if let Some(flow) = FLOWS.lock().unwrap().get_mut(&id) {
                        flow.view.state = "waiting_for_input".into();
                        flow.view.error = code.as_ref().map(|_| {
                            "The code did not match. Enter the digits shown in WeChat again.".into()
                        });
                        flow.code = None;
                    }
                }
                "scaned" => {
                    if let Some(flow) = FLOWS.lock().unwrap().get_mut(&id) {
                        flow.view.state = "waiting_for_scan".into();
                        flow.view.error = None;
                        flow.code = None;
                    }
                }
                "scaned_but_redirect" => {
                    let host = result["redirect_host"].as_str().unwrap_or_default();
                    let base = if host.starts_with("https://") {
                        host.to_owned()
                    } else {
                        format!("https://{host}")
                    };
                    match Api::new(&base, None) {
                        Ok(next) => api = next,
                        Err(error) => {
                            fail(&id, &error);
                            return;
                        }
                    }
                }
                "expired" => {
                    fail(&id, "QR code expired. Refresh to try again.");
                    return;
                }
                "verify_code_blocked" => {
                    fail(
                        &id,
                        "Too many incorrect verification codes. Refresh to try again.",
                    );
                    return;
                }
                "binded_redirect" => {
                    fail(
                        &id,
                        "This bot is already bound. Refresh and authorize this Grove instance.",
                    );
                    return;
                }
                "wait" => {}
                _ => {
                    fail(&id, "Unrecognized WeChat authorization status");
                    return;
                }
            }
        }
        tokio::select! { _ = cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
    }
}

fn fail(id: &str, error: &str) {
    if let Some(flow) = FLOWS.lock().unwrap().get_mut(id) {
        flow.view.state = "error".into();
        flow.view.error = Some(error.into());
        flow.code = None;
    }
}

pub fn get(id: &str) -> Option<RegistrationView> {
    FLOWS.lock().unwrap().get(id).map(|flow| flow.view.clone())
}

pub fn submit(id: &str, input: Value) -> Result<RegistrationView, String> {
    let code = input["verify_code"].as_str().unwrap_or_default().trim();
    if code.is_empty() || code.len() > 16 || !code.bytes().all(|ch| ch.is_ascii_digit()) {
        return Err("Enter the digits displayed in WeChat".into());
    }
    let mut flows = FLOWS.lock().unwrap();
    let flow = flows.get_mut(id).ok_or("Authorization flow not found")?;
    if flow.view.state != "waiting_for_input"
        || flow.code.is_some()
        || flow.view.expires_at <= chrono::Utc::now().timestamp()
    {
        return Err("This authorization flow is not waiting for a code".into());
    }
    flow.code = Some(code.into());
    flow.view.state = "waiting_for_scan".into();
    flow.view.error = None;
    flow.wake.notify_one();
    Ok(flow.view.clone())
}

pub fn claim(id: &str) -> Option<(String, Value, String, String)> {
    let mut flows = FLOWS.lock().unwrap();
    let flow = flows.get_mut(id)?;
    if flow.finishing
        || flow.view.state != "authorized"
        || flow.view.expires_at <= chrono::Utc::now().timestamp()
    {
        return None;
    }
    let config = flow.config.clone()?;
    flow.finishing = true;
    Some(("weixin".into(), config, "weixin".into(), flow.user.clone()))
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

    #[tokio::test]
    async fn registry_routes_private_input_claim_and_cancellation_to_owner() {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let view = RegistrationView {
            id: id.clone(),
            platform: "weixin".into(),
            domain: "weixin".into(),
            state: "waiting_for_input".into(),
            verification_url: "https://weixin.qq.com/qr".into(),
            qr_svg: String::new(),
            expires_at: chrono::Utc::now().timestamp() + 60,
            error: None,
        };
        FLOWS.lock().unwrap().insert(
            id.clone(),
            Flow {
                view,
                config: None,
                user: "owner".into(),
                finishing: false,
                code: None,
                cancel: cancel.clone(),
                wake: std::sync::Arc::new(tokio::sync::Notify::new()),
            },
        );
        let registry = crate::connect::adapter::registration_status(&id)
            .await
            .unwrap();
        assert_eq!(registry.platform, "weixin");
        assert!(
            crate::connect::adapter::submit_registration(&id, json!({"verify_code": "bad"}))
                .await
                .is_err()
        );
        let submitted =
            crate::connect::adapter::submit_registration(&id, json!({"verify_code": "123456"}))
                .await
                .unwrap();
        assert_eq!(submitted.state, "waiting_for_scan");
        assert!(!serde_json::to_string(&submitted)
            .unwrap()
            .contains("123456"));
        assert!(submit(&id, json!({"verify_code": "123456"})).is_err());
        assert!(crate::connect::adapter::claim_registration(&id).is_none());
        {
            let mut flows = FLOWS.lock().unwrap();
            let flow = flows.get_mut(&id).unwrap();
            flow.view.state = "authorized".into();
            flow.config = Some(json!({"bot_token": "private-token"}));
            flow.code = None;
        }
        assert_eq!(
            crate::connect::adapter::claim_registration(&id).unwrap().3,
            "owner"
        );
        assert!(crate::connect::adapter::claim_registration(&id).is_none());
        crate::connect::adapter::release_registration(&id);
        assert!(crate::connect::adapter::claim_registration(&id).is_some());
        assert!(!serde_json::to_string(&get(&id).unwrap())
            .unwrap()
            .contains("private-token"));
        crate::connect::adapter::finish_registration(&id);
        assert!(cancel.is_cancelled());
        assert!(crate::connect::adapter::registration_status(&id)
            .await
            .is_none());
        assert!(crate::connect::adapter::claim_registration(&id).is_none());
    }
}
