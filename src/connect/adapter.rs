use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::commands::CardSpec;
use super::platform::PlatformDefinition;
use super::registration::RegistrationView;
use crate::storage::connects::Connect;
pub type AdapterRef = Arc<dyn ConnectAdapter>;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionStatus {
    pub state: String,
    pub detail: Option<String>,
}

/// Platform-specific setup and connection lifecycle. Core only selects an
/// implementation by platform id and treats adapter_config as opaque JSON.
pub trait Platform: Send + Sync {
    fn validate_config(&self, domain: &str, config: &Value, existing: bool) -> Result<(), String>;
    fn merge_config(
        &self,
        domain: &str,
        current: Option<&Value>,
        incoming: &Value,
    ) -> Result<Value, String>;
    fn public_config(&self, domain: &str, config: &Value) -> Value;
    fn start(&self, connection: Connect);
    fn stop(&self, id: &str);
    fn statuses(&self) -> HashMap<String, ConnectionStatus>;
    fn begin_registration<'a>(
        &'a self,
        platform: &'a str,
        domain: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<RegistrationView, String>>;
    fn verify_config<'a>(
        &'a self,
        domain: &'a str,
        config: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<(), String>>;
}

struct FeishuPlatform;

static FEISHU_PLATFORM: FeishuPlatform = FeishuPlatform;

pub fn platform(id: &str) -> Option<&'static dyn Platform> {
    match id {
        "feishu" | "lark" => Some(&FEISHU_PLATFORM),
        _ => None,
    }
}

pub fn definitions() -> Vec<PlatformDefinition> {
    let mut definitions = super::platform::list();
    let claimed = crate::plugins::connect_provider::declared_ids();
    definitions.retain(|definition| definition.available || !claimed.contains(&definition.id));
    definitions.extend(crate::plugins::connect_provider::definitions());
    definitions
}

pub async fn begin_registration(
    platform_id: &str,
    domain: &str,
) -> Result<RegistrationView, String> {
    if let Some(adapter) = platform(platform_id) {
        return adapter.begin_registration(platform_id, domain).await;
    }
    if let Some(provider) = crate::plugins::connect_provider::find(platform_id) {
        if !provider
            .declaration
            .setup_modes
            .iter()
            .any(|mode| mode == "oauth" || mode == "qr")
        {
            return Err("This connect provider supports manual setup only".into());
        }
        return crate::plugins::connect_provider::begin_registration(&provider, domain)
            .await
            .map_err(|error| error.to_string());
    }
    Err(format!("Unsupported platform: {platform_id}"))
}

pub async fn registration_status(platform_flow_id: &str) -> Option<RegistrationView> {
    if let Some(view) = super::registration::get(platform_flow_id) {
        return Some(view);
    }
    crate::plugins::connect_provider::registration_status(platform_flow_id).await
}

pub fn claim_registration(id: &str) -> Option<(String, Value, String, String)> {
    super::registration::claim_credentials(id)
        .or_else(|| crate::plugins::connect_provider::claim_registration(id))
}

pub fn release_registration(id: &str) {
    super::registration::release_credentials(id);
    crate::plugins::connect_provider::release_registration(id);
}

pub fn finish_registration(id: &str) {
    super::registration::finish(id);
    crate::plugins::connect_provider::finish_registration(id);
}

pub fn start_connections() {
    match crate::storage::connects::list_enabled() {
        Ok(connections) => connections.into_iter().for_each(apply_connection),
        Err(error) => eprintln!("[connect] failed to load connections: {error}"),
    }
}

pub fn apply_connection(connection: Connect) {
    if let Some(adapter) = platform(&connection.platform) {
        adapter.start(connection);
    } else if crate::plugins::connect_provider::find(&connection.platform).is_some() {
        crate::plugins::connect_provider::start_connection(connection);
    } else {
        eprintln!("[connect] unsupported adapter: {}", connection.platform);
    }
}

pub fn stop_connection(connection: &Connect) {
    if let Some(adapter) = platform(&connection.platform) {
        adapter.stop(&connection.id);
    } else if crate::plugins::connect_provider::find(&connection.platform).is_some() {
        crate::plugins::connect_provider::stop_connection(connection);
    }
}

pub fn replace_connection(previous: &Connect, connection: Connect) {
    if previous.platform == connection.platform
        && crate::plugins::connect_provider::find(&connection.platform).is_some()
    {
        crate::plugins::connect_provider::replace_connection(connection);
    } else {
        stop_connection(previous);
        apply_connection(connection);
    }
}

