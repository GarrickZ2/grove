//! Delegations observe ACP turns; they do not weaken Agent Graph authority.
//! Watchers are process-local, like Agent Graph runtime state. Restart preserves
//! the last observed row; explicit send/cancel resumes management, never replay.
use crate::acp::{self, AcpUpdate, QueuedConfig};
use crate::error::{GroveError, Result};
use crate::storage::{
    buddies::{self as db, Buddy, Delegation, DelegationStatus as Status},
    custom_agent, database, tasks,
};
use chrono::Utc;
use once_cell::sync::Lazy;
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

struct WatchedRound {
    abort: tokio::task::AbortHandle,
    status: Status,
    revision: u64,
}
#[derive(Default)]
struct Watchers {
    latest: String,
    rounds: HashMap<String, WatchedRound>,
}
static WATCHERS: Lazy<Mutex<HashMap<String, Watchers>>> = Lazy::new(Mutex::default);

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    #[serde(rename = "self")]
    ThisBuddy,
    Task {
        project: String,
        task: String,
    },
    NewTask {
        project: String,
        name: String,
        notes: Option<String>,
    },
}
#[derive(Debug, Deserialize, JsonSchema)]
pub struct DelegateInput {
    pub title: String,
    pub brief: String,
    pub target: Target,
}

pub async fn delegate(
    buddy: &Buddy,
    from_session: &str,
    input: DelegateInput,
) -> Result<Delegation> {
    if input.title.trim().is_empty() || input.brief.trim().is_empty() {
        return Err(GroveError::invalid_data("title and brief are required"));
    }
    db::ensure_session_writable(from_session)?;
    let persona = custom_agent::get(&buddy.custom_agent_id)?
        .ok_or_else(|| GroveError::storage("Missing Buddy persona"))?;
    let (project, task) = match input.target {
        Target::ThisBuddy => (buddy.project_hash.clone(), tasks::LOCAL_TASK_ID.into()),
        Target::Task { project, task } => {
            tasks::get_task(&project, &task)?
                .ok_or_else(|| GroveError::not_found("Task not found"))?;
            (project, task)
        }
        Target::NewTask {
            project,
            name,
            notes,
        } => {
            let task = super::tools::create_task(buddy, &project, name, notes)?;
            (project, task.id)
        }
    };
    let now = Utc::now();
    let delegation = Delegation {
        id: uuid::Uuid::new_v4().to_string(),
        buddy_id: buddy.id.clone(),
        from_session: from_session.into(),
        target_project: project.clone(),
        target_task: task.clone(),
        target_session: tasks::generate_chat_id(),
        title: input.title,
        brief: input.brief,
        status: Status::Running,
        last_result: None,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
        completed_at: None,
    };
    {
        let conn = database::connection();
        let tx = conn.unchecked_transaction()?;
        // Store the base Agent, never the live Buddy persona. Runtime settings
        // are applied with the first prompt and persisted by ordinary ACP.
        tasks::add_chat_session_on(
            &tx,
            &project,
            &task,
            tasks::ChatSession {
                id: delegation.target_session.clone(),
                title: delegation.title.clone(),
                agent: persona.base_agent.clone(),
                acp_session_id: None,
                created_at: now,
                duty: None,
                launch_mode: "acp".into(),
            },
        )?;
        db::insert_delegation(&tx, &delegation)?;
        tx.commit()?;
    }
    if let Err(error) = send_round(buddy, &delegation, &delegation.brief, Some(&persona)).await {
        change(
            &delegation,
            Status::Running,
            Status::Failed,
            Some(&error.to_string()),
        )?;
        return Err(error);
    }
    get(&buddy.id, &delegation.id)
}

pub fn get(buddy: &str, id: &str) -> Result<Delegation> {
    db::get_delegation(&database::connection(), buddy, id)?
        .ok_or_else(|| GroveError::not_found("Delegation not found"))
}

