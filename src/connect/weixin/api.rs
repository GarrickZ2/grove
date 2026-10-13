//! iLink wire protocol, isolated from Grove's message/session semantics.
//! Compatibility baseline: Tencent/openclaw-weixin 2.4.10.
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

pub const BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const WIRE_VERSION: &str = "2.4.10";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("WeChat credentials expired; authorize this connection again")]
    Expired,
    #[error("WeChat API rejected the request (code {0})")]
    Rejected(i64),
    #[error("{0}")]
    Transport(String),
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
}

pub fn validated_base(base: &str) -> Result<String, String> {
    let url = url::Url::parse(base).map_err(|_| "Invalid WeChat API URL".to_owned())?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https"
        || !(host == "weixin.qq.com" || host.ends_with(".weixin.qq.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("WeChat API URL must be an HTTPS weixin.qq.com origin".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn business_result(value: &Value) -> Result<(), Error> {
    let codes = ["ret", "errcode"].map(|key| value.get(key).and_then(Value::as_i64).unwrap_or(0));
    if codes.contains(&-14) {
        return Err(Error::Expired);
    }
    if let Some(code) = codes.into_iter().find(|code| *code != 0) {
        return Err(Error::Rejected(code));
    }
    if !value.is_object() {
        return Err(Error::Transport("Invalid WeChat API response".into()));
    }
    Ok(())
}

impl Api {
    pub fn new(base: &str, token: Option<String>) -> Result<Self, String> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not initialize WeChat HTTP client".to_owned())?,
            base: validated_base(base)?,
            token,
        })
    }

    fn common(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.header("iLink-App-Id", "bot").header(
            "iLink-App-ClientVersion",
            (2u32 << 16 | 4 << 8 | 10).to_string(),
        )
    }

    pub async fn post(
        &self,
        endpoint: &str,
        mut body: Value,
        timeout: Duration,
        metadata: bool,
    ) -> Result<Value, Error> {
        if metadata {
            body["base_info"] = json!({"channel_version": WIRE_VERSION, "bot_agent": concat!("Grove/", env!("CARGO_PKG_VERSION"))});
        }
        let random = uuid::Uuid::new_v4();
        let uin = u32::from_be_bytes(random.as_bytes()[..4].try_into().unwrap()).to_string();
        let mut request = self
            .common(self.client.post(format!("{}{endpoint}", self.base)))
            .header("AuthorizationType", "ilink_bot_token")
            .header(
                "X-WECHAT-UIN",
                base64::engine::general_purpose::STANDARD.encode(uin),
            )
            .timeout(timeout)
            .json(&body);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        Self::response(request).await
    }

    pub async fn qr_status(&self, qrcode: &str, code: Option<&str>) -> Result<Value, Error> {
        let mut request = self
            .common(
                self.client
                    .get(format!("{}/ilink/bot/get_qrcode_status", self.base)),
            )
            .query(&[("qrcode", qrcode)])
            .timeout(Duration::from_secs(40));
        if let Some(code) = code {
            request = request.query(&[("verify_code", code)]);
        }
        Self::response(request).await
    }

    async fn response(request: reqwest::RequestBuilder) -> Result<Value, Error> {
        let response = request.send().await.map_err(|error| {
            Error::Transport(
                if error.is_timeout() {
                    "WeChat request timed out"
                } else {
                    "WeChat network request failed"
                }
                .into(),
            )
        })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Error::Expired);
        }
        if !response.status().is_success() {
            return Err(Error::Transport(format!(
                "WeChat HTTP {}",
                response.status().as_u16()
            )));
        }
        let value = response
            .json()
            .await
            .map_err(|_| Error::Transport("Invalid WeChat JSON response".into()))?;
        business_result(&value)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_untrusted_credential_destinations() {
        for base in [
            "http://ilinkai.weixin.qq.com",
            "https://weixin.qq.com.attacker.test",
            "https://user@ilinkai.weixin.qq.com",
            "https://ilinkai.weixin.qq.com/api",
            "https://ilinkai.weixin.qq.com/?token=x",
        ] {
            assert!(validated_base(base).is_err(), "{base}");
        }
        assert!(validated_base(BASE_URL).is_ok());
    }

    #[test]
    fn detects_expiration_in_either_error_field() {
        assert!(matches!(
            business_result(&json!({"ret": 0, "errcode": -14})),
            Err(Error::Expired)
        ));
        assert!(matches!(
            business_result(&json!({"ret": -14})),
            Err(Error::Expired)
        ));
        assert!(business_result(&json!({"ret": 9})).is_err());
    }

    #[tokio::test]
    async fn sends_authenticated_wire_message_and_checks_business_errors() {
        use axum::{routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/ilink/bot/sendmessage",
            post(
                |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                    assert_eq!(headers["authorization"], "Bearer test-token");
                    assert_eq!(headers["authorizationtype"], "ilink_bot_token");
                    assert_eq!(headers["ilink-app-id"], "bot");
                    assert_eq!(headers["ilink-app-clientversion"], "132106");
                    assert!(base64::engine::general_purpose::STANDARD
                        .decode(headers["x-wechat-uin"].as_bytes())
                        .is_ok());
                    assert_eq!(body["msg"]["context_token"], "conversation-token");
                    assert!(body["base_info"]["bot_agent"]
                        .as_str()
                        .unwrap()
                        .starts_with("Grove/"));
                    Json(json!({"ret": -14}))
                },
            ),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let api = Api {
            client: reqwest::Client::new(),
            base: format!("http://{address}"),
            token: Some("test-token".into()),
        };
        assert!(matches!(
            api.post(
                "/ilink/bot/sendmessage",
                json!({"msg":{"context_token":"conversation-token"}}),
                Duration::from_secs(2),
                true
            )
            .await,
            Err(Error::Expired)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn qr_requests_use_bootstrap_body_and_submit_code_without_bearer_credentials() {
        use axum::{
            extract::Query,
            routing::{get, post},
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/ilink/bot/get_bot_qrcode", post(|headers: axum::http::HeaderMap, Query(query): Query<std::collections::HashMap<String, String>>, Json(body): Json<Value>| async move {
                assert!(!headers.contains_key("authorization"));
                assert_eq!(query["bot_type"], "3");
                assert_eq!(body, json!({"local_token_list": []}));
                Json(json!({"qrcode": "qr-id", "qrcode_img_content": "https://weixin.qq.com/qr"}))
            }))
            .route("/ilink/bot/get_qrcode_status", get(|headers: axum::http::HeaderMap, Query(query): Query<std::collections::HashMap<String, String>>| async move {
                assert!(!headers.contains_key("authorization"));
                assert_eq!(headers["ilink-app-id"], "bot");
                assert_eq!(query["qrcode"], "qr-id");
                assert_eq!(query["verify_code"], "123456");
                Json(json!({"status": "confirmed"}))
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let api = Api {
            client: reqwest::Client::new(),
            base: format!("http://{address}"),
            token: None,
        };
        let result = api
            .post(
                "/ilink/bot/get_bot_qrcode?bot_type=3",
                json!({"local_token_list": []}),
                Duration::from_secs(2),
                false,
            )
            .await
            .unwrap();
        assert_eq!(result["qrcode"], "qr-id");
        assert_eq!(
            api.qr_status("qr-id", Some("123456")).await.unwrap()["status"],
            "confirmed"
        );
        server.abort();
    }
}
