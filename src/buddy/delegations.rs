//! Follow-ups: Buddy messages whose outcome comes back to the Buddy.
//!
//! Progress is read from Grove's Radio Turn events, never from a Session
//! handle, so it survives the target Agent reconnecting. Rows still open when
//! Grove starts are marked interrupted; Grove never replays a brief.
use crate::acp::{self, QueuedConfig};
use crate::error::{GroveError, Result};
use crate::radio::{RadioEvent, TurnEvent};
use crate::storage::{
    buddies::{self as db, Buddy, Delegation, DelegationStatus as Status},
    custom_agent, database, tasks,
};
use chrono::Utc;
use once_cell::sync::Lazy;
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// In-memory index of open follow-ups by target Session. The database row is
/// authoritative for status; this only routes Radio events cheaply.
struct Tracked {
    buddy_id: String,
    delegation_id: String,
    latest: String,
    /// Rounds still expected to finish, including earlier queued ones.
    pending: HashSet<String>,
    /// ask_form answers arrive as a new user turn; adopt that turn.
    awaiting_form: bool,
}
static TRACKED: Lazy<Mutex<HashMap<String, Vec<Tracked>>>> = Lazy::new(Mutex::default);

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    #[serde(rename = "self")]
    ThisBuddy,
    Task {
        /// Project id from list_projects, or its exact name.
        project: String,
        /// Task id from list_tasks, or its exact name.
        task: String,
    },
    NewTask {
        /// Project id from list_projects, or its exact name.
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
    /// Files sent along with the brief.
    #[serde(skip)]
    #[schemars(skip)]
    pub files: Vec<super::attachments::Outgoing>,
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
            let project = super::tools::resolve_project(&project)?;
            let task = super::tools::resolve_task(&project, &task)?;
            (project, task)
        }
        Target::NewTask {
            project,
            name,
            notes,
        } => {
            let project = super::tools::resolve_project(&project)?;
            let task = super::tools::create_task(buddy, &project, name, notes, &[])?;
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
        round_message_id: None,
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
            },
        )?;
        db::insert_delegation(&tx, &delegation)?;
        tx.commit()?;
    }
    if let Err(error) = send_round(
        buddy,
        &delegation,
        &delegation.brief,
        &input.files,
        Some(&persona),
    )
    .await
    {
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

/// Follow an existing Session: reuse this Buddy's follow-up for it, or start
/// one titled after the Session.
pub async fn follow(
    buddy: &Buddy,
    from_session: &str,
    session: &str,
    text: &str,
    files: &[super::attachments::Outgoing],
) -> Result<(Delegation, String)> {
    if text.trim().is_empty() {
        return Err(GroveError::invalid_data("text is required"));
    }
    super::tools::ensure_not_own_segment(buddy, session)?;
    let existing = db::find_delegation_for_session(&database::connection(), &buddy.id, session)?;
    let delegation = match existing {
        Some(delegation) => delegation,
        None => {
            let (project, task, chat) = tasks::find_chat_session(session)?
                .ok_or_else(|| GroveError::not_found("Session not found"))?;
            let now = Utc::now();
            let delegation = Delegation {
                id: uuid::Uuid::new_v4().to_string(),
                buddy_id: buddy.id.clone(),
                from_session: from_session.into(),
                target_project: project,
                target_task: task,
                target_session: chat.id,
                title: chat.title,
                brief: text.into(),
                status: Status::Running,
                last_result: None,
                created_at: now.to_rfc3339(),
                updated_at: now.to_rfc3339(),
                completed_at: None,
                round_message_id: None,
            };
            db::insert_delegation(&database::connection(), &delegation)?;
            delegation
        }
    };
    let message_id = send_round(buddy, &delegation, text, files, None).await?;
    Ok((get(&buddy.id, &delegation.id)?, message_id))
}

pub async fn send_round(
    buddy: &Buddy,
    delegation: &Delegation,
    text: &str,
    files: &[super::attachments::Outgoing],
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
    let mut message = super::tools::prompt(buddy, text, json!({"delegation_id":previous.id}));
    message.attachments = super::tools::session_attachments(
        &previous.target_project,
        &previous.target_task,
        &previous.target_session,
        files,
    )?;
    if let Some(persona) = persona {
        message.config = Some(inherited_config(persona, &handle));
    }
    let message_id = message.id.clone();
    // Track before delivery so even the fastest Turn event finds its round.
    db::start_delegation_round(
        &database::connection(),
        &buddy.id,
        &previous.id,
        &message_id,
    )?;
    track(&previous, &message_id);
    if let Err(error) = crate::agent_graph::tools::deliver_prompt(&handle, message).await {
        untrack_round(&previous.target_session, &previous.id, &message_id);
        change(
            &get(&buddy.id, &previous.id)?,
            Status::Running,
            previous.status,
            previous.last_result.as_deref(),
        )?;
        return Err(GroveError::storage(error.to_string()));
    }
    Ok(message_id)
}

fn track(d: &Delegation, message_id: &str) {
    let mut tracked = TRACKED.lock().unwrap();
    let entries = tracked.entry(d.target_session.clone()).or_default();
    match entries.iter_mut().find(|t| t.delegation_id == d.id) {
        Some(entry) => {
            entry.latest = message_id.into();
            entry.pending.insert(message_id.into());
            entry.awaiting_form = false;
        }
        None => entries.push(Tracked {
            buddy_id: d.buddy_id.clone(),
            delegation_id: d.id.clone(),
            latest: message_id.into(),
            pending: HashSet::from([message_id.to_owned()]),
            awaiting_form: false,
        }),
    }
}

fn untrack_round(session: &str, delegation: &str, message_id: &str) {
    let mut tracked = TRACKED.lock().unwrap();
    if let Some(entries) = tracked.get_mut(session) {
        for entry in entries.iter_mut().filter(|t| t.delegation_id == delegation) {
            entry.pending.remove(message_id);
        }
        entries.retain(|t| !t.pending.is_empty() || t.awaiting_form);
        if entries.is_empty() {
            tracked.remove(session);
        }
    }
}

fn untrack(session: &str, delegation: &str) {
    let mut tracked = TRACKED.lock().unwrap();
    if let Some(entries) = tracked.get_mut(session) {
        entries.retain(|t| t.delegation_id != delegation);
        if entries.is_empty() {
            tracked.remove(session);
        }
    }
}

/// A waiting request the Buddy may relay or answer.
#[derive(Debug, Clone)]
pub(crate) enum Request {
    Permission {
        request_id: String,
        permission: crate::radio::PermissionInfo,
    },
    Form {
        request_id: String,
        form: crate::radio::TurnForm,
    },
    AskForm {
        form_id: String,
        definition: Value,
    },
}

/// One message for the Buddy about a follow-up.
pub(crate) struct Notice {
    pub buddy_id: String,
    pub delegation_id: String,
    pub message_id: String,
    pub status: Status,
    pub text: String,
    pub request: Option<Request>,
}

/// Fold one Radio event into tracked follow-ups. Persists status changes and
/// returns the notices to deliver; delivery is async and may start the Buddy.
pub(crate) fn observe(event: &RadioEvent) -> Vec<Notice> {
    let RadioEvent::Turn {
        chat_id,
        message_ids,
        event,
        ..
    } = event
    else {
        return Vec::new();
    };
    let mut notices = Vec::new();
    let mut finished = Vec::new();
    {
        let mut tracked = TRACKED.lock().unwrap();
        let Some(entries) = tracked.get_mut(chat_id) else {
            return notices;
        };
        for entry in entries.iter_mut() {
            if entry.awaiting_form && matches!(event, TurnEvent::Started) {
                // The user's form answer starts an untracked turn; it continues
                // this round, so its outcome still belongs to the Buddy.
                if let Some(id) = message_ids.first() {
                    entry.awaiting_form = false;
                    entry.latest = id.clone();
                    entry.pending.extend(message_ids.iter().cloned());
                }
            }
            let round = message_ids
                .iter()
                .find(|id| entry.pending.contains(*id))
                .cloned();
            let round = match (round, event) {
                (Some(round), _) => round,
                (None, TurnEvent::SessionEnded) if !entry.pending.is_empty() => {
                    entry.latest.clone()
                }
                _ => continue,
            };
            let latest = round == entry.latest || message_ids.contains(&entry.latest);
            let (next, text, request) = match event {
                TurnEvent::Started
                | TurnEvent::MessageChunk { .. }
                | TurnEvent::ToolChanged { .. } => (Status::Running, String::new(), None),
                TurnEvent::PermissionRequired {
                    request_id,
                    permission,
                } => (
                    Status::Waiting,
                    String::new(),
                    Some(Request::Permission {
                        request_id: request_id.clone(),
                        permission: permission.clone(),
                    }),
                ),
                TurnEvent::FormRequired { form } => (
                    Status::Waiting,
                    String::new(),
                    Some(Request::Form {
                        request_id: form.request_id.clone(),
                        form: form.clone(),
                    }),
                ),
                TurnEvent::AskFormRequired {
                    form_id,
                    definition,
                } => {
                    entry.awaiting_form = true;
                    (
                        Status::Waiting,
                        String::new(),
                        Some(Request::AskForm {
                            form_id: form_id.clone(),
                            definition: serde_json::to_value(definition).unwrap_or_default(),
                        }),
                    )
                }
                TurnEvent::Completed {
                    stop_reason,
                    message,
                } => {
                    entry.pending.remove(&round);
                    if entry.awaiting_form && latest {
                        // ask_form returns at once; the round waits on the user.
                        continue;
                    }
                    let lowered = stop_reason.to_ascii_lowercase();
                    let status = if lowered.contains("cancel") || lowered == "killed" {
                        Status::Cancelled
                    } else {
                        Status::Done
                    };
                    (status, message.clone(), None)
                }
                TurnEvent::Failed { message } => {
                    entry.pending.remove(&round);
                    (Status::Failed, message.clone(), None)
                }
                TurnEvent::SessionEnded => {
                    entry.pending.clear();
                    entry.awaiting_form = false;
                    (
                        Status::Failed,
                        "The Agent Session ended before finishing.".into(),
                        None,
                    )
                }
                TurnEvent::Removed => {
                    entry.pending.remove(&round);
                    continue;
                }
            };
            let Ok(current) = get(&entry.buddy_id, &entry.delegation_id) else {
                continue;
            };
            if current.status == Status::Cancelled {
                finished.push(entry.delegation_id.clone());
                continue;
            }
            if !latest {
                // An earlier queued round finished: report it, keep waiting.
                if matches!(next, Status::Done | Status::Failed) {
                    notices.push(Notice {
                        buddy_id: entry.buddy_id.clone(),
                        delegation_id: entry.delegation_id.clone(),
                        message_id: round,
                        status: next,
                        text,
                        request: None,
                    });
                }
                continue;
            }
            let terminal = matches!(next, Status::Done | Status::Failed | Status::Cancelled);
            if current.status == next && next == Status::Running {
                continue;
            }
            let stored = if terminal { Some(text.as_str()) } else { None };
            if let Err(error) = change(&current, current.status, next, stored) {
                eprintln!("[Buddy] Follow-up update failed: {error}");
                continue;
            }
            if terminal {
                finished.push(entry.delegation_id.clone());
            }
            if next != Status::Running {
                notices.push(Notice {
                    buddy_id: entry.buddy_id.clone(),
                    delegation_id: entry.delegation_id.clone(),
                    message_id: round,
                    status: next,
                    text,
                    request,
                });
            }
        }
    }
    for delegation in finished {
        untrack(chat_id, &delegation);
    }
    notices
}

fn describe_request(request: &Request) -> String {
    match request {
        Request::Permission {
            request_id,
            permission,
        } => {
            let options = permission
                .options
                .iter()
                .map(|o| format!("{} ({}, option_id {})", o.name, o.kind, o.option_id))
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "Permission request {request_id}: {}\nOptions: {options}",
                permission.description
            )
        }
        Request::Form { request_id, form } => {
            let fields = form
                .fields
                .iter()
                .map(|f| {
                    format!(
                        "{} ({:?}{})",
                        f.name,
                        f.kind,
                        if f.required { ", required" } else { "" }
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "Form request {request_id}: {}\nFields: {fields}",
                form.message
            )
        }
        Request::AskForm {
            form_id,
            definition,
        } => {
            format!("It asked the user a form ({form_id}) and waits for the answer: {definition}")
        }
    }
}

fn request_metadata(request: &Request) -> Value {
    match request {
        Request::Permission {
            request_id,
            permission,
        } => {
            json!({"kind":"permission","request_id":request_id,"permission":permission})
        }
        Request::Form { request_id, form } => {
            json!({"kind":"form","request_id":request_id,"form":form})
        }
        Request::AskForm { form_id, .. } => json!({"kind":"ask_form","request_id":form_id}),
    }
}

/// Deliver one notice to the Buddy's current Segment.
pub(crate) async fn deliver(notice: Notice) -> Result<()> {
    let d = get(&notice.buddy_id, &notice.delegation_id)?;
    // A waiting notice is stale once the round moved on.
    if notice.status == Status::Waiting && d.status != Status::Waiting {
        return Ok(());
    }
    let (buddy, handle, _activity) = active_handle(&notice.buddy_id).await?;
    let _gate = super::lock(&format!("delegation:{}", d.id)).await;
    let mut metadata = json!({"delegation_id":d.id,"target_session":d.target_session,"message_id":notice.message_id,"status":notice.status});
    let mut body = notice.text.clone();
    if let Some(request) = &notice.request {
        metadata["request"] = request_metadata(request);
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&describe_request(request));
    }
    let message = super::tools::prompt(
        &buddy,
        &format!(
            "Follow-up {}: {}\n{}",
            d.title,
            serde_json::to_string(&notice.status)?,
            body
        ),
        metadata,
    );
    crate::agent_graph::tools::deliver_prompt(&handle, message)
        .await
        .map_err(|e| GroveError::storage(e.to_string()))
}

/// Grove restarted: open rounds lost their Agent processes. Mark them so the
/// Buddy and the user see the truth instead of a row stuck in "running".
fn reconcile() -> Result<()> {
    // Bind first: a temporary connection guard would live through the loop.
    let open = db::list_open_delegations(&database::connection())?;
    for d in open {
        let key = format!(
            "{}:{}:{}",
            d.target_project, d.target_task, d.target_session
        );
        match (acp::get_session_handle(&key), d.round_message_id.as_deref()) {
            (Some(_), Some(message_id)) => track(&d, message_id),
            _ => {
                change(
                    &d,
                    d.status,
                    Status::Failed,
                    Some("Interrupted: Grove restarted before this finished. Check the Session and send again if needed."),
                )?;
            }
        }
    }
    Ok(())
}

/// Start following Radio. Call once when the server starts.
pub fn start() {
    if let Err(error) = reconcile() {
        eprintln!("[Buddy] Follow-up reconcile failed: {error}");
    }
    let mut events = crate::radio::subscribe();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            for notice in observe(&event) {
                // Never block event consumption on a cold Buddy startup.
                tokio::spawn(async move {
                    if let Err(error) = deliver(notice).await {
                        eprintln!("[Buddy] Follow-up notification failed: {error}");
                    }
                });
            }
        }
    });
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
#[derive(Debug, Deserialize, JsonSchema)]
pub struct RespondInput {
    /// The waiting Session you follow.
    pub session: String,
    /// request_id from the waiting notice.
    pub request_id: String,
    /// For a permission request: the option to choose. One-time choices only.
    #[serde(default)]
    pub option_id: Option<String>,
    /// For a form request: field values by name.
    #[serde(default)]
    pub fields: Option<HashMap<String, String>>,
    /// For a form request: decline instead of answering.
    #[serde(default)]
    pub decline: bool,
}

