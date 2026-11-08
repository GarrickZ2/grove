//! Reaches the user's own browser through the Companion extension.
//!
//! The driver speaks plain CDP to a loopback WebSocket here, and each frame is
//! carried over the Companion's existing connection, which also works when
//! Grove runs on another machine. Grove stays a pipe; the Companion answers
//! the browser-level commands a Chrome extension cannot pass on. A relay token
//! is the session's whole authority.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::api::handlers::extension;

#[derive(Clone)]
struct RelayScope {
    scope: String,
    group: Option<String>,
}

static TOKENS: LazyLock<Mutex<HashMap<String, RelayScope>>> = LazyLock::new(Default::default);
static SOCKETS: LazyLock<Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>> =
    LazyLock::new(Default::default);
static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);

pub fn register_token(token: &str, scope: &str, group: Option<String>) {
    TOKENS.lock().unwrap().insert(
        token.to_string(),
        RelayScope {
            scope: scope.to_string(),
            group,
        },
    );
}

pub fn ensure_companion() -> Result<(), String> {
    extension::ensure_cdp_relay()
}

/// GET /browser-relay/{token} on the loopback listener.
pub async fn ws_handler(Path(token): Path<String>, ws: WebSocketUpgrade) -> Response {
    let scope = TOKENS.lock().unwrap().get(&token).cloned();
    match scope {
        Some(scope) => ws
            .max_message_size(128 * 1024 * 1024)
            .on_upgrade(move |socket| relay(socket, scope))
            .into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

async fn relay(socket: WebSocket, scope: RelayScope) {
    let id = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel();
    SOCKETS.lock().unwrap().insert(id, tx);
    let opened = extension::send_to_companion(json!({
        "type": "CDP_OPEN",
        "socket": id,
        "scope": scope.scope,
        "group": scope.group,
    }));
    let (mut sender, mut receiver) = socket.split();
    if opened.is_ok() {
        loop {
            tokio::select! {
                outbound = rx.recv() => {
                    let Some(frame) = outbound else { break };
                    if sender.send(Message::Text(frame.into())).await.is_err() {
                        break;
                    }
                }
                inbound = receiver.next() => {
                    let Some(Ok(message)) = inbound else { break };
                    let Message::Text(frame) = message else { continue };
                    let frame = json!({"type": "CDP_IN", "socket": id, "data": frame.as_str()});
                    if extension::send_to_companion(frame).is_err() {
                        break;
                    }
                }
            }
        }
    }
    SOCKETS.lock().unwrap().remove(&id);
    let _ = extension::send_to_companion(json!({"type": "CDP_CLOSE", "socket": id}));
}

/// A frame from the Companion for one driver connection.
pub fn deliver(message: &Value) {
    let Some(id) = message.get("socket").and_then(Value::as_u64) else {
        return;
    };
    let Some(frame) = message.get("data").and_then(Value::as_str) else {
        return;
    };
    if let Some(socket) = SOCKETS.lock().unwrap().get(&id) {
        let _ = socket.send(frame.to_string());
    }
}

/// The Companion ended one driver connection.
pub fn close_socket(message: &Value) {
    if let Some(id) = message.get("socket").and_then(Value::as_u64) {
        SOCKETS.lock().unwrap().remove(&id);
    }
}

/// Dropping the senders ends every relay, so drivers reconnect once the
/// Companion is back rather than waiting on a dead browser.
pub fn close_all() {
    SOCKETS.lock().unwrap().clear();
}
