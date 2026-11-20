//! Routines a chat Agent schedules for its own Task.
//!
//! The same Automations the user manages in the GUI and a Buddy manages with
//! its Routine tools, narrowed to the caller's Task: a Routine is always
//! delivered in this Task, either back to the calling chat (`self`) or to a
//! fresh chat with the caller's Agent (`new_chat`). Listing, editing and
//! deleting see only Routines that target this Task.

use chrono::Utc;
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};

use crate::automation::cron_util;
use crate::error::{GroveError, Result};
use crate::storage::automations::{
    self, Automation, ScheduleWindow, SessionTemplate, TargetMode, TASK_PROMPT_HANDLER,
};
use crate::storage::tasks;

/// Where a Routine's prompt is delivered, always inside the caller's Task.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum RoutineTarget {
    /// Back to this chat.
    #[default]
    #[serde(rename = "self")]
    SelfChat,
    /// A new chat in this Task with the same Agent, created on each run.
    #[serde(rename = "new_chat")]
    NewChat,
}

/// The calling chat: its Project, Task and Session.
#[derive(Debug, Clone)]
pub struct Caller {
    pub project: String,
    pub task_id: String,
    pub chat_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskRoutineInput {
    /// Short name shown in the Automations list.
    pub name: String,
    /// The message delivered when the Routine fires. Write it for whoever
    /// reads it then, with everything needed to act on it.
    pub prompt: String,
    /// `self` (default) sends it back to this chat; `new_chat` starts a new
    /// chat in this Task with the same Agent on each run.
    #[serde(default)]
    pub target: RoutineTarget,
    /// One-time Routine: fire once at this unix timestamp (seconds), then
    /// turn itself off. Cannot be combined with starts_at / ends_at.
    #[serde(default)]
    pub run_once_at: Option<i64>,
    /// Recurring Routine: standard 5-field cron in the machine's local
    /// timezone. Leave empty for a one-time Routine.
    #[serde(default)]
    pub schedule_cron: String,
    /// Recurring Routine: do not fire before this unix timestamp (seconds).
    #[serde(default)]
    pub starts_at: Option<i64>,
    /// Recurring Routine: stop after this unix timestamp (seconds).
    #[serde(default)]
    pub ends_at: Option<i64>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

/// A partial edit: what is left out stays as it is.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct TaskRoutinePatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    /// `self` re-targets it to this chat; `new_chat` to a new chat per run.
    pub target: Option<RoutineTarget>,
    pub schedule_cron: Option<String>,
    pub enabled: Option<bool>,
    /// Unix seconds; null clears it, turning a one-time Routine recurring.
    #[serde(default, deserialize_with = "crate::buddy::routines::present")]
    pub run_once_at: Option<Option<i64>>,
    /// Unix seconds; null clears it.
    #[serde(default, deserialize_with = "crate::buddy::routines::present")]
    pub starts_at: Option<Option<i64>>,
    /// Unix seconds; null clears it.
    #[serde(default, deserialize_with = "crate::buddy::routines::present")]
    pub ends_at: Option<Option<i64>>,
}

/// Routines that deliver into the caller's Task.
pub fn list(caller: &Caller) -> Result<Vec<Automation>> {
    Ok(automations::list_by_project(&caller.project)?
        .into_iter()
        .filter(|a| {
            a.handler_key == TASK_PROMPT_HANDLER
                && a.task_mode == TargetMode::Existing
                && a.task_id.as_deref() == Some(caller.task_id.as_str())
                && a.session_mode != TargetMode::BuddyActive
        })
        .collect())
}

pub fn get(caller: &Caller, id: &str) -> Result<Automation> {
    list(caller)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| GroveError::not_found("Routine not found in this Task"))
}

pub fn create(caller: &Caller, input: TaskRoutineInput) -> Result<Automation> {
    if input.name.trim().is_empty() || input.prompt.trim().is_empty() {
        return Err(GroveError::invalid_data("name and prompt are required"));
    }
    if input.run_once_at.is_none() && input.schedule_cron.trim().is_empty() {
        return Err(GroveError::invalid_data(
            "pass run_once_at for a one-time Routine or schedule_cron for a recurring one",
        ));
    }
    let now = Utc::now().timestamp();
    let mut routine = Automation {
        id: automations::generate_id(),
        project: caller.project.clone(),
        name: input.name,
        enabled: input.enabled,
        handler_key: TASK_PROMPT_HANDLER.into(),
        agent_config: Default::default(),
        task_mode: TargetMode::Existing,
        task_id: Some(caller.task_id.clone()),
        task_template: None,
        session_mode: TargetMode::Existing,
        chat_id: None,
        session_template: None,
        prompt: input.prompt,
        schedule_cron: input.schedule_cron,
        event_triggers: Vec::new(),
        window: ScheduleWindow {
            run_once_at: input.run_once_at,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
        },
        last_run_at: None,
        last_run_status: None,
        last_run_error: None,
        next_run_at: None,
        created_at: now,
        updated_at: now,
    };
    set_target(caller, &mut routine, input.target)?;
    schedule(&mut routine)?;
    automations::insert(&routine)?;
    Ok(routine)
}

pub fn update(caller: &Caller, id: &str, patch: TaskRoutinePatch) -> Result<Automation> {
    let mut routine = get(caller, id)?;
    if let Some(name) = patch.name {
        routine.name = name;
    }
    if let Some(prompt) = patch.prompt {
        routine.prompt = prompt;
    }
    if routine.name.trim().is_empty() || routine.prompt.trim().is_empty() {
        return Err(GroveError::invalid_data("name and prompt are required"));
    }
    if let Some(target) = patch.target {
        set_target(caller, &mut routine, target)?;
    }
    if let Some(cron) = patch.schedule_cron {
        routine.schedule_cron = cron;
    }
    if let Some(enabled) = patch.enabled {
        routine.enabled = enabled;
    }
    if let Some(at) = patch.run_once_at {
        routine.window.run_once_at = at;
    }
    if let Some(at) = patch.starts_at {
        routine.window.starts_at = at;
    }
    if let Some(at) = patch.ends_at {
        routine.window.ends_at = at;
    }
    routine.updated_at = Utc::now().timestamp();
    schedule(&mut routine)?;
    automations::update(&routine)?;
    Ok(routine)
}

