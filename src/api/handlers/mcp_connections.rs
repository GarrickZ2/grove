//! Authenticated management APIs. OAuth callbacks use a short-lived loopback
//! listener bound to the flow's state; credentials never appear in responses.
use crate::{api::error::ApiError, mcp_client};
use axum::{extract::Path, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct ConnectionRequest {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    callback_url: Option<String>,
}

pub async fn status(
    Json(req): Json<ConnectionRequest>,
) -> Result<Json<mcp_client::ConnectionSummary>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::connection_summary(&req.url)
        .map(Json)
        .map_err(ApiError::bad_request)
}

pub async fn probe(
    Json(req): Json<ConnectionRequest>,
) -> Result<Json<mcp_client::ConnectionSummary>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::probe(&req.url, req.headers)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

#[derive(Deserialize)]
pub struct PackageProbeRequest {
    package: Value,
    #[serde(default)]
    values: HashMap<String, String>,
}

pub async fn probe_package(
    Json(req): Json<PackageProbeRequest>,
) -> Result<Json<mcp_client::PackageProbeSummary>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::start_package_probe(req.package, req.values)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

pub async fn package_status(
    Path(id): Path<String>,
) -> Result<Json<mcp_client::PackageProbeSummary>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::package_probe_status(&id)
        .map(Json)
        .map_err(ApiError::bad_request)
}

pub async fn cancel_package(Path(id): Path<String>) -> Json<Value> {
    mcp_client::cancel_package_probe(&id);
    Json(json!({"ok":true}))
}

pub async fn authorize(
    Json(req): Json<ConnectionRequest>,
) -> Result<Json<mcp_client::FlowSummary>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::start_auth(&req.url, req.client_id, req.client_secret, req.callback_url)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

pub async fn disconnect(
    Json(req): Json<ConnectionRequest>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<ApiError>)> {
    let warning = mcp_client::disconnect(&req.url)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({"ok":true,"warning":warning})))
}

pub async fn flow_status(
    Path(id): Path<String>,
) -> Result<Json<mcp_client::FlowSummary>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::flow_status(&id)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

pub async fn cancel(
    Path(id): Path<String>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<ApiError>)> {
    mcp_client::cancel_flow(&id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
pub struct CallbackRequest {
    callback_url: String,
}

pub async fn callback(
    Path(id): Path<String>,
    Json(req): Json<CallbackRequest>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<ApiError>)> {
    let url = url::Url::parse(&req.callback_url)
        .map_err(|_| ApiError::bad_request("Paste the complete callback URL from your browser."))?;
    let params = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    mcp_client::finish_auth(&id, params)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({"ok":true})))
}
