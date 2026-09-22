//! Thin IM Connect contribution layer for Grove plugins.
//!
//! A Connect Provider uses the plugin's existing `contributes.backend` process.
//! Grove owns registration records, routing and Session delivery; the plugin
//! owns every external transport detail (webhooks, sockets, polling, auth).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use once_cell::sync::Lazy;
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connect::adapter::{
    ActionResult, AdapterRef, ConnectAdapter, ConnectionStatus, InboundAction, InboundAttachment,
    InboundAttachmentKind, InboundMessage, NoticeLevel,
};
use crate::connect::commands::CardSpec;
use crate::connect::platform::{ConfigField, PlatformCapabilities, PlatformDefinition};
use crate::error::{GroveError, Result};
use crate::storage::connects::{Connect, ConnectInput};

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderDeclaration {
    pub id: String,
    #[serde(alias = "title")]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub setup_modes: Vec<String>,
    #[serde(default)]
    pub config_fields: Vec<ConfigField>,
    #[serde(default)]
    pub capabilities: PlatformCapabilities,
}

#[derive(Clone, Debug)]
pub struct InstalledProvider {
    pub key: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub declaration: ProviderDeclaration,
}

fn manifest_value(plugin: &crate::storage::plugins::Plugin) -> Option<Value> {
    std::fs::read_to_string(std::path::Path::new(&plugin.local_path).join("plugin.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn provider_key(plugin_id: &str, provider_id: &str) -> String {
    format!("plugin:{plugin_id}/{provider_id}")
}

fn providers_from_plugin(plugin: &crate::storage::plugins::Plugin) -> Vec<InstalledProvider> {
    let Some(manifest) = manifest_value(plugin) else {
        return Vec::new();
    };
    let permissions = manifest
        .get("permissions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    if !permissions.contains("connect:provider")
        || manifest
            .get("contributes")
            .and_then(|value| value.get("backend"))
            .is_none()
    {
        return Vec::new();
    }
    manifest
        .get("contributes")
        .and_then(|value| value.get("connectProviders"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<ProviderDeclaration>(value.clone()).ok())
        .filter(|declaration| {
            !declaration.id.trim().is_empty() && !declaration.name.trim().is_empty()
        })
        .map(|declaration| InstalledProvider {
            key: provider_key(&plugin.id, &declaration.id),
            plugin_id: plugin.id.clone(),
            plugin_name: plugin.name.clone(),
            declaration,
        })
        .collect()
}

pub fn installed() -> Vec<InstalledProvider> {
    crate::storage::plugins::list()
        .unwrap_or_default()
        .iter()
        .flat_map(providers_from_plugin)
        .collect()
}

pub fn find(key: &str) -> Option<InstalledProvider> {
    installed().into_iter().find(|provider| provider.key == key)
}

pub fn definitions() -> Vec<PlatformDefinition> {
    installed()
        .into_iter()
        .map(|provider| {
            let mut setup_modes = provider
                .declaration
                .setup_modes
                .iter()
                .filter_map(|mode| match mode.as_str() {
                    "form" => Some("manual".to_owned()),
                    "manual" | "oauth" | "qr" => Some(mode.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            setup_modes.sort();
            setup_modes.dedup();
            if setup_modes.is_empty() {
                setup_modes.push("manual".into());
            }
            PlatformDefinition {
                id: provider.key,
                name: provider.declaration.name,
                description: if provider.declaration.description.is_empty() {
                    format!("Provided by {}", provider.plugin_name)
                } else {
                    provider.declaration.description
                },
                available: true,
                setup_modes,
                config_fields: provider.declaration.config_fields,
                capabilities: provider.declaration.capabilities,
            }
        })
        .collect()
}

pub fn declared_ids() -> HashSet<String> {
    installed()
        .into_iter()
        .map(|provider| provider.declaration.id)
        .collect()
}

pub fn validate_config(provider: &InstalledProvider, config: &Value, existing: bool) -> Result<()> {
    let object = config
        .as_object()
        .ok_or_else(|| GroveError::config("adapter_config must be a JSON object"))?;
    // Required fields describe the initial form, not the shape of an OAuth/QR
    // result or an existing provider-owned record.
    if existing {
        return Ok(());
    }
    for field in &provider.declaration.config_fields {
        if !field.required {
            continue;
        }
        let present = object.get(&field.key).is_some_and(|value| match value {
            Value::String(value) => !value.trim().is_empty(),
            Value::Null => false,
            _ => true,
        });
        if !present {
            return Err(GroveError::config(format!(
                "adapter_config.{} is required",
                field.key
            )));
        }
    }
    Ok(())
}

pub fn merge_config(
    provider: &InstalledProvider,
    current: Option<&Value>,
    incoming: &Value,
) -> Result<Value> {
    let mut merged = current
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let target = merged
        .as_object_mut()
        .ok_or_else(|| GroveError::config("adapter_config must be a JSON object"))?;
    let source = incoming
        .as_object()
        .ok_or_else(|| GroveError::config("adapter_config must be a JSON object"))?;
    let masked = provider
        .declaration
        .config_fields
        .iter()
        .filter(|field| field.secret)
        .map(|field| field.key.as_str())
        .collect::<HashSet<_>>();
    for (key, value) in source {
        if masked.contains(key.as_str()) && value.as_str().is_some_and(str::is_empty) {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
    Ok(merged)
}

pub fn public_config(provider: &InstalledProvider, config: &Value) -> Value {
    let source = config.as_object();
    let mut public = serde_json::Map::new();
    for field in &provider.declaration.config_fields {
        if field.secret {
            let present = source
                .and_then(|values| values.get(&field.key))
                .is_some_and(|value| {
                    !value.is_null() && value.as_str().is_none_or(|s| !s.is_empty())
                });
            public.insert(format!("has_{}", field.key), Value::Bool(present));
        } else if let Some(value) = source.and_then(|values| values.get(&field.key)) {
            public.insert(field.key.clone(), value.clone());
        }
    }
    Value::Object(public)
}

fn record_value(connection: &Connect) -> Value {
    json!({
        "id": connection.id,
        "name": connection.name,
        "provider": connection.platform,
        "domain": connection.domain,
        "enabled": connection.enabled,
        "config": connection.adapter_config,
        "projectId": connection.project_id,
        "taskId": connection.task_id,
        "sessionId": connection.session_id,
        "boundConversationId": connection.bound_chat_id,
        "boundUserId": connection.bound_user_id,
    })
}

fn emit_record(connection: Connect, kind: &'static str) {
    let Some(provider) = find(&connection.platform) else {
        return;
    };
    tokio::spawn(async move {
        let _ = crate::plugins::backend::send_event(
            &provider.plugin_id,
            "grove:connect",
            json!({ "type": kind, "record": record_value(&connection) }),
        )
        .await;
    });
}

static STATUSES: Lazy<std::sync::Mutex<HashMap<String, ConnectionStatus>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

pub fn statuses_for(provider_key: &str) -> HashMap<String, ConnectionStatus> {
    let connection_ids = crate::storage::connects::list()
        .unwrap_or_default()
        .into_iter()
        .filter(|connection| connection.platform == provider_key)
        .map(|connection| connection.id)
        .collect::<HashSet<_>>();
    STATUSES
        .lock()
        .unwrap()
        .iter()
        .filter(|(id, _)| connection_ids.contains(*id))
        .map(|(id, status)| (id.clone(), status.clone()))
        .collect()
}

pub fn start_connection(connection: Connect) {
    emit_record(connection, "record_changed");
}

pub fn stop_connection(connection: &Connect) {
    STATUSES.lock().unwrap().remove(&connection.id);
    emit_record(connection.clone(), "record_removed");
}

pub fn replace_connection(connection: Connect) {
    if !connection.enabled {
        STATUSES.lock().unwrap().remove(&connection.id);
    }
    emit_record(connection, "record_changed");
}

/// Uninstall removes Grove-owned Connect records for this plugin. The backend
/// has already stopped, so do not emit record events that would restart it.
pub fn remove_plugin_records(plugin_id: &str) -> Result<()> {
    let prefix = format!("plugin:{plugin_id}/");
    for connection in crate::storage::connects::list()?
        .into_iter()
        .filter(|connection| connection.platform.starts_with(&prefix))
    {
        crate::storage::connects::delete(&connection.id)?;
        STATUSES.lock().unwrap().remove(&connection.id);
        crate::connect::core::shutdown(&connection.id);
    }
    Ok(())
}

async fn invoke(provider: &InstalledProvider, method: &str, params: Value) -> Result<Value> {
    crate::plugins::backend::invoke(&provider.plugin_id, None, method, params, None).await
}

fn method_is_missing(error: &GroveError, method: &str) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    (message.contains("unknown method") || message.contains("method not found"))
        && message.contains(&method.to_ascii_lowercase())
}

pub async fn verify_config(
    provider: &InstalledProvider,
    domain: &str,
    config: &Value,
) -> Result<()> {
    if !config.is_object() {
        return Err(GroveError::config("adapter_config must be a JSON object"));
    }
    for method in ["connect.validate", "connect.verify"] {
        match invoke(
            provider,
            method,
            json!({ "providerId": provider.declaration.id, "domain": domain, "config": config }),
        )
        .await
        {
            Ok(_) => {}
            Err(error) if method_is_missing(&error, method) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn public_base_url() -> String {
    if let Ok(value) = std::env::var("GROVE_PUBLIC_BASE_URL") {
        let value = value.trim_end_matches('/');
        if !value.is_empty() {
            return value.to_owned();
        }
    }
    let protocol = std::env::var("GROVE_PROTOCOL").unwrap_or_else(|_| "http".into());
    let port = std::env::var("GROVE_PORT").unwrap_or_else(|_| "3001".into());
    format!("{protocol}://127.0.0.1:{port}")
}

#[derive(Clone)]
struct RegistrationFlow {
    provider_key: String,
    view: crate::connect::registration::RegistrationView,
    config: Option<Value>,
    user_id: Option<String>,
    finishing: bool,
}

static REGISTRATIONS: Lazy<std::sync::Mutex<HashMap<String, RegistrationFlow>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

fn registration_qr(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    QrCode::new(url.as_bytes())
        .map(|code| code.render::<svg::Color>().min_dimensions(220, 220).build())
        .unwrap_or_default()
}

fn update_registration(id: &str, result: &Value) {
    let mut flows = REGISTRATIONS.lock().unwrap();
    let Some(flow) = flows.get_mut(id) else {
        return;
    };
    if let Some(state) = result.get("state").and_then(Value::as_str) {
        if matches!(state, "waiting_for_scan" | "authorized" | "error") {
            flow.view.state = state.to_owned();
        }
    }
    if let Some(config) = result.get("config") {
        flow.config = Some(config.clone());
    }
    if let Some(user_id) = result.get("userId").and_then(Value::as_str) {
        flow.user_id = Some(user_id.to_owned());
    }
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        flow.view.error = Some(error.to_owned());
        flow.view.state = "error".into();
    }
}

pub async fn begin_registration(
    provider: &InstalledProvider,
    domain: &str,
) -> Result<crate::connect::registration::RegistrationView> {
    REGISTRATIONS
        .lock()
        .unwrap()
        .retain(|_, flow| flow.view.expires_at + 600 > chrono::Utc::now().timestamp());
    let id = uuid::Uuid::new_v4().to_string();
    let callback_url = format!(
        "{}/api/v1/connect-provider-callbacks/{}/{}/{id}",
        public_base_url(),
        provider.plugin_id,
        provider.declaration.id,
    );
    let result = invoke(
        provider,
        "connect.registration.begin",
        json!({ "providerId": provider.declaration.id, "id": id, "domain": domain, "callbackUrl": callback_url }),
    )
    .await?;
    let verification_url = result
        .get("verificationUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let now = chrono::Utc::now().timestamp();
    let expires_at = result
        .get("expiresAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| {
            now + result
                .get("expiresIn")
                .and_then(Value::as_i64)
                .unwrap_or(600)
                .max(60)
        });
    let view = crate::connect::registration::RegistrationView {
        id: id.clone(),
        platform: provider.key.clone(),
        state: result
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("waiting_for_scan")
            .to_owned(),
        verification_url: verification_url.clone(),
        qr_svg: result
            .get("qrSvg")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| registration_qr(&verification_url)),
        expires_at,
        domain: domain.to_owned(),
        error: result
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    REGISTRATIONS.lock().unwrap().insert(
        id,
        RegistrationFlow {
            provider_key: provider.key.clone(),
            view: view.clone(),
            config: result.get("config").cloned(),
            user_id: result
                .get("userId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            finishing: false,
        },
    );
    Ok(view)
}

pub async fn registration_status(
    id: &str,
) -> Option<crate::connect::registration::RegistrationView> {
    let provider = REGISTRATIONS
        .lock()
        .unwrap()
        .get(id)
        .and_then(|flow| find(&flow.provider_key))?;
    match invoke(
        &provider,
        "connect.registration.status",
        json!({ "providerId": provider.declaration.id, "id": id }),
    )
    .await
    {
        Ok(result) => update_registration(id, &result),
        Err(error) if method_is_missing(&error, "connect.registration.status") => {}
        Err(error) => {
            if let Some(flow) = REGISTRATIONS.lock().unwrap().get_mut(id) {
                flow.view.error = Some(error.to_string());
            }
        }
    }
    REGISTRATIONS
        .lock()
        .unwrap()
        .get(id)
        .map(|flow| flow.view.clone())
}

pub fn claim_registration(id: &str) -> Option<(String, Value, String, String)> {
    let mut flows = REGISTRATIONS.lock().unwrap();
    let flow = flows.get_mut(id)?;
    if flow.finishing || flow.view.state != "authorized" {
        return None;
    }
    let config = flow.config.clone()?;
    flow.finishing = true;
    Some((
        flow.view.platform.clone(),
        config,
        flow.view.domain.clone(),
        flow.user_id.clone().unwrap_or_default(),
    ))
}

pub fn release_registration(id: &str) {
    if let Some(flow) = REGISTRATIONS.lock().unwrap().get_mut(id) {
        flow.finishing = false;
    }
}

pub fn finish_registration(id: &str) {
    REGISTRATIONS.lock().unwrap().remove(id);
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderHttpRequest {
    pub method: String,
    pub query: String,
    pub headers: HashMap<String, String>,
    #[serde(rename = "bodyBase64")]
    pub body_base64: String,
}

pub struct ProviderHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

fn http_response(value: &Value) -> Result<ProviderHttpResponse> {
    let status = value.get("status").and_then(Value::as_u64).unwrap_or(200);
    let status = u16::try_from(status)
        .ok()
        .filter(|status| (100..=599).contains(status))
        .ok_or_else(|| GroveError::config("provider returned an invalid HTTP status"))?;
    let headers = value
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.into())))
                .collect()
        })
        .unwrap_or_default();
    let body = match value.get("bodyBase64").and_then(Value::as_str) {
        Some(body) => base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|error| GroveError::config(error.to_string()))?,
        None => value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .as_bytes()
            .to_vec(),
    };
    Ok(ProviderHttpResponse {
        status,
        headers,
        body,
    })
}

pub async fn registration_callback(
    plugin_id: &str,
    provider_id: &str,
    flow_id: &str,
    request: ProviderHttpRequest,
) -> Result<ProviderHttpResponse> {
    let expected_key = provider_key(plugin_id, provider_id);
    let flow_key = REGISTRATIONS
        .lock()
        .unwrap()
        .get(flow_id)
        .map(|flow| flow.provider_key.clone())
        .ok_or_else(|| GroveError::not_found("connect provider registration not found"))?;
    if flow_key != expected_key {
        return Err(GroveError::not_found(
            "connect provider registration not found",
        ));
    }
    let provider =
        find(&flow_key).ok_or_else(|| GroveError::not_found("connect provider not found"))?;
    let result = invoke(
        &provider,
        "connect.registration.callback",
        json!({ "providerId": provider.declaration.id, "id": flow_id, "request": request }),
    )
    .await?;
    update_registration(flow_id, &result);
    http_response(result.get("response").unwrap_or(&result))
}

#[derive(Deserialize)]
struct WireInboundMessage {
    #[serde(rename = "externalMessageId")]
    external_message_id: String,
    #[serde(rename = "conversationId")]
    conversation_id: String,
    #[serde(rename = "senderId")]
    sender_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    attachments: Vec<WireAttachment>,
}

#[derive(Deserialize)]
struct WireAttachment {
    kind: String,
    name: String,
    #[serde(default, rename = "mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "dataBase64")]
    data_base64: String,
}

impl WireInboundMessage {
    fn into_core(self) -> std::result::Result<InboundMessage, String> {
        let attachments = self
            .attachments
            .into_iter()
            .map(|attachment| {
                let kind = match attachment.kind.as_str() {
                    "image" => InboundAttachmentKind::Image,
                    "audio" => InboundAttachmentKind::Audio,
                    "file" => InboundAttachmentKind::File,
                    other => return Err(format!("unsupported attachment kind: {other}")),
                };
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(attachment.data_base64)
                    .map_err(|error| format!("invalid attachment data: {error}"))?;
                Ok(InboundAttachment {
                    kind,
                    name: attachment.name,
                    mime_type: attachment.mime_type,
                    bytes,
                })
            })
            .collect::<std::result::Result<Vec<_>, String>>()?;
        Ok(InboundMessage {
            external_message_id: self.external_message_id,
            conversation_id: self.conversation_id,
            sender_id: self.sender_id,
            text: self.text,
            attachments,
        })
    }
}

#[derive(Deserialize)]
struct WireInboundAction {
    #[serde(rename = "conversationId")]
    conversation_id: String,
    #[serde(rename = "senderId")]
    sender_id: String,
    #[serde(default, rename = "sourceMessageId")]
    source_message_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    fields: HashMap<String, String>,
}

fn owned_connection(plugin_id: &str, id: &str) -> Result<Connect> {
    let connection = crate::storage::connects::get(id)?
        .ok_or_else(|| GroveError::not_found("connect record not found"))?;
    let provider = find(&connection.platform)
        .ok_or_else(|| GroveError::not_found("connect provider not found"))?;
    if provider.plugin_id != plugin_id {
        return Err(GroveError::not_found("connect record not found"));
    }
    Ok(connection)
}

fn action_result_value(result: ActionResult) -> Value {
    json!({
        "card": result.card,
        "notice": result.notice.map(|(level, text)| json!({
            "level": match level {
                NoticeLevel::Info => "info",
                NoticeLevel::Success => "success",
                NoticeLevel::Warning => "warning",
                NoticeLevel::Error => "error",
            },
            "text": text,
        })),
    })
}

struct PluginEventAdapter {
    plugin_id: String,
    connection_id: String,
}

impl PluginEventAdapter {
    async fn emit(&self, kind: &str, payload: Value) -> std::result::Result<(), String> {
        crate::plugins::backend::send_event(
            &self.plugin_id,
            "grove:connect",
            json!({
                "type": kind,
                "connectionId": self.connection_id,
                "payload": payload,
            }),
        )
        .await
        .map_err(|error| error.to_string())
    }
}

#[async_trait]
impl ConnectAdapter for PluginEventAdapter {
    async fn mark_waiting(&self, message_id: &str) -> Option<String> {
        let receipt = uuid::Uuid::new_v4().to_string();
        self.emit(
            "message_waiting",
            json!({ "messageId": message_id, "receipt": receipt }),
        )
        .await
        .ok()?;
        Some(receipt)
    }

    async fn mark_working(&self, message_id: &str, waiting: &Option<String>) -> Option<String> {
        let receipt = uuid::Uuid::new_v4().to_string();
        self.emit(
            "message_working",
            json!({ "messageId": message_id, "waitingReceipt": waiting, "receipt": receipt }),
        )
        .await
        .ok()?;
        Some(receipt)
    }

    async fn clear_status(&self, message_id: &str, receipt: &Option<String>) {
        let _ = self
            .emit(
                "message_status_cleared",
                json!({ "messageId": message_id, "receipt": receipt }),
            )
            .await;
    }

    async fn reply_text(&self, message_id: &str, text: &str) -> std::result::Result<(), String> {
        self.emit(
            "message_text",
            json!({ "messageId": message_id, "text": text }),
        )
        .await
    }

    async fn reply_card(
        &self,
        message_id: &str,
        spec: &CardSpec,
    ) -> std::result::Result<(), String> {
        self.emit(
            "message_card",
            json!({ "messageId": message_id, "card": spec }),
        )
        .await
    }
}

/// Handle backend → Grove calls made through the existing plugin backend pipe.
pub async fn handle_host_call(plugin_id: &str, method: &str, params: Value) -> Result<Value> {
    match method {
        "connect.records.list" => {
            let records = crate::storage::connects::list()?
                .into_iter()
                .filter(|connection| {
                    find(&connection.platform)
                        .is_some_and(|provider| provider.plugin_id == plugin_id)
                })
                .map(|connection| record_value(&connection))
                .collect::<Vec<_>>();
            Ok(Value::Array(records))
        }
        "connect.records.get" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| GroveError::config("connect record id is required"))?;
            Ok(record_value(&owned_connection(plugin_id, id)?))
        }
        "connect.records.update" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| GroveError::config("connect record id is required"))?;
            let config = params
                .get("config")
                .cloned()
                .ok_or_else(|| GroveError::config("connect config is required"))?;
            let current = owned_connection(plugin_id, id)?;
            let updated = crate::connect::update(
                id,
                ConnectInput {
                    name: current.name,
                    platform: current.platform,
                    domain: current.domain,
                    enabled: current.enabled,
                    adapter_config: config,
                    project_id: current.project_id,
                    task_id: current.task_id,
                    session_id: current.session_id,
                },
            )
            .map_err(|error| GroveError::config(error.to_string()))?;
            Ok(record_value(&updated))
        }
        "connect.status" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or_else(|| GroveError::config("connectionId is required"))?;
            let _ = owned_connection(plugin_id, id)?;
            let state = params
                .get("state")
                .and_then(Value::as_str)
                .ok_or_else(|| GroveError::config("state is required"))?;
            if !matches!(state, "offline" | "connecting" | "online" | "error") {
                return Err(GroveError::config("invalid connection state"));
            }
            let detail = params
                .get("detail")
                .and_then(Value::as_str)
                .map(str::to_owned);
            STATUSES.lock().unwrap().insert(
                id.to_owned(),
                ConnectionStatus {
                    state: state.to_owned(),
                    detail,
                },
            );
            Ok(json!({ "ok": true }))
        }
        "connect.deliverMessage" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or_else(|| GroveError::config("connectionId is required"))?;
            let connection = owned_connection(plugin_id, id)?;
            if !connection.enabled {
                return Err(GroveError::config("connect record is disabled"));
            }
            let message = serde_json::from_value::<WireInboundMessage>(
                params.get("message").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| GroveError::config(error.to_string()))?
            .into_core()
            .map_err(GroveError::config)?;
            let adapter: AdapterRef = Arc::new(PluginEventAdapter {
                plugin_id: plugin_id.to_owned(),
                connection_id: id.to_owned(),
            });
            crate::connect::core::handle_message(id, adapter, message).await;
            Ok(json!({ "ok": true }))
        }
        "connect.deliverAction" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or_else(|| GroveError::config("connectionId is required"))?;
            let connection = owned_connection(plugin_id, id)?;
            if !connection.enabled {
                return Err(GroveError::config("connect record is disabled"));
            }
            let action = serde_json::from_value::<WireInboundAction>(
                params.get("action").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| GroveError::config(error.to_string()))?;
            let adapter: AdapterRef = Arc::new(PluginEventAdapter {
                plugin_id: plugin_id.to_owned(),
                connection_id: id.to_owned(),
            });
            let result = crate::connect::core::handle_action(
                id,
                adapter,
                InboundAction {
                    conversation_id: action.conversation_id,
                    sender_id: action.sender_id,
                    source_message_id: action.source_message_id,
                    name: action.name,
                    fields: action.fields,
                },
            )
            .await
            .map_err(GroveError::session)?;
            Ok(action_result_value(result))
        }
        _ => Err(GroveError::not_found(format!(
            "unknown Grove host method: {method}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_required_fields_do_not_constrain_existing_provider_config() {
        let provider = InstalledProvider {
            key: "plugin:test/example".into(),
            plugin_id: "test".into(),
            plugin_name: "Test".into(),
            declaration: ProviderDeclaration {
                id: "example".into(),
                name: "Example".into(),
                description: String::new(),
                setup_modes: vec!["form".into(), "oauth".into()],
                config_fields: vec![ConfigField {
                    key: "manual_token".into(),
                    label: "Manual token".into(),
                    secret: false,
                    required: true,
                    placeholder: String::new(),
                }],
                capabilities: PlatformCapabilities::default(),
            },
        };
        let authorized = json!({ "oauth_access_token": "granted" });
        assert!(validate_config(&provider, &authorized, false).is_err());
        assert!(validate_config(&provider, &authorized, true).is_ok());
    }
}
