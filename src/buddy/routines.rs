use crate::error::{GroveError, Result};
use crate::storage::{
    automations::{self, Automation, TargetMode},
    buddies::Buddy,
    tasks,
};
use chrono::Utc;
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RoutineInput {
    pub name: String,
    pub prompt: String,
    pub schedule_cron: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub event_triggers: Vec<String>,
}
fn enabled() -> bool {
    true
}

pub fn list(buddy: &Buddy) -> Result<Vec<Automation>> {
    Ok(automations::list_by_project(&buddy.project_hash)?
        .into_iter()
        .filter(|a| {
            a.handler_key == automations::TASK_PROMPT_HANDLER
                && a.session_mode == TargetMode::BuddyActive
        })
        .collect())
}
pub fn get(buddy: &Buddy, id: &str) -> Result<Automation> {
    list(buddy)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| GroveError::not_found("Buddy Routine not found"))
}
pub fn save(buddy: &Buddy, id: Option<&str>, input: RoutineInput) -> Result<Automation> {
    if input.name.trim().is_empty() || input.prompt.trim().is_empty() {
        return Err(GroveError::invalid_data("name and prompt are required"));
    }
    crate::automation::cron_util::validate(&input.schedule_cron)
        .map_err(GroveError::invalid_data)?;
    let now = Utc::now().timestamp();
    let mut routine = if let Some(id) = id {
        get(buddy, id)?
    } else {
        Automation {
            id: automations::generate_id(),
            project: buddy.project_hash.clone(),
            name: String::new(),
            enabled: false,
            handler_key: automations::TASK_PROMPT_HANDLER.into(),
            agent_config: Default::default(),
            task_mode: TargetMode::Existing,
            task_id: Some(tasks::LOCAL_TASK_ID.into()),
            task_template: None,
            session_mode: TargetMode::BuddyActive,
            chat_id: None,
            session_template: None,
            prompt: String::new(),
            schedule_cron: String::new(),
            event_triggers: Vec::new(),
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
        }
    };
    routine.name = input.name;
    routine.prompt = input.prompt;
    routine.schedule_cron = input.schedule_cron;
    routine.enabled = input.enabled;
    routine.event_triggers = input.event_triggers;
    routine.updated_at = now;
    routine.next_run_at = if routine.enabled {
        crate::automation::cron_util::next_unix(&routine.schedule_cron)
            .map_err(GroveError::invalid_data)?
    } else {
        None
    };
    if id.is_some() {
        automations::update(&routine)?;
    } else {
        automations::insert(&routine)?;
    }
    Ok(routine)
}
pub fn delete(buddy: &Buddy, id: &str) -> Result<()> {
    get(buddy, id)?;
    automations::delete(id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        buddies::test_support::{seed_buddy, Store},
        database,
    };
    fn input() -> RoutineInput {
        RoutineInput {
            name: "Daily".into(),
            prompt: "Check progress".into(),
            schedule_cron: "0 9 * * *".into(),
            enabled: true,
            event_triggers: Vec::new(),
        }
    }
    #[tokio::test]
    async fn routine_survives_switch_and_uses_current_segment() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "routine");
        let routine = save(&buddy, None, input()).unwrap();
        assert_eq!(
            serde_json::to_value(routine.session_mode).unwrap(),
            "buddy_active"
        );
        let current = super::super::switch_on(
            &database::connection(),
            &buddy,
            "codex-acp",
            Default::default(),
        )
        .unwrap();
        let chat = current.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", current.project_hash);
        let (_, _, _guard) = crate::acp::new_handle_for_test(
            &key,
            &current.project_hash,
            tasks::LOCAL_TASK_ID,
            chat,
        );
        let result = crate::automation::executor::run(&routine, "manual").await;
        assert_eq!(result.status, "queued", "{:?}", result.error);
        assert_eq!(result.resolved_chat_id.as_deref(), Some(chat));
        let other = seed_buddy(&database::connection(), "other");
        assert!(get(&other, &routine.id).is_err());
        let mut invalid = routine.clone();
        invalid.task_mode = TargetMode::BuddyActive;
        assert!(automations::update(&invalid).is_err());
        invalid = routine.clone();
        invalid.project = "normal-project".into();
        assert!(automations::update(&invalid).is_err());
        delete(&buddy, &routine.id).unwrap();
        assert!(list(&buddy).unwrap().is_empty());
    }
}
