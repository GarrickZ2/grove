//! Buddy groups: several Buddies sharing one conversation.
//!
//! The shared log is the record. Each member keeps its own Project (Memory,
//! files) and one Session in a group Task. Only a Buddy being addressed runs a
//! turn; whatever it missed reaches it in one piece when it is next woken, so
//! nobody loses context and nobody pays for messages that aren't for them.
use super::tools::{buddy_name, session_attachments, session_status};
use crate::acp::{self, QueuedMessage};
use crate::error::{GroveError, Result};
use crate::radio::{RadioEvent, TurnEvent};
use crate::storage::{
    buddies::{self as buddy_db, Buddy},
    buddy_groups::{self as db, Attachment, Group, Member, Message},
    custom_agent, database, taskgroups, tasks,
};
use chrono::Utc;
use once_cell::sync::Lazy;
use rmcp::schemars::{self, JsonSchema};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

/// Buddy-to-Buddy wakes allowed per user message.
const HAND_OFFS: u32 = 6;
/// How much of the log a Session that knows nothing yet is given.
const JOIN_HISTORY: i64 = 50;
const CATCH_UP_MESSAGES: usize = 100;
const CATCH_UP_BYTES: usize = 32 * 1024;
pub const MIN_MEMBERS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Addressed by the user: has to answer.
    Must,
    /// May answer, or stay quiet if this isn't theirs.
    Open,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Must => "must",
            Self::Open => "open",
        }
    }
}

#[derive(Default)]
struct Budget {
    spent: u32,
    paused: bool,
}
/// In memory on purpose: a restart waits for the user anyway.
static BUDGETS: Lazy<Mutex<HashMap<String, Budget>>> = Lazy::new(Mutex::default);
/// Prompts sent by a wake, so a turn's end can be tied back to one.
static WAKES: Lazy<Mutex<HashSet<String>>> = Lazy::new(Mutex::default);

fn with<T>(run: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    run(&*database::try_connection()?)
}

fn changed(group: &str) {
    crate::radio::publish(RadioEvent::BuddyGroupChanged {
        group_id: group.into(),
    });
}

fn get(id: &str) -> Result<Group> {
    with(|conn| db::get_group(conn, id))?.ok_or_else(|| GroveError::not_found("Group not found"))
}

fn open(id: &str) -> Result<Group> {
    let group = get(id)?;
    if group.archived_at.is_some() {
        return Err(GroveError::invalid_data("This group was disbanded"));
    }
    Ok(group)
}

fn session_key(buddy: &Buddy, member: &Member) -> String {
    format!(
        "{}:{}:{}",
        buddy.project_hash, member.task_id, member.session_id
    )
}

/// The Task a Buddy's Session sits in: its group Task, or its Local Task.
pub(crate) fn session_task(session: &str) -> String {
    tasks::find_chat_session_any(session)
        .ok()
        .flatten()
        .map_or_else(|| tasks::LOCAL_TASK_ID.to_owned(), |(_, task, _)| task)
}

pub(crate) fn member_of(session: &str) -> Result<Option<Member>> {
    with(|conn| db::member_by_session(conn, session))
}

fn new_session_on(conn: &Connection, buddy: &Buddy, task: &str, title: &str) -> Result<String> {
    let id = tasks::generate_chat_id();
    tasks::add_chat_session_on(
        conn,
        &buddy.project_hash,
        task,
        tasks::ChatSession {
            id: id.clone(),
            title: title.into(),
            agent: buddy.custom_agent_id.clone(),
            acp_session_id: None,
            created_at: Utc::now(),
            duty: None,
        },
    )?;
    Ok(id)
}

/// A member's Task lives in the Buddy's own directory, so Memory and files are
/// the ones it always has.
fn join_on(conn: &Connection, group: &Group, buddy: &Buddy, agent: &str) -> Result<()> {
    let seen = (db::latest_seq(conn, &group.id)? - JOIN_HISTORY).max(0);
    if let Some(member) = db::get_member(conn, &group.id, &buddy.id)? {
        let session = new_session_on(conn, buddy, &member.task_id, &group.name)?;
        return db::set_member_session(conn, &group.id, &buddy.id, &session, agent, seen);
    }
    let task_id = format!("group-{}", group.id);
    let path = buddy_db::project_directory(&buddy.id)?;
    let mut task = tasks::build_local_task(&path.to_string_lossy(), "", "", &group.name);
    task.id = task_id.clone();
    task.is_local = false;
    task.created_by = format!("group:{}", group.id);
    tasks::add_task_on(conn, &buddy.project_hash, task)?;
    taskgroups::ensure_task_assignment_on(conn, &buddy.project_hash, &task_id, false)?;
    let session = new_session_on(conn, buddy, &task_id, &group.name)?;
    db::insert_member(
        conn,
        &Member {
            group_id: group.id.clone(),
            buddy_id: buddy.id.clone(),
            task_id,
            session_id: session,
            agent: agent.into(),
            seen_seq: seen,
            pending_wake: None,
            left_at: None,
        },
    )
}

fn base_agent(buddy: &Buddy) -> Result<String> {
    Ok(custom_agent::get(&buddy.custom_agent_id)?
        .ok_or_else(|| GroveError::storage("Missing Buddy persona"))?
        .base_agent)
}

