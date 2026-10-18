//! Small, loopback-only client transport. No Grove backend, git or agent runtime.
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocketUpgrade},
        Request, State,
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock as SyncRwLock,
    },
    time::Duration,
};
use tokio::sync::{watch, Mutex};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as UpstreamMessage};
use url::Url;

#[derive(RustEmbed)]
#[folder = "../grove-web/dist"]
#[exclude = "*.map"]
struct Assets;

#[derive(Clone, Serialize, Deserialize)]
struct ServerProfile {
    id: String,
    name: String,
    server: String,
    port: u16,
}

#[derive(Default, Serialize, Deserialize)]
struct SavedServers {
    servers: Vec<ServerProfile>,
}

struct Manager {
    saved: Mutex<SavedServers>,
    preferences: PathBuf,
    legacy: PathBuf,
    allowed: Arc<SyncRwLock<HashSet<String>>>,
    token: String,
    active_origin: SyncRwLock<String>,
    http: reqwest::Client,
    listeners: Mutex<HashMap<SocketAddr, LocalListener>>,
    foreground: AtomicBool,
}

#[derive(Clone)]
struct ClientState {
    // A listener belongs to one server forever. Old requests and WebSockets
    // can never be redirected to another server during navigation.
    server: Option<Url>,
    profile: Option<ServerProfile>,
    origin: String,
    manager: Arc<Manager>,
}

struct LocalListener {
    state: ClientState,
    task: Option<tokio::task::JoinHandle<()>>,
    stop: watch::Sender<bool>,
}

