//! CardKit and IM transport with shared budgeting and token recovery.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use once_cell::sync::Lazy;
use reqwest::Method;
use serde_json::{json, Value};
use tokio::time::Instant;

use super::adapter::TurnView;
use super::feishu_auth::TenantTokens;
use super::progress::TurnBlock;

type Gate = tokio::sync::Mutex<Instant>;
static GATES: Lazy<Mutex<HashMap<String, Weak<Gate>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
const REQUEST_INTERVAL: Duration = Duration::from_millis(200);
const AUTH_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const MAX_CARD_BYTES: usize = 30_000;
pub(super) struct CardApi {
    client: reqwest::Client,
    base_url: String,
    gate: Arc<Gate>,
    tokens: Arc<dyn TenantTokens>,
}

impl CardApi {
    pub fn new(base_url: String, app_id: &str, tokens: Arc<dyn TenantTokens>) -> Self {
        let key = format!("{base_url}/{app_id}");
        let mut gates = GATES.lock().unwrap();
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = gates.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
            let gate = Arc::new(Gate::new(Instant::now()));
            gates.insert(key, Arc::downgrade(&gate));
            gate
        });
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("HTTP client"),
            base_url,
            gate,
            tokens,
        }
    }

    pub async fn wait_for_budget(&self) {
        let mut next = self.gate.lock().await;
        tokio::time::sleep_until(*next).await;
        *next = Instant::now() + REQUEST_INTERVAL;
    }

    pub(super) async fn request(
        &self,
        method: Method,
        path: &str,
        payload: Value,
    ) -> Result<Value, String> {
        self.request_with_attempts(method, path, payload, 1).await
    }

    async fn request_with_attempts(
        &self,
        method: Method,
        path: &str,
        payload: Value,
        max_transport_attempts: usize,
    ) -> Result<Value, String> {
        let mut refreshed = false;
        let mut transport_attempts = 0;
        loop {
            self.wait_for_budget().await;
            // Resolve credentials after throttling, so queued requests use the
            // latest token. All outbound endpoints share this recovery path.
            let token = self.tokens.token().await?;
            let request = self
                .client
                .request(
                    method.clone(),
                    format!("{}{path}", self.base_url.trim_end_matches('/')),
                )
                .bearer_auth(&token);
            let request = if payload.is_null() {
                request
            } else {
                request.json(&payload)
            };
            let response = request.send().await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    transport_attempts += 1;
                    if transport_attempts < max_transport_attempts {
                        continue;
                    }
                    return Err(format!("Feishu request {path} transport failed: {error}"));
                }
            };
            let status = response.status();
            let reset = response
                .headers()
                .get("x-ogw-ratelimit-reset")
                .or_else(|| response.headers().get("retry-after"))
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            let log_id = response
                .headers()
                .get("x-tt-logid")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            if status.as_u16() == 429 || (!status.is_success() && reset.is_some()) {
                let mut next = self.gate.lock().await;
                *next =
                    (*next).max(Instant::now() + Duration::from_secs(reset.unwrap_or(1).max(1)));
            }
            let body: Value = response.json().await.map_err(|error| {
                format!("Feishu request {path} invalid response (HTTP {status}): {error}")
            })?;
            let code = body.get("code").and_then(Value::as_i64);
            if matches!(code, Some(99991400 | 230020)) {
                let mut next = self.gate.lock().await;
                *next =
                    (*next).max(Instant::now() + Duration::from_secs(reset.unwrap_or(1).max(1)));
            }
            if code == Some(99991663) && !refreshed {
                // Auth rejection means the operation did not execute. Reuse
                // the exact payload/UUID/sequence and retry only once.
                refreshed = true;
                eprintln!("[connect] Feishu request {path} rejected token (HTTP {status}, code 99991663, log_id {log_id}); refreshing once");
                {
                    let mut next = self.gate.lock().await;
                    *next = (*next).max(Instant::now() + AUTH_RETRY_INTERVAL);
                }
                self.tokens
                    .refresh(&token)
                    .await
                    .map_err(|error| format!("Feishu token refresh failed for {path}: {error}"))?;
                continue;
            }
            if status.is_success() && code == Some(0) {
                return Ok(body["data"].clone());
            }
            return Err(format!(
                "Feishu request {path} failed (HTTP {status}, code {code:?}, log_id {log_id}): {}",
                body["msg"].as_str().unwrap_or("unknown error")
            ));
        }
    }

    pub async fn reply_text(&self, parent: &str, text: &str) -> Result<(), String> {
        self.request_with_attempts(
            Method::POST,
            &format!("/open-apis/im/v1/messages/{parent}/reply"),
            json!({"msg_type":"text", "content":json!({"text":text}).to_string(),
                "uuid":uuid::Uuid::new_v4().to_string()}),
            3,
        )
        .await
        .map(|_| ())
    }

    pub async fn create(&self, view: &TurnView) -> Result<String, String> {
        let payload = card_data(view)?;
        let data = self
            .request(Method::POST, "/open-apis/cardkit/v1/cards", payload)
            .await?;
        data["card_id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Missing card_id".into())
    }

    pub async fn send(&self, parent: &str, card_id: &str, uuid: &str) -> Result<String, String> {
        let data = self
            .request(
                Method::POST,
                &format!("/open-apis/im/v1/messages/{parent}/reply"),
                json!({
                    "msg_type": "interactive",
                    "content": json!({"type":"card", "data":{"card_id":card_id}}).to_string(),
                    "uuid": uuid,
                }),
            )
            .await?;
        data["message_id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Missing message_id".into())
    }

    pub async fn update(&self, id: &str, view: &TurnView, sequence: u32) -> Result<(), String> {
        let payload = card_data(view)?;
        self.request(
            Method::PUT,
            &format!("/open-apis/cardkit/v1/cards/{id}"),
            json!({
                "card": payload, "sequence": sequence,
                "uuid": uuid::Uuid::new_v4().to_string(),
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn replace(&self, id: &str, view: &TurnView) -> Result<(), String> {
        let (content, overflow) = match card_data(view) {
            Ok(data) => (data["data"].as_str().unwrap().to_owned(), false),
            Err(error) if view.final_output.is_some() => {
                // Never truncate the final answer. Clear the process card and
                // let the caller deliver the complete answer as ordinary text.
                eprintln!("[connect] final card fallback: {error}");
                let fallback = TurnView {
                    final_output: Some(
                        "Final response follows in a text message (card size limit).".into(),
                    ),
                    ..TurnView::default()
                };
                (
                    card_data(&fallback)?["data"].as_str().unwrap().to_owned(),
                    true,
                )
            }
            Err(error) => return Err(error),
        };
        self.request(
            Method::PATCH,
            &format!("/open-apis/im/v1/messages/{id}"),
            json!({"content":content}),
        )
        .await?;
        if overflow {
            Err("Final response requires text delivery".into())
        } else {
            Ok(())
        }
    }
}

fn card_data(view: &TurnView) -> Result<Value, String> {
    let mut bounded = view.clone();
    loop {
        let card = render_card(&bounded).to_string();
        if card.len() <= MAX_CARD_BYTES {
            return Ok(json!({"type":"card_json", "data":card}));
        }
        if bounded.final_output.is_some() {
            return Err("Card content exceeds Feishu's 30 KB limit".into());
        }
        if !bounded.tools.is_empty() {
            bounded.tools.remove(0);
        } else if bounded.blocks.len() > 1 {
            bounded.blocks.remove(0);
        } else if let Some(TurnBlock::Text(text)) = bounded.blocks.first_mut() {
            if text.is_empty() {
                bounded.blocks.clear();
            } else {
                trim_half(text);
            }
        } else if !bounded.text.is_empty() {
            trim_half(&mut bounded.text);
        } else {
            return Err("Card content exceeds Feishu's 30 KB limit".into());
        }
    }
}

fn trim_half(text: &mut String) {
    let mut start = text.len() / 2 + 1;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.drain(..start);
}

fn render_card(view: &TurnView) -> Value {
    let elements = if let Some(output) = &view.final_output {
        vec![json!({"tag":"markdown", "content":output, "element_id":"answer"})]
    } else {
        let mut legacy = Vec::new();
        if view.blocks.is_empty() {
            if !view.text.is_empty() {
                legacy.push(TurnBlock::Text(view.text.clone()));
            }
            if !view.tools.is_empty() {
                legacy.push(TurnBlock::Tools {
                    count: view.tools.len(),
                    ids: view.tools.iter().map(|tool| tool.id.clone()).collect(),
                });
            }
        }
        let blocks = if view.blocks.is_empty() {
            &legacy
        } else {
            &view.blocks
        };
        let mut elements: Vec<Value> = blocks
            .iter()
            .enumerate()
            .map(|(index, block)| match block {
                TurnBlock::Text(text) => {
                    json!({"tag":"markdown", "content":text, "element_id":format!("text_{index}")})
                }
                TurnBlock::Tools { count, .. } => tool_summary(*count, index),
            })
            .collect();
        let status = match view.status.as_str() {
            "Waiting for permission" => Some("等待授权"),
            "Waiting for input" => Some("等待输入"),
            _ if elements.is_empty() => Some("正在处理…"),
            _ => None,
        };
        if let Some(status) = status {
            elements.push(json!({"tag":"markdown", "content":format!("<font color='grey'>{status}</font>"), "text_size":"notation", "element_id":"status"}));
        }
        elements
    };
    // Full-card updates work outside streaming mode as well; no typewriter or
    // ten-minute streaming-mode lifetime is needed for these state snapshots.
    json!({"schema":"2.0", "config":{"update_multi":true,"streaming_mode":false}, "body":{"elements":elements}})
}

fn tool_summary(count: usize, index: usize) -> Value {
    let times = if count == 1 { "time" } else { "times" };
    json!({"tag":"markdown", "element_id":format!("tools_{index}"),
        "content":format!("<font color='grey'>Called tools {count} {times}</font>"),
        "icon":{"tag":"standard_icon", "token":"briefcase_outlined", "color":"grey"}})
}

#[cfg(test)]
mod tests {
    use super::super::progress::TurnTool;
    use super::*;

    struct FixedTokens(&'static str);
    #[async_trait::async_trait]
    impl TenantTokens for FixedTokens {
        async fn token(&self) -> Result<String, String> {
            Ok(self.0.into())
        }
        async fn refresh(&self, _: &str) -> Result<String, String> {
            panic!("unexpected refresh")
        }
    }

    fn process_view() -> TurnView {
        TurnView {
            tools: vec![TurnTool {
                id: "read".into(),
                name: None,
                title: "Read notes".into(),
                status: "in_progress".into(),
            }],
            blocks: vec![
                TurnBlock::Text("First message".into()),
                TurnBlock::Tools {
                    count: 2,
                    ids: vec!["read".into()],
                },
                TurnBlock::Text("Next message".into()),
            ],
            ..TurnView::default()
        }
    }

    #[test]
    fn tool_summaries_update_counts_without_exposing_details() {
        let mut view = process_view();
        let card = render_card(&view);
        let elements = card["body"]["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 3);
        assert_eq!(elements[0]["content"], "First message");
        assert_eq!(elements[2]["content"], "Next message");
        assert_eq!(elements[1]["tag"], "markdown");
        assert_eq!(elements[1]["icon"]["token"], "briefcase_outlined");
        assert_eq!(elements[1]["element_id"], "tools_1");
        assert!(elements[1]["content"]
            .as_str()
            .unwrap()
            .contains("Called tools 2 times"));
        let serialized = card.to_string();
        for detail in [
            "Read notes",
            "in_progress",
            "collapsible_panel",
            "img_key",
            "Agent ·",
        ] {
            assert!(!serialized.contains(detail), "Unexpected detail: {detail}");
        }

        view.tools[0].status = "completed".into();
        assert_eq!(render_card(&view), card);
        if let TurnBlock::Tools { count, .. } = &mut view.blocks[1] {
            *count = 3;
        }
        let updated = render_card(&view);
        assert_eq!(updated["body"]["elements"][1]["element_id"], "tools_1");
        assert!(updated["body"]["elements"][1]["content"]
            .as_str()
            .unwrap()
            .contains("Called tools 3 times"));
        view.final_output = Some("Final answer".into());
        let final_card = render_card(&view);
        assert_eq!(final_card["body"]["elements"].as_array().unwrap().len(), 1);
        assert!(!final_card.to_string().contains("Called tools"));
    }

    #[derive(Default)]
    struct RecoveringTokens {
        generation: std::sync::atomic::AtomicUsize,
        refreshes: std::sync::atomic::AtomicUsize,
        fail_refresh: bool,
    }

    #[async_trait::async_trait]
    impl TenantTokens for RecoveringTokens {
        async fn token(&self) -> Result<String, String> {
            Ok(format!(
                "token-{}",
                self.generation.load(std::sync::atomic::Ordering::SeqCst)
            ))
        }
        async fn refresh(&self, rejected: &str) -> Result<String, String> {
            self.refreshes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail_refresh {
                return Err("token service unavailable".into());
            }
            assert_eq!(rejected, self.token().await?);
            self.generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.token().await
        }
    }

    struct AuthCall {
        method: Method,
        path: String,
        authorization: String,
        body: Value,
        at: Instant,
    }

    async fn auth_server(
        code: i64,
        always_reject: bool,
    ) -> (
        String,
        Arc<Mutex<Vec<AuthCall>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use axum::{
            body::Bytes,
            http::{HeaderMap, StatusCode, Uri},
            routing::any,
            Json, Router,
        };
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let app = Router::new().route("/{*path}", any(
            move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                let requests = requests.clone();
                async move {
                    let index = {
                        let mut calls = requests.lock().unwrap();
                        let index = calls.len();
                        calls.push(AuthCall {
                            method, path: uri.path().to_owned(),
                            authorization: headers["authorization"].to_str().unwrap().to_owned(),
                            body: if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap() },
                            at: Instant::now(),
                        });
                        index
                    };
                    let mut headers = HeaderMap::new();
                    headers.insert("x-tt-logid", "request-log".parse().unwrap());
                    if always_reject || index % 2 == 0 {
                        (StatusCode::BAD_REQUEST, headers, Json(json!({"code":code,"msg":"request rejected"})))
                    } else {
                        (StatusCode::OK, headers, Json(json!({"code":0,"data":{
                            "card_id":"card", "message_id":"message", "reaction_id":"reaction"
                        }})))
                    }
                }
            }
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, captured, server)
    }

    #[tokio::test]
    async fn all_outbound_endpoints_refresh_invalid_tokens_and_reuse_original_payloads() {
        let (base, requests, server) = auth_server(99991663, false).await;
        let tokens = Arc::new(RecoveringTokens::default());
        let api = CardApi::new(base, "app", tokens.clone());
        let view = process_view();
        assert_eq!(api.create(&view).await.unwrap(), "card");
        assert_eq!(
            api.send("parent", "card", "stable-uuid").await.unwrap(),
            "message"
        );
        api.update("card", &view, 7).await.unwrap();
        let final_view = TurnView {
            final_output: Some("Final answer".into()),
            ..TurnView::default()
        };
        api.replace("message", &final_view).await.unwrap();
        api.reply_text("parent", "Final answer").await.unwrap();
        for (method, path, payload) in [
            (
                Method::POST,
                "/open-apis/im/v1/messages/parent/reactions",
                json!({"reaction_type":{"emoji_type":"OnIt"}}),
            ),
            (
                Method::DELETE,
                "/open-apis/im/v1/messages/parent/reactions/reaction",
                Value::Null,
            ),
            (
                Method::POST,
                "/open-apis/interactive/v1/card/update",
                json!({"token":"callback", "card":{"schema":"2.0"}}),
            ),
            (
                Method::POST,
                "/open-apis/im/v1/messages/parent/reply",
                json!({"msg_type":"interactive", "content":"card", "uuid":"command-uuid"}),
            ),
        ] {
            api.request(method, path, payload).await.unwrap();
        }
        assert_eq!(
            tokens.refreshes.load(std::sync::atomic::Ordering::SeqCst),
            9
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 18);
        for (index, pair) in requests.chunks_exact(2).enumerate() {
            assert_eq!(pair[0].method, pair[1].method);
            assert_eq!(pair[0].path, pair[1].path);
            assert_eq!(pair[0].body, pair[1].body);
            assert_eq!(pair[0].authorization, format!("Bearer token-{index}"));
            assert_eq!(pair[1].authorization, format!("Bearer token-{}", index + 1));
            assert!(pair[1].at.duration_since(pair[0].at) >= AUTH_RETRY_INTERVAL);
        }
        assert_eq!(requests[4].body["sequence"], 7);
        assert_eq!(requests[8].body["msg_type"], "text");
        assert!(requests[8].body["uuid"].is_string());
        server.abort();
    }

    #[tokio::test]
    async fn persistent_auth_failure_refreshes_only_once_and_preserves_diagnostics() {
        let (base, requests, server) = auth_server(99991663, true).await;
        let tokens = Arc::new(RecoveringTokens::default());
        let api = CardApi::new(base, "app", tokens.clone());
        let error = api.reply_text("parent", "Final answer").await.unwrap_err();
        assert!(error.contains("99991663"));
        assert!(error.contains("400"));
        assert!(error.contains("request-log"));
        assert!(!error.contains("token-0"));
        assert!(!error.contains("token-1"));
        assert!(!error.contains("Final answer"));
        assert_eq!(
            tokens.refreshes.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(requests.lock().unwrap().len(), 2);
        server.abort();
    }

    #[tokio::test]
    async fn non_auth_failure_does_not_refresh_or_retry() {
        let (base, requests, server) = auth_server(230001, true).await;
        let tokens = Arc::new(RecoveringTokens::default());
        let api = CardApi::new(base, "app", tokens.clone());
        assert!(api
            .reply_text("parent", "Final answer")
            .await
            .unwrap_err()
            .contains("230001"));
        assert_eq!(
            tokens.refreshes.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn token_refresh_failure_stops_retry_and_later_requests_can_recover() {
        let (base, requests, server) = auth_server(99991663, false).await;
        let tokens = Arc::new(RecoveringTokens {
            fail_refresh: true,
            ..RecoveringTokens::default()
        });
        let api = CardApi::new(base, "app", tokens);
        let error = api.create(&process_view()).await.unwrap_err();
        assert!(error.contains("token refresh failed"));
        assert!(error.contains("token service unavailable"));
        // The failed operation stops; it does not prevent a later operation.
        api.create(&process_view()).await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        server.abort();
    }

    #[test]
    fn final_card_contains_only_answer() {
        let view = TurnView {
            status: "old state".into(),
            text: "old commentary".into(),
            tools: vec![TurnTool {
                id: "t".into(),
                name: None,
                title: "old tool".into(),
                status: "completed".into(),
            }],
            final_output: Some("Final answer".into()),
            blocks: vec![TurnBlock::Text("old text".into())],
        };
        let payload = card_data(&view).unwrap();
        let card: Value = serde_json::from_str(payload["data"].as_str().unwrap()).unwrap();
        assert_eq!(card["body"]["elements"].as_array().unwrap().len(), 1);
        assert_eq!(card["body"]["elements"][0]["content"], "Final answer");
        assert!(!payload.to_string().contains("old"));
        assert_eq!(card["config"]["streaming_mode"], false);
    }

    #[test]
    fn oversized_final_is_rejected_without_truncation() {
        let view = TurnView {
            final_output: Some("x".repeat(MAX_CARD_BYTES)),
            ..TurnView::default()
        };
        assert!(card_data(&view).is_err());
    }

    #[test]
    fn same_application_shares_rate_budget() {
        let app = uuid::Uuid::new_v4().to_string();
        let a = CardApi::new(
            "https://open.feishu.cn".into(),
            &app,
            Arc::new(FixedTokens("test-token")),
        );
        let b = CardApi::new(
            "https://open.feishu.cn".into(),
            &app,
            Arc::new(FixedTokens("test-token")),
        );
        let c = CardApi::new(
            "https://open.larksuite.com".into(),
            &app,
            Arc::new(FixedTokens("test-token")),
        );
        assert!(Arc::ptr_eq(&a.gate, &b.gate));
        assert!(!Arc::ptr_eq(&a.gate, &c.gate));
    }

    #[test]
    fn progress_fits_card_limit_even_with_unicode_and_json_escaping() {
        let view = TurnView {
            text: "\u{0000}中🙂".repeat(4000),
            tools: (0..32)
                .map(|n| TurnTool {
                    id: n.to_string(),
                    name: None,
                    title: "中🙂\\".repeat(200),
                    status: "completed".into(),
                })
                .collect(),
            ..TurnView::default()
        };
        let data = card_data(&view).unwrap();
        assert!(data["data"].as_str().unwrap().len() <= MAX_CARD_BYTES);
    }

    #[tokio::test]
    async fn cardkit_requests_use_sequences_and_honor_shared_rate_limit_cooldown() {
        use axum::http::{HeaderMap, StatusCode, Uri};
        use axum::{routing::any, Json, Router};
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let app = Router::new().route(
            "/{*path}",
            any(
                move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
                    let requests = requests.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer test-token");
                        let index = {
                            let mut requests = requests.lock().unwrap();
                            let index = requests.len();
                            requests.push((uri.path().to_owned(), body, Instant::now()));
                            index
                        };
                        let mut headers = HeaderMap::new();
                        if index == 2 {
                            headers.insert("x-ogw-ratelimit-reset", "1".parse().unwrap());
                            (
                                StatusCode::TOO_MANY_REQUESTS,
                                headers,
                                Json(json!({"code":99991400,"msg":"rate limited"})),
                            )
                        } else {
                            let data = match index {
                                0 => json!({"card_id":"card"}),
                                1 => json!({"message_id":"message"}),
                                _ => json!({}),
                            };
                            (StatusCode::OK, headers, Json(json!({"code":0,"data":data})))
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let api = CardApi::new(
            base.clone(),
            "test-app",
            Arc::new(FixedTokens("test-token")),
        );
        let other = CardApi::new(base, "test-app", Arc::new(FixedTokens("test-token")));
        let view = process_view();
        assert_eq!(api.create(&view).await.unwrap(), "card");
        assert_eq!(
            other.send("parent", "card", "stable-uuid").await.unwrap(),
            "message"
        );
        assert!(api.update("card", &view, 1).await.is_err());
        let retry_start = Instant::now();
        let final_view = TurnView {
            final_output: Some("Final answer".into()),
            ..TurnView::default()
        };
        other.update("card", &final_view, 2).await.unwrap();
        assert!(retry_start.elapsed() >= Duration::from_secs(1));
        api.replace("message", &final_view).await.unwrap();
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 5);
        assert_eq!(requests[0].0, "/open-apis/cardkit/v1/cards");
        let process: Value = serde_json::from_str(requests[0].1["data"].as_str().unwrap()).unwrap();
        assert!(process.to_string().contains("Called tools 2 times"));
        assert!(!process.to_string().contains("Read notes"));
        assert!(!process.to_string().contains("img_key"));
        assert!(requests[1].2.duration_since(requests[0].2) >= Duration::from_millis(180));
        assert_eq!(requests[1].0, "/open-apis/im/v1/messages/parent/reply");
        assert_eq!(requests[1].1["uuid"], "stable-uuid");
        let content: Value =
            serde_json::from_str(requests[1].1["content"].as_str().unwrap()).unwrap();
        assert_eq!(content, json!({"type":"card","data":{"card_id":"card"}}));
        assert_eq!(requests[2].1["sequence"], 1);
        assert_eq!(requests[3].1["sequence"], 2);
        let card: Value =
            serde_json::from_str(requests[3].1["card"]["data"].as_str().unwrap()).unwrap();
        assert_eq!(card["body"]["elements"][0]["content"], "Final answer");
        assert_eq!(requests[4].0, "/open-apis/im/v1/messages/message");
        server.abort();
    }
}
