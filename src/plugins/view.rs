//! Where people are looking right now.
//!
//! A view exists only in the client showing it, and one Grove can have a
//! desktop window, a browser tab and a phone open at once, so there is no
//! single "current view". Each window reports its own; this registry holds
//! the live ones in memory. A window that stops reporting drops out.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};

/// Longer than the client's heartbeat, so one missed beat does not drop it.
const VIEW_TTL: Duration = Duration::from_secs(90);

/// What a window reports about itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewReport {
    pub surface_id: String,
    /// `desktop`, `web`, `phone` or `tui`.
    pub client: String,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub visible: bool,
    pub page: Option<String>,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub chat_id: Option<String>,
    pub panel: Option<String>,
}

static VIEWS: Lazy<Mutex<HashMap<String, (Instant, Value)>>> = Lazy::new(Default::default);

/// Device names come from the server's auth records, never from the client.
pub fn record(report: ViewReport, device_id: Option<&str>, device_name: Option<String>) -> Value {
    let name = device_name.unwrap_or_else(|| "This computer".to_string());
    let viewpoint = json!({
        "surfaceId": report.surface_id,
        "device": { "id": device_id, "name": name, "client": report.client },
        "focused": report.focused,
        "visible": report.visible,
        "lastActiveAt": chrono::Utc::now().timestamp_millis(),
        "page": report.page,
        "projectId": report.project_id,
        "taskId": report.task_id,
        "chatId": report.chat_id,
        "panel": report.panel,
    });
    VIEWS
        .lock()
        .unwrap()
        .insert(report.surface_id, (Instant::now(), viewpoint.clone()));
    viewpoint
}

pub fn remove(surface_id: &str) {
    VIEWS.lock().unwrap().remove(surface_id);
}

/// Every live viewpoint, focused first, then most recently active.
pub fn list() -> Vec<Value> {
    let mut views = VIEWS.lock().unwrap();
    views.retain(|_, (reported, _)| reported.elapsed() < VIEW_TTL);
    let mut live: Vec<Value> = views.values().map(|(_, view)| view.clone()).collect();
    live.sort_by_key(|view| {
        (
            !view["focused"].as_bool().unwrap_or(false),
            -view["lastActiveAt"].as_i64().unwrap_or(0),
        )
    });
    live
}

#[cfg(test)]
pub(crate) fn clear() {
    VIEWS.lock().unwrap().clear();
}

#[cfg(test)]
pub(crate) fn expire(surface_id: &str) {
    if let Some((reported, _)) = VIEWS.lock().unwrap().get_mut(surface_id) {
        *reported = Instant::now()
            .checked_sub(VIEW_TTL + Duration::from_secs(1))
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: &str, focused: bool) -> ViewReport {
        ViewReport {
            surface_id: id.into(),
            client: "web".into(),
            focused,
            visible: true,
            page: Some("tasks".into()),
            project_id: Some("p".into()),
            task_id: None,
            chat_id: None,
            panel: None,
        }
    }

    #[test]
    fn viewpoints_list_focused_first_and_expire() {
        // Shares a process-wide registry with no other test.
        clear();
        record(report("view-a", false), None, None);
        record(report("view-b", true), Some("d1"), Some("iPhone".into()));
        let live = list();
        assert_eq!(live.len(), 2);
        assert_eq!(live[0]["surfaceId"], "view-b");
        assert_eq!(live[0]["device"]["name"], "iPhone");
        assert_eq!(live[1]["device"]["name"], "This computer");
        record(report("view-a", false), None, None);
        assert_eq!(list().len(), 2);
        expire("view-a");
        assert_eq!(list().len(), 1);
        remove("view-b");
        assert!(list().is_empty());
    }
}
