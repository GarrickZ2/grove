//! Plugin event bus — a Grove-mediated channel so a plugin's MCP server or
//! node backend can push semantic events to its **panel**, which refreshes in
//! response. Keyed by (plugin, task).
//!
//! Directions (per the design — MCP can't receive, panel can't emit):
//!   - backend `emit` → a `{type:"grove:event",…}` line on its stdout, which
//!     [`super::backend`]'s reader forwards here (in-process, no HTTP).
//!   - MCP `emit` → an HTTP `POST /plugins/{id}/events` (its stdio is the agent
//!     channel, not Grove's), authenticated by the injected events token.
//!   - panel `on` → an SSE stream the host (`PluginFrame`) subscribes to and
//!     relays into the sandboxed iframe.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tokio::sync::mpsc;

/// Open panel subscribers, keyed by `pluginId::taskId`.
static SUBS: Lazy<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Panel subscribers that additionally opted into the task-scoped radio/ACP
/// event firehose — the subset of plugins holding `chat:read`. Keyed by
/// `taskId` (radio events are task-grained, not plugin-grained). Each sender
/// here is a clone of the same SSE channel already registered in [`SUBS`], so a
/// closed panel is pruned from both maps independently.
static RADIO_SUBS: Lazy<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Per-process secret the MCP server must present to POST events (its node
/// process isn't a normal authenticated Grove client). Random each run.
static TOKEN: Lazy<String> = Lazy::new(|| uuid::Uuid::new_v4().to_string());

/// Loopback base URL of Grove's own API, set once the server binds. None in
/// modes with no HTTP server (e.g. pure TUI) — then MCP event emit is inert.
static BASE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

pub fn token() -> &'static str {
    &TOKEN
}

/// Record Grove's own loopback base (e.g. `http://127.0.0.1:3001`) so MCP
/// servers can be told where to POST events. Called from `start_server`.
pub fn set_server_base(base: String) {
    *BASE.lock().unwrap() = Some(base);
}

/// The events endpoint a plugin's MCP server should POST to, if a server exists.
pub fn events_url(plugin_id: &str) -> Option<String> {
    BASE.lock()
        .unwrap()
        .as_ref()
        .map(|b| format!("{}/api/v1/plugins/{}/events", b, plugin_id))
}

fn key(plugin_id: &str, task_id: &str) -> String {
    format!("{}::{}", plugin_id, task_id)
}

/// Register a panel subscriber; the receiver yields SSE-framed `data:` lines.
///
/// `radio` is set when the subscribing plugin holds `chat:read` — only then is
/// the channel additionally registered in [`RADIO_SUBS`] to receive the
/// task-scoped radio/ACP firehose. Without it the panel still gets the plugin's
/// own backend/MCP `emit` events, just not the ambient ACP stream.
pub fn subscribe(plugin_id: &str, task_id: &str, radio: bool) -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    {
        let mut subs = SUBS.lock().unwrap();
        let list = subs.entry(key(plugin_id, task_id)).or_default();
        // Prune already-closed senders so the map doesn't accumulate dead
        // entries for keys that never see another publish.
        list.retain(|tx| !tx.is_closed());
        list.push(tx.clone());
    }
    if radio {
        let mut rsubs = RADIO_SUBS.lock().unwrap();
        let list = rsubs.entry(task_id.to_string()).or_default();
        list.retain(|tx| !tx.is_closed());
        list.push(tx);
    }
    rx
}

/// Fan an event out to the plugin's task panel. An app-scoped backend emits
/// with task `global`, which reaches every open surface of that plugin.
/// `payload` is the `{name, data}` object; dead subscribers are pruned.
pub fn publish(plugin_id: &str, task_id: &str, payload: &serde_json::Value) {
    let k = key(plugin_id, task_id);
    let line = format!("data: {}\n\n", payload);
    let mut subs = SUBS.lock().unwrap();
    if task_id == "global" {
        let prefix = format!("{plugin_id}::");
        subs.retain(|scope, list| {
            if scope.starts_with(&prefix) {
                list.retain(|tx| tx.send(line.clone()).is_ok());
            }
            !list.is_empty()
        });
    } else {
        let mut empty = false;
        if let Some(list) = subs.get_mut(&k) {
            list.retain(|tx| tx.send(line.clone()).is_ok());
            empty = list.is_empty();
        }
        if empty {
            subs.remove(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_event_reaches_only_its_plugins_surfaces() {
        let plugin = format!("global-event-test-{}", uuid::Uuid::new_v4());
        let other = format!("other-event-test-{}", uuid::Uuid::new_v4());
        let mut first = subscribe(&plugin, "task-a", false);
        let mut second = subscribe(&plugin, "task-b", false);
        let mut sidebar = subscribe(&plugin, "global", false);
        let mut unrelated = subscribe(&other, "task-a", false);
        publish(&plugin, "global", &serde_json::json!({"name": "changed"}));
        assert!(first.try_recv().is_ok());
        assert!(second.try_recv().is_ok());
        assert!(sidebar.try_recv().is_ok());
        assert!(unrelated.try_recv().is_err());
    }
}

/// Fan a task-scoped radio/ACP event out to every panel under `task_id` that
/// opted into the firehose (subscribed with `radio = true`, i.e. holds
/// `chat:read`). `payload` is the `{name, data}` object the panel relay turns
/// into a `grove:event`. Dead subscribers are pruned.
pub fn publish_radio(task_id: &str, payload: &serde_json::Value) {
    let line = format!("data: {}\n\n", payload);
    let mut rsubs = RADIO_SUBS.lock().unwrap();
    let mut empty = false;
    if let Some(list) = rsubs.get_mut(task_id) {
        list.retain(|tx| tx.send(line.clone()).is_ok());
        empty = list.is_empty();
    }
    if empty {
        rsubs.remove(task_id);
    }
}

/// True when at least one panel under `task_id` is subscribed to the radio
/// firehose. Lets the bridge pump skip serialising events nobody will receive.
pub fn has_radio_subscribers(task_id: &str) -> bool {
    RADIO_SUBS
        .lock()
        .unwrap()
        .get(task_id)
        .is_some_and(|l| !l.is_empty())
}