fn change(d: &Delegation, expected: Status, next: Status, text: Option<&str>) -> Result<bool> {
    db::update_delegation_status(
        &database::connection(),
        &d.buddy_id,
        &d.id,
        expected,
        next,
        text,
    )
}

fn inherited_config(
    persona: &custom_agent::CustomAgent,
    handle: &acp::AcpSessionHandle,
) -> QueuedConfig {
    persona.agent_config.queued_config().unwrap_or_else(|| {
        let mut config = handle.snapshot_config();
        if persona.model.is_some() {
            config.model = persona.model.clone();
        }
        if persona.mode.is_some() {
            config.mode = persona.mode.clone();
        }
        if persona.effort.is_some() {
            config.thought_level = persona.effort.clone();
        }
        config
    })
}

pub async fn send_round(
    buddy: &Buddy,
    delegation: &Delegation,
    text: &str,
    persona: Option<&custom_agent::CustomAgent>,
) -> Result<String> {
    let _gate = super::lock(&format!("delegation:{}", delegation.id)).await;
    let previous = get(&buddy.id, &delegation.id)?;
    if previous.status == Status::Cancelled {
        return Err(GroveError::invalid_data("Delegation was cancelled"));
    }
    let (handle, _activity) = crate::agent_graph::tools::ensure_target_handle(
        &previous.target_project,
        &previous.target_task,
        &previous.target_session,
    )
    .await
    .map_err(|e| GroveError::storage(e.to_string()))?;
    handle
        .wait_until_ready(crate::agent_graph::tools::ACP_SESSION_READY_TIMEOUT)
        .await
        .map_err(GroveError::storage)?;
    // Subscription precedes delivery, including the fastest mock/real Agent.
    let rx = handle.subscribe();
    let mut message = super::tools::prompt(buddy, text, json!({"delegation_id":previous.id}));
    if let Some(persona) = persona {
        message.config = Some(inherited_config(persona, &handle));
    }
    let message_id = message.id.clone();
    change(&previous, previous.status, Status::Running, None)?;
    if let Err(error) = crate::agent_graph::tools::deliver_prompt(&handle, message).await {
        change(
            &previous,
            Status::Running,
            previous.status,
            previous.last_result.as_deref(),
        )?;
        return Err(GroveError::storage(error.to_string()));
    }
    let id = previous.id.clone();
    let generation = message_id.clone();
    let task = tokio::spawn(watch(previous, generation.clone(), rx));
    let mut watchers = WATCHERS.lock().unwrap();
    let entry = watchers.entry(id).or_default();
    entry.latest = generation.clone();
    entry.rounds.insert(
        generation,
        WatchedRound {
            abort: task.abort_handle(),
            status: Status::Running,
            revision: 0,
        },
    );
    Ok(message_id)
}

