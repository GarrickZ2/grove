//! Buddies messaging each other. A message is a prompt in the recipient's
//! active Segment, tagged with a `buddy_message` envelope (`chat: true`).
//! Replies are explicit: the recipient answers with `message_buddy` and
//! `reply_to`. Without the user stepping in, an exchange stops after
//! `MAX_HOPS` messages so two Buddies can't talk to each other forever.
use crate::error::{GroveError, Result};
use crate::machines::link::{self, Call};
use crate::radio::{RadioEvent, TurnEvent};
use crate::storage::machines::{self as machines_store, Peer};
use crate::storage::{buddies::Buddy, chat_history, database, tasks};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// Messages Buddies may exchange in a row before the user has to step in.
pub const MAX_HOPS: u64 = 6;
/// How long a machine gets to list its Buddies.
const LIST_LIMIT: Duration = Duration::from_secs(5);
/// A message can wake its recipient's Agent, which may take the whole ready
/// timeout; the answer needs a moment more.
const MESSAGE_LIMIT: Duration = Duration::from_secs(100);
/// How long a message waits for its turn to show it was taken or refused.
const ARRIVAL_LIMIT: Duration = Duration::from_secs(5);

/// This machine's active Buddies, with the id `message_buddy` takes.
pub fn here(except: Option<&str>) -> Result<Value> {
    let buddies = crate::storage::buddies::list(&database::connection(), false)?;
    Ok(json!(buddies
        .iter()
        .filter(|buddy| except != Some(buddy.id.as_str()))
        .map(|buddy| {
            let persona = crate::storage::custom_agent::get(&buddy.custom_agent_id)
                .ok()
                .flatten();
            let status = buddy
                .active_session_id
                .as_deref()
                .map_or("idle", |session| {
                    super::tools::session_status(&buddy.project_hash, tasks::LOCAL_TASK_ID, session)
                });
            json!({
                "id": buddy.id,
                "name": persona.as_ref().map_or("Buddy", |p| p.name.as_str()),
                "avatar": buddy.avatar,
                "role": persona.and_then(|p| p.duty).filter(|role| !role.is_empty()),
                "status": status,
            })
        })
        .collect::<Vec<_>>()))
}

/// Other active Buddies on this machine.
pub fn list(caller: &Buddy) -> Result<Value> {
    here(Some(&caller.id))
}

/// A connected machine's Buddies, as this machine addresses them.
fn on_machine(machine: &Peer, buddies: Value) -> Vec<Value> {
    let Value::Array(buddies) = buddies else {
        return Vec::new();
    };
    buddies
        .into_iter()
        .filter_map(|mut buddy| {
            let id = buddy.get("id")?.as_str()?.to_owned();
            let entry = buddy.as_object_mut()?;
            entry.insert("id".into(), json!(address(&machine.profile.id, &id)));
            entry.insert("avatar_id".into(), json!(id));
            entry.insert("machine".into(), json!(machine.profile.name));
            Some(buddy)
        })
        .collect()
}

/// The Buddies on every connected machine. A machine that doesn't answer in
/// time is left out.
pub async fn reachable() -> Vec<Value> {
    let peers = machines_store::peers().unwrap_or_default();
    let asks = peers
        .iter()
        .filter(|peer| link::status(&peer.profile.id) == "online")
        .map(|peer| async move {
            let buddies = link::ask(&peer.profile.id, Call::Buddies, LIST_LIMIT).await;
            buddies.map_or_else(|_| Vec::new(), |buddies| on_machine(peer, buddies))
        });
    let found = futures::future::join_all(asks).await;
    found.into_iter().flatten().collect()
}

/// Every other Buddy the caller can reach, on any machine.
pub async fn all(caller: &Buddy) -> Result<Value> {
    let mut buddies = match list(caller)? {
        Value::Array(buddies) => buddies,
        _ => Vec::new(),
    };
    buddies.extend(reachable().await);
    Ok(json!(buddies))
}

fn address(machine: &str, buddy: &str) -> String {
    format!("{machine}/{buddy}")
}

/// The machine and Buddy in an address. Names can hold a slash, so the first
/// part has to be a paired machine.
fn remote_address(reference: &str) -> Option<(String, String)> {
    let (machine, buddy) = reference.trim().split_once('/')?;
    machines_store::peer(machine).ok().flatten()?;
    Some((machine.to_owned(), buddy.to_owned()))
}

