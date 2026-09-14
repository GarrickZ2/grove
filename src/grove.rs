//! Grove's stable anti-corruption boundary for external integrations.
//!
//! Connect and other external surfaces depend on this module instead of ACP
//! handles, commands, or snapshots. ACP remains an implementation detail of
//! Grove and is converted here into the small operations those surfaces need.

use std::collections::HashMap;
use std::sync::Arc;

use crate::acp;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueueMode {
    #[default]
    Separate,
    Compact,
}

#[derive(Debug, Clone)]
pub(crate) struct ConfigSelector {
    pub config_id: String,
    pub label: String,
    pub current: Option<String>,
    pub options: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub(crate) struct UsageSnapshot {
    pub used: u64,
    pub size: u64,
    pub cost: Option<UsageCost>,
}

#[derive(Debug, Clone)]
pub(crate) struct UsageCost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConfigSnapshot {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub thought_level: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionSnapshot {
    pub busy: bool,
    pub queued: usize,
    pub queue_mode: QueueMode,
    pub config: ConfigSnapshot,
    pub usage: Option<UsageSnapshot>,
}

/// Opaque handle to a Grove session. The ACP handle is intentionally private
/// to this module.
#[derive(Clone)]
pub(crate) struct Session {
    handle: Arc<acp::AcpSessionHandle>,
}

pub(crate) struct PreparedPrompt {
    handle: Session,
    prompt: acp::PreparedTextPrompt,
}

pub(crate) fn session(project_id: &str, task_id: &str, session_id: &str) -> Option<Session> {
    if project_id.is_empty() || task_id.is_empty() || session_id.is_empty() {
        return None;
    }
    let key = format!("{project_id}:{task_id}:{session_id}");
    acp::get_session_handle(&key).map(|handle| Session { handle })
}

pub(crate) async fn ensure_session(
    project_id: &str,
    task_id: &str,
    session_id: &str,
) -> Result<Session, String> {
    crate::agent_graph::tools::ensure_target_handle(project_id, task_id, session_id)
        .await
        .map(|handle| Session { handle })
        .map_err(|error| error.to_string())
}

pub(crate) fn snapshot(
    project_id: &str,
    task_id: &str,
    session_id: &str,
) -> Option<SessionSnapshot> {
    let session = session(project_id, task_id, session_id)?;
    Some(session.snapshot())
}

impl Session {
    pub(crate) fn prepare_text_prompt(
        &self,
        text: String,
        sender: Option<String>,
    ) -> PreparedPrompt {
        PreparedPrompt {
            handle: self.clone(),
            prompt: self.handle.prepare_text_prompt(text, sender),
        }
    }

    pub(crate) fn pending_permission_accepts(&self, request_id: &str, option_id: &str) -> bool {
        self.handle
            .pending_permission_accepts(request_id, option_id)
    }

    pub(crate) fn respond_permission(&self, option_id: String) -> bool {
        self.handle.respond_permission(option_id)
    }

    pub(crate) fn pending_turn_form(&self, request_id: &str) -> Option<crate::radio::TurnForm> {
        self.handle.pending_turn_form(request_id)
    }

    pub(crate) fn respond_turn_form(
        &self,
        request_id: &str,
        accept: bool,
        fields: &HashMap<String, String>,
    ) -> Result<(), String> {
        self.handle.respond_turn_form(request_id, accept, fields)
    }

    pub(crate) fn config_selectors(&self) -> Vec<ConfigSelector> {
        self.handle
            .config_selectors()
            .into_iter()
            .map(|selector| ConfigSelector {
                config_id: selector.config_id,
                label: selector.label,
                current: selector.current,
                options: selector.options,
            })
            .collect()
    }

    pub(crate) async fn set_config_option(
        &self,
        config_id: String,
        value: String,
    ) -> Result<(), String> {
        self.handle
            .set_config_option(config_id, acp::ConfigOptionValue::Select(value))
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn cancel(&self) -> Result<(), String> {
        self.handle
            .cancel()
            .await
            .map_err(|error| error.to_string())
    }

    fn snapshot(&self) -> SessionSnapshot {
        let config = self.handle.snapshot_config();
        let usage = self.handle.current_usage.lock().ok().and_then(|value| {
            value.as_ref().map(|usage| UsageSnapshot {
                used: usage.used,
                size: usage.size,
                cost: usage.cost.as_ref().map(|cost| UsageCost {
                    amount: cost.amount,
                    currency: cost.currency.clone(),
                }),
            })
        });
        SessionSnapshot {
            busy: self
                .handle
                .is_busy
                .load(std::sync::atomic::Ordering::Acquire),
            queued: self.handle.get_queue().len(),
            queue_mode: match self.handle.queue_mode_snapshot() {
                acp::QueueMode::Separate => QueueMode::Separate,
                acp::QueueMode::Compact => QueueMode::Compact,
            },
            config: ConfigSnapshot {
                model: config.model,
                mode: config.mode,
                thought_level: config.thought_level,
            },
            usage,
        }
    }
}

impl PreparedPrompt {
    pub(crate) fn id(&self) -> &str {
        self.prompt.id()
    }

    pub(crate) async fn start(self) -> Result<String, String> {
        self.handle
            .handle
            .submit_prepared_text_prompt(self.prompt)
            .await
            .map_err(|error| error.to_string())
    }
}
