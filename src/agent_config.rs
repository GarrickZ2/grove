//! Agent runtime configuration selected from a persisted capability snapshot.
//!
//! This is shared by Automations, Memory organization, and Custom Agents. It
//! intentionally lives outside those product domains: each consumer owns when
//! the Agent runs, while this type only describes how the Agent is configured.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum AgentConfigSelection {
    Default {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
    },
    ConfigOptions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default)]
        values: BTreeMap<String, crate::acp::ConfigOptionValue>,
    },
    Modes {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        mode_id: String,
    },
}

impl Default for AgentConfigSelection {
    fn default() -> Self {
        Self::Default { agent_id: None }
    }
}

impl AgentConfigSelection {
    pub fn agent_id(&self) -> Option<&str> {
        match self {
            Self::Default { agent_id }
            | Self::ConfigOptions { agent_id, .. }
            | Self::Modes { agent_id, .. } => agent_id.as_deref(),
        }
    }

    pub fn queued_config(&self) -> Option<crate::acp::QueuedConfig> {
        match self {
            Self::Default { .. } => None,
            Self::ConfigOptions { values, .. } => Some(crate::acp::QueuedConfig {
                model: None,
                mode: None,
                thought_level: None,
                thought_level_config_id: None,
                config_options: values.clone(),
            }),
            Self::Modes { mode_id, .. } => Some(crate::acp::QueuedConfig {
                model: None,
                mode: Some(mode_id.clone()),
                thought_level: None,
                thought_level_config_id: None,
                config_options: BTreeMap::new(),
            }),
        }
    }

    /// Keep only explicit overrides that the current ACP Session still
    /// advertises and accepts. Agent capability snapshots are authoritative:
    /// removed options and values fall back to the Agent's current default.
    pub fn reconciled_with(
        &self,
        advertised: &[agent_client_protocol::v1::schema::SessionConfigOption],
    ) -> Self {
        let Self::ConfigOptions { agent_id, values } = self else {
            return self.clone();
        };
        Self::ConfigOptions {
            agent_id: agent_id.clone(),
            values: values
                .iter()
                .filter(|(id, value)| {
                    advertised.iter().any(|option| {
                        option.id.to_string() == id.as_str() && config_option_accepts(option, value)
                    })
                })
                .map(|(id, value)| (id.clone(), value.clone()))
                .collect(),
        }
    }

    /// Explicit config values in the order the installed Agent advertised its
    /// options, so a value that changes later options (a model resetting the
    /// available modes) is applied first. Values the snapshot does not list
    /// keep their stored order at the end.
    pub fn ordered_config_values(&self) -> Vec<(String, crate::acp::ConfigOptionValue)> {
        let Self::ConfigOptions { agent_id, values } = self else {
            return Vec::new();
        };
        let advertised: Vec<String> = agent_id
            .as_deref()
            .map(crate::storage::installed_agents::canonicalize_agent_id)
            .and_then(|id| {
                crate::storage::installed_agents::get_capability_snapshot(&id)
                    .ok()
                    .flatten()
            })
            .and_then(|snapshot| snapshot.get("config_options").cloned())
            .and_then(|raw| {
                serde_json::from_value::<
                    Vec<agent_client_protocol::v1::schema::SessionConfigOption>,
                >(raw)
                .ok()
            })
            .map(|options| options.iter().map(|option| option.id.to_string()).collect())
            .unwrap_or_default();
        let mut ordered: Vec<_> = values
            .iter()
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect();
        ordered.sort_by_key(|(id, _)| {
            advertised
                .iter()
                .position(|candidate| candidate == id)
                .unwrap_or(usize::MAX)
        });
        ordered
    }

