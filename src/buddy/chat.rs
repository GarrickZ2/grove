//! Buddies messaging each other. A message is a prompt in the recipient's
//! active Segment, tagged with a `buddy_message` envelope (`chat: true`).
//! Replies are explicit: the recipient answers with `message_buddy` and
//! `reply_to`. Without the user stepping in, an exchange stops after
//! `MAX_HOPS` messages so two Buddies can't talk to each other forever.
use crate::error::{GroveError, Result};
use crate::storage::{buddies::Buddy, chat_history, database, tasks};
use serde_json::{json, Value};

/// Messages Buddies may exchange in a row before the user has to step in.
pub const MAX_HOPS: u64 = 6;

/// Other active Buddies, with the id `message_buddy` takes.
pub fn list(caller: &Buddy) -> Result<Value> {
    let buddies = crate::storage::buddies::list(&database::connection(), false)?;
    Ok(json!(buddies
        .iter()
        .filter(|buddy| buddy.id != caller.id)
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
                "role": persona.and_then(|p| p.duty).filter(|role| !role.is_empty()),
                "status": status,
            })
        })
        .collect::<Vec<_>>()))
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
    let history = chat_history::load_history(&caller.project_hash, tasks::LOCAL_TASK_ID, session);
    let started_by = history.iter().rev().find_map(|update| match update {
        crate::acp::AcpUpdate::UserMessage { text, .. } => Some(text.as_str()),
        _ => None,
    });
    started_by.and_then(|text| hops(text).max()).unwrap_or(0) + 1
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
    let target = resolve(caller, reference)?;
    let hop = next_hop(caller, session);
    if hop > MAX_HOPS {
        return Err(GroveError::invalid_data(format!(
            "Buddies have exchanged {MAX_HOPS} messages in a row without the user. Stop here and tell the user what is still open."
        )));
    }
    let target_name = super::tools::buddy_name(&target);
    let name = super::tools::buddy_name(caller);
    let id = uuid::Uuid::new_v4().to_string();
    let lead = if reply_to.is_some() {
        format!("{name} (Buddy id {}) replied to your message", caller.id)
    } else {
        format!(
            "Message from {name} (Buddy id {}), another of the user's Buddies",
            caller.id
        )
    };
    let note = format!(
        "{lead}. Its message id is {id}. Answer only if a reply is useful, with message_buddy(buddy: \"{}\", reply_to: \"{id}\"); never reply just to acknowledge or thank.",
        caller.id
    );
    let mut message = super::tools::prompt_with_note(
        caller,
        text,
        json!({"chat": true, "message_id": id, "hop": hop, "reply_to": reply_to, "to": {"id": target.id, "name": target_name}}),
        Some(note),
    );
    message.id = id.clone();
    message.message_ids = vec![id.clone()];
    let (_, handle, _activity) = super::delegations::active_handle(&target.id).await?;
    crate::agent_graph::tools::deliver_prompt(&handle, message)
        .await
        .map_err(|e| GroveError::storage(e.to_string()))?;
    // The text is echoed so the sender's timeline can show it even when the
    // agent's tool-call events leave out the input.
    Ok(json!({"message_id": id, "to": {"id": target.id, "name": target_name}, "text": text}))
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