pub fn connection_statuses() -> HashMap<String, ConnectionStatus> {
    let platform_ids = crate::storage::connects::list()
        .map(|connections| {
            connections
                .into_iter()
                .map(|connection| connection.platform)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let mut statuses = HashMap::new();
    for platform_id in platform_ids {
        if let Some(adapter) = platform(&platform_id) {
            statuses.extend(adapter.statuses());
        } else if crate::plugins::connect_provider::find(&platform_id).is_some() {
            statuses.extend(crate::plugins::connect_provider::statuses_for(&platform_id));
        }
    }
    statuses
}

pub async fn verify_config(platform_id: &str, domain: &str, config: &Value) -> Result<(), String> {
    if let Some(adapter) = platform(platform_id) {
        return adapter.verify_config(domain, config).await;
    }
    let provider = crate::plugins::connect_provider::find(platform_id)
        .ok_or_else(|| format!("Unsupported platform: {platform_id}"))?;
    crate::plugins::connect_provider::verify_config(&provider, domain, config)
        .await
        .map_err(|error| error.to_string())
}

pub fn validate_config(
    platform_id: &str,
    domain: &str,
    config: &Value,
    existing: bool,
) -> Result<(), String> {
    if let Some(adapter) = platform(platform_id) {
        return adapter.validate_config(domain, config, existing);
    }
    let provider = crate::plugins::connect_provider::find(platform_id)
        .ok_or_else(|| format!("Unsupported platform: {platform_id}"))?;
    crate::plugins::connect_provider::validate_config(&provider, config, existing)
        .map_err(|error| error.to_string())
}

pub fn merge_config(
    platform_id: &str,
    domain: &str,
    current: Option<&Value>,
    incoming: &Value,
) -> Result<Value, String> {
    if let Some(adapter) = platform(platform_id) {
        return adapter.merge_config(domain, current, incoming);
    }
    let provider = crate::plugins::connect_provider::find(platform_id)
        .ok_or_else(|| format!("Unsupported platform: {platform_id}"))?;
    crate::plugins::connect_provider::merge_config(&provider, current, incoming)
        .map_err(|error| error.to_string())
}

pub fn public_config(platform_id: &str, domain: &str, config: &Value) -> Value {
    if let Some(adapter) = platform(platform_id) {
        return adapter.public_config(domain, config);
    }
    crate::plugins::connect_provider::find(platform_id)
        .map(|provider| crate::plugins::connect_provider::public_config(&provider, config))
        .unwrap_or_else(|| Value::Object(Default::default()))
}

impl Platform for FeishuPlatform {
    fn validate_config(&self, domain: &str, config: &Value, existing: bool) -> Result<(), String> {
        super::feishu::validate_config(domain, config, existing)
    }

    fn merge_config(
        &self,
        _domain: &str,
        current: Option<&Value>,
        incoming: &Value,
    ) -> Result<Value, String> {
        let mut merged = current
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let target = merged
            .as_object_mut()
            .ok_or_else(|| "adapter_config must be a JSON object".to_owned())?;
        let source = incoming
            .as_object()
            .ok_or_else(|| "adapter_config must be a JSON object".to_owned())?;
        for (key, value) in source {
            if key != "app_secret" || value.as_str().is_none_or(|value| !value.is_empty()) {
                target.insert(key.clone(), value.clone());
            }
        }
        Ok(merged)
    }

    fn public_config(&self, domain: &str, config: &Value) -> Value {
        super::feishu::public_config(domain, config)
    }

    fn start(&self, connection: Connect) {
        super::feishu::start(connection);
    }

    fn stop(&self, id: &str) {
        super::feishu::stop(id);
    }

    fn statuses(&self) -> HashMap<String, ConnectionStatus> {
        super::feishu::statuses()
    }

    fn begin_registration<'a>(
        &'a self,
        platform: &'a str,
        domain: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<RegistrationView, String>> {
        Box::pin(async move { super::registration::begin(platform, domain).await })
    }

    fn verify_config<'a>(
        &'a self,
        domain: &'a str,
        config: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { super::feishu::verify_config(domain, config).await })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundAttachmentKind {
    Image,
    Audio,
    File,
}

/// Platform-neutral attachment delivered into the Connect core.
///
/// Adapters download and validate platform resources before crossing this
/// boundary. Core and Grove therefore do not need to know about Feishu keys or
/// resource endpoints.
#[derive(Debug, Clone)]
pub struct InboundAttachment {
    pub kind: InboundAttachmentKind,
    pub name: String,
    pub mime_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// Platform-neutral message delivered into the Connect core.
#[derive(Debug, Clone)]
pub struct InboundMessage {
    pub external_message_id: String,
    pub conversation_id: String,
    pub sender_id: String,
    pub text: String,
    pub attachments: Vec<InboundAttachment>,
}

/// Platform-neutral interactive action delivered into the Connect core.
/// Platform callback payloads are decoded by the adapter before crossing this
/// boundary.
#[derive(Debug, Clone)]
pub struct InboundAction {
    pub conversation_id: String,
    pub sender_id: String,
    /// Opaque external id of the interactive card that was clicked. Core
    /// uses it as the reply parent when an action creates a follow-up prompt.
    pub source_message_id: Option<String>,
    pub name: Option<String>,
    pub fields: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy)]
pub enum NoticeLevel {
    Info,
    Success,
    Warning,
    Error,
}

/// Core result for an interactive action. Adapters decide how a notice and a
/// replacement card are represented by their platform callback protocol.
pub struct ActionResult {
    pub card: Option<CardSpec>,
    pub notice: Option<(NoticeLevel, String)>,
}

impl ActionResult {
    pub fn ignored() -> Self {
        Self {
            card: None,
            notice: None,
        }
    }

    pub fn card(card: CardSpec) -> Self {
        Self {
            card: Some(card),
            notice: None,
        }
    }

    pub fn notice(text: impl Into<String>, level: NoticeLevel) -> Self {
        let text = text.into();
        Self {
            card: Some(CardSpec::Notice(text.clone())),
            notice: Some((level, text)),
        }
    }

    pub fn warning_card(text: impl Into<String>, card: CardSpec) -> Self {
        Self {
            card: Some(card),
            notice: Some((NoticeLevel::Warning, text.into())),
        }
    }
}

/// Capability surface every IM adapter exposes to the Connect core.
/// Platform-native cards and reactions stay behind this boundary.
#[async_trait]
pub trait ConnectAdapter: Send + Sync + 'static {
    async fn mark_waiting(&self, message_id: &str) -> Option<String>;
    async fn mark_working(&self, message_id: &str, waiting: &Option<String>) -> Option<String>;
    async fn clear_status(&self, message_id: &str, receipt: &Option<String>);
    async fn reply_text(&self, message_id: &str, text: &str) -> Result<(), String>;
    async fn reply_card(&self, message_id: &str, spec: &CardSpec) -> Result<(), String>;
}