/// A message on its way to a Buddy on another machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuddyMessage {
    from_id: String,
    from_name: String,
    from_avatar: Option<String>,
    to: String,
    id: String,
    text: String,
    hop: u64,
    reply_to: Option<String>,
}

/// Who a message is from, as the recipient should reach them.
struct Sender<'a> {
    id: &'a str,
    address: String,
    name: &'a str,
    avatar: Option<&'a str>,
    machine: Option<String>,
}

enum Target {
    Here(Box<Buddy>),
    There { machine: String, buddy: String },
}

/// Another active Buddy, by id or unambiguous name.
fn resolve(caller: &Buddy, reference: &str) -> Result<Buddy> {
    let reference = reference.trim();
    // Release the connection before naming: buddy_name takes it again.
    let buddies = crate::storage::buddies::list(&database::connection(), false)?;
    let others: Vec<(Buddy, String)> = buddies
        .into_iter()
        .filter(|buddy| buddy.id != caller.id)
        .map(|buddy| {
            let name = super::tools::buddy_name(&buddy);
            (buddy, name)
        })
        .collect();
    if reference == caller.id || reference.eq_ignore_ascii_case(&super::tools::buddy_name(caller)) {
        return Err(GroveError::invalid_data("You cannot message yourself"));
    }
    let matches: Vec<&(Buddy, String)> = others
        .iter()
        .filter(|(buddy, name)| buddy.id == reference || name.eq_ignore_ascii_case(reference))
        .collect();
    let listing = |items: &[&(Buddy, String)]| {
        let names: Vec<String> = items
            .iter()
            .map(|(buddy, name)| format!("{name} ({})", buddy.id))
            .collect();
        if names.is_empty() {
            "none".to_owned()
        } else {
            names.join(", ")
        }
    };
    match matches.as_slice() {
        [(buddy, _)] => Ok(buddy.clone()),
        [] => Err(GroveError::not_found(format!(
            "No Buddy matches \"{reference}\". Buddies: {}",
            listing(&others.iter().collect::<Vec<_>>())
        ))),
        _ => Err(GroveError::invalid_data(format!(
            "\"{reference}\" matches several Buddies; pass one id: {}",
            listing(&matches)
        ))),
    }
}

/// Another Buddy on any machine. This machine's come first: a name only looks
/// further when nothing here has it.
async fn find(caller: &Buddy, reference: &str) -> Result<Target> {
    if let Some((machine, buddy)) = remote_address(reference) {
        return Ok(Target::There { machine, buddy });
    }
    let missing = match resolve(caller, reference) {
        Err(GroveError::NotFound(missing)) => missing,
        found => return found.map(|buddy| Target::Here(Box::new(buddy))),
    };
    let elsewhere = reachable().await;
    let matches: Vec<&Value> = elsewhere
        .iter()
        .filter(|buddy| {
            buddy
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(reference.trim()))
        })
        .collect();
    let listing = |items: &[&Value]| {
        let names: Vec<String> = items
            .iter()
            .map(|buddy| {
                format!(
                    "{} on {} ({})",
                    buddy["name"], buddy["machine"], buddy["id"]
                )
            })
            .collect();
        names.join(", ").replace('"', "")
    };
    match matches.as_slice() {
        [buddy] => {
            let found = buddy["id"].as_str().and_then(remote_address);
            let (machine, buddy) = found.ok_or_else(|| GroveError::not_found(missing))?;
            Ok(Target::There { machine, buddy })
        }
        [] if elsewhere.is_empty() => Err(GroveError::not_found(missing)),
        [] => Err(GroveError::not_found(format!(
            "{missing}. On other machines: {}",
            listing(&elsewhere.iter().collect::<Vec<_>>())
        ))),
        _ => Err(GroveError::invalid_data(format!(
            "\"{}\" matches several Buddies; pass one id: {}",
            reference.trim(),
            listing(&matches)
        ))),
    }
}

/// The hop of every Buddy-chat envelope in a prompt's text (merged prompts
/// can carry several).
fn hops(text: &str) -> impl Iterator<Item = u64> + '_ {
    text.split("<grove-meta>").skip(1).filter_map(|rest| {
        let body = &rest[..rest.find("</grove-meta>")?];
        let envelope: Value = serde_json::from_str(body).ok()?;
        let data = envelope.get("data")?;
        (envelope.get("type")?.as_str()? == "buddy_message" && data.get("chat")?.as_bool()?)
            .then(|| data.get("hop").and_then(Value::as_u64).unwrap_or(1))
    })
}