impl LocalListener {
    async fn restart(&mut self, address: SocketAddr) -> Result<(), String> {
        let mut last_error = String::new();
        for attempt in 0..5 {
            match tokio::net::TcpListener::bind(address).await {
                Ok(listener) => {
                    let (stop, _) = watch::channel(false);
                    self.task = Some(spawn_listener(
                        listener,
                        self.state.clone(),
                        stop.subscribe(),
                    ));
                    self.stop = stop;
                    last_error.clear();
                    break;
                }
                Err(error) => {
                    last_error = error.to_string();
                    crate::lifecycle::record("bind_retry", address.port());
                    tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await;
                }
            }
        }
        if !last_error.is_empty() {
            return Err(format!("local port {}: {last_error}", address.port()));
        }
        // Probe the local listener independently of upstream connectivity/auth.
        let response = reqwest::Client::new()
            .get(format!("http://{address}/_grove/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map_err(|error| format!("local port {}: {error}", address.port()))?;
        if response.status() != StatusCode::NO_CONTENT {
            return Err(format!("local port {} failed health check", address.port()));
        }
        crate::lifecycle::record("listener_ready", address.port());
        Ok(())
    }

    async fn stop(&mut self) {
        self.stop.send_replace(true);
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(Duration::from_millis(250), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

#[derive(Clone)]
pub struct ClientTransport {
    pub address: SocketAddr,
    manager: Arc<Manager>,
    allowed: Arc<SyncRwLock<HashSet<String>>>,
}

/// Same-server activity taps keep the webview, drafts and sockets alive.
pub fn activity_navigation_script(current: &Url, target: &Url) -> Option<String> {
    if current.origin() != target.origin() || current.path().starts_with("/_grove") {
        return None;
    }
    let (_, payload) = target
        .query_pairs()
        .find(|(key, _)| key == "grove_activity")?;
    Some(format!("window.__GROVE_ACTIVITY_NAV__={payload};window.dispatchEvent(new Event('grove:activity-open'));"))
}

impl ClientTransport {
    /// Called serially by the native lifecycle worker. Never change storage origins.
    pub async fn set_foreground(&self, foreground: bool) -> Result<(), String> {
        let mut listeners = self.manager.listeners.lock().await;
        self.manager.foreground.store(foreground, Ordering::SeqCst);
        for entry in listeners.values_mut() {
            entry.stop().await;
        }
        if !foreground {
            crate::lifecycle::record("listeners_stopped", 0);
            return Ok(());
        }
        let active_origin = self.manager.active_origin.read().unwrap().clone();
        let active_origin = if active_origin.is_empty() {
            format!("http://{}", self.address)
        } else {
            active_origin
        };
        let mut active_error = None;
        for (address, entry) in listeners.iter_mut() {
            if let Err(error) = entry.restart(*address).await {
                entry.stop().await;
                crate::lifecycle::record("listener_recovery_failed", address.port());
                if entry.state.origin == active_origin {
                    active_error = Some(error);
                }
            }
        }
        // An old profile must not hold the current webview behind the global
        // readiness gate. Still try every listener so it can recover on retry.
        active_error.map_or(Ok(()), Err)
    }
    /// Reopen only a saved profile; deep links never authorize arbitrary hosts.
    pub async fn activity_target(&self, link: &Url) -> Option<Url> {
        if link.scheme() != "grove" || link.host_str() != Some("activity") {
            return None;
        }
        let params: std::collections::HashMap<_, _> = link.query_pairs().into_owned().collect();
        let origin = params.get("origin")?;
        let saved = self.manager.saved.lock().await;
        let profile = saved
            .servers
            .iter()
            .find(|p| format!("http://127.0.0.1:{}", p.port) == *origin)?
            .clone();
        if !self.allowed.read().unwrap().contains(origin) {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", profile.port))
                .await
                .ok()?;
            let server = Url::parse(&profile.server).ok()?;
            self.allowed.write().unwrap().insert(origin.clone());
            serve_listener(
                listener,
                ClientState {
                    server: Some(server),
                    profile: Some(profile),
                    origin: origin.clone(),
                    manager: self.manager.clone(),
                },
            )
            .await;
        }
        let mut target = Url::parse(origin).ok()?;
        let payload = serde_json::json!({"route":"tasks", "origin":origin, "project_id":params.get("project"), "task_id":params.get("task"), "chat_id":params.get("chat")});
        target
            .query_pairs_mut()
            .append_pair("grove_activity", &payload.to_string());
        Some(target)
    }

    pub fn allows_navigation(&self, url: &Url) -> bool {
        self.allowed
            .read()
            .unwrap()
            .contains(&url.origin().ascii_serialization())
    }
}

async fn serve_listener(listener: tokio::net::TcpListener, state: ClientState) {
    let address = listener.local_addr().expect("bound listener");
    let manager = state.manager.clone();
    let mut listeners = manager.listeners.lock().await;
    let (stop, _) = watch::channel(false);
    let task = if manager.foreground.load(Ordering::SeqCst) {
        Some(spawn_listener(listener, state.clone(), stop.subscribe()))
    } else {
        drop(listener);
        None
    };
    listeners.insert(address, LocalListener { state, task, stop });
}

fn spawn_listener(
    listener: tokio::net::TcpListener,
    state: ClientState,
    stop: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    let websocket_stop = stop.clone();
    let router = Router::new()
        .route("/_grove/health", get(|| async { StatusCode::NO_CONTENT }))
        .route("/_grove/", get(launcher))
        .route("/_grove/connect", post(connect))
        .route("/_grove/activity", post(activity))
        .fallback(serve)
        .layer(axum::Extension(websocket_stop))
        .with_state(Arc::new(state));
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let mut stop = stop;
                let _ = stop.wait_for(|stopped| *stopped).await;
            })
            .await
        {
            eprintln!("iOS client transport stopped: {error}");
        }
    })
}

pub async fn start(legacy: PathBuf) -> Result<ClientTransport, Box<dyn std::error::Error>> {
    let preferences = legacy.with_file_name("servers.json");
    let saved: SavedServers = match tokio::fs::read(&preferences).await {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SavedServers::default(),
        Err(error) => return Err(error.into()),
    };
    // The manager must never take a saved server's storage origin.
    let mut reserved = Vec::new();
    let listener = loop {
        let candidate = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        if !saved
            .servers
            .iter()
            .any(|p| p.port == candidate.local_addr().unwrap().port())
        {
            break candidate;
        }
        reserved.push(candidate);
    };
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let allowed = Arc::new(SyncRwLock::new(HashSet::from([origin.clone()])));
    let manager = Arc::new(Manager {
        saved: Mutex::new(saved),
        preferences,
        legacy,
        allowed: allowed.clone(),
        token: uuid::Uuid::new_v4().to_string(),
        active_origin: SyncRwLock::new(String::new()),
        http: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        listeners: Mutex::new(HashMap::new()),
        foreground: AtomicBool::new(true),
    });
    serve_listener(
        listener,
        ClientState {
            server: None,
            profile: None,
            origin,
            manager: manager.clone(),
        },
    )
    .await;
    Ok(ClientTransport {
        address,
        allowed,
        manager,
    })
}

async fn launcher(State(state): State<Arc<ClientState>>, headers: HeaderMap) -> Response {
    if headers.get("host").and_then(|v| v.to_str().ok()) != state.origin.strip_prefix("http://") {
        return StatusCode::FORBIDDEN.into_response();
    }
    *state.manager.active_origin.write().unwrap() = String::new();
    crate::activity::send(serde_json::json!({"clear":true,"stale":false,"origin":"","server":""}));
    let server = tokio::fs::read_to_string(&state.manager.legacy)
        .await
        .ok()
        .or_else(|| option_env!("GROVE_IOS_SERVER_URL").map(str::to_owned))
        .unwrap_or_default();
    let config = serde_json::json!({
        "server": server, "token": state.manager.token,
        "servers": state.manager.saved.lock().await.servers,
        "current": state.profile.as_ref().map(|p| &p.id),
    })
    .to_string()
    .replace('<', "\\u003c");
    (
        [("Cache-Control", "no-store"), ("X-Frame-Options", "DENY")],
        Html(include_str!("../launcher/index.html").replace("__CONFIGURATION__", &config)),
    )
        .into_response()
}

#[derive(Deserialize)]
struct ConnectRequest {
    server: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    save_only: bool,
}

fn normalize_server(value: &str) -> Result<Url, &'static str> {
    let mut url =
        Url::parse(value.trim()).map_err(|_| "Enter a complete http:// or https:// address.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("Enter only the server origin, without a path, password or Secret Key.");
    }
    url.set_path("/");
    Ok(url)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

async fn activity(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(mut input): Json<serde_json::Value>,
) -> Response {
    if headers.get("Origin").and_then(|v| v.to_str().ok()) != Some(state.origin.as_str())
        || headers.get("X-Grove-Setup").and_then(|v| v.to_str().ok())
            != Some(state.manager.token.as_str())
        || *state.manager.active_origin.read().unwrap() != state.origin
        || state.profile.is_none()
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !input.is_object() || input.to_string().len() > 4096 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    input["origin"] = state.origin.clone().into();
    input["server"] = state.profile.as_ref().unwrap().name.clone().into();
    crate::activity::send(input);
    StatusCode::NO_CONTENT.into_response()
}

async fn connect(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(input): Json<ConnectRequest>,
) -> Response {
    if headers.get("X-Grove-Setup").and_then(|v| v.to_str().ok())
        != Some(state.manager.token.as_str())
        || headers.get("Origin").and_then(|v| v.to_str().ok()) != Some(state.origin.as_str())
    {
        return error(
            StatusCode::FORBIDDEN,
            "Open the connection screen in Grove.",
        );
    }
    let url = match normalize_server(&input.server) {
        Ok(url)
            if !state
                .manager
                .allowed
                .read()
                .unwrap()
                .contains(&url.origin().ascii_serialization()) =>
        {
            url
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "Use your computer's Grove address, without a path or Secret Key.",
            )
        }
    };
    if !input.save_only {
        let response = state
            .manager
            .http
            .get(url.join("api/v1/auth/info").unwrap())
            .timeout(Duration::from_secs(12))
            .send()
            .await;
        let valid = match response {
            Ok(response) if response.status().is_success() => response
                .json::<serde_json::Value>()
                .await
                .is_ok_and(|value| {
                    value
                        .get("required")
                        .is_some_and(serde_json::Value::is_boolean)
                }),
            _ => false,
        };
        if !valid {
            return error(StatusCode::BAD_GATEWAY,
            "Could not reach Grove. Check the address, Wi-Fi, local network permission and that Grove Mobile is running. HTTPS needs a trusted certificate; use the LAN HTTP address for this test.");
        }
    }
    let mut saved = state.manager.saved.lock().await;
    let existing = saved
        .servers
        .iter()
        .find(|p| p.server == url.as_str())
        .cloned();
    let mut profile = existing.unwrap_or_else(|| ServerProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: url.host_str().unwrap().to_owned(),
        server: url.to_string(),
        port: 0,
    });
    if !input.name.trim().is_empty() {
        profile.name = input.name.trim().chars().take(80).collect();
    }
    let mut origin = format!("http://127.0.0.1:{}", profile.port);
    let listener = if state.manager.allowed.read().unwrap().contains(&origin) {
        None
    } else {
        // Keeping each saved origin stable preserves WKWebView's own storage
        // across app launches. Never fall back to another server's origin.
        let mut reserved = Vec::new();
        let listener = loop {
            let candidate = match tokio::net::TcpListener::bind(("127.0.0.1", profile.port)).await {
                Ok(listener) => listener,
                Err(_) => return error(StatusCode::CONFLICT,
                    "This saved connection is busy. Close and reopen Grove, then try again. Your sign-in has been kept."),
            };
            if profile.port != 0
                || !saved
                    .servers
                    .iter()
                    .any(|p| p.port == candidate.local_addr().unwrap().port())
            {
                break candidate;
            }
            reserved.push(candidate);
        };
        profile.port = listener.local_addr().unwrap().port();
        origin = format!("http://127.0.0.1:{}", profile.port);
        Some(listener)
    };
    let mut next = SavedServers {
        servers: saved.servers.clone(),
    };
    if let Some(entry) = next.servers.iter_mut().find(|p| p.id == profile.id) {
        *entry = profile.clone();
    } else {
        next.servers.push(profile.clone());
    }
    let persist = async {
        if let Some(parent) = state.manager.preferences.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let temporary = state.manager.preferences.with_extension("json.tmp");
        tokio::fs::write(&temporary, serde_json::to_vec(&next).unwrap()).await?;
        tokio::fs::rename(temporary, &state.manager.preferences).await
    }
    .await;
    if persist.is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not save this server. Try again.",
        );
    }
    *saved = next;
    if let Some(listener) = listener {
        state
            .manager
            .allowed
            .write()
            .unwrap()
            .insert(origin.clone());
        serve_listener(
            listener,
            ClientState {
                server: Some(url),
                profile: Some(profile),
                origin: origin.clone(),
                manager: state.manager.clone(),
            },
        )
        .await;
    }
    Json(serde_json::json!({ "connected": true, "location": format!("{origin}/") })).into_response()
}

