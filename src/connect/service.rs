use crate::storage::{connects, tasks, workspace};
use serde::Serialize;
use serde_json::Value;

use super::adapter::ConnectionStatus;

#[derive(Debug, Serialize)]
pub struct ConnectionView {
    #[serde(flatten)]
    pub connection: connects::Connect,
    pub adapter_config: Value,
    pub runtime: ConnectionStatus,
    pub target: TargetView,
}

#[derive(Debug, Serialize)]
pub struct TargetView {
    pub agent: String,
    pub state: String,
    pub queue_mode: crate::grove::QueueMode,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub thought_level: Option<String>,
}

#[derive(Debug)]
pub enum ConnectionError {
    Invalid(String),
    NotFound,
    Adapter(String),
    Storage(String),
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::Adapter(message) | Self::Storage(message) => {
                formatter.write_str(message)
            }
            Self::NotFound => formatter.write_str("connect not found"),
        }
    }
}

fn storage(error: impl std::fmt::Display) -> ConnectionError {
    ConnectionError::Storage(error.to_string())
}

pub fn validate(input: &connects::ConnectInput, existing: bool) -> Result<(), ConnectionError> {
    super::adapter::validate_config(
        &input.platform,
        &input.domain,
        &input.adapter_config,
        existing,
    )
    .map_err(ConnectionError::Invalid)?;
    validate_target(input)
}

fn validate_target(input: &connects::ConnectInput) -> Result<(), ConnectionError> {
    if input.name.trim().is_empty() {
        return Err(ConnectionError::Invalid("name is required".into()));
    }
    if input.project_id.is_empty() {
        if !input.task_id.is_empty() || !input.session_id.is_empty() {
            return Err(ConnectionError::Invalid(
                "target project is required".into(),
            ));
        }
        return Ok(());
    }
    if workspace::load_project_by_hash(&input.project_id)
        .map_err(storage)?
        .is_none()
    {
        return Err(ConnectionError::Invalid("target project not found".into()));
    }
    if input.task_id.is_empty() {
        if !input.session_id.is_empty() {
            return Err(ConnectionError::Invalid("target task is required".into()));
        }
        return Ok(());
    }
    if tasks::get_task(&input.project_id, &input.task_id)
        .map_err(storage)?
        .is_none()
    {
        return Err(ConnectionError::Invalid("target task not found".into()));
    }
    if input.session_id.is_empty() {
        return Ok(());
    }
    let found = tasks::find_chat_session(&input.session_id).map_err(storage)?;
    if !matches!(found, Some((ref project, ref task, _)) if project == &input.project_id && task == &input.task_id)
    {
        return Err(ConnectionError::Invalid(
            "target session does not belong to the selected task".into(),
        ));
    }
    Ok(())
}

pub fn list() -> Result<Vec<connects::Connect>, ConnectionError> {
    connects::list().map_err(storage)
}

pub fn list_views() -> Result<Vec<ConnectionView>, ConnectionError> {
    let statuses = super::adapter::connection_statuses();
    list().map(|connections| {
        connections
            .into_iter()
            .map(|connection| view(connection, &statuses))
            .collect()
    })
}

pub fn current_view(connection: connects::Connect) -> ConnectionView {
    view(connection, &super::adapter::connection_statuses())
}

fn view(
    connection: connects::Connect,
    statuses: &std::collections::HashMap<String, ConnectionStatus>,
) -> ConnectionView {
    let adapter_config = super::adapter::public_config(
        &connection.platform,
        &connection.domain,
        &connection.adapter_config,
    );
    let provider_missing = connection.platform.starts_with("plugin:")
        && crate::plugins::connect_provider::find(&connection.platform).is_none();
    let runtime = if !connection.enabled {
        ConnectionStatus {
            state: "disabled".into(),
            detail: None,
        }
    } else {
        statuses
            .get(&connection.id)
            .cloned()
            .unwrap_or(ConnectionStatus {
                state: if provider_missing { "error" } else { "offline" }.into(),
                detail: provider_missing.then(|| "Connect provider plugin is not installed".into()),
            })
    };
    let snapshot = crate::grove::snapshot(
        &connection.project_id,
        &connection.task_id,
        &connection.session_id,
    );
    let agent = tasks::find_chat_session(&connection.session_id)
        .ok()
        .flatten()
        .map(|(_, _, chat)| chat.agent)
        .unwrap_or_default();
    let target = TargetView {
        agent,
        state: snapshot
            .as_ref()
            .map(|snapshot| if snapshot.busy { "working" } else { "idle" })
            .unwrap_or("offline")
            .into(),
        queue_mode: snapshot
            .as_ref()
            .map(|snapshot| snapshot.queue_mode)
            .unwrap_or_default(),
        model: snapshot
            .as_ref()
            .and_then(|value| value.config.model.clone()),
        mode: snapshot
            .as_ref()
            .and_then(|value| value.config.mode.clone()),
        thought_level: snapshot.and_then(|value| value.config.thought_level),
    };
    ConnectionView {
        connection,
        adapter_config,
        runtime,
        target,
    }
}