/// How far into a Buddy exchange a message sent now would be: one past the
/// Buddy message that started this turn, or 1 when the user (or anything
/// else) did.
fn next_hop(caller: &Buddy, session: &str) -> u64 {
    let task = super::group::session_task(session);
    let history = chat_history::load_history(&caller.project_hash, &task, session);
    let started_by = history.iter().rev().find_map(|update| match update {
        crate::acp::AcpUpdate::UserMessage { text, .. } => Some(text.as_str()),
        _ => None,
    });
    started_by.and_then(|text| hops(text).max()).unwrap_or(0) + 1
}

/// What arrives in the recipient's conversation.
fn chat_message(
    from: &Sender,
    to: (&str, &str),
    id: &str,
    text: &str,
    hop: u64,
    reply_to: Option<&str>,
) -> crate::acp::QueuedMessage {
    let Sender {
        id: sender,
        address,
        name,
        avatar,
        machine,
    } = from;
    let origin = machine.as_ref().map_or(String::new(), |machine| {
        format!(" on the machine {machine}")
    });
    let lead = if reply_to.is_some() {
        format!("{name} (Buddy id {address}){origin} replied to your message")
    } else {
        format!("Message from {name} (Buddy id {address}){origin}, another of the user's Buddies")
    };
    let note = format!(
        "{lead}. Its message id is {id}. Answer only if a reply is useful, with message_buddy(buddy: \"{address}\", reply_to: \"{id}\"); never reply just to acknowledge or thank."
    );
    let (to_id, to_name) = to;
    let mut message = super::tools::prompt_from(
        sender,
        name,
        *avatar,
        text,
        json!({"chat": true, "message_id": id, "hop": hop, "reply_to": reply_to, "machine": machine, "to": {"id": to_id, "name": to_name}}),
        Some(note),
    );
    message.id = id.to_owned();
    message.message_ids = vec![id.to_owned()];
    message
}

/// What a Radio event says about a message reaching its recipient: nothing
/// yet, or how it went. A turn that produced anything took the message.
fn arrival(event: &RadioEvent, id: &str) -> Option<std::result::Result<(), String>> {
    let RadioEvent::Turn {
        message_ids, event, ..
    } = event
    else {
        return None;
    };
    if !message_ids.iter().any(|message| message == id) {
        return None;
    }
    match event {
        TurnEvent::Started => None,
        TurnEvent::Failed { message } => Some(Err(message.clone())),
        TurnEvent::Removed { .. } | TurnEvent::SessionEnded { .. } => {
            Some(Err("Its session ended before it read the message".into()))
        }
        _ => Some(Ok(())),
    }
}

async fn start_turn(target: &Buddy, message: crate::acp::QueuedMessage) -> Result<()> {
    let id = message.id.clone();
    let mut events = crate::radio::subscribe();
    let (_, handle, _activity) = super::delegations::active_handle(&target.id).await?;
    let waits = handle.is_busy.load(std::sync::atomic::Ordering::Acquire);
    crate::agent_graph::tools::deliver_prompt(&handle, message)
        .await
        .map_err(|e| GroveError::storage(e.to_string()))?;
    // A busy Buddy reads it after this turn, which is not worth waiting for.
    if waits {
        return Ok(());
    }
    let outcome = tokio::time::timeout(ARRIVAL_LIMIT, async {
        while let Some(event) = events.recv().await {
            if let Some(outcome) = arrival(&event, &id) {
                return outcome;
            }
        }
        Ok(())
    });
    match outcome.await {
        Ok(Err(reason)) => Err(GroveError::storage(reason)),
        // Slow to start is not a failure.
        _ => Ok(()),
    }
}

/// Hand a message to a Buddy, saying so at once when it can't take it: not
/// signed in, its Agent won't start, or the turn is refused.
async fn deliver(target: &Buddy, message: crate::acp::QueuedMessage) -> Result<()> {
    start_turn(target, message).await.map_err(|error| {
        let reason = match error {
            GroveError::Storage(reason) => reason,
            other => other.to_string(),
        };
        let reason = reason.strip_prefix("internal_error: ").unwrap_or(&reason);
        let name = super::tools::buddy_name(target);
        GroveError::invalid_data(format!("{name} couldn't take the message: {reason}"))
    })
}