#[derive(Debug, Deserialize)]
pub struct CreateInput {
    #[serde(default)]
    pub name: Option<String>,
    pub buddy_ids: Vec<String>,
}

/// No Agent starts here: the first message does that.
pub fn create(input: CreateInput) -> Result<Group> {
    let mut seen = HashSet::new();
    let ids: Vec<_> = input
        .buddy_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if ids.len() < MIN_MEMBERS {
        return Err(GroveError::invalid_data(
            "A group needs at least two Buddies",
        ));
    }
    let mut people = Vec::new();
    for id in &ids {
        let buddy = super::get(id)?;
        let agent = base_agent(&buddy)?;
        people.push((buddy_name(&buddy), buddy, agent));
    }
    let name = input
        .name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            people
                .iter()
                .map(|(name, ..)| name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        });
    let now = Utc::now().to_rfc3339();
    let group = Group {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        sort_position: None,
        pinned_at: None,
        archived_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    with(|conn| {
        let tx = conn.unchecked_transaction()?;
        db::insert_group(&tx, &group)?;
        for (_, buddy, agent) in &people {
            join_on(&tx, &group, buddy, agent)?;
        }
        tx.commit()?;
        Ok(())
    })?;
    changed(&group.id);
    Ok(group)
}

pub fn rename(id: &str, name: &str) -> Result<Group> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GroveError::invalid_data("Group name is required"));
    }
    let members = with(|conn| {
        if !db::rename_group(conn, id, name)? {
            return Err(GroveError::not_found("Group not found"));
        }
        db::list_members(conn, id)
    })?;
    for member in members {
        let buddy = super::get(&member.buddy_id)?;
        tasks::update_task_name(&buddy.project_hash, &member.task_id, name)?;
    }
    changed(id);
    get(id)
}

fn system(group: &str, text: &str) -> Result<()> {
    with(|conn| db::append_message(conn, group, "system", None, text, &[], &[]))?;
    Ok(())
}

pub fn add_member(id: &str, buddy_id: &str) -> Result<()> {
    let group = open(id)?;
    let buddy = super::get(buddy_id)?;
    let agent = base_agent(&buddy)?;
    with(|conn| {
        if db::member_by_task(conn, buddy_id, &format!("group-{id}"))?.is_some() {
            return Err(GroveError::invalid_data("Already in this group"));
        }
        let tx = conn.unchecked_transaction()?;
        join_on(&tx, &group, &buddy, &agent)?;
        tx.commit()?;
        Ok(())
    })?;
    system(id, &format!("{} joined", buddy_name(&buddy)))?;
    changed(id);
    Ok(())
}

async fn stop_session(key: &str) {
    if let Some(handle) = acp::get_session_handle(key) {
        let _ = handle.cancel().await;
        handle.request_shutdown();
    }
}

async fn leave(id: &str, buddy: &Buddy, note: &str) -> Result<()> {
    let Some(member) = with(|conn| db::get_member(conn, id, &buddy.id))? else {
        return Err(GroveError::not_found("Not in this group"));
    };
    // Marked first: the Session ending below is not a failure anyone must see.
    if !with(|conn| db::mark_left(conn, id, &buddy.id))? {
        return Err(GroveError::not_found("Not in this group"));
    }
    stop_session(&session_key(buddy, &member)).await;
    tasks::archive_chat_session(&buddy.project_hash, &member.task_id, &member.session_id)?;
    system(id, &format!("{} {note}", buddy_name(buddy)))?;
    changed(id);
    Ok(())
}

pub async fn remove_member(id: &str, buddy_id: &str) -> Result<()> {
    open(id)?;
    leave(id, &super::get(buddy_id)?, "was removed").await
}

/// An archived Buddy no longer answers anywhere.
pub async fn leave_all(buddy_id: &str) -> Result<()> {
    let buddy = super::get(buddy_id)?;
    for group in with(|conn| db::groups_of(conn, buddy_id))? {
        leave(&group.id, &buddy, "left").await?;
    }
    Ok(())
}

/// History stays where it is, in each Buddy's Project.
pub async fn disband(id: &str) -> Result<()> {
    let members = with(|conn| {
        let members = db::list_members(conn, id)?;
        if !db::archive_group(conn, id)? {
            return Err(GroveError::not_found("Group not found"));
        }
        Ok(members)
    })?;
    for member in members {
        let buddy = super::get(&member.buddy_id)?;
        stop_session(&session_key(&buddy, &member)).await;
        tasks::archive_chat_session(&buddy.project_hash, &member.task_id, &member.session_id)?;
    }
    BUDGETS.lock().unwrap().remove(id);
    changed(id);
    Ok(())
}

/// Stop every member's turn and anything lined up after it.
pub async fn stop(id: &str) -> Result<()> {
    open(id)?;
    let members = with(|conn| {
        db::clear_pending(conn, id, None)?;
        db::list_members(conn, id)
    })?;
    BUDGETS.lock().unwrap().insert(
        id.to_owned(),
        Budget {
            spent: HAND_OFFS,
            paused: true,
        },
    );
    for member in members {
        let buddy = super::get(&member.buddy_id)?;
        if let Some(handle) = acp::get_session_handle(&session_key(&buddy, &member)) {
            let _ = handle.cancel().await;
        }
    }
    changed(id);
    Ok(())
}