    /// Reconcile persisted overrides against the latest installed-Agent
    /// capability snapshot. A snapshot that explicitly uses configOptions is
    /// a full replacement; absent snapshots remain non-authoritative.
    pub fn reconciled_with_installed_snapshot(&self) -> crate::error::Result<Self> {
        let Some(agent_id) = self.agent_id() else {
            return Ok(self.clone());
        };
        let canonical_agent_id = crate::storage::installed_agents::canonicalize_agent_id(agent_id);
        let Some(snapshot) =
            crate::storage::installed_agents::get_capability_snapshot(&canonical_agent_id)?
        else {
            return Ok(self.clone());
        };
        let Some(uses_config_options) = snapshot
            .get("uses_config_options")
            .and_then(serde_json::Value::as_bool)
        else {
            return Ok(self.clone());
        };
        if !matches!(self, Self::ConfigOptions { .. }) {
            return Ok(self.clone());
        }
        if !uses_config_options {
            return Ok(Self::ConfigOptions {
                agent_id: Some(agent_id.to_string()),
                values: BTreeMap::new(),
            });
        }
        let Some(raw_options) = snapshot.get("config_options").cloned() else {
            return Ok(self.clone());
        };
        let Ok(advertised) = serde_json::from_value::<
            Vec<agent_client_protocol::v1::schema::SessionConfigOption>,
        >(raw_options) else {
            // A stale or future snapshot shape must not make configuration
            // pages unsavable. The live runtime remains authoritative.
            return Ok(self.clone());
        };
        Ok(self.reconciled_with(&advertised))
    }
}

pub fn config_option_accepts(
    option: &agent_client_protocol::v1::schema::SessionConfigOption,
    value: &crate::acp::ConfigOptionValue,
) -> bool {
    use agent_client_protocol::v1::schema::{SessionConfigKind, SessionConfigSelectOptions};

    match (&option.kind, value) {
        (SessionConfigKind::Boolean(_), crate::acp::ConfigOptionValue::Boolean(_)) => true,
        (SessionConfigKind::Select(select), crate::acp::ConfigOptionValue::Select(value)) => {
            match &select.options {
                SessionConfigSelectOptions::Ungrouped(options) => options
                    .iter()
                    .any(|option| option.value.to_string() == *value),
                SessionConfigSelectOptions::Grouped(groups) => groups.iter().any(|group| {
                    group
                        .options
                        .iter()
                        .any(|option| option.value.to_string() == *value)
                }),
                _ => false,
            }
        }
        _ => false,
    }
}

pub fn config_option_has_current_value(
    option: &agent_client_protocol::v1::schema::SessionConfigOption,
    value: &crate::acp::ConfigOptionValue,
) -> bool {
    use agent_client_protocol::v1::schema::SessionConfigKind;

    match (&option.kind, value) {
        (SessionConfigKind::Boolean(current), crate::acp::ConfigOptionValue::Boolean(value)) => {
            current.current_value == *value
        }
        (SessionConfigKind::Select(current), crate::acp::ConfigOptionValue::Select(value)) => {
            current.current_value.to_string() == *value
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::v1::schema::{
        SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption,
    };

    #[test]
    fn reconcile_drops_removed_and_invalid_overrides() {
        let config = AgentConfigSelection::ConfigOptions {
            agent_id: Some("agent".into()),
            values: BTreeMap::from([
                (
                    "model".into(),
                    crate::acp::ConfigOptionValue::Select("old".into()),
                ),
                ("fast".into(), crate::acp::ConfigOptionValue::Boolean(false)),
                (
                    "removed".into(),
                    crate::acp::ConfigOptionValue::Boolean(true),
                ),
            ]),
        };
        let advertised = vec![
            SessionConfigOption::select(
                "model",
                "Model",
                "new",
                vec![SessionConfigSelectOption::new("new", "New")],
            ),
            SessionConfigOption::boolean("fast", "Fast", true),
        ];

        assert_eq!(
            config.reconciled_with(&advertised),
            AgentConfigSelection::ConfigOptions {
                agent_id: Some("agent".into()),
                values: BTreeMap::from([(
                    "fast".into(),
                    crate::acp::ConfigOptionValue::Boolean(false),
                )]),
            }
        );
    }

    #[test]
    fn grouped_select_override_remains_valid() {
        let option = SessionConfigOption::select(
            "effort",
            "Effort",
            "medium",
            vec![SessionConfigSelectGroup::new(
                "levels",
                "Levels",
                vec![SessionConfigSelectOption::new("high", "High")],
            )],
        );
        assert!(config_option_accepts(
            &option,
            &crate::acp::ConfigOptionValue::Select("high".into()),
        ));
    }
}
