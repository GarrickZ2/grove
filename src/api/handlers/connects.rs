use axum::{extract::Path, http::StatusCode, Json};
use serde::Deserialize;

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
    crate::connect::registration::get(&id)
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
        crate::connect::registration::claim_credentials(&input.flow_id).ok_or((
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
    if let Err(error) = connect::validate(&create, false).map_err(connection_error) {
        crate::connect::registration::release_credentials(&input.flow_id);
        return Err(error);
    }
    let item = match connect::persist(create) {
        Ok(item) => item,
        Err(error) => {
            crate::connect::registration::release_credentials(&input.flow_id);
            return Err(connection_error(error));
        }
    };
    // The user who authorized the QR flow owns this connection — seed the
    // binding so nobody else can capture it by messaging the bot first.
    if !user_open_id.is_empty() {
        if let Err(error) = connects::prebind_user(&item.id, &user_open_id) {
            let _ = connects::delete(&item.id);
            crate::connect::registration::release_credentials(&input.flow_id);
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
    crate::connect::registration::finish(&input.flow_id);
    Ok((StatusCode::CREATED, Json(connect::current_view(item))))
}