// Remove hop-by-hop headers, including names nominated by Connection.
fn strip_transport_headers(headers: &mut HeaderMap) {
    let nominated: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(',').map(|name| name.trim().to_owned()))
        .collect();
    for name in nominated {
        headers.remove(name);
    }
    for name in [
        "host",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

async fn serve(
    State(state): State<Arc<ClientState>>,
    axum::Extension(stop): axum::Extension<watch::Receiver<bool>>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request,
) -> Response {
    // Prevent DNS rebinding against the loopback transport.
    if request.headers().get("host").and_then(|v| v.to_str().ok())
        != state.origin.strip_prefix("http://")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = request.uri().path();
    if path == "/sw.js" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() == axum::http::Method::GET && ws.is_err() {
        let asset_path = if path == "/" || path.starts_with("/review/") {
            "index.html"
        } else {
            path.trim_start_matches('/')
        };
        if let Some(asset) = Assets::get(asset_path) {
            return (
                [
                    (
                        "Content-Type",
                        mime_guess::from_path(asset_path)
                            .first_or_octet_stream()
                            .to_string(),
                    ),
                    ("Cache-Control", "no-store".to_string()),
                ],
                if asset_path == "index.html" {
                    *state.manager.active_origin.write().unwrap() = state.origin.clone();
                    let metadata = serde_json::json!({ "token": state.manager.token, "name": state.profile.as_ref().map(|p| &p.name), "server": state.server.as_ref().map(Url::as_str) })
                        .to_string().replace('<', "\\u003c");
                    String::from_utf8_lossy(&asset.data).replace("<head>", &format!("<head><script>window.__GROVE_IOS_SERVER__={metadata};</script>")).into_bytes()
                } else { asset.data.into_owned() },
            )
                .into_response();
        }
    }
    let Some(server) = state.server.clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Connect to a Grove server first.",
        );
    };
    // Concatenation (not Url::join) keeps // paths from changing the authority.
    let target = format!(
        "{}{}",
        server.as_str().trim_end_matches('/'),
        request
            .uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
    );
    if let Ok(ws) = ws {
        return proxy_websocket(ws, &target, request.headers(), &server, stop).await;
    }
    let (parts, body) = request.into_parts();
    let mut headers = parts.headers;
    strip_transport_headers(&mut headers);
    headers.remove("cookie");
    if headers.contains_key("origin") {
        headers.insert(
            "origin",
            server.origin().ascii_serialization().parse().unwrap(),
        );
    }
    match state
        .manager
        .http
        .request(parts.method, target)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
    {
        Ok(upstream) => {
            let status = upstream.status();
            let mut headers = upstream.headers().clone();
            strip_transport_headers(&mut headers);
            headers.remove("set-cookie");
            let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            response
        }
        Err(_) => error(
            StatusCode::BAD_GATEWAY,
            "Grove is unreachable. Check the computer and network, then reconnect.",
        ),
    }
}