/// Answer a waiting request on the user's behalf. Only in Sessions this Buddy
/// follows, only while waiting, and never a standing ("always") permission.
pub fn respond(buddy: &Buddy, input: RespondInput) -> Result<Delegation> {
    let d = db::find_delegation_for_session(&database::connection(), &buddy.id, &input.session)?
        .filter(|d| d.status == Status::Waiting)
        .ok_or_else(|| {
            GroveError::invalid_data(
                "You can only answer requests in Sessions you follow while they are waiting",
            )
        })?;
    let key = format!(
        "{}:{}:{}",
        d.target_project, d.target_task, d.target_session
    );
    let handle = acp::get_session_handle(&key)
        .ok_or_else(|| GroveError::invalid_data("That Session is not running"))?;
    let answered = match input.option_id {
        Some(option_id) => {
            let option = handle
                .pending_permission_option(&input.request_id, &option_id)
                .ok_or_else(|| {
                    GroveError::invalid_data("That request or option is no longer pending")
                })?;
            if option.kind.contains("always") {
                return Err(GroveError::invalid_data(
                    "Standing permissions are the user's call; choose a one-time option or ask the user",
                ));
            }
            if !handle.respond_permission_for(&input.request_id, option_id) {
                return Err(GroveError::invalid_data(
                    "That request is no longer pending",
                ));
            }
            format!("Answered by Buddy: {}", option.name)
        }
        None => {
            handle
                .respond_turn_form(
                    &input.request_id,
                    !input.decline,
                    &input.fields.unwrap_or_default(),
                )
                .map_err(GroveError::invalid_data)?;
            if input.decline {
                "Form declined by Buddy"
            } else {
                "Form answered by Buddy"
            }
            .to_owned()
        }
    };
    change(&d, Status::Waiting, Status::Running, Some(&answered))?;
    get(&buddy.id, &d.id)
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
    untrack(&delegation.target_session, id);
    get(buddy, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{AcpUpdate, PermOptionData};
    use crate::storage::buddies::test_support::{delegation, seed_buddy, Store};
    use std::time::Duration;

    fn started(id: &str) -> AcpUpdate {
        AcpUpdate::PromptStarted {
            message_ids: vec![id.into()],
        }
    }
    fn completed(id: &str, reason: &str) -> AcpUpdate {
        AcpUpdate::PromptCompleted {
            message_ids: vec![id.into()],
            stop_reason: reason.into(),
        }
    }
    fn chunk(text: &str) -> AcpUpdate {
        AcpUpdate::MessageChunk {
            message_id: None,
            text: text.into(),
        }
    }
    /// Feed this test's Radio events to the tracker. Other tests share the bus.
    async fn drain(sub: &mut crate::radio::Subscription, chat: &str) -> Vec<Notice> {
        let mut notices = Vec::new();
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_millis(50), sub.recv()).await
        {
            if matches!(&event, RadioEvent::Turn { chat_id, .. } if chat_id == chat) {
                notices.extend(observe(&event));
            }
        }
        notices
    }
    fn target(d: &Delegation) -> (Arc<acp::AcpSessionHandle>, impl Drop) {
        let key = format!(
            "{}:{}:{}",
            d.target_project, d.target_task, d.target_session
        );
        let (handle, _, guard) =
            acp::new_handle_for_test(&key, &d.target_project, &d.target_task, &d.target_session);
        // Busy: rounds queue, so only the events a test emits reach Radio.
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        (handle, guard)
    }
    fn owner(buddy: &Buddy) -> (Arc<acp::AcpSessionHandle>, impl Drop) {
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, _, guard) =
            acp::new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        (handle, guard)
    }
    fn seeded(name: &str) -> (Buddy, Delegation) {
        let conn = database::connection();
        let buddy = seed_buddy(&conn, name);
        let d = delegation(&conn, &buddy, &format!("{name}-work"));
        db::insert_delegation(&conn, &d).unwrap();
        (buddy, d)
    }

    #[tokio::test]
    async fn result_is_recorded_and_delivered_to_the_current_segment() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, d) = seeded("watch");
        let (target, _target_guard) = target(&d);
        let (owner, _owner_guard) = owner(&buddy);
        let mut sub = crate::radio::subscribe();
        let id = send_round(&buddy, &d, "do work", &[], None).await.unwrap();
        target.emit(started(&id));
        target.emit(chunk("finished"));
        target.emit(completed(&id, "end_turn"));
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].status, Status::Done);
        let stored = get(&buddy.id, &d.id).unwrap();
        assert_eq!(stored.status, Status::Done);
        assert_eq!(stored.last_result.as_deref(), Some("finished"));
        assert_eq!(stored.round_message_id.as_deref(), Some(id.as_str()));
        for notice in notices {
            deliver(notice).await.unwrap();
        }
        let queued = owner.get_queue();
        assert!(queued[0]
            .text
            .contains(&format!("\"delegation_id\":\"{}\"", d.id)));
        assert!(queued[0].text.contains("finished"));
    }

    #[tokio::test]
    async fn permission_waits_with_full_request_then_resumes() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, d) = seeded("permission");
        let (target, _target_guard) = target(&d);
        let mut sub = crate::radio::subscribe();
        let id = send_round(&buddy, &d, "push", &[], None).await.unwrap();
        target.emit(started(&id));
        target.emit_with_origin(
            AcpUpdate::PermissionRequest {
                id: "perm-1".into(),
                title: None,
                detail: None,
                description: "git push origin main".into(),
                options: vec![PermOptionData {
                    option_id: "allow".into(),
                    name: "Allow".into(),
                    kind: "allow_once".into(),
                }],
            },
            target.active_turn_origin(),
        );
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].status, Status::Waiting);
        let Some(Request::Permission {
            request_id,
            permission,
        }) = &notices[0].request
        else {
            panic!("expected a permission request");
        };
        assert_eq!(request_id, "perm-1");
        assert_eq!(permission.description, "git push origin main");
        assert_eq!(get(&buddy.id, &d.id).unwrap().status, Status::Waiting);
        target.emit(chunk("pushed"));
        target.emit(completed(&id, "end_turn"));
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(
            notices.iter().map(|n| n.status).collect::<Vec<_>>(),
            [Status::Done]
        );
    }

    #[tokio::test]
    async fn ask_form_waits_for_the_users_answer_turn() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, d) = seeded("form");
        let (target, _target_guard) = target(&d);
        let mut sub = crate::radio::subscribe();
        let id = send_round(&buddy, &d, "plan", &[], None).await.unwrap();
        target.emit(started(&id));
        target.emit_with_origin(
            AcpUpdate::AskForm {
                form_id: "form-1".into(),
                definition: serde_json::from_value(json!({"title":"Question","questions":[]}))
                    .unwrap(),
            },
            target.active_turn_origin(),
        );
        target.emit(completed(&id, "end_turn"));
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(
            notices.iter().map(|n| n.status).collect::<Vec<_>>(),
            [Status::Waiting]
        );
        assert_eq!(get(&buddy.id, &d.id).unwrap().status, Status::Waiting);
        target.emit(started("user-answer"));
        target.emit(chunk("planned"));
        target.emit(completed("user-answer", "end_turn"));
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(
            notices.iter().map(|n| n.status).collect::<Vec<_>>(),
            [Status::Done]
        );
        assert_eq!(
            get(&buddy.id, &d.id).unwrap().last_result.as_deref(),
            Some("planned")
        );
    }

    #[tokio::test]
    async fn queued_rounds_report_each_result_without_finishing_early() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, d) = seeded("queued");
        let (target, _target_guard) = target(&d);
        target
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let mut sub = crate::radio::subscribe();
        let first = send_round(&buddy, &d, "first", &[], None).await.unwrap();
        let second = send_round(&buddy, &d, "second", &[], None).await.unwrap();
        target.emit(started(&first));
        target.emit(chunk("first result"));
        target.emit(completed(&first, "end_turn"));
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].text, "first result");
        assert_eq!(get(&buddy.id, &d.id).unwrap().status, Status::Running);
        target.emit(started(&second));
        target.emit(chunk("second result"));
        target.emit(completed(&second, "end_turn"));
        drain(&mut sub, &d.target_session).await;
        let stored = get(&buddy.id, &d.id).unwrap();
        assert_eq!(stored.status, Status::Done);
        assert_eq!(stored.last_result.as_deref(), Some("second result"));
    }

    #[tokio::test]
    async fn reconnecting_target_keeps_the_follow_up_and_session_end_fails_it() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, d) = seeded("reconnect");
        let mut sub = crate::radio::subscribe();
        let id = {
            let (_first, _guard) = target(&d);
            send_round(&buddy, &d, "work", &[], None).await.unwrap()
        };
        // A fresh handle for the same Session still reports through Radio.
        let (target, _target_guard) = target(&d);
        target.emit(started(&id));
        target.emit(AcpUpdate::SessionEnded);
        let notices = drain(&mut sub, &d.target_session).await;
        assert_eq!(
            notices.iter().map(|n| n.status).collect::<Vec<_>>(),
            [Status::Failed]
        );
        assert_eq!(get(&buddy.id, &d.id).unwrap().status, Status::Failed);
    }

    #[tokio::test]
    async fn startup_marks_orphaned_rounds_interrupted_and_cancel_stays_explicit() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, orphan) = seeded("restart");
        reconcile().unwrap();
        let stored = get(&buddy.id, &orphan.id).unwrap();
        assert_eq!(stored.status, Status::Failed);
        assert!(stored.last_result.unwrap().starts_with("Interrupted"));
        let d = delegation(&database::connection(), &buddy, "restart-other");
        db::insert_delegation(&database::connection(), &d).unwrap();
        assert_eq!(
            cancel(&buddy.id, &d.id).await.unwrap().status,
            Status::Cancelled
        );
    }

    #[tokio::test]
    async fn waiting_notice_is_not_delivered_after_cancel() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (buddy, d) = seeded("slow-notify");
        let (target, _target_guard) = target(&d);
        let (owner, _owner_guard) = owner(&buddy);
        let mut sub = crate::radio::subscribe();
        let id = send_round(&buddy, &d, "work", &[], None).await.unwrap();
        target.emit(started(&id));
        target.emit_with_origin(
            AcpUpdate::AskForm {
                form_id: "cancel-form".into(),
                definition: serde_json::from_value(json!({"title":"Question","questions":[]}))
                    .unwrap(),
            },
            target.active_turn_origin(),
        );
        let notices = drain(&mut sub, &d.target_session).await;
        cancel(&buddy.id, &d.id).await.unwrap();
        for notice in notices {
            deliver(notice).await.unwrap();
        }
        assert!(owner.get_queue().is_empty());
    }

    #[tokio::test]
    async fn following_an_existing_session_reuses_one_follow_up_and_refuses_own_segment() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "follow");
        crate::storage::buddies::test_support::seed_session(
            &database::connection(),
            "other-project",
            "task",
            "plain-chat",
        );
        let key = "other-project:task:plain-chat";
        let (_target, _, _guard) =
            acp::new_handle_for_test(key, "other-project", "task", "plain-chat");
        let from = buddy.active_session_id.clone().unwrap();
        let (first, _) = follow(&buddy, &from, "plain-chat", "status?", &[])
            .await
            .unwrap();
        let (again, _) = follow(&buddy, &from, "plain-chat", "and now?", &[])
            .await
            .unwrap();
        assert_eq!(first.id, again.id);
        assert!(follow(&buddy, &from, &from, "hi me", &[]).await.is_err());
    }
}
