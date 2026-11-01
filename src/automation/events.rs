//! Domain-event bridge for Automations.

use crate::storage::automations;

pub fn emit(project_id: impl Into<String>, event: impl Into<String>, payload: serde_json::Value) {
    let project_id = project_id.into();
    let event = event.into();
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        super::awarn!("event {event} ignored because no Tokio runtime is active");
        return;
    };
    runtime.spawn(async move {
        let items = match automations::list_by_project(&project_id) {
            Ok(items) => items,
            Err(error) => {
                super::awarn!("load subscribers for event {event}: {error}");
                return;
            }
        };
        let now = chrono::Utc::now().timestamp();
        for automation in items.into_iter().filter(|automation| {
            automation.enabled
                && automation.window.contains(now)
                && automation.event_triggers.iter().any(|item| item == &event)
        }) {
            let payload = payload.clone();
            tokio::spawn(async move {
                super::executor::run_with_payload(&automation, "event", Some(payload)).await;
            });
        }
    });
}
