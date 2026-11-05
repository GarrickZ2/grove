//! Grove's semantic Radio event model and subscription bus.
//!
//! The event model belongs to Grove, not to a particular HTTP/WebSocket
//! handler. Built-in consumers use an ordered, lossless subscription. Plugin
//! consumers may opt into the bounded broadcast subscription exposed below.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::{broadcast, mpsc};

/// Grove-owned events shared by Radio, desktop surfaces, plugins, and other
/// in-process consumers. ACP remains behind Grove's conversion boundary.
///
/// # Event stream contract
///
/// Every variant belongs to exactly one of two streams — keep new events
/// inside one of them so consumers stay reason-able:
///
/// - **UI state stream** (`Turn`, `ChatStatus`, `TaskBusy`, focus/terminal
///   events): drives what a surface renders right now. Not a notification
///   trigger.
/// - **Attention stream** (`HookAdded`): the human-attention inbox. The ONLY
///   trigger for transient notifications (banners, sounds). Surfaces decide
///   their own presentation — the backend publishes facts, never renders.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RadioEvent {
    FocusTask {
        project_id: String,
        task_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<TargetMode>,
    },
    PromptSent {
        project_id: String,
        task_id: String,
    },
    ClientConnected,
    ClientDisconnected,
    ClientCount {
        count: usize,
    },
    GroupChanged,
    /// A Buddy group's messages, members or details changed.
    BuddyGroupChanged {
        group_id: String,
    },
    /// Installed channels, registry metadata, or custom Agent configuration changed.
    AgentsChanged,
    ThemeChanged {
        name: String,
    },
    TaskBusy {
        project_id: String,
        task_id: String,
        busy: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
    },
    HookAdded {
        project_id: String,
        task_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        level: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        /// What produced the hook — surfaces key their presentation policy
        /// (banner text, sound, permission buttons, config switch) off this.
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        /// Semantic event label, e.g. "Task Complete" / "Permission Required".
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        /// Full permission payload for `kind == "permission_required"` so a
        /// surface can render Approve/Deny without a follow-up fetch.
        #[serde(skip_serializing_if = "Option::is_none")]
        permission: Option<PermissionInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_name: Option<String>,
    },
    FocusTarget {
        project_id: String,
        task_id: String,
        target: TargetMode,
    },
    TerminalInput {
        project_id: String,
        task_id: String,
        text: String,
    },
    ChatListChanged {
        project_id: String,
        task_id: String,
    },
    /// Input attention is independent of busy/idle: ask_form can stay open
    /// after the agent's turn has finished.
    ChatInputStatus {
        project_id: String,
        task_id: String,
        chat_id: String,
        waiting_for_input: bool,
    },
    ChatStatus {
        project_id: String,
        task_id: String,
        chat_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        permission: Option<PermissionInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todo_completed: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todo_total: Option<u32>,
        /// Settled outcome of the chat's last turn while it is idle:
        /// `"error"` (the prompt failed) or `"done"` (it replied to its graph
        /// message and ended its turn). Absent otherwise. Additive — clients
        /// that only read `status` are unaffected.
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<String>,
    },
    PendingChanged {
        project_id: String,
        task_id: String,
        msg_id: String,
        from_chat_id: String,
        to_chat_id: String,
        op: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        body_excerpt: Option<String>,
    },
    /// Stable Grove turn semantics. No ACP type crosses this boundary.
    Turn {
        project_id: String,
        task_id: String,
        chat_id: String,
        message_ids: Vec<String>,
        event: TurnEvent,
    },
}

