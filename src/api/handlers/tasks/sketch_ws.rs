//! WebSocket endpoint streaming sketch events for a single task.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path,
    },
    response::{IntoResponse, Response},
};

use super::super::common::find_project_by_id;
use super::sketch_events::{subscribe, SketchEvent};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path((id, task_id)): Path<(String, String)>,
) -> Response {
    // Resolve the project up front — a missing project should surface as 404
    // rather than a silently-dead WebSocket that the client waits on forever.
    let project_key = match find_project_by_id(&id) {
        Ok((_p, k)) => k,
        Err(status) => return status.into_response(),
    };
    ws.on_upgrade(move |socket| handle(socket, project_key, task_id))
}

async fn handle(mut socket: WebSocket, project_key: String, task_id: String) {
    let mut rx = subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    // First tick fires immediately; skip it so we don't ping before any event.
    heartbeat.tick().await;
    loop {
        tokio::select! {
            // Outgoing: filter events by project + task
            evt = rx.recv() => match evt {
                Ok(event) => {
                    if matches(&event, &project_key, &task_id) {
                        if let Ok(text) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            // Keep the connection alive through reverse-proxy idle timeouts.
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            // Incoming: we only care about close pings
            inc = socket.recv() => match inc {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            }
        }
    }
}

fn matches(event: &SketchEvent, project: &str, task_id: &str) -> bool {
    match event {
        SketchEvent::SketchUpdated {
            project: p,
            task_id: t,
            ..
        }
        | SketchEvent::IndexChanged {
            project: p,
            task_id: t,
        } => p == project && t == task_id,
    }
}
