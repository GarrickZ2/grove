//! Connection errors without credentials, request bodies or signed URLs.
use std::error::Error as _;
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lark_channel::lark_openapi::{
    BinaryHttpResponse, BoxFuture, HttpMethod, HttpRequest, HttpResponse, MultipartRequest,
    OpenApiBinaryTransport, OpenApiMultipartTransport, OpenApiTransport, ReqwestOpenApiTransport,
};

static LOG_LOCK: Mutex<()> = Mutex::new(());
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

pub(super) fn log_error(id: &str, stage: &str, detail: &str) {
    let record = format!(
        "{} level=error connect={} stage={} {}\n",
        chrono::Utc::now().to_rfc3339(),
        safe(id),
        safe(stage),
        safe(detail)
    );
    eprint!("{record}");
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = if cfg!(test) {
        std::env::temp_dir().join("grove-connect-test-logs")
    } else {
        let Some(home) = dirs::home_dir() else { return };
        home.join(".grove").join("logs")
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("connect.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() >= MAX_LOG_BYTES) {
        let _ = std::fs::remove_file(dir.join("connect.previous.log"));
        let _ = std::fs::rename(&path, dir.join("connect.previous.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(record.as_bytes());
    }
}

pub(super) fn safe(detail: &str) -> String {
    static URLS: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r#"(?:https?|wss?|socks5h?)://[^\s\"<>]+"#).unwrap()
    });
    URLS.replace_all(detail, "[URL redacted]")
        .chars()
        .filter(|c| !c.is_control())
        .take(2000)
        .collect()
}

#[derive(Clone)]
pub(super) struct DiagnosticTransport {
    client: reqwest::Client,
    media: ReqwestOpenApiTransport,
    id: String,
}

impl DiagnosticTransport {
    pub fn new(id: &str) -> Result<Self, String> {
        let builder = || {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
        };
        let client = builder()
            .build()
            .map_err(|e| request_error(e, "HTTP client"))?;
        // Keep SDK upload/download bounds and timeouts unchanged.
        let media = ReqwestOpenApiTransport::new();
        Ok(Self {
            client,
            media,
            id: id.to_owned(),
        })
    }
}

fn request_error(error: reqwest::Error, stage: &str) -> String {
    let error = error.without_url();
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection failure"
    } else {
        "request failure"
    };
    let mut details = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        details.push(cause.to_string());
        source = cause.source();
        if details.len() >= 8 {
            break;
        }
    }
    safe(&format!("{stage}: {kind}: {}", details.join(" -> ")))
}

impl OpenApiTransport for DiagnosticTransport {
    fn send_json(
        &self,
        request: HttpRequest,
    ) -> BoxFuture<'static, lark_channel::Result<HttpResponse>> {
        let this = self.clone();
        Box::pin(async move {
            // Only a known operation is recorded, never headers/body/path IDs.
            let stage = match request.url.path() {
                "/open-apis/auth/v3/tenant_access_token/internal" => "credential verification",
                "/callback/ws/endpoint" => "WebSocket endpoint",
                _ => "OpenAPI request",
            };
            let started = Instant::now();
            let method = match request.method {
                HttpMethod::Get => reqwest::Method::GET,
                HttpMethod::Post => reqwest::Method::POST,
                HttpMethod::Put => reqwest::Method::PUT,
                HttpMethod::Patch => reqwest::Method::PATCH,
                HttpMethod::Delete => reqwest::Method::DELETE,
            };
            let mut builder = this.client.request(method, request.url);
            for (key, value) in request.headers {
                builder = builder.header(key, value);
            }
            if !request.body.is_null() {
                builder = builder.json(&request.body);
            }
            let result: lark_channel::Result<HttpResponse> = async {
                let response = builder
                    .send()
                    .await
                    .map_err(|e| lark_channel::Error::Transport(request_error(e, stage)))?;
                let status = response.status().as_u16();
                // Preserve HTTP errors for the SDK; do not include their bodies in logs.
                let body = if !(200..300).contains(&status) {
                    serde_json::Value::Null
                } else {
                    response.json().await.map_err(|e| {
                        let detail = if e.is_decode() {
                            format!("{stage}: invalid JSON response")
                        } else {
                            request_error(e, stage)
                        };
                        lark_channel::Error::Transport(detail)
                    })?
                };
                Ok(HttpResponse { status, body })
            }
            .await;
            let failure = match &result {
                Ok(response) if !(200..300).contains(&response.status) => Some(format!(
                    "HTTP {} elapsed_ms={}",
                    response.status,
                    started.elapsed().as_millis()
                )),
                Ok(response) => response
                    .body
                    .get("code")
                    .and_then(serde_json::Value::as_i64)
                    .filter(|code| *code != 0)
                    .map(|code| {
                        format!(
                            "OpenAPI rejected request (code {code}) elapsed_ms={}",
                            started.elapsed().as_millis()
                        )
                    }),
                Err(error) => Some(format!(
                    "{} elapsed_ms={}",
                    safe(&error.to_string()),
                    started.elapsed().as_millis()
                )),
            };
            if let Some(failure) = failure {
                log_error(&this.id, stage, &failure);
            }
            result
        })
    }
}