/// A pure observer state machine, testable without a real Agent or network.
struct Round {
    message_id: String,
    started: bool,
    observing_turn: bool,
    finished: bool,
    waiting: HashSet<String>,
    text: String,
    messages: acp::v2_messages::Messages,
}
impl Round {
    fn new(message_id: String) -> Self {
        Self {
            message_id,
            started: false,
            observing_turn: false,
            finished: false,
            waiting: HashSet::new(),
            text: String::new(),
            messages: Default::default(),
        }
    }
    fn start(&mut self) {
        self.started = true;
        self.observing_turn = true;
        self.text.clear();
        self.messages = Default::default();
        self.waiting.retain(|key| !key.starts_with("form:"));
    }
    fn observe(&mut self, update: AcpUpdate) -> Option<Status> {
        if self.finished {
            return None;
        }
        if let AcpUpdate::PromptStarted { message_ids } = &update {
            if !message_ids.contains(&self.message_id) {
                self.observing_turn = false;
                return None;
            }
        }
        let next = match update {
            AcpUpdate::PromptStarted { message_ids } if message_ids.contains(&self.message_id) => {
                self.start();
                Some(Status::Running)
            }
            AcpUpdate::UserMessage {
                client_message_id, ..
            } if client_message_id.as_deref() == Some(&self.message_id) && !self.observing_turn => {
                self.start();
                Some(Status::Running)
            }
            AcpUpdate::UserMessage { sender, .. }
                if self.started && self.waiting.iter().any(|key| key.starts_with("form:")) =>
            {
                // A Buddy follow-up has its own observer. A human's form
                // answer continues this round; do not track the same turn twice.
                if sender
                    .as_deref()
                    .is_some_and(|sender| sender.starts_with("buddy:"))
                {
                    self.finished = true;
                    None
                } else {
                    self.start();
                    Some(Status::Running)
                }
            }
            AcpUpdate::SessionEnded => {
                self.text = "Agent Session ended".into();
                Some(Status::Failed)
            }
            AcpUpdate::PromptFailed { message_ids, .. }
                if message_ids.contains(&self.message_id) && self.waiting.contains("auth") =>
            {
                self.observing_turn = false;
                None
            }
            // Config/middleware rejection can precede PromptStarted. Match
            // its input identity, while authentication remains a waiting state.
            AcpUpdate::PromptFailed {
                message_ids,
                message,
            } if message_ids.contains(&self.message_id) && !self.waiting.contains("auth") => {
                self.text = message;
                Some(Status::Failed)
            }
            AcpUpdate::Error { message } if self.observing_turn => {
                self.text = message;
                Some(Status::Failed)
            }
            AcpUpdate::PromptCompleted {
                message_ids,
                stop_reason,
            } if message_ids.contains(&self.message_id) && stop_reason.contains("cancel") => {
                Some(Status::Cancelled)
            }
            AcpUpdate::Complete { stop_reason, .. } if self.observing_turn => {
                if stop_reason.contains("cancel") {
                    Some(Status::Cancelled)
                } else if self.waiting.is_empty() {
                    Some(Status::Done)
                } else {
                    if self.waiting.iter().any(|key| key.starts_with("form:")) {
                        self.observing_turn = false;
                    }
                    None
                }
            }
            AcpUpdate::AskForm { form_id, .. } if self.observing_turn => {
                self.waiting.insert(format!("form:{form_id}"));
                Some(Status::Waiting)
            }
            AcpUpdate::PermissionRequest { id, .. } if self.observing_turn => {
                self.waiting.insert(format!("permission:{id}"));
                Some(Status::Waiting)
            }
            AcpUpdate::ElicitationRequest { snapshot } if self.observing_turn => {
                self.waiting
                    .insert(format!("elicitation:{}", snapshot.request_id));
                Some(Status::Waiting)
            }
            AcpUpdate::AuthRequired { .. } | AcpUpdate::AuthFailed { .. }
                if self.observing_turn =>
            {
                self.waiting.insert("auth".into());
                Some(Status::Waiting)
            }
            AcpUpdate::PermissionResponse { id, .. } if self.started => {
                self.waiting.remove(&format!("permission:{id}"));
                Some(if self.waiting.is_empty() {
                    Status::Running
                } else {
                    Status::Waiting
                })
            }
            AcpUpdate::ElicitationResolved { request_id, .. } if self.started => {
                self.waiting.remove(&format!("elicitation:{request_id}"));
                Some(if self.waiting.is_empty() {
                    Status::Running
                } else {
                    Status::Waiting
                })
            }
            AcpUpdate::AuthSucceeded if self.started => {
                self.waiting.remove("auth");
                Some(if self.waiting.is_empty() {
                    Status::Running
                } else {
                    Status::Waiting
                })
            }
            AcpUpdate::MessageChunk { text, .. } if self.observing_turn => {
                append_bounded(&mut self.text, &text);
                None
            }
            AcpUpdate::V2MessageUpdate { update } if self.observing_turn => {
                self.messages.apply(&update);
                self.text.clear();
                for message in self
                    .messages
                    .entries()
                    .iter()
                    .filter(|m| m.kind == acp::v2_messages::MessageKind::Agent)
                {
                    for block in &message.content {
                        if let agent_client_protocol::schema::v2::ContentBlock::Text(text) = block {
                            append_bounded(&mut self.text, &text.text);
                        }
                    }
                }
                None
            }
            _ => None,
        };
        if matches!(
            next,
            Some(Status::Done | Status::Failed | Status::Cancelled)
        ) {
            self.finished = true;
        }
        next
    }
}
fn append_bounded(target: &mut String, text: &str) {
    let mut end = text
        .len()
        .min((16 * 1024usize).saturating_sub(target.len()));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&text[..end]);
}