/// One active chat's current state, returned by the Radio snapshot endpoint.
/// It mirrors the task-scoped fields in `RadioEvent::ChatStatus` so a client
/// can seed its state before consuming live events.
#[derive(Debug, Clone, Serialize)]
pub struct ChatSnapshot {
    pub chat_id: String,
    pub project_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// "idle" | "busy" | "permission_required".
    pub status: String,
    pub waiting_for_input: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<PermissionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_completed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_total: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TurnEvent {
    Started,
    MessageChunk {
        text: String,
    },
    ToolChanged {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        title: Option<String>,
        status: Option<String>,
    },
    PermissionRequired {
        request_id: String,
        permission: PermissionInfo,
    },
    FormRequired {
        form: TurnForm,
    },
    /// Grove's own non-blocking structured form (`ask_form`). The answer is
    /// sent back as a normal follow-up prompt rather than an ACP response.
    AskFormRequired {
        form_id: String,
        definition: crate::agent_graph::ask_form::AskFormInput,
    },
    Completed {
        stop_reason: String,
        message: String,
        /// A Buddy chose to keep this turn from the user.
        quiet: bool,
        /// Who stopped this turn on purpose, when someone did.
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<TurnAction>,
    },
    Failed {
        message: String,
    },
    Removed {
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<TurnAction>,
    },
    SessionEnded {
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<TurnAction>,
    },
}

/// A deliberate intervention, as opposed to a Session stopping by itself.
/// Whoever waits on the Session reads this to tell "someone decided this"
/// from a failure worth retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TurnAction {
    pub by: TurnActor,
    pub kind: TurnActionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnActor {
    User,
    /// A Buddy, which acts for the user.
    Buddy,
    /// A Working Agent directing a Session it has an edge to.
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnActionKind {
    /// Stopped the turn.
    Cancel,
    /// Stopped the turn so a waiting prompt runs now; the Session carries on.
    Interrupt,
    /// Took a queued message out before it was read.
    Remove,
    /// Closed or deleted the Session.
    EndSession,
}

impl TurnAction {
    pub fn user(kind: TurnActionKind) -> Self {
        Self {
            by: TurnActor::User,
            kind,
        }
    }

    pub fn buddy(kind: TurnActionKind) -> Self {
        Self {
            by: TurnActor::Buddy,
            kind,
        }
    }

    /// What an Agent waiting on this Session should be told.
    pub fn notice(self) -> String {
        let who = match self.by {
            TurnActor::User => "The user",
            TurnActor::Buddy => "The user's Buddy",
            TurnActor::Agent => "Another Agent in this Task",
        };
        let what = match self.kind {
            TurnActionKind::Cancel => "stopped this Session",
            TurnActionKind::Interrupt => "interrupted this Session",
            TurnActionKind::Remove => {
                "removed the message from this Session's queue before it was read"
            }
            TurnActionKind::EndSession => "closed this Session",
        };
        format!(
            "{who} {what} on purpose. This was a deliberate decision, not a failure: do not \
             retry it or work around it. Ask the user if you need direction."
        )
    }
}

/// Whether a stop reason means the turn was stopped rather than finished.
pub fn is_stop_reason(stop_reason: &str) -> bool {
    let lowered = stop_reason.to_ascii_lowercase();
    lowered.contains("cancel") || lowered == "killed"
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnForm {
    pub request_id: String,
    pub message: String,
    pub fields: Vec<TurnFormField>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnFormField {
    pub name: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: TurnFormFieldKind,
    pub options: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnFormFieldKind {
    Text,
    Integer,
    Number,
    Boolean,
    StringArray,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TargetMode {
    Chat { chat_id: String },
    Terminal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionInfo {
    pub description: String,
    pub options: Vec<PermissionOptionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOptionInfo {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

/// Lossless in-process Radio subscription. Each subscriber has its own
/// ordered queue; a slow built-in consumer does not make the publisher drop
/// events globally.
pub struct Subscription {
    receiver: mpsc::UnboundedReceiver<RadioEvent>,
}

impl Subscription {
    pub async fn recv(&mut self) -> Option<RadioEvent> {
        self.receiver.recv().await
    }
}

static INTERNAL_SUBSCRIBERS: Lazy<Mutex<Vec<mpsc::UnboundedSender<RadioEvent>>>> =
    Lazy::new(|| Mutex::new(Vec::new()));

/// Bounded broadcast remains available for plugin integrations, whose
/// subscriptions are external and may choose lossy backpressure semantics.
static PLUGIN_EVENTS: Lazy<broadcast::Sender<RadioEvent>> = Lazy::new(|| {
    let (sender, _) = broadcast::channel(64);
    sender
});

/// Publish one Grove event to all built-in and plugin subscribers.
pub fn publish(event: RadioEvent) {
    if let Ok(mut subscribers) = INTERNAL_SUBSCRIBERS.lock() {
        subscribers.retain(|sender| sender.send(event.clone()).is_ok());
    }
    let _ = PLUGIN_EVENTS.send(event);
}

/// Subscribe to the ordered, lossless in-process stream.
pub fn subscribe() -> Subscription {
    let (sender, receiver) = mpsc::unbounded_channel();
    INTERNAL_SUBSCRIBERS.lock().unwrap().push(sender);
    Subscription { receiver }
}

/// Subscribe to the bounded stream intended for plugins.
pub fn subscribe_plugins() -> broadcast::Receiver<RadioEvent> {
    PLUGIN_EVENTS.subscribe()
}
