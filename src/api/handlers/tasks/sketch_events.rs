//! Broadcast channel for sketch updates. Follows the `walkie_talkie` pattern.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SketchEvent {
    SketchUpdated {
        project: String,
        task_id: String,
        sketch_id: String,
        source: SketchEventSource,
    },
    IndexChanged {
        project: String,
        task_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SketchEventSource {
    User,
    Agent,
}

static SKETCH_EVENTS: Lazy<broadcast::Sender<SketchEvent>> = Lazy::new(|| {
    let (tx, _) = broadcast::channel(256);
    tx
});

pub fn broadcast_sketch_event(event: SketchEvent) {
    let _ = SKETCH_EVENTS.send(event);
}

pub fn subscribe() -> broadcast::Receiver<SketchEvent> {
    SKETCH_EVENTS.subscribe()
}