impl OpenApiBinaryTransport for DiagnosticTransport {
    fn send_bytes(
        &self,
        request: HttpRequest,
        max_response_bytes: usize,
    ) -> BoxFuture<'static, lark_channel::Result<BinaryHttpResponse>> {
        self.media.send_bytes(request, max_response_bytes)
    }
}

impl OpenApiMultipartTransport for DiagnosticTransport {
    fn send_multipart(
        &self,
        request: MultipartRequest,
    ) -> BoxFuture<'static, lark_channel::Result<HttpResponse>> {
        self.media.send_multipart(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_remove_signed_urls_and_control_characters() {
        let text = safe(
            "failed https://user:secret@host/path?token=secret\nws=wss://host/path?token=secret",
        );
        assert!(!text.contains("secret"));
        assert!(!text.contains('\n'));
        assert!(text.contains("[URL redacted]"));
    }

    #[tokio::test]
    async fn connection_errors_keep_the_source_and_operation() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = client
            .get(format!("http://{address}/?token=secret"))
            .send()
            .await
            .unwrap_err();
        let detail = request_error(error, "credential verification");
        assert!(detail.contains("credential verification: connection failure"));
        assert!(detail.contains(" -> "));
        assert!(!detail.contains("token=secret"));
    }

    #[tokio::test]
    async fn successful_requests_are_silent_and_only_failures_reach_the_error_log() {
        use axum::{routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(|Json(body): Json<serde_json::Value>| async move {
                let status = if body["mode"] == "http_error" {
                    axum::http::StatusCode::BAD_GATEWAY
                } else {
                    axum::http::StatusCode::OK
                };
                let code = if body["mode"] == "api_error" { 9 } else { 0 };
                (
                    status,
                    Json(serde_json::json!({"code": code, "msg": "private-response"})),
                )
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let id = uuid::Uuid::new_v4().to_string();
        let transport = DiagnosticTransport {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            media: ReqwestOpenApiTransport::new(),
            id: id.clone(),
        };
        let request = |mode: &str| {
            HttpRequest::post_json(
            format!("http://{address}/open-apis/auth/v3/tenant_access_token/internal?token=private-query").parse().unwrap(),
            serde_json::json!({"mode": mode, "app_secret": "private-request"}),
        )
        };
        let records = || {
            std::fs::read_to_string(
                std::env::temp_dir().join("grove-connect-test-logs/connect.log"),
            )
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains(&id))
            .map(str::to_owned)
            .collect::<Vec<_>>()
        };
        assert_eq!(
            transport.send_json(request("ok")).await.unwrap().status,
            200
        );
        assert!(records().is_empty());
        assert_eq!(
            transport
                .send_json(request("api_error"))
                .await
                .unwrap()
                .body["code"],
            9
        );
        assert_eq!(
            transport
                .send_json(request("http_error"))
                .await
                .unwrap()
                .status,
            502
        );
        server.abort();
        let _ = server.await;
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_address = closed.local_addr().unwrap();
        drop(closed);
        let mut failed_request = request("network_error");
        failed_request.url = format!("http://{closed_address}/?token=private-query")
            .parse()
            .unwrap();
        assert!(transport.send_json(failed_request).await.is_err());
        let errors = records();
        assert_eq!(errors.len(), 3);
        assert!(errors.iter().all(|line| line.contains("level=error")));
        assert!(errors.iter().any(|line| line.contains("code 9")));
        assert!(errors.iter().any(|line| line.contains("HTTP 502")));
        assert!(errors
            .iter()
            .any(|line| line.contains("connection failure")));
        assert!(errors.iter().all(|line| !line.contains("private-")));
    }
}
