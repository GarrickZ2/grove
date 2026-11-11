//! Chat state the CLI builds from server messages.
//!
//! Live WebSocket frames and `/history` events share one JSON shape (the
//! server's `ServerMessage`), so both go through [`Session::apply`]. The CLI
//! reads that JSON leniently: an unknown type or field is ignored rather than
//! failing, so a newer server never breaks an older CLI.

use std::collections::HashMap;
use std::time::Instant;

use serde_json::Value;

use super::form::{Form, Source};
use crate::acp::v2_messages::{MessageKind, Messages};

#[derive(Debug, Clone, PartialEq)]
pub enum ToolStatus {
    Pending,
    Running,
    Done,
    Failed,
}

impl ToolStatus {
    fn parse(raw: &str) -> Self {
        match raw {
            "completed" | "complete" | "done" | "success" => Self::Done,
            "failed" | "error" | "cancelled" | "canceled" => Self::Failed,
            "in_progress" | "running" => Self::Running,
            _ => Self::Pending,
        }
    }

    pub fn settled(&self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
}

#[derive(Debug, Clone)]
pub struct Diff {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone)]
pub struct Tool {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: ToolStatus,
    pub inputs: Vec<(String, String)>,
    pub diffs: Vec<Diff>,
    pub output: String,
    pub terminal_ids: Vec<String>,
    pub locations: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PlanEntry {
    pub content: String,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone)]
pub enum Block {
    User {
        text: String,
        sender: Option<String>,
    },
    Agent {
        id: Option<String>,
        text: String,
    },
    Thought {
        id: Option<String>,
        text: String,
    },
    Tool(Tool),
    Plan(Vec<PlanEntry>),
    Notice {
        level: Level,
        text: String,
    },
    TurnEnd {
        interrupted: bool,
        seconds: Option<i64>,
        tokens: Option<u64>,
    },
    Shell {
        command: String,
        output: String,
        exit_code: Option<i32>,
    },
    /// A delegated sub-agent's run, reported once it stops working.
    Subagent {
        title: String,
        status: String,
        preview: String,
    },
    /// A message between agents (agent graph send/reply).
    Exchange {
        id: String,
        sender: Option<String>,
        recipient: Option<String>,
        text: String,
    },
    /// A document the agent produced, such as a plan-mode plan.
    Document {
        title: String,
        text: String,
    },
}

#[derive(Debug, Clone)]
pub struct PermOption {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct Permission {
    pub id: String,
    pub title: String,
    pub description: String,
    pub detail: Option<String>,
    pub options: Vec<PermOption>,
}

#[derive(Debug, Clone)]
pub struct Choice {
    pub id: String,
    pub name: String,
}

/// Agent-advertised session settings, from `session_ready` and later updates.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub modes: Vec<Choice>,
    pub current_mode: Option<String>,
    pub models: Vec<Choice>,
    pub current_model: Option<String>,
    /// Config id of the agent's "model" select option, when it exposes the
    /// model that way (then changes go through `set_config_option`).
    pub model_config: Option<String>,
    /// Config id of the agent's "mode" select option, when it exposes the
    /// mode that way (then the legacy `set_mode` is refused).
    pub mode_config: Option<String>,
    /// Thinking effort levels ("thought levels") the agent offers.
    pub thought_levels: Vec<Choice>,
    pub current_thought: Option<String>,
    pub thought_config: Option<String>,
}

impl Settings {
    pub fn mode_name(&self) -> Option<String> {
        let id = self.current_mode.as_ref()?;
        Some(
            self.modes
                .iter()
                .find(|mode| &mode.id == id)
                .map(|mode| mode.name.clone())
                .unwrap_or_else(|| id.clone()),
        )
    }

    pub fn model_name(&self) -> Option<String> {
        let id = self.current_model.as_ref()?;
        Some(
            self.models
                .iter()
                .find(|model| &model.id == id)
                .map(|model| model.name.clone())
                .unwrap_or_else(|| id.clone()),
        )
    }

    pub fn thought_name(&self) -> Option<String> {
        let id = self.current_thought.as_ref()?;
        Some(
            self.thought_levels
                .iter()
                .find(|level| &level.id == id)
                .map(|level| level.name.clone())
                .unwrap_or_else(|| id.clone()),
        )
    }
}

/// A slash command the agent itself provides (e.g. `/compact`).
#[derive(Debug, Clone)]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Subagent {
    pub session_id: String,
    pub title: String,
    pub state: String,
    pub preview: String,
    /// The preview is the child's own text (appended to as it streams), not
    /// a tool title.
    preview_is_text: bool,
    /// Whether this run's end is already in the transcript.
    pub reported: bool,
}

impl Subagent {
    pub fn working(&self) -> bool {
        matches!(self.state.as_str(), "running" | "requires_action")
    }