/// A message from a Buddy on a paired machine. Who it is from comes from the
/// connection, so a machine can only speak for itself.
pub async fn receive(machine: &str, message: BuddyMessage) -> Result<Value> {
    let peer =
        machines_store::peer(machine)?.ok_or_else(|| GroveError::not_found("Machine not found"))?;
    let buddies = crate::storage::buddies::list(&database::connection(), false)?;
    let target = buddies
        .into_iter()
        .find(|buddy| buddy.id == message.to)
        .ok_or_else(|| GroveError::not_found("That Buddy is no longer on this machine"))?;
    let target_name = super::tools::buddy_name(&target);
    let from = Sender {
        id: &message.from_id,
        address: address(machine, &message.from_id),
        name: &message.from_name,
        avatar: message.from_avatar.as_deref(),
        machine: Some(peer.profile.name),
    };
    let prompt = chat_message(
        &from,
        (&target.id, &target_name),
        &message.id,
        &message.text,
        message.hop,
        message.reply_to.as_deref(),
    );
    deliver(&target, prompt).await?;
    Ok(json!({"name": target_name}))
}

/// Send `text` to another Buddy; returns the message id it can reply to.
pub async fn send(
    caller: &Buddy,
    session: &str,
    reference: &str,
    text: &str,
    reply_to: Option<&str>,
) -> Result<Value> {
    if text.trim().is_empty() {
        return Err(GroveError::invalid_data("text is required"));
    }
    let target = find(caller, reference).await?;
    let hop = next_hop(caller, session);
    if hop > MAX_HOPS {
        return Err(GroveError::invalid_data(format!(
            "Buddies have exchanged {MAX_HOPS} messages in a row without the user. Stop here and tell the user what is still open."
        )));
    }
    let name = super::tools::buddy_name(caller);
    let id = uuid::Uuid::new_v4().to_string();
    let to = match target {
        Target::Here(target) => {
            let target_name = super::tools::buddy_name(&target);
            let from = Sender {
                id: &caller.id,
                address: caller.id.clone(),
                name: &name,
                avatar: caller.avatar.as_deref(),
                machine: None,
            };
            let to = (target.id.as_str(), target_name.as_str());
            deliver(&target, chat_message(&from, to, &id, text, hop, reply_to)).await?;
            json!({"id": target.id, "name": target_name})
        }
        Target::There { machine, buddy } => {
            let message = BuddyMessage {
                from_id: caller.id.clone(),
                from_name: name,
                from_avatar: caller.avatar.clone(),
                to: buddy.clone(),
                id: id.clone(),
                text: text.to_owned(),
                hop,
                reply_to: reply_to.map(str::to_owned),
            };
            let answer = link::ask(&machine, Call::MessageBuddy(message), MESSAGE_LIMIT)
                .await
                .map_err(GroveError::invalid_data)?;
            json!({"id": address(&machine, &buddy), "name": answer["name"]})
        }
    };
    // The text is echoed so the sender's timeline can show it even when the
    // agent's tool-call events leave out the input.
    Ok(json!({"message_id": id, "to": to, "text": text}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(hop: u64) -> String {
        format!(
            "<grove-meta>{}</grove-meta>\nhi",
            json!({"v":1,"type":"buddy_message","data":{"chat":true,"hop":hop}})
        )
    }

    #[test]
    fn hops_read_chat_envelopes_only() {
        assert_eq!(hops(&envelope(3)).collect::<Vec<_>>(), vec![3]);
        let merged = format!("{}\n\n{}", envelope(2), envelope(5));
        assert_eq!(hops(&merged).max(), Some(5));
        let delegation = format!(
            "<grove-meta>{}</grove-meta>\nFollow-up",
            json!({"v":1,"type":"buddy_message","data":{"delegation_id":"d"}})
        );
        assert_eq!(hops(&delegation).count(), 0);
        assert_eq!(hops("plain user text").count(), 0);
    }

    #[test]
    fn radio_says_whether_a_message_arrived() {
        let turn = |ids: &[&str], event| RadioEvent::Turn {
            project_id: "p".into(),
            task_id: "t".into(),
            chat_id: "c".into(),
            message_ids: ids.iter().map(|id| id.to_string()).collect(),
            event,
        };
        let text = TurnEvent::MessageChunk { text: "hi".into() };
        assert_eq!(arrival(&turn(&["m"], TurnEvent::Started), "m"), None);
        assert_eq!(arrival(&turn(&["other"], text.clone()), "m"), None);
        assert_eq!(arrival(&turn(&["m"], text), "m"), Some(Ok(())));
        let failed = TurnEvent::Failed {
            message: "Authentication required".into(),
        };
        assert_eq!(
            arrival(&turn(&["m"], failed), "m"),
            Some(Err("Authentication required".into()))
        );
        let ended = TurnEvent::SessionEnded { action: None };
        assert!(matches!(arrival(&turn(&["m"], ended), "m"), Some(Err(_))));
    }

    #[test]
    fn a_message_from_another_machine_says_how_to_reply_across() {
        let from = Sender {
            id: "ada",
            address: address("studio", "ada"),
            name: "Ada",
            avatar: None,
            machine: Some("Studio Mac".into()),
        };
        let prompt = chat_message(&from, ("bob", "Bob"), "m1", "hello", 2, None);
        assert_eq!(prompt.sender.as_deref(), Some("buddy:ada"));
        assert_eq!(prompt.id, "m1");
        assert!(prompt.text.contains("on the machine Studio Mac"));
        assert!(prompt
            .text
            .contains(r#"message_buddy(buddy: \"studio/ada\", reply_to: \"m1\")"#));
        // Hop counting reads the envelope, so an exchange stops across machines too.
        assert_eq!(hops(&prompt.text).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn another_machines_buddies_carry_its_address_and_name() {
        let peer = Peer {
            url: None,
            device_id: None,
            device_key: None,
            proxy_port: None,
            headers: Default::default(),
            profile: crate::storage::machines::Profile {
                id: "studio".into(),
                name: "Studio Mac".into(),
                description: String::new(),
                icon: "laptop".into(),
            },
        };
        let listed = on_machine(&peer, json!([{"id": "ada", "name": "Ada"}]));
        assert_eq!(listed[0]["id"], "studio/ada");
        assert_eq!(listed[0]["avatar_id"], "ada");
        assert_eq!(listed[0]["machine"], "Studio Mac");
        assert!(on_machine(&peer, json!({"error": "nope"})).is_empty());
    }

    #[test]
    fn only_a_paired_machine_makes_a_slash_an_address() {
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        assert_eq!(remote_address("R&D/Ops"), None);
        crate::storage::set_grove_dir_override(None);
    }

    fn user(text: String, sender: Option<&str>) -> crate::acp::AcpUpdate {
        crate::acp::AcpUpdate::UserMessage {
            message_id: None,
            text,
            client_message_id: None,
            attachments: Vec::new(),
            sender: sender.map(str::to_owned),
            terminal: false,
        }
    }

    #[tokio::test]
    async fn buddies_resolve_by_id_or_name_and_long_exchanges_stop() {
        use crate::storage::buddies::test_support::{seed_buddy, Store};
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (ada, bob) = {
            let conn = database::connection();
            (seed_buddy(&conn, "ada"), seed_buddy(&conn, "bob"))
        };
        let listed = list(&ada).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], "bob");
        assert_eq!(listed[0]["name"], "ca-bob");
        for reference in ["bob", "ca-bob", "CA-BOB"] {
            assert_eq!(resolve(&ada, reference).unwrap().id, bob.id, "{reference}");
        }
        assert!(resolve(&ada, "ada").is_err());
        assert!(resolve(&ada, "carol")
            .unwrap_err()
            .to_string()
            .contains("ca-bob (bob)"));

        let session = "ada-segment-1";
        let append = |event| {
            chat_history::append_event(&ada.project_hash, tasks::LOCAL_TASK_ID, session, &event)
        };
        assert_eq!(next_hop(&ada, session), 1);
        append(user(envelope(3), Some("buddy:bob")));
        assert_eq!(next_hop(&ada, session), 4);
        append(user(envelope(MAX_HOPS), Some("buddy:bob")));
        let refused = send(&ada, session, "bob", "one more", None)
            .await
            .unwrap_err();
        assert!(
            refused.to_string().contains("without the user"),
            "{refused}"
        );
        // The user stepping in starts a fresh exchange.
        append(user("Ask Bob again".into(), None));
        assert_eq!(next_hop(&ada, session), 1);
    }
}