async fn proxy_websocket(
    ws: WebSocketUpgrade,
    target: &str,
    headers: &HeaderMap,
    server: &Url,
    mut stop: watch::Receiver<bool>,
) -> Response {
    let mut url = Url::parse(target).unwrap();
    url.set_scheme(if server.scheme() == "https" {
        "wss"
    } else {
        "ws"
    })
    .unwrap();
    let mut request = url.as_str().into_client_request().unwrap();
    for (name, value) in headers {
        if name.as_str().starts_with("x-")
            || matches!(name.as_str(), "authorization" | "sec-websocket-protocol")
        {
            request.headers_mut().append(name.clone(), value.clone());
        }
    }
    request.headers_mut().insert(
        "origin",
        server.origin().ascii_serialization().parse().unwrap(),
    );
    let result = tokio::time::timeout(
        Duration::from_secs(12),
        tokio_tungstenite::connect_async(request),
    )
    .await;
    let (upstream, response) = match result {
        Ok(Ok(value)) => value,
        _ => {
            return error(
                StatusCode::BAD_GATEWAY,
                "Could not connect to Grove WebSocket.",
            )
        }
    };
    let ws = if let Some(protocol) = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
    {
        ws.protocols([protocol.to_owned()])
    } else {
        ws
    };
    let activity_events = url.path() == "/api/v1/radio/events/ws";
    ws.on_upgrade(move |client| async move {
        let (mut client_send, mut client_recv) = client.split();
        let (mut remote_send, mut remote_recv) = upstream.split();
        let outgoing = async {
            while let Some(Ok(message)) = client_recv.next().await {
                let message = match message {
                    Message::Text(value) if activity_events && value == "activity_heartbeat" => {
                        UpstreamMessage::Ping(b"grove-activity".to_vec().into())
                    }
                    Message::Text(value) => UpstreamMessage::Text(value.to_string().into()),
                    Message::Binary(value) => UpstreamMessage::Binary(value),
                    Message::Ping(value) => UpstreamMessage::Ping(value),
                    Message::Pong(value) => UpstreamMessage::Pong(value),
                    Message::Close(frame) => UpstreamMessage::Close(frame.map(|frame| {
                        tokio_tungstenite::tungstenite::protocol::CloseFrame {
                            code: frame.code.into(),
                            reason: frame.reason.to_string().into(),
                        }
                    })),
                };
                if remote_send.send(message).await.is_err() {
                    break;
                }
            }
            let _ = remote_send.close().await;
        };
        let incoming = async {
            while let Some(Ok(message)) = remote_recv.next().await {
                let message = match message {
                    UpstreamMessage::Text(value) => Message::Text(value.to_string().into()),
                    UpstreamMessage::Binary(value) => Message::Binary(value),
                    UpstreamMessage::Ping(value) => Message::Ping(value),
                    UpstreamMessage::Pong(value)
                        if activity_events && value.as_ref() == b"grove-activity" =>
                    {
                        Message::Text(r#"{"type":"activity_heartbeat"}"#.into())
                    }
                    UpstreamMessage::Pong(value) => Message::Pong(value),
                    UpstreamMessage::Close(frame) => {
                        Message::Close(frame.map(|frame| axum::extract::ws::CloseFrame {
                            code: frame.code.into(),
                            reason: frame.reason.to_string().into(),
                        }))
                    }
                    UpstreamMessage::Frame(_) => continue,
                };
                if client_send.send(message).await.is_err() {
                    break;
                }
            }
            let _ = client_send.close().await;
        };
        tokio::select! {
            _ = outgoing => {}, _ = incoming => {},
            _ = stop.wait_for(|stopped| *stopped) => {},
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn foreground_rebinds_original_ports_and_recovers_http_and_websocket() {
        let dir = tempfile::tempdir().unwrap();
        let transport = start(dir.path().join("server.txt")).await.unwrap();
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote = upstream.local_addr().unwrap();
        let remote_task = tokio::spawn(async move {
            let app = Router::new()
                .route(
                    "/probe",
                    get(|headers: HeaderMap| async move {
                        headers
                            .get("x-device-id")
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_owned()
                    }),
                )
                .route(
                    "/ws",
                    get(|ws: WebSocketUpgrade| async move {
                        ws.on_upgrade(|mut socket| async move {
                            while let Some(Ok(message)) = socket.recv().await {
                                if socket.send(message).await.is_err() {
                                    break;
                                }
                            }
                        })
                    }),
                );
            axum::serve(upstream, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let manager = format!("http://{}", transport.address);
        let profile = select_profile(&client, &manager, &format!("http://{remote}"), true).await;
        let profile: serde_json::Value = profile.json().await.unwrap();
        let origin = profile["location"].as_str().unwrap().trim_end_matches('/');
        let port = Url::parse(origin).unwrap().port().unwrap();
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let original_saved = tokio::fs::read(dir.path().join("servers.json"))
            .await
            .unwrap();
        for _ in 0..3 {
            let (mut socket, _) =
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
                    .await
                    .unwrap();
            transport.set_foreground(false).await.unwrap();
            assert!(tokio::net::TcpStream::connect(address).await.is_err());
            assert!(tokio::net::TcpStream::connect(transport.address)
                .await
                .is_err());
            // Backgrounding closes the proxy, not the upstream Agent/runtime.
            let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap();
            assert!(!matches!(closed, Some(Ok(UpstreamMessage::Text(_)))));
            transport.set_foreground(true).await.unwrap();
            assert_eq!(
                client
                    .get(format!("{origin}/probe"))
                    .header("x-device-id", "unchanged-device")
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "unchanged-device"
            );
            let (mut socket, _) =
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
                    .await
                    .unwrap();
            socket
                .send(UpstreamMessage::Text("after-resume".into()))
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "after-resume"
            );
        }
        assert_eq!(
            tokio::fs::read(dir.path().join("servers.json"))
                .await
                .unwrap(),
            original_saved
        );
        // A stopped listener must recover even if a background callback was missed
        // and its address is still present in the navigation allowlist.
        transport
            .manager
            .listeners
            .lock()
            .await
            .get_mut(&address)
            .unwrap()
            .stop()
            .await;
        transport.set_foreground(true).await.unwrap();
        assert_eq!(
            client
                .get(format!("{origin}/_grove/health"))
                .send()
                .await
                .unwrap()
                .status(),
            204
        );
        transport.set_foreground(false).await.unwrap();
        remote_task.abort();
    }

    #[tokio::test]
    async fn inactive_listener_failure_does_not_block_active_profile_and_can_retry() {
        let dir = tempfile::tempdir().unwrap();
        let transport = start(dir.path().join("server.txt")).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut state = transport
            .manager
            .listeners
            .lock()
            .await
            .get(&transport.address)
            .unwrap()
            .state
            .clone();
        state.origin = format!("http://{address}");
        serve_listener(listener, state).await;
        // Select the second profile, so recovery must use active_origin rather
        // than assuming that the launcher's transport.address is always active.
        *transport.manager.active_origin.write().unwrap() = format!("http://{address}");
        transport.set_foreground(false).await.unwrap();
        let occupied = tokio::net::TcpListener::bind(transport.address)
            .await
            .unwrap();
        transport.set_foreground(true).await.unwrap();
        assert_eq!(
            reqwest::get(format!("http://{address}/_grove/health"))
                .await
                .unwrap()
                .status(),
            204
        );
        drop(occupied);
        transport.set_foreground(true).await.unwrap();
        for recovered in [address, transport.address] {
            assert_eq!(
                reqwest::get(format!("http://{recovered}/_grove/health"))
                    .await
                    .unwrap()
                    .status(),
                204
            );
        }
        // The same conflict must still fail if it belongs to the current page.
        transport.set_foreground(false).await.unwrap();
        let occupied = tokio::net::TcpListener::bind(address).await.unwrap();
        assert!(transport.set_foreground(true).await.is_err());
        drop(occupied);
        assert_eq!(
            reqwest::get(format!("http://{}/_grove/health", transport.address))
                .await
                .unwrap()
                .status(),
            204
        );
        transport.set_foreground(false).await.unwrap();
    }

    #[tokio::test]
    async fn occupied_port_fails_without_switching_storage_origin_and_can_retry() {
        let dir = tempfile::tempdir().unwrap();
        let transport = start(dir.path().join("server.txt")).await.unwrap();
        transport.set_foreground(false).await.unwrap();
        let occupied = tokio::net::TcpListener::bind(transport.address)
            .await
            .unwrap();
        assert!(transport.set_foreground(true).await.is_err());
        drop(occupied);
        transport.set_foreground(true).await.unwrap();
        let reply = reqwest::get(format!("http://{}/_grove/health", transport.address))
            .await
            .unwrap();
        assert_eq!(reply.status(), 204);
        transport.set_foreground(false).await.unwrap();
    }

    #[tokio::test]
    async fn activity_links_only_reopen_saved_origins() {
        let dir = tempfile::tempdir().unwrap();
        let transport = start(dir.path().join("server.txt")).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        transport
            .manager
            .saved
            .lock()
            .await
            .servers
            .push(ServerProfile {
                id: "test".into(),
                name: "Home".into(),
                server: "http://127.0.0.1:1/".into(),
                port,
            });
        let origin = format!("http://127.0.0.1:{port}");
        let mut link = Url::parse("grove://activity").unwrap();
        link.query_pairs_mut()
            .append_pair("origin", &origin)
            .append_pair("project", "p")
            .append_pair("task", "t")
            .append_pair("chat", "session-two");
        let target = transport.activity_target(&link).await.unwrap();
        assert_eq!(target.origin().ascii_serialization(), origin);
        assert!(transport.allows_navigation(&target));
        let payload = target
            .query_pairs()
            .find(|(k, _)| k == "grove_activity")
            .unwrap()
            .1
            .into_owned();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["task_id"], "t");
        assert_eq!(payload["chat_id"], "session-two");
        let script =
            activity_navigation_script(&Url::parse(&format!("{origin}/tasks")).unwrap(), &target)
                .unwrap();
        assert!(script.contains("grove:activity-open"));
        assert!(script.contains("session-two"));
        assert!(!script.contains("location"));
        assert!(
            activity_navigation_script(&Url::parse("http://127.0.0.1:1/").unwrap(), &target)
                .is_none()
        );
        assert!(activity_navigation_script(
            &Url::parse(&format!("{origin}/_grove/")).unwrap(),
            &target
        )
        .is_none());
        for value in [
            "grove://activity?origin=https://evil.example",
            "https://activity?origin=http://127.0.0.1:1",
        ] {
            assert!(transport
                .activity_target(&Url::parse(value).unwrap())
                .await
                .is_none());
        }
        // The bridge must reject requests lacking the per-process token.
        let response = reqwest::Client::new()
            .post(format!("{origin}/_grove/activity"))
            .header("origin", &origin)
            .json(&serde_json::json!({"clear":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn activity_heartbeat_requires_an_upstream_pong() {
        let remote = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_address = remote.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (stream, _) = remote.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            match socket.next().await.unwrap().unwrap() {
                UpstreamMessage::Ping(bytes) => {
                    assert_eq!(bytes.as_ref(), b"grove-activity");
                    socket.send(UpstreamMessage::Pong(bytes)).await.unwrap();
                }
                message => panic!("expected protocol ping, got {message:?}"),
            }
            let _ = socket.next().await;
        });
        let dir = tempfile::tempdir().unwrap();
        let transport = start(dir.path().join("server.txt")).await.unwrap();
        let client = reqwest::Client::new();
        let manager = format!("http://{}", transport.address);
        let response =
            select_profile(&client, &manager, &format!("http://{remote_address}"), true).await;
        let profile = response.json::<serde_json::Value>().await.unwrap();
        let origin = profile["location"].as_str().unwrap().trim_end_matches('/');
        let url = format!(
            "{}/api/v1/radio/events/ws",
            origin.replacen("http:", "ws:", 1)
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        socket
            .send(UpstreamMessage::Text("activity_heartbeat".into()))
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.into_text().unwrap(),
            r#"{"type":"activity_heartbeat"}"#
        );
        socket.close(None).await.unwrap();
        upstream.abort();
    }

    #[test]
    fn accepts_origins_and_rejects_credentials_paths_and_other_schemes() {
        assert_eq!(
            normalize_server(" http://192.168.1.2:3001 ")
                .unwrap()
                .as_str(),
            "http://192.168.1.2:3001/"
        );
        assert!(normalize_server("https://grove.example").is_ok());
        for value in [
            "file:///tmp",
            "ftp://example.com",
            "http://user:secret@host",
            "http://host/#sk=secret",
            "http://host/api",
            "http://host/?token=secret",
        ] {
            assert!(normalize_server(value).is_err(), "{value}");
        }
    }

    #[test]
    fn strips_connection_nominated_headers_but_preserves_auth() {
        let mut headers = HeaderMap::new();
        headers.insert("connection", "keep-alive, x-private-hop".parse().unwrap());
        headers.insert("x-private-hop", "secret".parse().unwrap());
        headers.insert("authorization", "Bearer test".parse().unwrap());
        strip_transport_headers(&mut headers);
        assert!(!headers.contains_key("connection"));
        assert!(!headers.contains_key("x-private-hop"));
        assert!(headers.contains_key("authorization"));
    }

    async fn configuration(client: &reqwest::Client, origin: &str) -> serde_json::Value {
        let html = client
            .get(format!("{origin}/_grove/"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        serde_json::from_str(
            html.split("type=\"application/json\">")
                .nth(1)
                .unwrap()
                .split("</script>")
                .next()
                .unwrap(),
        )
        .unwrap()
    }

    async fn select_profile(
        client: &reqwest::Client,
        origin: &str,
        server: &str,
        save_only: bool,
    ) -> reqwest::Response {
        let config = configuration(client, origin).await;
        client.post(format!("{origin}/_grove/connect"))
            .header("origin", origin).header("x-grove-setup", config["token"].as_str().unwrap())
            .json(&serde_json::json!({ "server": server, "name": "Test server", "save_only": save_only }))
            .send().await.unwrap()
    }

    #[tokio::test]
    async fn switching_keeps_origins_and_upstream_credentials_isolated() {
        let client = reqwest::Client::new();
        let temp = tempfile::tempdir().unwrap();
        let transport = start(temp.path().join("server.txt")).await.unwrap();
        let manager = format!("http://{}", transport.address);
        let mut servers = Vec::new();
        let mut tasks = Vec::new();
        for name in ["A", "B"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            servers.push(format!("http://{}", listener.local_addr().unwrap()));
            let app = Router::new()
                .route("/api/v1/auth/info", get(|| async { Json(serde_json::json!({"required": true})) }))
                .route("/api/v1/who", get(move |headers: HeaderMap| async move {
                    assert!(!headers.contains_key("cookie"));
                    ([("set-cookie", "upstream=private")], Json(serde_json::json!({"server": name, "auth": headers["authorization"].to_str().unwrap()})))
                }));
            tasks.push(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            }));
        }
        let a = select_profile(&client, &manager, &servers[0], false)
            .await
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let a = a["location"]
            .as_str()
            .unwrap()
            .trim_end_matches('/')
            .to_owned();
        let b = select_profile(&client, &a, &servers[1], false)
            .await
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let b = b["location"]
            .as_str()
            .unwrap()
            .trim_end_matches('/')
            .to_owned();
        assert_ne!(a, b);
        for (origin, label, key) in [(&a, "A", "key-A"), (&b, "B", "key-B")] {
            let response = client
                .get(format!("{origin}/api/v1/who"))
                .header("authorization", key)
                .header("cookie", "other-server=secret")
                .send()
                .await
                .unwrap();
            assert!(!response.headers().contains_key("set-cookie"));
            let value: serde_json::Value = response.json().await.unwrap();
            assert_eq!(value["server"], label);
            assert_eq!(value["auth"], key);
        }
        let back = select_profile(&client, &b, &servers[0], false)
            .await
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(back["location"], format!("{a}/"));
        assert_eq!(
            configuration(&client, &a).await["servers"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(!transport.allows_navigation(&Url::parse(&servers[0]).unwrap()));
        assert_eq!(
            select_profile(&client, &a, &b, false).await.status(),
            StatusCode::BAD_REQUEST
        );
        // An unreachable server does not change either established route.
        assert_eq!(
            select_profile(&client, &a, "http://127.0.0.1:1", false)
                .await
                .status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            configuration(&client, &a).await["servers"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for task in tasks {
            task.abort();
        }
    }

    #[test]
    fn saved_server_origin_survives_a_cold_restart_without_storing_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let preferences = temp.path().join("server.txt");
        std::fs::write(&preferences, "http://old-server:3001").unwrap();
        let mut origins = Vec::new();
        for _ in 0..2 {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            origins.push(runtime.block_on(async {
                let transport = start(preferences.clone()).await.unwrap();
                let manager = format!("http://{}", transport.address);
                let client = reqwest::Client::new();
                assert_eq!(
                    configuration(&client, &manager).await["server"],
                    "http://old-server:3001"
                );
                let response =
                    select_profile(&client, &manager, "http://offline-server:3001", true).await;
                assert_eq!(response.status(), StatusCode::OK);
                response.json::<serde_json::Value>().await.unwrap()["location"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            }));
        }
        assert_eq!(origins[0], origins[1]);
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(preferences.with_file_name("servers.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["servers"].as_array().unwrap().len(), 1);
        assert_eq!(value["servers"][0].as_object().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn forwards_authenticated_http_and_websocket_without_exposing_setup() {
        use axum::{extract::OriginalUri, routing::any};
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let upstream_router = Router::new()
            .route(
                "/api/v1/auth/info",
                get(|| async { Json(serde_json::json!({"required": true})) }),
            )
            .route(
                "/api/v1/echo",
                any(
                    |OriginalUri(uri): OriginalUri, headers: HeaderMap, body: String| async move {
                        assert_eq!(uri.query(), Some("timestamp=123&signature=test"));
                        assert_eq!(headers["x-grove-device-id"], "test-device");
                        (StatusCode::ACCEPTED, [("x-upstream", "preserved")], body)
                    },
                ),
            )
            .route(
                "/ws",
                get(
                    |ws: WebSocketUpgrade, OriginalUri(uri): OriginalUri| async move {
                        assert_eq!(uri.query(), Some("signature=ws-proof"));
                        ws.on_upgrade(|mut socket| async move {
                            while let Some(Ok(message)) = socket.recv().await {
                                if socket.send(message).await.is_err() {
                                    break;
                                }
                            }
                        })
                    },
                ),
            );
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream_listener, upstream_router)
                .await
                .unwrap();
        });
        let temporary = tempfile::tempdir().unwrap();
        let preferences = temporary.path().join("server.txt");
        let transport = start(preferences.clone()).await.unwrap();
        let local = transport.address;
        let origin = format!("http://{local}");
        let client = reqwest::Client::new();
        let html = client
            .get(format!("{origin}/_grove/"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let config = html
            .split("type=\"application/json\">")
            .nth(1)
            .unwrap()
            .split("</script>")
            .next()
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(config).unwrap();
        let setup_url = format!("{origin}/_grove/connect");
        let payload = serde_json::json!({"server": format!("http://{upstream_address}")});
        let missing_token = client
            .post(&setup_url)
            .header("origin", &origin)
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(missing_token.status(), StatusCode::FORBIDDEN);
        let wrong_origin = client
            .post(&setup_url)
            .header("origin", "https://untrusted.example")
            .header("x-grove-setup", config["token"].as_str().unwrap())
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        let connected = client
            .post(&setup_url)
            .header("origin", &origin)
            .header("x-grove-setup", config["token"].as_str().unwrap())
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(connected.status(), StatusCode::OK);
        let result: serde_json::Value = connected.json().await.unwrap();
        let origin = result["location"]
            .as_str()
            .unwrap()
            .trim_end_matches('/')
            .to_owned();
        let local = origin.strip_prefix("http://").unwrap();
        assert!(transport.allows_navigation(&Url::parse(&origin).unwrap()));
        let saved: SavedServers = serde_json::from_slice(
            &tokio::fs::read(preferences.with_file_name("servers.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            saved.servers[0].server,
            format!("http://{upstream_address}/")
        );

        let response = client
            .post(format!("{origin}/api/v1/echo?timestamp=123&signature=test"))
            .header("x-grove-device-id", "test-device")
            .body("upload contents")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()["x-upstream"], "preserved");
        assert_eq!(response.text().await.unwrap(), "upload contents");
        let denied = client
            .get(format!("{origin}/api/v1/auth/info"))
            .header("host", "attacker.example")
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let asset = client.get(format!("{origin}/")).send().await.unwrap();
        assert!(asset.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("text/html"));
        assert_eq!(
            client
                .get(format!("{origin}/sw.js"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );

        let (mut websocket, _) =
            tokio_tungstenite::connect_async(format!("ws://{local}/ws?signature=ws-proof"))
                .await
                .unwrap();
        websocket
            .send(UpstreamMessage::Text("streamed reply".into()))
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(2), websocket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(reply, UpstreamMessage::Text("streamed reply".into()));
        websocket
            .send(UpstreamMessage::Binary(vec![1, 2, 3].into()))
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(2), websocket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(reply, UpstreamMessage::Binary(vec![1, 2, 3].into()));
        websocket.close(None).await.unwrap();
        upstream_task.abort();
    }
}