    pub fn status(&self) -> &'static str {
        match self.state.as_str() {
            "running" => "Running",
            "requires_action" => "Needs your input",
            "idle" => "Idle",
            "_completed" => "Completed",
            "_failed" => "Failed",
            "_cancelled" => "Cancelled",
            _ => "Status unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Queued {
    pub id: String,
    pub text: String,
}

#[derive(Default)]
pub struct Session {
    pub blocks: Vec<Block>,
    pub settings: Settings,
    pub ready: bool,
    pub busy: bool,
    pub busy_since: Option<Instant>,
    pub turn_tokens: u64,
    pub permission: Option<Permission>,
    pub queue: Vec<Queued>,
    pub plan: Vec<PlanEntry>,
    pub context: Option<(u64, u64)>,
    pub phase: Option<String>,
    /// Session owned by another Grove process; this view is read-only.
    pub remote_owner: Option<String>,
    pub ended: bool,
    pub auth_required: Option<String>,
    /// Open questions from the agent, oldest first; the UI asks the first.
    pub forms: Vec<Form>,
    pub subagents: Vec<Subagent>,
    pub compacting: bool,
    /// Latest plan document (title, text) and whether it changed since it
    /// was last put in the transcript.
    pub plan_doc: Option<(String, String)>,
    plan_doc_dirty: bool,
    pub agent_commands: Vec<AgentCommand>,
    v2: Messages,
    tool_index: HashMap<String, usize>,
    terminals: HashMap<String, String>,
}

/// The server's `type` tag for a message, if any.
pub fn kind(value: &Value) -> &str {
    value.get("type").and_then(Value::as_str).unwrap_or("")
}

fn s(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn choices(value: Option<&Value>) -> Vec<Choice> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(Choice {
                        id: s(item, "id")?,
                        name: s(item, "name").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Text inside an ACP content block (`{"type":"text","text":…}`), or a short
/// placeholder for media.
fn content_text(block: &Value) -> String {
    match kind(block) {
        "text" => s(block, "text").unwrap_or_default(),
        "image" => "[image]".into(),
        "audio" => "[audio]".into(),
        "resource_link" => format!("[{}]", s(block, "uri").unwrap_or_default()),
        "resource" => block
            .get("resource")
            .and_then(|r| r.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| "[resource]".into()),
        _ => String::new(),
    }
}

impl Session {
    fn push(&mut self, block: Block) {
        self.blocks.push(block);
    }

    fn agent_block(&mut self, id: Option<String>, thought: bool) -> &mut String {
        let matches = |block: &Block| match (block, thought) {
            (Block::Agent { id: block_id, .. }, false)
            | (Block::Thought { id: block_id, .. }, true) => id.is_none() || block_id == &id,
            _ => false,
        };
        // Keep appending to the latest block of the same kind while nothing
        // else has been emitted after it.
        let reuse = self.blocks.last().is_some_and(matches);
        if !reuse {
            self.blocks.push(if thought {
                Block::Thought {
                    id: id.clone(),
                    text: String::new(),
                }
            } else {
                Block::Agent {
                    id: id.clone(),
                    text: String::new(),
                }
            });
        }
        match self.blocks.last_mut() {
            Some(Block::Agent { text, .. }) | Some(Block::Thought { text, .. }) => text,
            _ => unreachable!(),
        }
    }

    fn set_message_text(&mut self, id: &str, thought: bool, full: String) {
        let found = self.blocks.iter_mut().rev().find_map(|block| match block {
            Block::Agent {
                id: Some(block_id),
                text,
            } if !thought && block_id == id => Some(text),
            Block::Thought {
                id: Some(block_id),
                text,
            } if thought && block_id == id => Some(text),
            _ => None,
        });
        match found {
            Some(text) => *text = full,
            None => {
                let id = Some(id.to_string());
                self.push(if thought {
                    Block::Thought { id, text: full }
                } else {
                    Block::Agent { id, text: full }
                });
            }
        }
    }

    fn tool_mut(&mut self, id: &str) -> &mut Tool {
        let index = match self.tool_index.get(id) {
            Some(&index) => index,
            None => {
                self.push(Block::Tool(Tool {
                    id: id.to_string(),
                    title: String::new(),
                    kind: String::new(),
                    status: ToolStatus::Pending,
                    inputs: Vec::new(),
                    diffs: Vec::new(),
                    output: String::new(),
                    terminal_ids: Vec::new(),
                    locations: Vec::new(),
                }));
                let index = self.blocks.len() - 1;
                self.tool_index.insert(id.to_string(), index);
                index
            }
        };
        match &mut self.blocks[index] {
            Block::Tool(tool) => tool,
            _ => unreachable!(),
        }
    }

    /// Merge one tool-call frame (v1 snake_case or v2 camelCase) into its block.
    fn apply_tool(&mut self, value: &Value) {
        let Some(id) = s(value, "id").or_else(|| s(value, "toolCallId")) else {
            return;
        };
        let terminals = self.terminals.clone();
        let tool = self.tool_mut(&id);
        if let Some(title) = s(value, "title").filter(|t| !t.is_empty()) {
            tool.title = title;
        }
        if tool.title.is_empty() {
            if let Some(name) = s(value, "name") {
                tool.title = name;
            }
        }
        if let Some(kind) = s(value, "kind") {
            tool.kind = kind;
        }
        if let Some(status) = s(value, "status") {
            tool.status = ToolStatus::parse(&status);
        }
        if let Some(inputs) = value.get("input").and_then(Value::as_array) {
            tool.inputs = inputs
                .iter()
                .filter_map(|item| Some((s(item, "label")?, s(item, "value")?)))
                .collect();
        }
        if let Some(locations) = value.get("locations").and_then(Value::as_array) {
            let replace = value
                .get("locations_replace")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let mut next: Vec<String> = locations
                .iter()
                .filter_map(|loc| {
                    let path = s(loc, "path")?;
                    Some(match loc.get("line").and_then(Value::as_u64) {
                        Some(line) => format!("{path}:{line}"),
                        None => path,
                    })
                })
                .collect();
            if replace {
                tool.locations = next;
            } else {
                tool.locations.append(&mut next);
            }
        }
        // v1: `output`; v2: `content`. Both are lists of tool content items.
        let items = value
            .get("output")
            .or_else(|| value.get("content").filter(|c| c.is_array()))
            .and_then(Value::as_array);
        if let Some(items) = items {
            tool.diffs.clear();
            let mut text = String::new();
            for item in items {
                match kind(item) {
                    "diff" => tool.diffs.push(Diff {
                        path: s(item, "path").unwrap_or_default(),
                        old_text: s(item, "old_text")
                            .or_else(|| s(item, "oldText"))
                            .unwrap_or_default(),
                        new_text: s(item, "new_text")
                            .or_else(|| s(item, "newText"))
                            .unwrap_or_default(),
                    }),
                    "content" => {
                        if let Some(block) = item.get("content") {
                            text.push_str(&content_text(block));
                        }
                    }
                    "terminal" => {
                        let terminal_id = s(item, "terminal_id")
                            .or_else(|| s(item, "terminalId"))
                            .unwrap_or_default();
                        if let Some(output) =
                            s(item, "output").or_else(|| terminals.get(&terminal_id).cloned())
                        {
                            text.push_str(&output);
                        }
                        if !tool.terminal_ids.contains(&terminal_id) {
                            tool.terminal_ids.push(terminal_id);
                        }
                    }
                    _ => {}
                }
            }
            tool.output = text;
        } else if let Some(content) = s(value, "content") {
            // v1 summary string.
            tool.output = content;
        }
    }

    fn apply_v2_message(&mut self, update: &Value) {
        let Ok(typed) = serde_json::from_value::<agent_client_protocol::v2::schema::SessionUpdate>(
            update.clone(),
        ) else {
            return;
        };
        self.v2.apply(&typed);
        let id = s(update, "messageId");
        let thought =
            s(update, "sessionUpdate").is_some_and(|tag| tag.starts_with("agent_thought"));
        let user = s(update, "sessionUpdate").is_some_and(|tag| tag.starts_with("user_message"));
        let (Some(id), false) = (id, user) else {
            return;
        };
        let kind = if thought {
            MessageKind::Thought
        } else {
            MessageKind::Agent
        };
        let full: String = self
            .v2
            .entries()
            .iter()
            .find(|message| message.kind == kind && message.id == id)
            .map(|message| {
                message
                    .content
                    .iter()
                    .filter_map(|block| serde_json::to_value(block).ok())
                    .map(|block| content_text(&block))
                    .collect()
            })
            .unwrap_or_default();
        self.set_message_text(&id, thought, full);
    }

    fn end_turn(&mut self, interrupted: bool, value: &Value) {
        let seconds = match (
            value.get("start_ts").and_then(Value::as_i64),
            value.get("end_ts").and_then(Value::as_i64),
        ) {
            (Some(start), Some(end)) if end >= start => Some((end - start) / 1000),
            _ => self
                .busy_since
                .map(|since| since.elapsed().as_secs() as i64),
        };
        let tokens = value
            .get("usage")
            .and_then(|usage| {
                usage
                    .get("output_tokens")
                    .or_else(|| usage.get("outputTokens"))
            })
            .and_then(Value::as_u64);
        // Anything still running when the turn ends will not finish.
        for block in &mut self.blocks {
            if let Block::Tool(tool) = block {
                if !tool.status.settled() {
                    tool.status = if interrupted {
                        ToolStatus::Failed
                    } else {
                        ToolStatus::Done
                    };
                }
            }
        }
        if !self.plan.is_empty() {
            let plan = std::mem::take(&mut self.plan);
            self.push(Block::Plan(plan));
        }
        self.flush_plan_doc();
        self.push(Block::TurnEnd {
            interrupted,
            seconds,
            tokens,
        });
        self.busy = false;
        self.busy_since = None;
        self.permission = None;
        self.compacting = false;
        // An elicitation belongs to the turn that asked it; an `ask_form` is
        // answered by the next prompt, so it outlives the turn.
        self.forms.retain(|form| !form.is_elicitation());
        // Tool ids are only unique within a turn; some agents reuse them.
        self.tool_index.clear();
    }

    /// Put a changed plan document into the transcript, so it can be read
    /// before approving it.
    fn flush_plan_doc(&mut self) {
        if !self.plan_doc_dirty {
            return;
        }
        self.plan_doc_dirty = false;
        if let Some((title, text)) = self.plan_doc.clone() {
            self.push(Block::Document { title, text });
        }
    }

    fn set_plan_doc(&mut self, title: String, text: String) {
        if self.plan_doc.as_ref() != Some(&(title.clone(), text.clone())) {
            self.plan_doc = Some((title, text));
            self.plan_doc_dirty = true;
        }
    }

    fn subagent_mut(&mut self, session_id: &str) -> Option<&mut Subagent> {
        self.subagents
            .iter_mut()
            .find(|sub| sub.session_id == session_id)
    }

    fn apply_subagent_update(&mut self, value: &Value) {
        let (Some(id), Some(parent)) = (s(value, "session_id"), s(value, "parent_session_id"))
        else {
            return;
        };
        if id == parent {
            return;
        }
        let state = value
            .get("state")
            .and_then(|state| state.get("state"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if self.subagent_mut(&id).is_none() {
            // A reconnect snapshot of a finished child is not new activity.
            let snapshot = value.get("snapshot").and_then(Value::as_bool) == Some(true);
            let live = matches!(state.as_deref(), Some("running" | "requires_action"));
            if snapshot && !live {
                return;
            }
            self.subagents.push(Subagent {
                session_id: id.clone(),
                title: String::new(),
                state: String::new(),
                preview: String::new(),
                preview_is_text: false,
                reported: false,
            });
        }
        let description = s(value, "description");
        let Some(sub) = self.subagent_mut(&id) else {
            return;
        };
        if let Some(title) = s(value, "title").filter(|t| !t.is_empty()) {
            sub.title = title;
        }
        if sub.preview.is_empty() {
            if let Some(description) = description {
                sub.preview = description;
            }
        }
        if let Some(state) = state {
            sub.state = state;
        }
        if sub.working() {
            sub.reported = false;
            return;
        }
        if sub.reported || sub.state.is_empty() {
            return;
        }
        sub.reported = true;
        let block = Block::Subagent {
            title: if sub.title.is_empty() {
                "Sub-agent".into()
            } else {
                sub.title.clone()
            },
            status: sub.status().into(),
            preview: sub.preview.clone(),
        };
        self.push(block);
    }

    /// An event from inside a sub-agent. Requests that need the user are
    /// lifted to the top level (they are answered by id, like the parent's);
    /// the rest only feed the sub-agent's one-line preview.
    fn apply_subagent_event(&mut self, value: &Value) {
        let (Some(id), Some(event)) = (s(value, "session_id"), value.get("event")) else {
            return;
        };
        let title = self
            .subagent_mut(&id)
            .map(|sub| sub.title.clone())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Sub-agent".into());
        match kind(event) {
            "subagent_event" => {}
            "permission_request" => {
                self.apply(event);
                // The server usually names the child already.
                if let Some(permission) = self
                    .permission
                    .as_mut()
                    .filter(|p| !p.title.contains(&title))
                {
                    permission.title = format!("{title} · {}", permission.title);
                }
            }
            "elicitation_request" => {
                self.apply(event);
                if let Some(form) = self
                    .forms
                    .iter_mut()
                    .find(|form| s(event, "request_id").as_deref() == Some(form.id.as_str()))
                {
                    form.asker = Some(title);
                }
            }
            "permission_response"
            | "elicitation_resolved"
            | "elicitation_validation_error"
            | "elicitation_complete" => self.apply(event),
            other => {
                let preview = match other {
                    "message_chunk" => s(event, "text"),
                    "tool_call" | "tool_call_update" => s(event, "title"),
                    "v2_tool_update" => event.get("update").and_then(|u| s(u, "title")),
                    "v2_message_update" => event
                        .get("update")
                        .and_then(|u| u.get("content"))
                        .and_then(|c| s(c, "text")),
                    _ => None,
                };
                let Some(preview) = preview else { return };
                let Some(sub) = self.subagent_mut(&id) else {
                    return;
                };
                if other == "message_chunk" || other == "v2_message_update" {
                    if !sub.preview_is_text {
                        sub.preview.clear();
                        sub.preview_is_text = true;
                    }
                    sub.preview.push_str(&preview);
                } else {
                    sub.preview = preview;
                    sub.preview_is_text = false;
                }
                // Keep only the latest line, short.
                let last = sub
                    .preview
                    .lines()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                sub.preview = last
                    .chars()
                    .rev()
                    .take(180)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
        }
    }

    fn apply_exchange(&mut self, value: &Value) {
        let Some(id) = s(value, "id") else { return };
        let text: Option<String> = value.get("content").map(|content| {
            content
                .as_array()
                .map(|blocks| blocks.iter().map(content_text).collect())
                .unwrap_or_default()
        });
        let append = value.get("append").and_then(Value::as_bool) == Some(true);
        let sender = s(value, "sender");
        let recipient = s(value, "recipient");
        let existing = self.blocks.iter_mut().rev().find_map(|block| match block {
            Block::Exchange {
                id: block_id,
                sender: block_sender,
                recipient: block_recipient,
                text: block_text,
            } if *block_id == id => Some((block_sender, block_recipient, block_text)),
            _ => None,
        });
        match existing {
            Some((block_sender, block_recipient, block_text)) => {
                if sender.is_some() {
                    *block_sender = sender;
                }
                if recipient.is_some() {
                    *block_recipient = recipient;
                }
                if let Some(text) = text {
                    if append {
                        block_text.push_str(&text);
                    } else {
                        *block_text = text;
                    }
                }
            }
            None => self.push(Block::Exchange {
                id,
                sender,
                recipient,
                text: text.unwrap_or_default(),
            }),
        }
    }

    fn apply_plan_document(&mut self, plan: &Value) {
        match kind(plan) {
            "items" => {
                self.plan = plan_entries(plan.get("entries"));
            }
            "markdown" => {
                self.set_plan_doc("Plan".into(), s(plan, "content").unwrap_or_default());
            }
            "file" => {
                let uri = s(plan, "uri").unwrap_or_default();
                self.set_plan_doc("Plan".into(), format!("Plan saved to {uri}"));
            }
            _ => {}
        }
    }

    fn apply_thought_levels(
        &mut self,
        available: Option<&Value>,
        current: Option<String>,
        config: Option<String>,
    ) {
        let levels = choices(available);
        if !levels.is_empty() {
            self.settings.thought_levels = levels;
        }
        if current.is_some() {
            self.settings.current_thought = current;
        }
        if config.is_some() {
            self.settings.thought_config = config;
        }
    }

    /// Fold one server message into the session.
    pub fn apply(&mut self, value: &Value) {
        match kind(value) {
            "session_ready" => {
                self.ready = true;
                self.phase = None;
                self.auth_required = None;
                let mut settings = Settings {
                    modes: choices(value.get("available_modes")),
                    current_mode: s(value, "current_mode_id"),
                    models: choices(value.get("available_models")),
                    current_model: s(value, "current_model_id"),
                    model_config: None,
                    mode_config: None,
                    thought_levels: choices(value.get("available_thought_levels")),
                    current_thought: s(value, "current_thought_level_id"),
                    thought_config: s(value, "thought_level_config_id"),
                };
                if let Some(options) = value.get("config_options").and_then(Value::as_array) {
                    apply_config_options(&mut settings, options);
                }
                self.settings = settings;
                // A fresh agent process has no running sub-agents.
                self.subagents.clear();
            }
            "thought_levels_update" => self.apply_thought_levels(
                value.get("available"),
                s(value, "current"),
                s(value, "config_id"),
            ),
            "available_commands" => {
                self.agent_commands = value
                    .get("commands")
                    .and_then(Value::as_array)
                    .map(|commands| {
                        commands
                            .iter()
                            .filter_map(|command| {
                                Some(AgentCommand {
                                    name: s(command, "name")?.trim_start_matches('/').to_string(),
                                    description: s(command, "description").unwrap_or_default(),
                                    hint: s(command, "input_hint").filter(|h| !h.is_empty()),
                                })
                            })
                            .filter(|command| !command.name.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
            }
            "config_option_error" => {
                let config = s(value, "config_id").unwrap_or_default();
                let what = if Some(&config) == self.settings.model_config.as_ref() {
                    "the model".to_string()
                } else if Some(&config) == self.settings.thought_config.as_ref() {
                    "the thinking effort".to_string()
                } else {
                    format!("“{config}”")
                };
                self.push(Block::Notice {
                    level: Level::Error,
                    text: format!(
                        "Could not change {what}: {}",
                        s(value, "message").unwrap_or_default()
                    ),
                });
            }
            "config_options_update" => {
                if let Some(options) = value.get("config_options").and_then(Value::as_array) {
                    apply_config_options(&mut self.settings, options);
                }
            }
            "mode_changed" => self.settings.current_mode = s(value, "mode_id"),
            "model_changed" => self.settings.current_model = s(value, "model_id"),
            "connect_phase" => self.phase = s(value, "phase"),
            "busy" => {
                let busy = value.get("value").and_then(Value::as_bool).unwrap_or(false);
                if busy && !self.busy {
                    self.busy_since = Some(Instant::now());
                    self.turn_tokens = 0;
                }
                self.busy = busy;
                if !busy {
                    self.compacting = false;
                }
            }
            "user_message" => {
                if value.get("terminal").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                self.push(Block::User {
                    text: readable_user_text(&s(value, "text").unwrap_or_default()),
                    sender: s(value, "sender"),
                });
            }
            "message_chunk" => {
                let text = s(value, "text").unwrap_or_default();
                self.turn_tokens += (text.len() / 4) as u64;
                self.agent_block(s(value, "message_id"), false)
                    .push_str(&text);
            }
            "message_content_chunk" => {
                let text = value.get("content").map(content_text).unwrap_or_default();
                self.agent_block(s(value, "message_id"), false)
                    .push_str(&text);
            }
            "thought_chunk" => {
                let text = s(value, "text").unwrap_or_default();
                self.agent_block(s(value, "message_id"), true)
                    .push_str(&text);
            }
            "v2_message_update" => {
                if let Some(update) = value.get("update") {
                    self.apply_v2_message(update);
                }
            }
            "tool_call" | "tool_call_update" => self.apply_tool(value),
            "v2_tool_update" => {
                if let Some(update) = value.get("update") {
                    if s(update, "sessionUpdate").as_deref() == Some("tool_call_content_chunk") {
                        if let (Some(id), Some(content)) =
                            (s(update, "toolCallId"), update.get("content"))
                        {
                            let mut frame = serde_json::json!({ "toolCallId": id });
                            frame["content"] = Value::Array(vec![content.clone()]);
                            // A chunk appends rather than replaces.
                            let before = self.tool_mut(&id).output.clone();
                            self.apply_tool(&frame);
                            let tool = self.tool_mut(&id);
                            tool.output = before + &tool.output;
                        }
                    } else {
                        self.apply_tool(update);
                    }
                }
            }
            "terminal_output_update" => {
                let id = s(value, "terminal_id").unwrap_or_default();
                let output = s(value, "output").unwrap_or_default();
                self.terminals.insert(id.clone(), output.clone());
                for block in &mut self.blocks {
                    if let Block::Tool(tool) = block {
                        if tool.terminal_ids.contains(&id) {
                            tool.output = output.clone();
                        }
                    }
                }
            }
            "plan_update" => self.plan = plan_entries(value.get("entries")),
            "plan_document_update" => {
                if let Some(plan) = value.get("plan") {
                    self.apply_plan_document(plan);
                }
            }
            "plan_file_update" => {
                let path = s(value, "path").unwrap_or_default();
                match s(value, "content") {
                    Some(content) => {
                        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
                        self.set_plan_doc(format!("Plan · {name}"), content);
                    }
                    None => {
                        self.plan_doc = None;
                        self.plan_doc_dirty = false;
                    }
                }
            }
            "plan_document_removed" => {
                self.plan_doc = None;
                self.plan_doc_dirty = false;
            }
            "subagent_update" => self.apply_subagent_update(value),
            "subagent_event" => self.apply_subagent_event(value),
            "session_message" => self.apply_exchange(value),
            "compaction_update" => match s(value, "status").as_deref() {
                Some("in_progress") => self.compacting = true,
                Some("completed") => {
                    self.compacting = false;
                    self.push(Block::Notice {
                        level: Level::Info,
                        text: "Context compacted".into(),
                    });
                }
                Some("failed") => {
                    self.compacting = false;
                    let error = s(value, "error");
                    self.push(Block::Notice {
                        level: Level::Warn,
                        text: match error {
                            Some(error) => format!("Context compaction failed: {error}"),
                            None => "Context compaction failed".into(),
                        },
                    });
                }
                _ => self.compacting = false,
            },
            "ask_form" => {
                if let Some(form) = Form::from_ask_form(value) {
                    if !self.forms.iter().any(|f| f.id == form.id) {
                        self.forms.push(form);
                    }
                }
            }
            "elicitation_request" => {
                if let Some(mut form) = Form::from_elicitation(value) {
                    match self.forms.iter_mut().find(|f| f.id == form.id) {
                        Some(existing) => {
                            if let (Source::Url { opened, .. }, Source::Url { opened: was, .. }) =
                                (&mut form.source, &existing.source)
                            {
                                *opened |= *was;
                            }
                            form.asker = existing.asker.take();
                            *existing = form;
                        }
                        None => self.forms.push(form),
                    }
                }
            }
            "elicitation_resolved" => {
                let id = s(value, "request_id");
                let accepted = s(value, "action").as_deref() == Some("accept");
                self.forms.retain_mut(|form| {
                    if Some(&form.id) != id.as_ref() {
                        return true;
                    }
                    // Accepting a URL request means "opened"; the agent then
                    // waits for the page and sends `elicitation_complete`.
                    match &mut form.source {
                        Source::Url { opened, .. } if accepted => {
                            *opened = true;
                            true
                        }
                        _ => false,
                    }
                });
            }
            "elicitation_validation_error" => {
                let id = s(value, "request_id");
                if let Some(form) = self.forms.iter_mut().find(|f| Some(&f.id) == id.as_ref()) {
                    form.error = s(value, "message");
                }
            }
            "elicitation_complete" => {
                let id = s(value, "elicitation_id");
                self.forms
                    .retain(|form| id.is_none() || form.elicitation_id != id);
            }
            "permission_request" => {
                // Show a plan-mode plan before asking to approve it.
                self.flush_plan_doc();
                self.permission = Some(Permission {
                    id: s(value, "id").unwrap_or_default(),
                    title: s(value, "title").unwrap_or_else(|| "Permission".into()),
                    description: s(value, "description").unwrap_or_default(),
                    detail: s(value, "detail"),
                    options: value
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| {
                                    Some(PermOption {
                                        id: s(option, "option_id")?,
                                        name: s(option, "name").unwrap_or_default(),
                                        kind: s(option, "kind").unwrap_or_default(),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                });
            }
            "permission_response" => {
                let id = s(value, "id");
                if self.permission.as_ref().map(|p| &p.id) == id.as_ref() {
                    self.permission = None;
                }
            }
            "complete" => self.end_turn(false, value),
            "turn_interrupted" => self.end_turn(true, value),
            "prompt_failed" | "input_rejected" => self.push(Block::Notice {
                level: Level::Error,
                text: s(value, "message").unwrap_or_default(),
            }),
            "error" => {
                self.push(Block::Notice {
                    level: Level::Error,
                    text: s(value, "message").unwrap_or_default(),
                });
            }
            "session_notice" => {
                let level = match s(value, "severity").as_deref() {
                    Some("error") => Level::Error,
                    Some("warning") | Some("warn") => Level::Warn,
                    _ => Level::Info,
                };
                let mut text = s(value, "title").unwrap_or_default();
                if let Some(description) = s(value, "description") {
                    text = format!("{text} — {description}");
                }
                self.push(Block::Notice { level, text });
            }
            "queue_update" => {
                self.queue = value
                    .get("messages")
                    .and_then(Value::as_array)
                    .map(|messages| {
                        messages
                            .iter()
                            .map(|message| Queued {
                                id: s(message, "id").unwrap_or_default(),
                                text: readable_user_text(&s(message, "text").unwrap_or_default()),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            }
            "usage_update" => {
                if let (Some(used), Some(size)) = (
                    value.get("used").and_then(Value::as_u64),
                    value.get("size").and_then(Value::as_u64),
                ) {
                    self.context = Some((used, size));
                }
            }
            "terminal_execute" => self.push(Block::Shell {
                command: s(value, "command").unwrap_or_default(),
                output: String::new(),
                exit_code: None,
            }),
            "terminal_chunk" => {
                if let Some(Block::Shell { output, .. }) = self.blocks.last_mut() {
                    output.push_str(&s(value, "output").unwrap_or_default());
                }
            }
            "terminal_complete" => {
                if let Some(Block::Shell { exit_code, .. }) = self.blocks.last_mut() {
                    *exit_code = value
                        .get("exit_code")
                        .and_then(Value::as_i64)
                        .map(|c| c as i32);
                }
            }
            "remote_session" => {
                self.remote_owner = Some(s(value, "agent_name").unwrap_or_default());
            }
            "auth_required" => {
                self.auth_required =
                    Some(s(value, "agent_name").unwrap_or_else(|| "The agent".into()));
            }
            "auth_succeeded" => self.auth_required = None,
            "auth_failed" => self.push(Block::Notice {
                level: Level::Error,
                text: format!(
                    "Sign-in failed: {}",
                    s(value, "message").unwrap_or_default()
                ),
            }),
            "auth_logged_out" => self.push(Block::Notice {
                level: Level::Info,
                text: "Signed out of the agent".into(),
            }),
            // Bookkeeping the terminal view has no use for: message-id
            // binding and timing (the web UI uses them for optimistic
            // bubbles), queue edits (the CLI only removes queued messages) and the
            // compaction summary text (the CLI only reports that it happened).
            "prompt_started"
            | "prompt_completed"
            | "user_message_time"
            | "v2_message_bind"
            | "queue_edit_result"
            | "queue_message_gone"
            | "compaction_summary_chunk" => {}
            "session_ended" => self.ended = true,
            _ => {}
        }
    }

    /// Whether block `index` can no longer change and may move to scrollback.
    pub fn settled(&self, index: usize) -> bool {
        match &self.blocks[index] {
            Block::Agent { .. } | Block::Thought { .. } => {
                index + 1 < self.blocks.len() || !self.busy
            }
            Block::Tool(tool) => tool.status.settled() || !self.busy,
            Block::Shell { exit_code, .. } => exit_code.is_some() || !self.busy,
            Block::Exchange { .. } => index + 1 < self.blocks.len() || !self.busy,
            _ => true,
        }
    }

    /// History replays leave a permission open only if the session is live.
    pub fn finish_replay(&mut self, live: bool, busy: bool) {
        if !live {
            self.permission = None;
            self.forms.retain(|form| !form.is_elicitation());
            self.subagents.clear();
        }
        self.busy = busy;
        if busy {
            self.busy_since = Some(Instant::now());
        }
    }
}

/// Replace `<grove-meta>{…}</grove-meta>` envelopes in a user message with a
/// short chip, as the web chat does. Grove's own session bootstrap is hidden;
/// a malformed envelope stays as typed so user text never disappears.
fn readable_user_text(raw: &str) -> String {
    const OPEN: &str = "<grove-meta>";
    const CLOSE: &str = "</grove-meta>";
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(end) = after.find(CLOSE) else { break };
        let Ok(envelope) = serde_json::from_str::<Value>(after[..end].trim()) else {
            out.push_str(&rest[..start + OPEN.len()]);
            rest = after;
            continue;
        };
        out.push_str(&rest[..start]);
        let kind = s(&envelope, "type").unwrap_or_default();
        // Mentioned Buddies are already named in the text.
        if kind != "grove_session_init" && kind != "buddy_mentions" {
            let data = envelope.get("data").cloned().unwrap_or_default();
            let label = ["name", "title", "label", "path", "sender_name"]
                .iter()
                .find_map(|key| s(&data, key))
                .unwrap_or_else(|| kind.replace('_', " "));
            out.push_str(&format!("⟨{label}⟩"));
        }
        rest = &after[end + CLOSE.len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn plan_entries(value: Option<&Value>) -> Vec<PlanEntry> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|entry| PlanEntry {
                    content: s(entry, "content").unwrap_or_default(),
                    status: s(entry, "status").unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read the agent's model, mode and thinking choices from its config options
/// (ACP select options), matching categories as the web chat does.
fn apply_config_options(settings: &mut Settings, options: &[Value]) {
    for option in options {
        let category = s(option, "category").unwrap_or_default().to_lowercase();
        let Some(id) = s(option, "id") else { continue };
        let mut choices = Vec::new();
        collect_select_options(option.get("options"), &mut choices);
        let current = s(option, "currentValue");
        let (list, value, config) = match category.as_str() {
            "model" => (
                &mut settings.models,
                &mut settings.current_model,
                &mut settings.model_config,
            ),
            "mode" => (
                &mut settings.modes,
                &mut settings.current_mode,
                &mut settings.mode_config,
            ),
            "thought_level" | "thoughtlevel" | "effort" => (
                &mut settings.thought_levels,
                &mut settings.current_thought,
                &mut settings.thought_config,
            ),
            _ => continue,
        };
        if !choices.is_empty() {
            *list = choices;
        }
        if current.is_some() {
            *value = current;
        }
        *config = Some(id);
    }
}

/// Flatten ACP select options, which may be grouped.
fn collect_select_options(value: Option<&Value>, out: &mut Vec<Choice>) {
    let Some(items) = value.and_then(Value::as_array) else {
        return;
    };
    for item in items {
        if let Some(value) = s(item, "value") {
            out.push(Choice {
                id: value,
                name: s(item, "name").unwrap_or_default(),
            });
        } else {
            collect_select_options(item.get("options"), out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn v1_stream_builds_blocks_and_settles_on_complete() {
        let mut session = Session::default();
        session.apply(&json!({"type":"busy","value":true}));
        session.apply(&json!({"type":"user_message","text":"hi"}));
        session.apply(&json!({"type":"message_chunk","text":"Hel"}));
        session.apply(&json!({"type":"message_chunk","text":"lo"}));
        session.apply(
            &json!({"type":"tool_call","id":"t1","title":"Read a.rs","status":"in_progress"}),
        );
        assert!(session.settled(1), "agent text settles once a tool follows");
        assert!(!session.settled(2), "running tool stays live");
        session.apply(&json!({"type":"tool_call_update","id":"t1","status":"completed","locations":[],"locations_replace":true}));
        session.apply(&json!({"type":"complete","stop_reason":"end_turn"}));
        assert!(matches!(&session.blocks[1], Block::Agent { text, .. } if text == "Hello"));
        assert!(matches!(&session.blocks[2], Block::Tool(tool) if tool.status == ToolStatus::Done));
        assert!(matches!(
            session.blocks.last(),
            Some(Block::TurnEnd {
                interrupted: false,
                ..
            })
        ));
        assert!(!session.busy);

        // A later turn reusing the tool id gets its own block.
        session
            .apply(&json!({"type":"tool_call","id":"t1","title":"Read b.rs","status":"completed"}));
        assert!(
            matches!(session.blocks.last(), Some(Block::Tool(tool)) if tool.title == "Read b.rs")
        );
    }

    #[test]
    fn diff_output_is_kept() {
        let mut session = Session::default();
        session.apply(&json!({"type":"tool_call","id":"e","title":"Edit","status":"completed",
            "output":[{"type":"diff","path":"a.rs","old_text":"a","new_text":"b","display_text":""}]}));
        let Block::Tool(tool) = &session.blocks[0] else {
            panic!()
        };
        assert_eq!(tool.diffs[0].new_text, "b");
    }

    #[test]
    fn permission_round_trip() {
        let mut session = Session::default();
        session.apply(
            &json!({"type":"permission_request","id":"p","description":"Run ls",
            "options":[{"option_id":"allow","name":"Allow","kind":"allow_once"}]}),
        );
        assert_eq!(session.permission.as_ref().unwrap().options.len(), 1);
        session.apply(&json!({"type":"permission_response","id":"p","option_id":"allow"}));
        assert!(session.permission.is_none());
    }

    #[test]
    fn grove_meta_is_hidden_or_chipped() {
        let init = r#"<grove-meta>{"v":1,"type":"grove_session_init","data":{},"system-prompt":"x"}</grove-meta>

hello"#;
        assert_eq!(readable_user_text(init), "hello");
        let mention = r#"see <grove-meta>{"v":1,"type":"file","data":{"path":"a.rs"},"system-prompt":"x"}</grove-meta>"#;
        assert_eq!(readable_user_text(mention), "see ⟨a.rs⟩");
        let mentions = r#"<grove-meta>{"v":1,"type":"buddy_mentions","data":{},"system-prompt":"x"}</grove-meta>
@Jack hi"#;
        assert_eq!(readable_user_text(mentions), "@Jack hi");
        let review = r#"<grove-meta>{"v":1,"type":"review_comment","data":{},"system-prompt":"x"}</grove-meta>"#;
        assert_eq!(readable_user_text(review), "⟨review comment⟩");
        assert_eq!(
            readable_user_text("<grove-meta>not json</grove-meta>"),
            "<grove-meta>not json</grove-meta>"
        );
    }

    #[test]
    fn forms_open_and_close_like_the_web_chat() {
        let mut session = Session::default();
        session.apply(&json!({"type":"busy","value":true}));
        session.apply(
            &json!({"type":"ask_form","form_id":"f","definition":{"title":"T",
            "questions":[{"type":"text","id":"q","title":"Q"}]}}),
        );
        session.apply(
            &json!({"type":"ask_form","form_id":"f","definition":{"title":"T",
            "questions":[{"type":"text","id":"q","title":"Q"}]}}),
        );
        session.apply(
            &json!({"type":"elicitation_request","request_id":"e","agent_name":"A",
            "request":{"mode":"url","message":"m","url":"https://x","elicitationId":"eid"}}),
        );
        assert_eq!(session.forms.len(), 2, "duplicate ask_form is merged");
        session.apply(&json!({"type":"elicitation_resolved","request_id":"e","action":"accept"}));
        assert!(matches!(
            session.forms[1].source,
            Source::Url { opened: true, .. }
        ));
        session.apply(&json!({"type":"elicitation_complete","elicitation_id":"eid"}));
        assert_eq!(session.forms.len(), 1);
        session.apply(&json!({"type":"complete","stop_reason":"end_turn"}));
        assert_eq!(session.forms.len(), 1, "ask_form outlives the turn");
    }

    #[test]
    fn subagent_requests_reach_the_top_level() {
        let mut session = Session::default();
        session.apply(
            &json!({"type":"subagent_update","session_id":"c","parent_session_id":"p",
            "title":"Reviewer","state":{"state":"running"}}),
        );
        session.apply(&json!({"type":"subagent_event","session_id":"c",
            "event":{"type":"tool_call","id":"t","title":"Read a.rs"}}));
        assert_eq!(session.subagents[0].preview, "Read a.rs");
        session.apply(&json!({"type":"subagent_event","session_id":"c",
            "event":{"type":"permission_request","id":"p1","title":"Bash","description":"rm",
                     "options":[{"option_id":"ok","name":"Allow","kind":"allow_once"}]}}));
        assert_eq!(
            session.permission.as_ref().unwrap().title,
            "Reviewer · Bash"
        );
        session.apply(&json!({"type":"subagent_event","session_id":"c",
            "event":{"type":"message_chunk","text":"All tests pass."}}));
        assert_eq!(session.subagents[0].preview, "All tests pass.");
        assert!(
            session.blocks.is_empty(),
            "child tools stay out of the parent transcript"
        );
        session.apply(
            &json!({"type":"subagent_update","session_id":"c","parent_session_id":"p",
            "state":{"state":"_completed"}}),
        );
        assert!(
            matches!(&session.blocks[0], Block::Subagent { status, .. } if status == "Completed")
        );
        // A later snapshot of the same finished child is not reported twice.
        session.apply(
            &json!({"type":"subagent_update","session_id":"c","parent_session_id":"p",
            "snapshot":true,"state":{"state":"_completed"}}),
        );
        assert_eq!(session.blocks.len(), 1);
    }

    #[test]
    fn plan_document_shows_before_its_approval() {
        let mut session = Session::default();
        session.apply(&json!({"type":"plan_document_update",
            "plan":{"type":"markdown","plan_id":"p","content":"1. do it"}}));
        session.apply(
            &json!({"type":"permission_request","id":"x","description":"Exit plan mode",
            "options":[]}),
        );
        assert!(matches!(&session.blocks[0], Block::Document { text, .. } if text == "1. do it"));
        session.apply(&json!({"type":"complete","stop_reason":"end_turn"}));
        assert_eq!(
            session
                .blocks
                .iter()
                .filter(|b| matches!(b, Block::Document { .. }))
                .count(),
            1,
            "an unchanged plan is not repeated"
        );
    }

    #[test]
    fn settings_errors_and_agent_commands() {
        let mut session = Session::default();
        session.apply(
            &json!({"type":"session_ready","agent_name":"A","available_modes":[],
            "available_models":[],"available_thought_levels":[{"id":"hi","name":"High"}],
            "current_thought_level_id":"hi","thought_level_config_id":"effort"}),
        );
        assert_eq!(session.settings.thought_name().as_deref(), Some("High"));
        session.apply(&json!({"type":"config_option_error","config_id":"effort","message":"nope"}));
        assert!(matches!(&session.blocks[0], Block::Notice { text, .. }
            if text == "Could not change the thinking effort: nope"));
        session.apply(&json!({"type":"available_commands","commands":[
            {"name":"/compact","description":"Compact","input_hint":null}]}));
        assert_eq!(session.agent_commands[0].name, "compact");
    }

    #[test]
    fn unknown_messages_are_ignored() {
        let mut session = Session::default();
        session.apply(&json!({"type":"something_new","x":1}));
        session.apply(&json!({"no_type":true}));
        assert!(session.blocks.is_empty());
    }
}
