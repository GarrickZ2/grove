use axum::{
    body::{Body, Bytes},
    extract::{OriginalUri, Path},
    http::{HeaderMap, Method, Response, StatusCode},
    Json,
};
use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;

use crate::connect;
use crate::storage::connects;

pub async fn platforms() -> Json<Vec<crate::connect::platform::PlatformDefinition>> {
    Json(crate::connect::adapter::definitions())
}

fn connection_error(error: connect::ConnectionError) -> (StatusCode, String) {
    let status = match error {
        connect::ConnectionError::Invalid(_) => StatusCode::BAD_REQUEST,
        connect::ConnectionError::NotFound => StatusCode::NOT_FOUND,
        connect::ConnectionError::Adapter(_) => StatusCode::BAD_GATEWAY,
        connect::ConnectionError::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}

pub async fn list() -> Result<Json<Vec<connect::ConnectionView>>, (StatusCode, String)> {
    connect::list_views().map(Json).map_err(connection_error)
}

pub async fn create(
    Json(input): Json<connects::ConnectInput>,
) -> Result<(StatusCode, Json<connect::ConnectionView>), (StatusCode, String)> {
    let item = connect::create(input).map_err(connection_error)?;
    Ok((StatusCode::CREATED, Json(connect::current_view(item))))
}

pub async fn update(
    Path(id): Path<String>,
    Json(input): Json<connects::ConnectInput>,
) -> Result<Json<connect::ConnectionView>, (StatusCode, String)> {
    let item = connect::update(&id, input).map_err(connection_error)?;
    Ok(Json(connect::current_view(item)))
}

pub async fn delete(Path(id): Path<String>) -> Result<StatusCode, (StatusCode, String)> {
    connect::delete(&id).map_err(connection_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn verify(Path(id): Path<String>) -> Result<StatusCode, (StatusCode, String)> {
    connect::verify(&id).await.map_err(connection_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct VerifyCredentials {
    pub platform: String,
    pub domain: String,
    pub adapter_config: serde_json::Value,
}

pub async fn verify_credentials(
    Json(input): Json<VerifyCredentials>,
) -> Result<StatusCode, (StatusCode, String)> {
    connect::verify_credentials(&input.platform, &input.domain, &input.adapter_config)
        .await
        .map_err(connection_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct BeginRegistration {
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default)]
    pub domain: String,
}

fn default_platform() -> String {
    "feishu".into()
}

pub async fn begin_registration(
    Json(input): Json<BeginRegistration>,
) -> Result<Json<crate::connect::registration::RegistrationView>, (StatusCode, String)> {
    crate::connect::adapter::begin_registration(&input.platform, &input.domain)
        .await
        .map(Json)
        .map_err(|error| (StatusCode::BAD_GATEWAY, error))
}

pub async fn registration_status(
    Path(id): Path<String>,
) -> Result<Json<crate::connect::registration::RegistrationView>, (StatusCode, String)> {
    crate::connect::adapter::registration_status(&id)
        .await
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "registration flow not found".into()))
}

#[derive(Debug, Deserialize)]
pub struct FinishRegistration {
    pub flow_id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub session_id: String,
}

fn default_true() -> bool {
    true
}

pub async fn finish_registration(
    Json(input): Json<FinishRegistration>,
) -> Result<(StatusCode, Json<connect::ConnectionView>), (StatusCode, String)> {
    let (platform, adapter_config, domain, user_open_id) =
        crate::connect::adapter::claim_registration(&input.flow_id).ok_or((
            StatusCode::CONFLICT,
            "registration is not authorized yet".into(),
        ))?;
    let create = connects::ConnectInput {
        name: input.name,
        platform,
        domain,
        enabled: input.enabled,
        adapter_config,
        project_id: input.project_id,
        task_id: input.task_id,
        session_id: input.session_id,
    };
    let item = match connect::persist_authorized(create) {
        Ok(item) => item,
        Err(error) => {
            crate::connect::adapter::release_registration(&input.flow_id);
            return Err(connection_error(error));
        }
    };
    // The user who authorized the QR flow owns this connection — seed the
    // binding so nobody else can capture it by messaging the bot first.
    if !user_open_id.is_empty() {
        if let Err(error) = connects::prebind_user(&item.id, &user_open_id) {
            let _ = connects::delete(&item.id);
            crate::connect::adapter::release_registration(&input.flow_id);
            return Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string()));
        }
    }
    // Start the platform only after the Connect row and the QR owner have
    // both been persisted.
    let item = connects::get(&item.id)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "created connect disappeared".into(),
        ))?;
    crate::connect::adapter::apply_connection(item.clone());
    crate::connect::adapter::finish_registration(&input.flow_id);
    Ok((StatusCode::CREATED, Json(connect::current_view(item))))
}

fn provider_request(
    method: Method,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> crate::plugins::connect_provider::ProviderHttpRequest {
    let headers = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect::<HashMap<_, _>>();
    crate::plugins::connect_provider::ProviderHttpRequest {
        method: method.as_str().to_owned(),
        query: uri.0.query().unwrap_or_default().to_owned(),
        headers,
        body_base64: base64::engine::general_purpose::STANDARD.encode(body),
    }
}

fn provider_response(
    response: crate::plugins::connect_provider::ProviderHttpResponse,
) -> Result<Response<Body>, (StatusCode, String)> {
    let mut builder = Response::builder().status(response.status);
    for (name, value) in response.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "connection"
                | "content-length"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
        ) {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(response.body))
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))
}

fn provider_http_error(error: crate::error::GroveError) -> (StatusCode, String) {
    let status = if matches!(error, crate::error::GroveError::NotFound(_)) {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_GATEWAY
    };
    (status, error.to_string())
}

/// Public OAuth/QR callback ingress. Flow ids are unguessable and Providers
/// must still validate platform state/signatures before returning credentials.
pub async fn provider_registration_callback(
    Path((plugin_id, provider_id, flow_id)): Path<(String, String, String)>,
    method: Method,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response<Body>, (StatusCode, String)> {
    let request = provider_request(method, uri, headers, body);
    let response = crate::plugins::connect_provider::registration_callback(
        &plugin_id,
        &provider_id,
        &flow_id,
        request,
    )
    .await
    .map_err(provider_http_error)?;
    provider_response(response)
}
