use crate::agent_config::AgentConfigSelection;
use crate::error::{GroveError, Result};
use crate::storage::{
    buddies as db,
    custom_agent::{self, CustomAgent, CustomAgentPatch},
    database,
};
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
    pub role: Option<String>,
    pub system_prompt: Option<String>,
    pub agent_config: Option<AgentConfigSelection>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}
impl Patch {
    fn config_changed(&self) -> bool {
        self.agent_config.is_some()
            || self.model.is_some()
            || self.mode.is_some()
            || self.effort.is_some()
    }
}
fn updated_persona(mut persona: CustomAgent, patch: &Patch) -> Result<CustomAgent> {
    let selection = patch.agent_config.as_ref().unwrap_or(&persona.agent_config);
    if !matches!(selection, AgentConfigSelection::Default { .. })
        && (patch.model.is_some() || patch.mode.is_some() || patch.effort.is_some())
    {
        return Err(GroveError::invalid_data(
            "Use agent_config while structured configuration is selected",
        ));
    }
    if let Some(selection) = &patch.agent_config {
        let mut selection = selection.clone();
        super::validate_agent(&persona.base_agent, &mut selection)?;
        persona.agent_config = selection;
    }
    if let Some(name) = &patch.name {
        if name.trim().is_empty() {
            return Err(GroveError::invalid_data("name is required"));
        }
        persona.name = name.clone();
    }
    if let Some(role) = &patch.role {
        persona.duty = Some(role.clone());
    }
    if let Some(prompt) = &patch.system_prompt {
        persona.system_prompt = prompt.clone();
    }
    if let Some(model) = &patch.model {
        persona.model = Some(model.clone());
    }
    if let Some(mode) = &patch.mode {
        persona.mode = Some(mode.clone());
    }
    if let Some(effort) = &patch.effort {
        persona.effort = Some(effort.clone());
    }
    Ok(persona)
}

fn persist(buddy: &db::Buddy, persona: &CustomAgent, patch: &Patch) -> Result<()> {
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    custom_agent::update_on(
        &tx,
        &persona.id,
        CustomAgentPatch {
            name: Some(persona.name.clone()),
            agent_config: Some(persona.agent_config.clone()),
            model: Some(persona.model.clone()),
            mode: Some(persona.mode.clone()),
            effort: Some(persona.effort.clone()),
            duty: Some(persona.duty.clone()),
            system_prompt: Some(persona.system_prompt.clone()),
            ..Default::default()
        },
    )?
    .ok_or_else(|| GroveError::not_found("Buddy persona not found"))?;
    tx.execute(
        "UPDATE projects SET name=?1 WHERE hash=?2",
        rusqlite::params![persona.name, buddy.project_hash],
    )?;
    tx.execute(
        "UPDATE tasks SET name=?1 WHERE project=?2 AND id='_local'",
        rusqlite::params![persona.name, buddy.project_hash],
    )?;
    db::update_profile(
        &tx,
        &buddy.id,
        patch.avatar.as_deref().or(buddy.avatar.as_deref()),
        patch.description.as_deref().unwrap_or(&buddy.description),
    )?;
    tx.execute("UPDATE automations SET agent_config_json=?1,updated_at=?2 WHERE id IN (SELECT organization_automation_id FROM memory_project_configs WHERE project_id=?3)",
        rusqlite::params![serde_json::to_string(&persona.agent_config)?, chrono::Utc::now().timestamp(),buddy.project_hash])?;
    tx.commit()?;
    Ok(())
}

