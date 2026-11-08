//! The Browser panel: live view of a Task's browser and the user's controls.
//!
//! The driver's stream only accepts local origins, so the panel always goes
//! through this proxy. That also keeps it behind Grove's auth, which is what
//! lets a phone connected through Remote watch and use the page.

use axum::extract::ws::{Message as AxumMessage, WebSocket};
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as DriverMessage;

use crate::api::device_auth::RevocableWebSocketUpgrade as WebSocketUpgrade;
use crate::api::error::ApiError;
use crate::browser;

type TaskPath = Path<(String, String)>;
type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

/// GET /api/v1/browser/{project}/{task}
pub async fn status(Path((project, task)): TaskPath) -> Json<browser::SessionStatus> {
    Json(browser::status(&project, &task))
}

#[derive(Deserialize)]
pub struct TabRequest {
    target: browser::Target,
    tab: String,
}

/// POST /api/v1/browser/{project}/{task}/tab — show another tab in the panel.
pub async fn tab(
    Path((project, task)): TaskPath,
    Json(request): Json<TabRequest>,
) -> ApiResult<browser::SessionStatus> {
    browser::switch_tab(&project, &task, request.target, &request.tab)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(browser::status(&project, &task)))
}

#[derive(Deserialize)]
pub struct StreamQuery {
    target: Option<browser::Target>,
}

/// GET /api/v1/browser/{project}/{task}/stream
pub async fn stream(
    Path((project, task)): TaskPath,
    Query(query): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let port = browser::stream_port(&project, &task, query.target)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(ws.on_upgrade(move |socket| proxy(socket, port)))
}

async fn proxy(socket: WebSocket, port: u16) {
    let Ok(mut request) = format!("ws://127.0.0.1:{port}").into_client_request() else {
        return;
    };
    request
        .headers_mut()
        .insert("Origin", HeaderValue::from_static("http://localhost"));
    let Ok((driver, _)) = tokio_tungstenite::connect_async(request).await else {
        return;
    };
    let (mut to_driver, mut from_driver) = driver.split();
    let (mut to_panel, mut from_panel) = socket.split();
    loop {
        tokio::select! {
            frame = from_driver.next() => {
                let Some(Ok(DriverMessage::Text(frame))) = frame else { break };
                let frame = AxumMessage::Text(frame.as_str().to_owned().into());
                if to_panel.send(frame).await.is_err() {
                    break;
                }
            }
            frame = from_panel.next() => {
                let Some(Ok(frame)) = frame else { break };
                let AxumMessage::Text(frame) = frame else { continue };
                let frame = DriverMessage::text(frame.as_str().to_owned());
                if to_driver.send(frame).await.is_err() {
                    break;
                }
            }
        }
    }
}