async fn watch(
    delegation: Delegation,
    message_id: String,
    mut rx: tokio::sync::broadcast::Receiver<AcpUpdate>,
) {
    let mut round = Round::new(message_id.clone());
    loop {
        let update = match rx.recv().await {
            Ok(update) => update,
            Err(_) => AcpUpdate::SessionEnded,
        };
        let observed = round.observe(update);
        if let Some(status) = observed {
            let revision = {
                let _gate = super::lock(&format!("delegation:{}", delegation.id)).await;
                let Ok(current) = get(&delegation.buddy_id, &delegation.id) else {
                    remove_round(&delegation.id, &message_id);
                    return;
                };
                if current.status == Status::Cancelled {
                    remove_round(&delegation.id, &message_id);
                    return;
                }
                let mut watchers = WATCHERS.lock().unwrap();
                let Some(entry) = watchers.get_mut(&delegation.id) else {
                    return;
                };
                let Some(watched) = entry.rounds.get_mut(&message_id) else {
                    return;
                };
                if watched.status == status {
                    None
                } else {
                    watched.status = status;
                    watched.revision += 1;
                    // Earlier queued rounds still return their results, but
                    // cannot mark the latest accepted round done/failed.
                    if entry.latest == message_id {
                        if let Err(error) =
                            change(&current, current.status, status, Some(&round.text))
                        {
                            eprintln!("[Buddy] Delegation update failed: {error}");
                            return;
                        }
                    }
                    Some(watched.revision)
                }
            };
            if let Some(revision) = revision {
                if matches!(
                    status,
                    Status::Waiting | Status::Done | Status::Failed | Status::Cancelled
                ) {
                    let d = delegation.clone();
                    let id = message_id.clone();
                    let text = round.text.clone();
                    // Never block event consumption on a cold Buddy startup.
                    tokio::spawn(async move {
                        if let Err(error) = notify(&d, &id, revision, status, &text).await {
                            eprintln!("[Buddy] Result notification failed: {error}");
                        }
                        if status != Status::Waiting {
                            remove_round(&d.id, &id);
                        }
                    });
                }
            }
        }
        if round.finished {
            if observed.is_none() {
                remove_round(&delegation.id, &message_id);
            }
            break;
        }
    }
}

fn remove_round(delegation: &str, message: &str) {
    let mut watchers = WATCHERS.lock().unwrap();
    if let Some(entry) = watchers.get_mut(delegation) {
        entry.rounds.remove(message);
        if entry.rounds.is_empty() {
            watchers.remove(delegation);
        }
    }
}

pub(crate) async fn active_handle(
    buddy_id: &str,
) -> Result<(Buddy, Arc<acp::AcpSessionHandle>, acp::ActivityGuard)> {
    loop {
        let buddy = super::get(buddy_id)?;
        let session = buddy
            .active_session_id
            .as_deref()
            .ok_or_else(|| GroveError::storage("Missing active Segment"))?;
        let result = crate::agent_graph::tools::ensure_target_handle(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            session,
        )
        .await;
        if super::get(buddy_id)?.active_session_id != buddy.active_session_id {
            continue;
        }
        let (handle, activity) = result.map_err(|e| GroveError::storage(e.to_string()))?;
        handle
            .wait_until_ready(crate::agent_graph::tools::ACP_SESSION_READY_TIMEOUT)
            .await
            .map_err(GroveError::storage)?;
        return Ok((buddy, handle, activity));
    }
}
fn notification_current(delegation: &str, message: &str, revision: u64, status: Status) -> bool {
    WATCHERS
        .lock()
        .unwrap()
        .get(delegation)
        .and_then(|entry| entry.rounds.get(message))
        .is_some_and(|round| round.revision == revision && round.status == status)
}

