//! Plugin radio bridge — relays Grove's global [`RadioEvent`] stream into the
//! per-task plugin event channel as `grove:radio` events, so plugin panels
//! holding `chat:read` see the same aggregated ACP/agent activity (chat status,
//! busy transitions, prompts, final messages, hook notifications, todo
//! progress) that the Radio phone and menubar tray already consume.
//!
//! This deliberately rides the *already-aggregated* radio event bus rather than
//! the raw per-session `AcpUpdate` broadcast: the radio layer has done the work
//! of collapsing the firehose into semantic, task-grained events, which is
//! exactly the granularity a plugin wants.
//!
//! Only task-scoped events are forwarded; ambient global events (client count,
//! theme, group changes) have no task to attribute and are dropped.

use tokio::sync::broadcast::error::RecvError;

use crate::radio::{subscribe_plugins, RadioEvent};

/// The owning task id of a radio event, if it is task-scoped.
fn task_of(event: &RadioEvent) -> Option<&str> {
    match event {
        RadioEvent::FocusTask { task_id, .. }
        | RadioEvent::PromptSent { task_id, .. }
        | RadioEvent::TaskBusy { task_id, .. }
        | RadioEvent::HookAdded { task_id, .. }
        | RadioEvent::FocusTarget { task_id, .. }
        | RadioEvent::TerminalInput { task_id, .. }
        | RadioEvent::ChatListChanged { task_id, .. }
        | RadioEvent::ChatStatus { task_id, .. }
        | RadioEvent::Turn { task_id, .. }
        | RadioEvent::PendingChanged { task_id, .. } => Some(task_id),
        RadioEvent::ClientConnected
        | RadioEvent::ClientDisconnected
        | RadioEvent::ClientCount { .. }
        | RadioEvent::GroupChanged
        | RadioEvent::ThemeChanged { .. } => None,
    }
}

/// Spawn the bridge pump. Call once at server startup. The pump is a no-op on
/// the wire whenever no panel under the event's task holds `chat:read`.
pub fn spawn() {
    tokio::spawn(async move {
        let mut rx = subscribe_plugins();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let Some(task_id) = task_of(&event) else {
                        continue;
                    };
                    // Skip serialising for tasks nobody is listening on.
                    if !super::events::has_radio_subscribers(task_id) {
                        continue;
                    }
                    let Ok(data) = serde_json::to_value(&event) else {
                        continue;
                    };
                    let payload = serde_json::json!({ "name": "grove:radio", "data": data });
                    super::events::publish_radio(task_id, &payload);
                }
                // Under a burst we may drop intermediate events; the next
                // recv resyncs. Keep the pump alive.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