/// The part of a message that is speech: an @ quoted in code addresses nobody.
fn speech(text: &str) -> String {
    let mut spoken = String::with_capacity(text.len());
    for (index, block) in text.split("```").enumerate() {
        if index % 2 == 1 {
            continue;
        }
        for (index, part) in block.split('`').enumerate() {
            if index % 2 == 0 {
                spoken.push_str(part);
            }
            spoken.push(' ');
        }
    }
    spoken
}

/// Same rule as the composer: `@` plus a whole name, standing on its own.
fn says_at(text: &str, name: &str) -> bool {
    regex::Regex::new(&format!(
        r"(?iu)(^|\s)@{}($|[\s.,!?;:，。！？；：、)）])",
        regex::escape(name)
    ))
    .is_ok_and(|pattern| pattern.is_match(text))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Mentions {
    pub everyone: bool,
    pub buddies: Vec<String>,
}

pub(crate) fn mentions(text: &str, members: &[(String, String)]) -> Mentions {
    let spoken = speech(text);
    Mentions {
        everyone: says_at(&spoken, "everyone"),
        buddies: members
            .iter()
            .filter(|(_, name)| says_at(&spoken, name))
            .map(|(id, _)| id.clone())
            .collect(),
    }
}

/// Who a user message wakes. Naming someone asks them; everyone else is only
/// woken by @everyone, or by a message that names nobody.
pub(crate) fn user_wakes(said: &Mentions, members: &[(String, String)]) -> Vec<(String, Mode)> {
    members
        .iter()
        .filter_map(|(id, _)| {
            if said.buddies.contains(id) {
                Some((id.clone(), Mode::Must))
            } else if said.everyone || said.buddies.is_empty() {
                Some((id.clone(), Mode::Open))
            } else {
                None
            }
        })
        .collect()
}

/// Who a Buddy's reply wakes: only those it names. A plain reply wakes nobody.
pub(crate) fn buddy_wakes(
    said: &Mentions,
    sender: &str,
    members: &[(String, String)],
) -> Vec<(String, Mode)> {
    members
        .iter()
        .filter(|(id, _)| id != sender && (said.everyone || said.buddies.contains(id)))
        .map(|(id, _)| (id.clone(), Mode::Open))
        .collect()
}

fn names(group: &str) -> Result<Vec<(String, String)>> {
    let members = with(|conn| db::list_members(conn, group))?;
    members
        .into_iter()
        .map(|member| {
            let buddy = super::get(&member.buddy_id)?;
            Ok((member.buddy_id, buddy_name(&buddy)))
        })
        .collect()
}

fn spawn_wake(group: String, buddy: String, mode: Mode, turn_ended: bool) {
    tokio::spawn(async move {
        if let Err(error) = wake(&group, &buddy, mode, turn_ended).await {
            eprintln!("[Buddy group] Wake failed: {error}");
            let failed = with(|conn| {
                db::append_message(
                    conn,
                    &group,
                    "failed",
                    Some(&buddy),
                    &error.to_string(),
                    &[],
                    &[],
                )
            });
            if failed.is_ok() {
                changed(&group);
            }
        }
    });
}

/// A new member's files, stored with the group so each recipient gets a copy.
fn store_attachment(group: &str, file: &super::attachments::Outgoing) -> Result<Attachment> {
    let directory = crate::storage::grove_dir().join("buddy-groups").join(group);
    std::fs::create_dir_all(&directory)?;
    let safe: String = file
        .name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let path: PathBuf = directory.join(format!("{}-{safe}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, &file.bytes)?;
    Ok(Attachment {
        name: file.name.clone(),
        mime_type: file.mime_type.clone(),
        path: path.to_string_lossy().into_owned(),
    })
}

pub fn send(id: &str, text: &str, files: &[super::attachments::Outgoing]) -> Result<Message> {
    open(id)?;
    if text.trim().is_empty() && files.is_empty() {
        return Err(GroveError::invalid_data("Message is empty"));
    }
    let attachments = files
        .iter()
        .map(|file| store_attachment(id, file))
        .collect::<Result<Vec<_>>>()?;
    let members = names(id)?;
    let said = mentions(text, &members);
    BUDGETS.lock().unwrap().remove(id);
    let message =
        with(|conn| db::append_message(conn, id, "user", None, text, &said.buddies, &attachments))?;
    changed(id);
    for (buddy, mode) in user_wakes(&said, &members) {
        spawn_wake(id.to_owned(), buddy, mode, false);
    }
    Ok(message)
}

/// Wake one member again after a failed turn. It has to answer.
pub fn ask_again(id: &str, buddy: &str) -> Result<()> {
    open(id)?;
    with(|conn| db::member_by_task(conn, buddy, &format!("group-{id}")))?
        .ok_or_else(|| GroveError::not_found("Not in this group"))?;
    spawn_wake(id.to_owned(), buddy.to_owned(), Mode::Must, false);
    Ok(())
}

/// Spend one hand-off. The first refusal tells the group why it went silent.
fn spend(group: &str) -> Result<bool> {
    let first_refusal = {
        let mut budgets = BUDGETS.lock().unwrap();
        let budget = budgets.entry(group.to_owned()).or_default();
        if budget.spent < HAND_OFFS {
            budget.spent += 1;
            return Ok(true);
        }
        !std::mem::replace(&mut budget.paused, true)
    };
    if first_refusal {
        system(
            group,
            &format!("Buddies paused after {HAND_OFFS} hand-offs. Send a message to continue."),
        )?;
    }
    Ok(false)
}

fn post_reply(member: &Member, text: &str) -> Result<()> {
    let group = &member.group_id;
    let members = names(group)?;
    let said = mentions(text, &members);
    with(|conn| {
        db::append_message(
            conn,
            group,
            "buddy",
            Some(&member.buddy_id),
            text,
            &said.buddies,
            &[],
        )
    })?;
    for (buddy, mode) in buddy_wakes(&said, &member.buddy_id, &members) {
        if spend(group)? {
            spawn_wake(group.clone(), buddy, mode, false);
        }
    }
    Ok(())
}

fn took_wake(message_ids: &[String]) -> bool {
    let mut wakes = WAKES.lock().unwrap();
    // Every id is removed: a merged turn can carry several wakes.
    message_ids.iter().filter(|id| wakes.remove(*id)).count() > 0
}

/// A member's turn ended: its reply joins the log, then whatever waited on it runs.
fn turn_ended(chat: &str, message_ids: &[String], event: &TurnEvent) -> Result<()> {
    if !matches!(
        event,
        TurnEvent::Completed { .. } | TurnEvent::Failed { .. } | TurnEvent::SessionEnded
    ) {
        return Ok(());
    }
    let Some(member) = member_of(chat)? else {
        return Ok(());
    };
    let group = &member.group_id;
    let woken = took_wake(message_ids);
    if get(group)?.archived_at.is_some() {
        return Ok(());
    }
    let note = |kind: &str, text: &str| {
        with(|conn| db::append_message(conn, group, kind, Some(&member.buddy_id), text, &[], &[]))
    };
    match event {
        TurnEvent::Completed {
            stop_reason,
            message,
            quiet,
        } => {
            let reason = stop_reason.to_ascii_lowercase();
            if reason.contains("cancel") || reason == "killed" {
                // Stopped on purpose: half an answer isn't one.
            } else if *quiet || message.is_empty() {
                if woken {
                    note("quiet", "")?;
                }
            } else {
                post_reply(&member, message)?;
            }
        }
        TurnEvent::Failed { message } if woken => {
            note("failed", message)?;
        }
        TurnEvent::SessionEnded if woken => {
            note("failed", "The Agent stopped")?;
        }
        _ => {}
    }
    changed(group);
    if let Some(mode) = with(|conn| db::take_pending(conn, group, &member.buddy_id))? {
        let mode = if mode == "must" {
            Mode::Must
        } else {
            Mode::Open
        };
        spawn_wake(group.clone(), member.buddy_id.clone(), mode, true);
    }
    Ok(())
}

/// A Buddy that switched engines starts a new Session, rebuilt from the log.
fn on_current_engine(member: Member, buddy: &Buddy) -> Result<Member> {
    let agent = base_agent(buddy)?;
    if agent == member.agent {
        return Ok(member);
    }
    if let Some(handle) = acp::get_session_handle(&session_key(buddy, &member)) {
        handle.request_shutdown();
    }
    let group = get(&member.group_id)?;
    tasks::archive_chat_session(&buddy.project_hash, &member.task_id, &member.session_id)?;
    with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let session = new_session_on(&tx, buddy, &member.task_id, &group.name)?;
        let seen = (db::latest_seq(&tx, &group.id)? - JOIN_HISTORY).max(0);
        db::set_member_session(&tx, &group.id, &buddy.id, &session, &agent, seen)?;
        tx.commit()?;
        db::get_member(conn, &group.id, &buddy.id)?
            .ok_or_else(|| GroveError::storage("Group member vanished"))
    })
}

struct CatchUp {
    history: Vec<String>,
    files: Vec<String>,
    omitted: usize,
    last_seq: i64,
}

/// What a member hasn't seen: everything said since its last wake, except its
/// own words and the log's bookkeeping.
fn catch_up(member: &Member) -> Result<CatchUp> {
    let log = with(|conn| db::messages_after(conn, &member.group_id, member.seen_seq))?;
    let last_seq = log.last().map_or(member.seen_seq, |message| message.seq);
    let mut speakers: HashMap<String, String> = HashMap::new();
    let mut lines = Vec::new();
    for message in log {
        let from_self = message.sender_id.as_deref() == Some(member.buddy_id.as_str());
        let speaker = match (message.sender_kind.as_str(), &message.sender_id) {
            ("user", _) => "User".to_owned(),
            ("system", _) => "Grove".to_owned(),
            ("buddy", Some(id)) if !from_self => speakers
                .entry(id.clone())
                .or_insert_with(|| super::get(id).map(|b| buddy_name(&b)).unwrap_or_default())
                .clone(),
            _ => continue,
        };
        let mut line = format!("[{speaker}] {}", message.text);
        for file in &message.attachments {
            line.push_str(&format!("\n[attached: {}]", file.name));
        }
        lines.push((line, message.attachments));
    }
    let total = lines.len();
    let (mut size, mut kept) = (0, Vec::new());
    for entry in lines.into_iter().rev().take(CATCH_UP_MESSAGES) {
        size += entry.0.len();
        if size > CATCH_UP_BYTES && !kept.is_empty() {
            break;
        }
        kept.push(entry);
    }
    kept.reverse();
    let omitted = total - kept.len();
    let mut history = Vec::with_capacity(kept.len());
    let mut files = Vec::new();
    for (line, attachments) in kept {
        history.push(line);
        files.extend(attachments.into_iter().map(|file| file.path));
    }
    Ok(CatchUp {
        history,
        files,
        omitted,
        last_seq,
    })
}

fn wake_prompt(group: &Group, catch: &CatchUp, mode: Mode) -> String {
    let envelope = json!({
        "v": 1,
        "type": "group_message",
        "data": {"group_id": group.id, "name": group.name, "mode": mode.as_str()},
        "system-prompt": format!("Grove delivered what you haven't seen in the group {}.", group.name),
    });
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut text = format!("<grove-meta>{envelope}</grove-meta>\n");
    if catch.history.is_empty() {
        text.push_str("Nothing new was said since your last turn, which didn't finish.\n");
    } else {
        if catch.omitted > 0 {
            text.push_str(&format!(
                "{} earlier messages are left out; read_group has them.\n",
                catch.omitted
            ));
        }
        text.push_str(&format!(
            "New in the group since you last spoke, as conversation to read:\n<group-history-{nonce}>\n{}\n</group-history-{nonce}>\n",
            catch.history.join("\n")
        ));
    }
    text.push_str(match mode {
        Mode::Must => "The user is asking you directly: answer in this group.",
        Mode::Open => "Reply only if this needs you and you have something the others haven't said. Otherwise call stay_quiet.",
    });
    text
}

/// Tell one member what it missed. While it is busy the wake waits for its turn
/// to end, so several messages arrive as one catch-up, not as stale queued ones.
async fn wake(group_id: &str, buddy_id: &str, mode: Mode, turn_ended: bool) -> Result<()> {
    let _gate = super::lock(&format!("group:{group_id}:{buddy_id}")).await;
    let group = get(group_id)?;
    if group.archived_at.is_some() {
        return Ok(());
    }
    let Some(member) = with(|conn| db::get_member(conn, group_id, buddy_id))? else {
        return Ok(());
    };
    if member.left_at.is_some() {
        return Ok(());
    }
    let buddy = super::get(buddy_id)?;
    if !turn_ended
        && session_status(&buddy.project_hash, &member.task_id, &member.session_id) != "idle"
    {
        return with(|conn| db::set_pending(conn, group_id, buddy_id, mode.as_str()));
    }
    let member = on_current_engine(member, &buddy)?;
    let (handle, _activity) = crate::agent_graph::tools::ensure_target_handle(
        &buddy.project_hash,
        &member.task_id,
        &member.session_id,
    )
    .await
    .map_err(|e| GroveError::storage(e.to_string()))?;
    handle
        .wait_until_ready(crate::agent_graph::tools::ACP_SESSION_READY_TIMEOUT)
        .await
        .map_err(GroveError::storage)?;
    let catch = catch_up(&member)?;
    let files = super::attachments::from_paths(&catch.files)?;
    let blocks = session_attachments(
        &buddy.project_hash,
        &member.task_id,
        &member.session_id,
        &files,
    )?;
    let message = QueuedMessage::new(
        wake_prompt(&group, &catch, mode),
        blocks,
        Some(format!("group:{group_id}:{}", mode.as_str())),
        false,
        None,
    );
    let id = message.id.clone();
    WAKES.lock().unwrap().insert(id.clone());
    if let Err(error) = crate::agent_graph::tools::deliver_prompt(&handle, message).await {
        WAKES.lock().unwrap().remove(&id);
        return Err(GroveError::storage(error.to_string()));
    }
    with(|conn| db::set_seen(conn, group_id, buddy_id, catch.last_seq))?;
    changed(group_id);
    Ok(())
}

/// Grove restarted: prompts lined up for a turn that no longer exists are gone.
fn reconcile() -> Result<()> {
    for group in with(db::clear_all_pending)? {
        system(
            &group,
            "Grove restarted before everyone could answer. Send a message to continue.",
        )?;
    }
    Ok(())
}

/// Start following member turns. Call once when the server starts.
pub fn start() {
    if let Err(error) = reconcile() {
        eprintln!("[Buddy group] Reconcile failed: {error}");
    }
    let mut events = crate::radio::subscribe();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let RadioEvent::Turn {
                chat_id,
                message_ids,
                event,
                ..
            } = &event
            {
                if let Err(error) = turn_ended(chat_id, message_ids, event) {
                    eprintln!("[Buddy group] Turn update failed: {error}");
                }
            }
        }
    });
}

