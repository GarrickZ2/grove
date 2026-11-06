//! The machines this one is paired with.
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Request};
use axum::http::StatusCode;
use axum::response::Response;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::buddies::{error, ApiError};

use crate::api::device_auth::RequestAuth;
use crate::machines::{self, PairInput, ProfilePatch};
use crate::storage::machines::Profile;

pub async fn overview() -> Result<Json<Value>, ApiError> {
    Ok(Json(machines::overview(None).map_err(error)?))
}

pub async fn this() -> Result<Json<Profile>, ApiError> {
    Ok(Json(machines::this().map_err(error)?))
}

pub async fn pair(Json(input): Json<PairInput>) -> Result<Json<Profile>, ApiError> {
    Ok(Json(machines::pair(input).await.map_err(error)?))
}

pub async fn update(
    Path(id): Path<String>,
    Json(patch): Json<ProfilePatch>,
) -> Result<StatusCode, ApiError> {
    machines::update(&id, &patch).map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SessionInput {
    cookie: String,
}

pub async fn refresh_session(
    Path(id): Path<String>,
    Json(input): Json<SessionInput>,
) -> Result<StatusCode, ApiError> {
    machines::refresh_session(&id, &input.cookie)
        .await
        .map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove(Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    machines::remove(&id).await.map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn open(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"url": machines::proxy::open(&id).await.map_err(error)?}),
    ))
}

/// A window that can't use a local port reaches the machine through here.
pub async fn via(
    Path((id, _)): Path<(String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    machines::proxy::via(&id, request).await.map_err(error)
}

/// A paired machine keeping its connection to this one.
pub async fn link(
    Extension(identity): Extension<RequestAuth>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let device = identity.id().map(str::to_owned);
    upgrade.on_upgrade(move |socket| machines::link::accept(socket, device))
}