pub fn delete(caller: &Caller, id: &str) -> Result<()> {
    get(caller, id)?;
    automations::delete(id)?;
    Ok(())
}

/// Readable summary of a Routine for the calling Agent.
pub fn describe(caller: &Caller, a: &Automation) -> serde_json::Value {
    let target = match (a.session_mode, a.chat_id.as_deref()) {
        (TargetMode::New, _) => "new_chat".to_string(),
        (TargetMode::Existing, Some(chat)) if chat == caller.chat_id => "self".to_string(),
        (TargetMode::Existing, Some(chat)) => format!("chat:{chat}"),
        _ => "unknown".to_string(),
    };
    serde_json::json!({
        "id": a.id,
        "name": a.name,
        "prompt": a.prompt,
        "target": target,
        "enabled": a.enabled,
        "schedule_cron": a.schedule_cron,
        "run_once_at": a.window.run_once_at,
        "starts_at": a.window.starts_at,
        "ends_at": a.window.ends_at,
        "next_run_at": a.next_run_at,
        "last_run_at": a.last_run_at,
        "last_run_status": a.last_run_status,
        "last_run_error": a.last_run_error,
    })
}

fn set_target(caller: &Caller, routine: &mut Automation, target: RoutineTarget) -> Result<()> {
    match target {
        RoutineTarget::SelfChat => {
            routine.session_mode = TargetMode::Existing;
            routine.chat_id = Some(caller.chat_id.clone());
            routine.session_template = None;
        }
        RoutineTarget::NewChat => {
            let chat = tasks::get_chat_session(&caller.project, &caller.task_id, &caller.chat_id)?
                .ok_or_else(|| GroveError::not_found("this chat was not found"))?;
            routine.session_mode = TargetMode::New;
            routine.chat_id = None;
            routine.session_template = Some(SessionTemplate {
                agent: chat.agent,
                title: None,
            });
        }
    }
    Ok(())
}

/// Validate the schedule and work out the next run.
fn schedule(routine: &mut Automation) -> Result<()> {
    cron_util::validate_schedule(&routine.schedule_cron, routine.window)
        .map_err(GroveError::invalid_data)?;
    routine.next_run_at = if routine.enabled {
        let next = cron_util::next_scheduled(&routine.schedule_cron, routine.window)
            .map_err(GroveError::invalid_data)?;
        if next.is_none() && routine.window.is_bounded() {
            return Err(GroveError::invalid_data(
                "this schedule has no future runs — pick a later time or end date",
            ));
        }
        next
    } else {
        None
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(project: &str) -> Caller {
        Caller {
            project: project.into(),
            task_id: "task-a".into(),
            chat_id: "chat-a".into(),
        }
    }

    fn input(target: RoutineTarget) -> TaskRoutineInput {
        TaskRoutineInput {
            name: "Check CI".into(),
            prompt: "See whether CI passed".into(),
            target,
            run_once_at: Some(Utc::now().timestamp() + 3600),
            schedule_cron: String::new(),
            starts_at: None,
            ends_at: None,
            enabled: true,
        }
    }

    fn seed_chat(project: &str) {
        tasks::add_chat_session(
            project,
            "task-a",
            tasks::ChatSession {
                id: "chat-a".into(),
                title: "Main".into(),
                agent: "codex".into(),
                acp_session_id: None,
                created_at: Utc::now(),
                duty: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn routines_stay_inside_the_callers_task() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let project = format!("project-{}", uuid::Uuid::new_v4().simple());
        seed_chat(&project);
        let me = caller(&project);

        let own = create(&me, input(RoutineTarget::SelfChat)).unwrap();
        assert_eq!(own.session_mode, TargetMode::Existing);
        assert_eq!(own.chat_id.as_deref(), Some("chat-a"));
        assert_eq!(own.task_id.as_deref(), Some("task-a"));
        assert!(own.next_run_at.is_some());
        assert_eq!(describe(&me, &own)["target"], "self");

        let fresh = create(&me, input(RoutineTarget::NewChat)).unwrap();
        assert_eq!(fresh.session_mode, TargetMode::New);
        assert_eq!(fresh.session_template.as_ref().unwrap().agent, "codex");

        let other = Caller {
            task_id: "task-b".into(),
            ..caller(&project)
        };
        assert!(list(&other).unwrap().is_empty());
        assert!(delete(&other, &own.id).is_err());
        assert_eq!(list(&me).unwrap().len(), 2);

        let recurring = update(
            &me,
            &own.id,
            TaskRoutinePatch {
                run_once_at: Some(None),
                schedule_cron: Some("0 9 * * 1-5".into()),
                target: Some(RoutineTarget::NewChat),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(recurring.window.run_once_at.is_none());
        assert_eq!(recurring.session_mode, TargetMode::New);
        assert!(recurring.chat_id.is_none());

        let mut no_schedule = input(RoutineTarget::SelfChat);
        no_schedule.run_once_at = None;
        assert!(create(&me, no_schedule).is_err());

        delete(&me, &own.id).unwrap();
        delete(&me, &fresh.id).unwrap();
        assert!(list(&me).unwrap().is_empty());
        crate::storage::set_grove_dir_override(None);
    }
}