/// The group part of a member's bootstrap.
pub(crate) fn bootstrap(member: &Member) -> String {
    let group = get(&member.group_id).map(|g| g.name).unwrap_or_default();
    let roster = names(&member.group_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|(id, _)| *id != member.buddy_id)
        .map(|(id, name)| {
            let role = super::get(&id)
                .ok()
                .and_then(|b| custom_agent::get(&b.custom_agent_id).ok().flatten())
                .and_then(|persona| persona.duty)
                .unwrap_or_default();
            format!("- {name}: {role}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\nThis conversation is the group \"{group}\". You are in it as yourself, alongside the user and these Buddies:\n{roster}\n\nHow the group works\n- Your last message of a turn goes to the group. No other Buddy receives it until they are next woken. Only an explicit @Name (or @everyone) reaches someone now, so use it when you need them, and don't @ someone just to acknowledge them.\n- You only run when you are addressed. Each time, you get everything you missed.\n- When the user names you, answer. When a message is for everyone, or another Buddy mentions you, answer only if it needs you and you have something from your area the others haven't said. Otherwise call stay_quiet; don't repeat what was said and don't report that you have nothing to add.\n- Use read_group for who is here now and for earlier messages.\n- Your one-to-one conversation with the user is separate from this one. Your Memory is the same in both: save what should carry over, and read_session reads your Segments when you need them.\n"
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadGroupInput {
    /// Group id or exact name. Leave out inside a group to read that group; in
    /// your one-to-one conversation, leave out to list your groups.
    #[serde(default)]
    pub group: Option<String>,
    /// Return messages before this seq.
    #[serde(default)]
    pub before_seq: Option<i64>,
    /// Messages to return, 50 by default.
    #[serde(default)]
    pub limit: Option<i64>,
}

pub fn read(buddy: &Buddy, session: &str, input: ReadGroupInput) -> Result<Value> {
    let mine = with(|conn| db::groups_of(conn, &buddy.id))?;
    let id = match (&input.group, member_of(session)?) {
        (Some(reference), _) => mine
            .iter()
            .find(|group| group.id == *reference || group.name == *reference)
            .ok_or_else(|| GroveError::invalid_data("You are not in that group"))?
            .id
            .clone(),
        (None, Some(member)) => member.group_id,
        (None, None) => {
            return Ok(
                json!({"groups": mine.iter().map(|g| json!({"id":g.id,"name":g.name})).collect::<Vec<_>>()}),
            );
        }
    };
    let group = get(&id)?;
    let members = with(|conn| db::list_members(conn, &id))?;
    let mut people = Vec::new();
    let mut speakers: HashMap<String, String> = HashMap::new();
    for member in members {
        let other = super::get(&member.buddy_id)?;
        let persona = custom_agent::get(&other.custom_agent_id)?;
        let name = buddy_name(&other);
        people.push(json!({
            "name": name,
            "role": persona.and_then(|p| p.duty).unwrap_or_default(),
            "description": other.description,
            "status": member_status(&other, &member),
        }));
        speakers.insert(member.buddy_id, name);
    }
    let limit = input.limit.unwrap_or(50).clamp(1, 200);
    let log = with(|conn| db::messages_before(conn, &id, input.before_seq, limit))?;
    let messages: Vec<Value> = log
        .into_iter()
        .filter(|message| matches!(message.sender_kind.as_str(), "user" | "buddy" | "system"))
        .map(|message| {
            let sender = match (message.sender_kind.as_str(), &message.sender_id) {
                ("user", _) => "User".to_owned(),
                ("system", _) => "Grove".to_owned(),
                (_, Some(id)) => speakers
                    .entry(id.clone())
                    .or_insert_with(|| super::get(id).map(|b| buddy_name(&b)).unwrap_or_default())
                    .clone(),
                _ => String::new(),
            };
            json!({"seq": message.seq, "sender": sender, "text": message.text, "created_at": message.created_at})
        })
        .collect();
    Ok(
        json!({"group": {"id": group.id, "name": group.name}, "members": people, "messages": messages}),
    )
}

pub(crate) fn member_status(buddy: &Buddy, member: &Member) -> &'static str {
    match session_status(&buddy.project_hash, &member.task_id, &member.session_id) {
        "running" => "working",
        "waiting" => "waiting",
        _ => "idle",
    }
}

/// The Session a follow-up should report to: the group that sent it, wherever
/// its member's Session is now.
pub(crate) fn followup_session(buddy: &Buddy, from_session: &str) -> Result<Option<Member>> {
    if buddy_db::get_segment(&*database::try_connection()?, from_session)?.is_some() {
        return Ok(None);
    }
    let task = session_task(from_session);
    with(|conn| db::member_by_task(conn, &buddy.id, &task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::buddies::test_support::{seed_buddy, Store};

    fn people() -> Vec<(String, String)> {
        vec![
            ("a".into(), "Mira".into()),
            ("b".into(), "Alex".into()),
            ("c".into(), "Li Na".into()),
        ]
    }

    #[test]
    fn mentions_are_whole_names_outside_code() {
        let members = people();
        let said = |text| mentions(text, &members);
        assert_eq!(said("hi @Mira, and @alex.").buddies, ["a", "b"]);
        assert_eq!(said("@Li Na？").buddies, ["c"]);
        assert!(said("@Mirage hello").buddies.is_empty());
        assert!(said("mail mira@Mira").buddies.is_empty());
        assert!(said("see `@Mira` and\n```\n@Alex\n```").buddies.is_empty());
        assert!(said("@everyone ready?").everyone);
    }

    #[test]
    fn user_messages_wake_by_name_or_everyone() {
        let members = people();
        let wakes = |text| user_wakes(&mentions(text, &members), &members);
        assert_eq!(wakes("@Mira look"), vec![("a".to_owned(), Mode::Must)]);
        assert!(wakes("nobody named")
            .iter()
            .all(|(_, mode)| *mode == Mode::Open));
        assert_eq!(wakes("nobody named").len(), 3);
        let both = wakes("@everyone and @Alex");
        assert_eq!(both.len(), 3);
        assert_eq!(both[1], ("b".to_owned(), Mode::Must));
        assert_eq!(both[0].1, Mode::Open);
    }

    #[test]
    fn buddy_replies_reach_only_who_they_name() {
        let members = people();
        let wakes = |text| buddy_wakes(&mentions(text, &members), "a", &members);
        assert!(wakes("a plain reply").is_empty());
        assert_eq!(
            wakes("@Alex over to you"),
            vec![("b".to_owned(), Mode::Open)]
        );
        assert!(wakes("@Mira note to self").is_empty());
        assert_eq!(wakes("@everyone heads up").len(), 2);
    }

    fn group_of(ids: &[&str]) -> Group {
        let buddies: Vec<_> = {
            let conn = database::connection();
            ids.iter().map(|id| seed_buddy(&conn, id).id).collect()
        };
        create(CreateInput {
            name: None,
            buddy_ids: buddies,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn creation_puts_each_member_in_its_own_project_and_starts_nothing() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        assert_eq!(group.name, "ca-one, ca-two");
        let members = with(|conn| db::list_members(conn, &group.id)).unwrap();
        assert_eq!(members.len(), 2);
        for member in &members {
            let buddy = super::super::get(&member.buddy_id).unwrap();
            let task = tasks::get_task(&buddy.project_hash, &member.task_id)
                .unwrap()
                .unwrap();
            assert_eq!(task.name, group.name);
            assert_eq!(
                task.worktree_path,
                buddy_db::project_directory(&buddy.id)
                    .unwrap()
                    .to_string_lossy()
            );
            assert!(!task.is_local);
            assert_eq!(member_of(&member.session_id).unwrap().unwrap(), *member);
            assert!(acp::get_session_handle(&session_key(&buddy, member)).is_none());
        }
        rename(&group.id, "Launch crew").unwrap();
        let buddy = super::super::get(&members[0].buddy_id).unwrap();
        let task = tasks::get_task(&buddy.project_hash, &members[0].task_id)
            .unwrap()
            .unwrap();
        assert_eq!(task.name, "Launch crew");
        let lonely = create(CreateInput {
            name: None,
            buddy_ids: vec!["one".into(), "one".into()],
        });
        assert!(lonely.is_err());
    }

    fn say(group: &str, kind: &str, sender: Option<&str>, text: &str) -> Message {
        with(|conn| db::append_message(conn, group, kind, sender, text, &[], &[])).unwrap()
    }

    #[tokio::test]
    async fn catch_up_has_what_was_missed_without_own_words_or_bookkeeping() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        say(&group.id, "user", None, "why is it slow?");
        say(&group.id, "buddy", Some("two"), "N+1 queries");
        say(&group.id, "buddy", Some("one"), "my own words");
        say(&group.id, "quiet", Some("two"), "");
        say(&group.id, "failed", Some("two"), "boom");
        let last = say(&group.id, "system", None, "two joined");
        let catch = catch_up(&member).unwrap();
        assert_eq!(
            catch.history,
            [
                "[User] why is it slow?",
                "[ca-two] N+1 queries",
                "[Grove] two joined"
            ]
        );
        assert_eq!(catch.last_seq, last.seq);
        with(|conn| db::set_seen(conn, &group.id, "one", catch.last_seq)).unwrap();
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        let next = catch_up(&member).unwrap();
        assert!(next.history.is_empty());
        assert_eq!(next.last_seq, last.seq);
        let prompt = wake_prompt(&group, &catch, Mode::Must);
        assert!(prompt.contains("N+1 queries"));
        assert!(prompt.ends_with("answer in this group."));
    }

    #[tokio::test]
    async fn catch_up_keeps_the_latest_messages_when_there_are_too_many() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        for index in 0..(CATCH_UP_MESSAGES + 5) {
            say(&group.id, "user", None, &format!("message {index}"));
        }
        let catch = catch_up(&member).unwrap();
        assert_eq!(catch.history.len(), CATCH_UP_MESSAGES);
        assert_eq!(catch.omitted, 5);
        assert!(catch.history[0].ends_with("message 5"));
        assert!(wake_prompt(&group, &catch, Mode::Open).contains("5 earlier messages"));
    }

    #[tokio::test]
    async fn a_busy_member_is_woken_once_with_everything_when_its_turn_ends() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        let buddy = super::super::get("one").unwrap();
        let (handle, mut updates, _guard) = acp::new_handle_for_test(
            &session_key(&buddy, &member),
            &buddy.project_hash,
            &member.task_id,
            &member.session_id,
        );
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        say(&group.id, "user", None, "first");
        wake(&group.id, "one", Mode::Must, false).await.unwrap();
        say(&group.id, "user", None, "second");
        wake(&group.id, "one", Mode::Open, false).await.unwrap();
        assert!(handle.get_queue().is_empty());
        let pending = with(|conn| db::take_pending(conn, &group.id, "one")).unwrap();
        assert_eq!(pending.as_deref(), Some("must"));
        handle
            .is_busy
            .store(false, std::sync::atomic::Ordering::Release);
        wake(&group.id, "one", Mode::Must, true).await.unwrap();
        let text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let acp::AcpUpdate::UserMessage { text, sender, .. } =
                    updates.recv().await.unwrap()
                {
                    let sender = sender.unwrap();
                    assert!(sender.ends_with(":must"), "{sender}");
                    break text;
                }
            }
        })
        .await
        .unwrap();
        assert!(text.contains("[User] first\n[User] second"));
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        assert_eq!(member.seen_seq, 2);
    }

    #[tokio::test]
    async fn replies_join_the_log_and_quiet_turns_are_only_noted() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        let completed = |message: &str, quiet| TurnEvent::Completed {
            stop_reason: "EndTurn".into(),
            message: message.into(),
            quiet,
        };
        WAKES.lock().unwrap().insert("m1".into());
        turn_ended(&member.session_id, &["m1".into()], &completed("", true)).unwrap();
        turn_ended(&member.session_id, &[], &completed("a reply", false)).unwrap();
        let cancelled = TurnEvent::Completed {
            stop_reason: "Cancelled".into(),
            message: "half".into(),
            quiet: false,
        };
        turn_ended(&member.session_id, &[], &cancelled).unwrap();
        let log = with(|conn| db::messages_after(conn, &group.id, 0)).unwrap();
        let kinds: Vec<_> = log.iter().map(|m| m.sender_kind.as_str()).collect();
        assert_eq!(kinds, ["quiet", "buddy"]);
        assert_eq!(log[1].text, "a reply");
        assert!(!WAKES.lock().unwrap().contains("m1"));
    }

    #[tokio::test]
    async fn hand_offs_stop_and_say_so_once_until_the_user_speaks() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        for _ in 0..HAND_OFFS {
            assert!(spend(&group.id).unwrap());
        }
        assert!(!spend(&group.id).unwrap());
        assert!(!spend(&group.id).unwrap());
        let log = with(|conn| db::messages_after(conn, &group.id, 0)).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].sender_kind, "system");
        send(&group.id, "@nobody keep going", &[]).unwrap();
        assert!(spend(&group.id).unwrap());
    }

    #[tokio::test]
    async fn removed_members_stop_and_can_come_back_with_recent_history() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let before = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        remove_member(&group.id, "one").await.unwrap();
        assert!(member_of(&before.session_id).unwrap().is_none());
        assert_eq!(names(&group.id).unwrap().len(), 1);
        assert!(ask_again(&group.id, "one").is_err());
        add_member(&group.id, "one").unwrap();
        let back = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        assert_ne!(back.session_id, before.session_id);
        assert_eq!(back.task_id, before.task_id);
        assert!(add_member(&group.id, "one").is_err());
        let log = with(|conn| db::messages_after(conn, &group.id, 0)).unwrap();
        assert_eq!(log[0].text, "ca-one was removed");
        assert_eq!(log[1].text, "ca-one joined");
    }

    #[tokio::test]
    async fn switching_engines_rebuilds_the_session_from_the_log() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        let buddy = super::super::get("one").unwrap();
        database::connection()
            .execute(
                "UPDATE custom_agent SET base_agent='codex-acp' WHERE id=?1",
                [&buddy.custom_agent_id],
            )
            .unwrap();
        let moved = on_current_engine(member.clone(), &buddy).unwrap();
        assert_ne!(moved.session_id, member.session_id);
        assert_eq!(moved.agent, "codex-acp");
        assert_eq!(moved.task_id, member.task_id);
        let same = on_current_engine(moved.clone(), &buddy).unwrap();
        assert_eq!(same.session_id, moved.session_id);
    }

    #[tokio::test]
    async fn disbanded_groups_refuse_messages_and_read_shows_members() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let group = group_of(&["one", "two"]);
        let buddy = super::super::get("one").unwrap();
        let member = with(|conn| db::get_member(conn, &group.id, "one"))
            .unwrap()
            .unwrap();
        say(&group.id, "user", None, "hello");
        let page = read(
            &buddy,
            &member.session_id,
            ReadGroupInput {
                group: None,
                before_seq: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(page["members"].as_array().unwrap().len(), 2);
        assert_eq!(page["messages"][0]["sender"], "User");
        let segment = buddy.active_session_id.clone().unwrap();
        let listed = read(
            &buddy,
            &segment,
            ReadGroupInput {
                group: None,
                before_seq: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(listed["groups"][0]["id"], group.id.as_str());
        disband(&group.id).await.unwrap();
        assert!(send(&group.id, "hello?", &[]).is_err());
        assert!(member_of(&member.session_id).unwrap().is_some());
        assert!(with(|conn| db::list_groups(conn)).unwrap().is_empty());
    }
}