pub fn get(id: &str) -> Result<connects::Connect, ConnectionError> {
    connects::get(id)
        .map_err(storage)?
        .ok_or(ConnectionError::NotFound)
}

pub fn create(input: connects::ConnectInput) -> Result<connects::Connect, ConnectionError> {
    let connection = persist(input)?;
    super::adapter::apply_connection(connection.clone());
    Ok(connection)
}

/// Persists a fully validated Connect without starting its external adapter.
/// Registration flows use this to finish every DB write before opening the
/// platform connection.
pub fn persist(input: connects::ConnectInput) -> Result<connects::Connect, ConnectionError> {
    validate(&input, false)?;
    connects::create(input).map_err(storage)
}

/// OAuth/QR results are provider-owned configuration, not values entered in
/// the provider's form. Keep Core target validation without applying the
/// form's required-field rules to a different setup mode.
pub fn persist_authorized(
    input: connects::ConnectInput,
) -> Result<connects::Connect, ConnectionError> {
    if input.platform.starts_with("plugin:") {
        if crate::plugins::connect_provider::find(&input.platform).is_none() {
            return Err(ConnectionError::Invalid(
                "Connect provider is not installed".into(),
            ));
        }
        if !input.adapter_config.is_object() {
            return Err(ConnectionError::Invalid(
                "adapter_config must be a JSON object".into(),
            ));
        }
        validate_target(&input)?;
    } else {
        validate(&input, false)?;
    }
    connects::create(input).map_err(storage)
}

pub fn update(
    id: &str,
    input: connects::ConnectInput,
) -> Result<connects::Connect, ConnectionError> {
    let previous = get(id)?;
    let mut input = input;
    let current_config = (previous.platform == input.platform).then_some(&previous.adapter_config);
    input.adapter_config = super::adapter::merge_config(
        &input.platform,
        &input.domain,
        current_config,
        &input.adapter_config,
    )
    .map_err(ConnectionError::Invalid)?;
    validate(&input, true)?;
    let connection = connects::update(id, input)
        .map_err(storage)?
        .ok_or(ConnectionError::NotFound)?;
    let adapter_changed = previous.enabled != connection.enabled
        || previous.platform != connection.platform
        || previous.domain != connection.domain
        || previous.adapter_config != connection.adapter_config;
    if adapter_changed {
        super::core::shutdown(id);
        super::adapter::replace_connection(&previous, connection.clone());
    }
    Ok(connection)
}

pub fn delete(id: &str) -> Result<(), ConnectionError> {
    let connection = get(id)?;
    if !connects::delete(id).map_err(storage)? {
        return Err(ConnectionError::NotFound);
    }
    super::adapter::stop_connection(&connection);
    super::core::shutdown(id);
    Ok(())
}

pub async fn verify(id: &str) -> Result<(), ConnectionError> {
    let connection = get(id)?;
    verify_credentials(
        &connection.platform,
        &connection.domain,
        &connection.adapter_config,
    )
    .await?;
    super::adapter::apply_connection(connection);
    Ok(())
}

pub async fn verify_credentials(
    platform: &str,
    domain: &str,
    adapter_config: &Value,
) -> Result<(), ConnectionError> {
    super::adapter::verify_config(platform, domain, adapter_config)
        .await
        .map_err(ConnectionError::Adapter)
}
