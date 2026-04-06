//! Independent Radio HTTPS server for LAN access from mobile devices.
//!
//! The main Grove server binds to localhost and is not reachable from a phone.
//! This module manages a separate Axum server bound to `0.0.0.0` on a random port,
//! serving the embedded SPA and a walkie-talkie WebSocket endpoint over HTTPS
//! (required for getUserMedia microphone access on mobile browsers).
//! Auth is handled via a one-time token passed as a query parameter.

use axum::{
    body::Body,
    extract::{Query, Request, WebSocketUpgrade},
    http::{header, Response, StatusCode, Uri},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::FrontendAssets;

/// Information about a running Radio server instance.
#[derive(Debug, Clone, Serialize)]
pub struct RadioServerInfo {
    pub port: u16,
    pub token: String,
}

/// Internal state for the running Radio server.
struct RadioServerHandle {
    pub port: u16,
    pub token: String,
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

/// Global singleton for the radio server handle.
static RADIO_SERVER: once_cell::sync::Lazy<Mutex<Option<RadioServerHandle>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// Start the Radio server if not already running. Returns connection info.
pub async fn start() -> Result<RadioServerInfo, String> {
    let mut guard = RADIO_SERVER.lock().await;
    if let Some(ref handle) = *guard {
        return Ok(RadioServerInfo {
            port: handle.port,
            token: handle.token.clone(),
        });
    }

    let token = uuid::Uuid::new_v4().to_string().replace('-', "");
    let expected_token = Arc::new(token.clone());
    let app = create_radio_router(expected_token);

    // Generate/load self-signed TLS certificate (required for getUserMedia on mobile)
    let lan_ip = crate::api::get_lan_ip();
    let (cert_pem, key_pem) = crate::api::tls::ensure_cert(lan_ip.as_deref())
        .map_err(|e| format!("Failed to generate TLS cert: {}", e))?;

    // Install rustls crypto provider (idempotent)
    let _ = rustls::crypto::ring::default_provider().install_default();

    let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem(
        cert_pem.into_bytes(),
        key_pem.into_bytes(),
    )
    .await
    .map_err(|e| format!("Failed to configure TLS: {}", e))?;

    // Bind to 0.0.0.0:0 to get a random available port
    let listener = std::net::TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind radio server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {}", e))?
        .port();

    // Use axum_server Handle for graceful shutdown
    let handle = axum_server::Handle::new();
    let shutdown_handle = handle.clone();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        let _ = shutdown_rx.await;
        shutdown_handle.shutdown();
    });

    tokio::spawn(async move {
        axum_server::from_tcp_rustls(listener, tls_config)
            .handle(handle)
            .serve(app.into_make_service())
            .await
            .ok();
    });

    let info = RadioServerInfo {
        port,
        token: token.clone(),
    };

    *guard = Some(RadioServerHandle {
        port,
        token,
        shutdown_tx,
    });

    Ok(info)
}

/// Stop the Radio server if running.
pub async fn stop() {
    let mut guard = RADIO_SERVER.lock().await;
    if let Some(handle) = guard.take() {
        let _ = handle.shutdown_tx.send(());
    }
}

/// Get info about the currently running Radio server, if any.
pub async fn info() -> Option<RadioServerInfo> {
    let guard = RADIO_SERVER.lock().await;
    guard.as_ref().map(|h| RadioServerInfo {
        port: h.port,
        token: h.token.clone(),
    })
}

// ─── Router ────────────────────────────────────────────────────────────────

fn create_radio_router(expected_token: Arc<String>) -> Router {
    let authed_routes = Router::new()
        .route("/ws", get(radio_ws_handler))
        .route(
            "/api/v1/ai/transcribe",
            post(super::handlers::ai::transcribe),
        )
        .layer(middleware::from_fn_with_state(
            expected_token,
            radio_auth_middleware,
        ));

    let static_routes = Router::new().fallback(serve_radio_embedded);

    authed_routes.merge(static_routes)
}

// ─── Token Auth Middleware ──────────────────────────────────────────────────

async fn radio_auth_middleware(
    axum::extract::State(expected_token): axum::extract::State<Arc<String>>,
    Query(params): Query<HashMap<String, String>>,
    request: Request,
    next: Next,
) -> axum::response::Response {
    let provided = params.get("token").cloned().or_else(|| {
        request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|s| s.to_string())
    });

    match provided {
        Some(t) if t == *expected_token => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, "Invalid or missing token").into_response(),
    }
}

// ─── WebSocket Handler ─────────────────────────────────────────────────────

async fn radio_ws_handler(ws: WebSocketUpgrade) -> axum::response::Response {
    ws.on_upgrade(|socket| async {
        use super::handlers::walkie_talkie::{
            broadcast_radio_event, decrement_radio_clients, increment_radio_clients, RadioEvent,
        };
        increment_radio_clients();
        broadcast_radio_event(RadioEvent::ClientConnected);
        super::handlers::walkie_talkie::handle_walkie_talkie_ws_inner(socket).await;
        decrement_radio_clients();
        broadcast_radio_event(RadioEvent::ClientDisconnected);
    })
}

// ─── Embedded Static Files ─────────────────────────────────────────────────

async fn serve_radio_embedded(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

    // Radio server serves radio.html as the SPA entry point (independent from main Grove app)
    let (file, serve_path) = if let Some(content) = FrontendAssets::get(path) {
        (Some(content), path)
    } else if path.is_empty() || !path.contains('.') || path.ends_with(".html") {
        (FrontendAssets::get("radio.html"), "radio.html")
    } else {
        (None, path)
    };

    match file {
        Some(content) => {
            let mime = mime_guess::from_path(serve_path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(content.data.into_owned()))
                .expect("build static file HTTP response")
        }
        None => {
            if let Some(index) = FrontendAssets::get("radio.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(index.data.into_owned()))
                    .expect("build radio.html HTTP response")
            } else {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Not Found"))
                    .expect("build 404 HTTP response")
            }
        }
    }
}