async fn notify(
    d: &Delegation,
    message_id: &str,
    revision: u64,
    status: Status,
    text: &str,
) -> Result<()> {
    if !notification_current(&d.id, message_id, revision, status) {
        return Ok(());
    }
    let (buddy, handle, _activity) = active_handle(&d.buddy_id).await?;
    let _gate = super::lock(&format!("delegation:{}", d.id)).await;
    if !notification_current(&d.id, message_id, revision, status) {
        return Ok(());
    }
    let metadata = json!({"delegation_id":d.id,"target_session":d.target_session,"message_id":message_id,"status":status});
    let message = super::tools::prompt(
        &buddy,
        &format!(
            "Delegation {}: {}\n{}",
            d.title,
            serde_json::to_string(&status)?,
            text
        ),
        metadata,
    );
    crate::agent_graph::tools::deliver_prompt(&handle, message)
        .await
        .map_err(|e| GroveError::storage(e.to_string()))
}

pub async fn cancel(buddy: &str, id: &str) -> Result<Delegation> {
    let _gate = super::lock(&format!("delegation:{id}")).await;
    let delegation = get(buddy, id)?;
    if !matches!(delegation.status, Status::Running | Status::Waiting) {
        return Ok(delegation);
    }
    let key = format!(
        "{}:{}:{}",
        delegation.target_project, delegation.target_task, delegation.target_session
    );
    if let Some(handle) = acp::get_session_handle(&key) {
        handle.dequeue_messages_by_sender(&format!("buddy:{buddy}"));
        handle.cancel().await?;
    }
    change(&delegation, delegation.status, Status::Cancelled, None)?;
    if let Some(watchers) = WATCHERS.lock().unwrap().remove(id) {
        for watcher in watchers.rounds.into_values() {
            watcher.abort.abort();
        }
    }
    get(buddy, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::buddies::test_support::{delegation, seed_buddy, Store};
    fn complete(reason: &str) -> AcpUpdate {
        AcpUpdate::Complete {
            stop_reason: reason.into(),
            usage: None,
            start_ts: None,
            end_ts: None,
            cost: None,
        }
    }
    fn started(id: &str) -> AcpUpdate {
        AcpUpdate::PromptStarted {
            message_ids: vec![id.into()],
        }
    }
    #[test]
    fn rounds_correlate_identity_and_do_not_overwrite_terminal_states() {
        let mut round = Round::new("mine".into());
        assert_eq!(round.observe(started("previous")), None);
        assert_eq!(round.observe(complete("end_turn")), None);
        assert_eq!(round.observe(started("mine")), Some(Status::Running));
        round.observe(AcpUpdate::MessageChunk {
            message_id: None,
            text: "result".into(),
        });
        assert_eq!(round.observe(complete("end_turn")), Some(Status::Done));
        assert_eq!(round.text, "result");
        assert_eq!(round.observe(complete("end_turn")), None);
        let mut failed = Round::new("mine".into());
        failed.observe(started("mine"));
        assert_eq!(
            failed.observe(AcpUpdate::Error {
                message: "broken".into()
            }),
            Some(Status::Failed)
        );
        assert_eq!(failed.observe(complete("end_turn")), None);
        let mut cancelled = Round::new("mine".into());
        cancelled.observe(started("mine"));
        assert_eq!(
            cancelled.observe(complete("cancelled")),
            Some(Status::Cancelled)
        );
        assert_eq!(cancelled.observe(complete("end_turn")), None);
    }
    #[test]
    fn pre_start_rejection_is_failed_but_authentication_stays_waiting() {
        let mut round = Round::new("mine".into());
        let rejection = |id: &str| AcpUpdate::PromptFailed {
            message_ids: vec![id.into()],
            message: "Configuration rejected".into(),
        };
        assert_eq!(round.observe(rejection("another")), None);
        assert_eq!(round.observe(rejection("mine")), Some(Status::Failed));
        assert_eq!(round.observe(started("mine")), None);
        let mut round = Round::new("mine".into());
        round.observe(started("mine"));
        assert_eq!(
            round.observe(AcpUpdate::AuthRequired {
                methods: Vec::new(),
                agent_name: None
            }),
            Some(Status::Waiting)
        );
        assert_eq!(round.observe(rejection("mine")), None);
        assert!(!round.finished);
        assert_eq!(
            round.observe(AcpUpdate::AuthSucceeded),
            Some(Status::Running)
        );
    }

    #[test]
    fn foreign_turn_events_cannot_complete_an_auth_waiting_round() {
        let mut round = Round::new("mine".into());
        round.observe(started("mine"));
        round.observe(AcpUpdate::AuthRequired {
            methods: Vec::new(),
            agent_name: None,
        });
        round.observe(AcpUpdate::AuthSucceeded);
        round.observe(started("someone-else"));
        assert_eq!(
            round.observe(AcpUpdate::MessageChunk {
                message_id: None,
                text: "unrelated".into()
            }),
            None
        );
        assert_eq!(round.observe(complete("end_turn")), None);
        assert_eq!(
            round.observe(AcpUpdate::Error {
                message: "unrelated error".into()
            }),
            None
        );
        assert!(round.text.is_empty());
        assert!(!round.finished);
        round.observe(started("mine"));
        assert_eq!(round.observe(complete("end_turn")), Some(Status::Done));
    }

    #[test]
    fn form_completion_stays_waiting_until_user_input_and_bounds_utf8() {
        let mut round = Round::new("mine".into());
        round.observe(started("mine"));
        let form: crate::agent_graph::ask_form::AskFormInput =
            serde_json::from_value(json!({"title":"Choose","questions":[]})).unwrap();
        assert_eq!(
            round.observe(AcpUpdate::AskForm {
                form_id: "form".into(),
                definition: form
            }),
            Some(Status::Waiting)
        );
        assert_eq!(round.observe(complete("end_turn")), None);
        assert_eq!(
            round.observe(AcpUpdate::Error {
                message: "another queued input was rejected".into()
            }),
            None
        );
        assert!(!round.finished);
        let message: AcpUpdate =
            serde_json::from_value(json!({"type":"user_message","text":"answer"})).unwrap();
        assert_eq!(round.observe(message), Some(Status::Running));
        round.observe(AcpUpdate::MessageChunk {
            message_id: None,
            text: "界".repeat(10000),
        });
        assert!(round.text.len() <= 16 * 1024);
        assert_eq!(round.observe(complete("end_turn")), Some(Status::Done));
    }
    #[test]
    fn multiple_pending_permissions_are_resolved_individually() {
        let mut round = Round::new("mine".into());
        round.observe(started("mine"));
        for id in ["one", "two"] {
            assert_eq!(
                round.observe(AcpUpdate::PermissionRequest {
                    id: id.into(),
                    title: None,
                    detail: None,
                    description: "allow".into(),
                    options: Vec::new()
                }),
                Some(Status::Waiting)
            );
        }
        assert_eq!(
            round.observe(AcpUpdate::PermissionResponse {
                id: "one".into(),
                option_id: "yes".into()
            }),
            Some(Status::Waiting)
        );
        assert_eq!(round.observe(complete("end_turn")), None);
        assert_eq!(
            round.observe(AcpUpdate::PermissionResponse {
                id: "two".into(),
                option_id: "yes".into()
            }),
            Some(Status::Running)
        );
        assert_eq!(round.observe(complete("end_turn")), Some(Status::Done));
    }
    #[tokio::test]
    async fn quick_result_is_recorded_and_notified_to_current_segment() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, delegation) = {
            let conn = database::connection();
            let buddy = seed_buddy(&conn, "watch");
            let delegation = delegation(&conn, &buddy, "work");
            db::insert_delegation(&conn, &delegation).unwrap();
            (buddy, delegation)
        };
        let target_key = format!(
            "{}:{}:{}",
            delegation.target_project, delegation.target_task, delegation.target_session
        );
        let (target, _, _target_guard) = acp::new_handle_for_test(
            &target_key,
            &delegation.target_project,
            &delegation.target_task,
            &delegation.target_session,
        );
        let message_id = send_round(&buddy, &delegation, "do work", None)
            .await
            .unwrap();
        let current = super::super::switch_on(
            &database::connection(),
            &buddy,
            "codex-acp",
            Default::default(),
        )
        .unwrap();
        let chat = current.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", current.project_hash);
        let (_, mut results, _buddy_guard) =
            acp::new_handle_for_test(&key, &current.project_hash, tasks::LOCAL_TASK_ID, chat);
        target.emit(started(&message_id));
        target.emit(AcpUpdate::MessageChunk {
            message_id: None,
            text: "finished".into(),
        });
        target.emit(complete("end_turn"));
        let text = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let AcpUpdate::UserMessage { text, .. } = results.recv().await.unwrap() {
                    break text;
                }
            }
        })
        .await
        .unwrap();
        assert!(text.contains("\"delegation_id\":\"work\""));
        assert!(text.contains("finished"));
        let stored = get(&buddy.id, &delegation.id).unwrap();
        assert_eq!(stored.status, Status::Done);
        assert_eq!(stored.last_result.as_deref(), Some("finished"));
    }
    #[tokio::test]
    async fn restart_keeps_observed_status_until_explicit_cancel() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "restart");
        let delegation = {
            let conn = database::connection();
            let d = delegation(&conn, &buddy, "orphan");
            db::insert_delegation(&conn, &d).unwrap();
            d
        };
        assert_eq!(
            get(&buddy.id, &delegation.id).unwrap().status,
            Status::Running
        );
        assert_eq!(
            cancel(&buddy.id, &delegation.id).await.unwrap().status,
            Status::Cancelled
        );
        assert!(get(&buddy.id, &delegation.id)
            .unwrap()
            .last_result
            .is_none());
    }
    #[tokio::test]
    async fn queued_followups_keep_each_result_without_finishing_the_latest_early() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "queued-rounds");
        let d = delegation(&database::connection(), &buddy, "queued-work");
        db::insert_delegation(&database::connection(), &d).unwrap();
        let key = format!(
            "{}:{}:{}",
            d.target_project, d.target_task, d.target_session
        );
        let (target, _, _target_guard) =
            acp::new_handle_for_test(&key, &d.target_project, &d.target_task, &d.target_session);
        target
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (owner, _, _owner_guard) =
            acp::new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        owner
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let first = send_round(&buddy, &d, "first", None).await.unwrap();
        let second = send_round(&buddy, &d, "second", None).await.unwrap();
        for (id, text, count) in [(&first, "first result", 1), (&second, "second result", 2)] {
            target.emit(started(id));
            target.emit(AcpUpdate::MessageChunk {
                message_id: None,
                text: text.into(),
            });
            target.emit(complete("end_turn"));
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while owner.get_queue().len() < count {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(owner
                .get_queue()
                .iter()
                .any(|message| message.text.contains(text)));
            assert_eq!(
                get(&buddy.id, &d.id).unwrap().status,
                if count == 1 {
                    Status::Running
                } else {
                    Status::Done
                }
            );
        }
        assert_eq!(
            get(&buddy.id, &d.id).unwrap().last_result.as_deref(),
            Some("second result")
        );
    }
}