pub async fn update(id: &str, patch: Patch) -> Result<db::Buddy> {
    // Validate before starting an Agent. Reserve activity before the Buddy gate,
    // so startup never recursively acquires the same gate.
    let initial = super::get(id)?;
    let persona = custom_agent::get(&initial.custom_agent_id)?
        .ok_or_else(|| GroveError::not_found("Buddy persona not found"))?;
    updated_persona(persona, &patch)?;
    let runtime = if patch.config_changed() {
        Some(super::delegations::active_handle(id).await?)
    } else {
        None
    };
    let _gate = super::lock(id).await;
    let buddy = super::get(id)?;
    let previous = custom_agent::get(&buddy.custom_agent_id)?
        .ok_or_else(|| GroveError::not_found("Buddy persona not found"))?;
    let next = updated_persona(previous.clone(), &patch)?;
    if let Some((_, handle, _)) = &runtime {
        let before_runtime = serde_json::to_vec(&handle.snapshot_buddy_config())?;
        if let Err(error) = handle.apply_buddy_preferences(&next).await {
            // A failed rollback is observable, never reported as a successful
            // PATCH. Save actual acknowledged settings so persistence agrees.
            let snapshot = handle.snapshot_buddy_config();
            if serde_json::to_vec(&snapshot)? == before_runtime {
                return Err(error);
            }
            let mut observed = previous.clone();
            if !snapshot.config_options.is_empty() {
                observed.agent_config = AgentConfigSelection::ConfigOptions {
                    agent_id: Some(observed.base_agent.clone()),
                    values: snapshot.config_options,
                };
            } else {
                observed.agent_config = AgentConfigSelection::Default {
                    agent_id: Some(observed.base_agent.clone()),
                };
                observed.model = snapshot.model;
                observed.mode = snapshot.mode;
                observed.effort = snapshot.thought_level;
            }
            persist(&buddy, &observed, &Patch::default())?;
            return Err(error);
        }
    }
    if let Err(error) = persist(&buddy, &next, &patch) {
        if let Some((_, handle, _)) = &runtime {
            handle.apply_buddy_preferences(&previous).await?;
        }
        return Err(error);
    }
    crate::radio::publish(crate::radio::RadioEvent::AgentsChanged);
    super::get(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        automations,
        buddies::test_support::{seed_buddy, Store},
    };
    #[tokio::test]
    async fn structured_priority_rejects_legacy_update_without_starting_agent() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "config");
        custom_agent::update(
            &buddy.custom_agent_id,
            CustomAgentPatch {
                agent_config: Some(AgentConfigSelection::ConfigOptions {
                    agent_id: Some("claude-acp".into()),
                    values: Default::default(),
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(update(
            &buddy.id,
            Patch {
                model: Some("model".into()),
                ..Default::default()
            }
        )
        .await
        .is_err());
        let key = format!(
            "{}:_local:{}",
            buddy.project_hash,
            buddy.active_session_id.as_deref().unwrap()
        );
        assert!(!crate::acp::session_exists(&key));
        let updated = update(
            &buddy.id,
            Patch {
                name: Some("New name".into()),
                system_prompt: Some("New instruction".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.active_session_id, buddy.active_session_id);
        assert_eq!(
            custom_agent::get(&buddy.custom_agent_id)
                .unwrap()
                .unwrap()
                .system_prompt,
            "New instruction"
        );
        assert!(!crate::acp::session_exists(&key));
    }
    #[tokio::test]
    async fn unsupported_runtime_settings_leave_persona_and_segment_unchanged() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "config-rejected");
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (_, _, _guard) = crate::acp::new_handle_for_test(
            &key,
            &buddy.project_hash,
            crate::storage::tasks::LOCAL_TASK_ID,
            chat,
        );
        let before = custom_agent::get(&buddy.custom_agent_id).unwrap().unwrap();
        let error = update(
            &buddy.id,
            Patch {
                model: Some("unsupported".into()),
                name: Some("Should not persist".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("no model config option"));
        let after = custom_agent::get(&buddy.custom_agent_id).unwrap().unwrap();
        assert_eq!(after.model, before.model);
        assert_eq!(after.name, before.name);
        assert_eq!(
            super::super::get(&buddy.id).unwrap().active_session_id,
            buddy.active_session_id
        );
    }

    #[test]
    fn persona_and_memory_configuration_commit_together_without_persona_text() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "memory-config");
        let mut persona = custom_agent::get(&buddy.custom_agent_id).unwrap().unwrap();
        super::super::create_memory_on(
            &database::connection(),
            &buddy,
            &AgentConfigSelection::Default {
                agent_id: Some(persona.base_agent.clone()),
            },
        )
        .unwrap();
        persona.mode = Some("plan".into());
        persona.system_prompt = "Private Buddy personality".into();
        persist(&buddy, &persona, &Patch::default()).unwrap();
        let automation = automations::list_by_project(&buddy.project_hash)
            .unwrap()
            .pop()
            .unwrap();
        // Structured settings sync exactly and legacy preferences use the
        // existing fresh-create injector with an empty system prompt.
        assert_eq!(automation.agent_config, persona.agent_config);
        let mut automation = automation;
        automation.agent_config = AgentConfigSelection::Default {
            agent_id: Some(persona.base_agent.clone()),
        };
        let injection = super::super::memory_persona(&automation).unwrap();
        assert_eq!(injection.mode.as_deref(), Some("plan"));
        assert!(injection.system_prompt.is_empty());
        assert!(crate::storage::memory::project_memory_enabled(&buddy.project_hash).unwrap());
        assert!(!crate::storage::memory::project_memory_enabled("other").unwrap());
    }
}
