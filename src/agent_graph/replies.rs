//! Automatic replies: a Session's answer to a graph message is its final
//! response, not a tool call.
//!
//! `graph_send` opens a ticket here; Grove then follows the target's Turn
//! events and sends the outcome back to the sender, the way Buddy follow-ups
//! work. A turn that ends while the target still waits on its own graph
//! messages does not answer yet: the reply it receives continues the same
//! ticket, so the sender gets the integrated result rather than "I asked C".
//!
//! The `agent_pending_message` row stays the authoritative ticket and blocks a
//! second send until the reply has reached the sender's queue. This index only
//! routes Radio events and is rebuilt from nothing: open tickets cannot outlive
//! the Grove process, because their Agents do not.

use super::tools;
use crate::radio::{
    is_stop_reason, publish as broadcast_radio_event, RadioEvent, TurnAction, TurnActionKind,
    TurnEvent,
};
use crate::storage::{agent_graph as graph_db, database, tasks};
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

struct Ticket {
    msg_id: String,
    project: String,
    task: String,
    from: String,
    /// Kept here because the user may delete this Session before it answers.
    replier: tasks::ChatSession,
    /// Prompts on the target whose outcome this ticket still waits for: the
    /// message itself, plus replies to anything the target delegated meanwhile.
    rounds: HashSet<String>,
    /// The outcome is in the next turn on the target, which no ticket knows
    /// the id of: the answer to an ask_form, or the prompt that interrupted it.
    adopts_next_turn: bool,
}

/// Open tickets by target Session.
static OPEN: Lazy<Mutex<HashMap<String, Vec<Ticket>>>> = Lazy::new(Mutex::default);

/// A ticket whose outcome is ready to go back to its sender.
struct Settled {
    msg_id: String,
    project: String,
    task: String,
    from: String,
    replier: tasks::ChatSession,
    /// Queue id of the reply on the sender, reserved before delivery so the
    /// sender's own tickets already wait on it.
    reply_round: String,
    body: String,
}

/// Follow `msg_id`, which is also the queue id of the prompt on `target`.
/// Call before delivery so even the fastest Turn event finds its ticket.
pub(crate) fn watch(
    project: &str,
    task: &str,
    from: &str,
    target: &tasks::ChatSession,
    msg_id: &str,
) {
    OPEN.lock()
        .unwrap()
        .entry(target.id.clone())
        .or_default()
        .push(Ticket {
            msg_id: msg_id.to_owned(),
            project: project.to_owned(),
            task: task.to_owned(),
            from: from.to_owned(),
            replier: target.clone(),
            rounds: HashSet::from([msg_id.to_owned()]),
            adopts_next_turn: false,
        });
}

/// Delivery failed: the message never reached the target.
pub(crate) fn unwatch(target: &str, msg_id: &str) {
    let mut open = OPEN.lock().unwrap();
    if let Some(tickets) = open.get_mut(target) {
        tickets.retain(|ticket| ticket.msg_id != msg_id);
        if tickets.is_empty() {
            open.remove(target);
        }
    }
}

/// True when this Session still waits on a message it sent.
fn awaits_replies(chat: &str) -> bool {
    graph_db::awaiting_reply_for(&database::connection(), chat)
        .map(|sent| !sent.is_empty())
        .unwrap_or(false)
}

/// Whether the turn ending now answers a graph message, so the graph can show
/// the node as done in the same status update that marks it idle.
pub(crate) fn turn_answers(chat: &str, turn: &[String]) -> bool {
    turn_finishes_ticket(chat, turn) && !awaits_replies(chat)
}

fn turn_finishes_ticket(chat: &str, turn: &[String]) -> bool {
    OPEN.lock().unwrap().get(chat).is_some_and(|tickets| {
        tickets.iter().any(|ticket| {
            !ticket.adopts_next_turn
                && turn.iter().any(|id| ticket.rounds.contains(id))
                && ticket.rounds.iter().all(|id| turn.contains(id))
        })
    })
}

fn settled(ticket: &Ticket, body: String) -> Settled {
    Settled {
        msg_id: ticket.msg_id.clone(),
        project: ticket.project.clone(),
        task: ticket.task.clone(),
        from: ticket.from.clone(),
        replier: ticket.replier.clone(),
        reply_round: uuid::Uuid::new_v4().to_string(),
        body,
    }
}

fn answer_body(stop_reason: &str, message: &str, action: Option<TurnAction>) -> String {
    if !is_stop_reason(stop_reason) {
        return if message.is_empty() {
            "The Session finished its turn without a written response.".to_owned()
        } else {
            message.to_owned()
        };
    }
    let mut body = action.map_or_else(
        || "The Session was stopped before it finished.".to_owned(),
        TurnAction::notice,
    );
    if !message.is_empty() {
        body.push_str(" Its response so far:\n\n");
        body.push_str(message);
    }
    body
}

fn is_interrupt(action: Option<TurnAction>) -> bool {
    action.is_some_and(|action| action.kind == TurnActionKind::Interrupt)
}

/// Fold one Turn event of `chat` into its tickets. Returns the ones it settled.
fn observe(chat: &str, ids: &[String], event: &TurnEvent) -> Vec<Settled> {
    if !OPEN.lock().unwrap().contains_key(chat) {
        return Vec::new();
    }
    // Outside the lock: `connection()` can wait on a writer.
    let delegating = matches!(
        event,
        TurnEvent::Completed { .. } | TurnEvent::Removed { .. }
    ) && awaits_replies(chat);
    fold(chat, ids, event, delegating)
}

/// `delegating`: `chat` still waits on a message it sent.
fn fold(chat: &str, ids: &[String], event: &TurnEvent, delegating: bool) -> Vec<Settled> {
    let mut open = OPEN.lock().unwrap();
    let Some(tickets) = open.get_mut(chat) else {
        return Vec::new();
    };
    let mut done = Vec::new();
    tickets.retain_mut(|ticket| {
        if ticket.adopts_next_turn && matches!(event, TurnEvent::Started) && !ids.is_empty() {
            ticket.adopts_next_turn = false;
            ticket.rounds.extend(ids.iter().cloned());
        }
        let hit = ids.iter().any(|id| ticket.rounds.contains(id));
        let outcome = match event {
            TurnEvent::AskFormRequired { .. } if hit => {
                ticket.adopts_next_turn = true;
                None
            }
            TurnEvent::Completed {
                stop_reason,
                message,
                action,
                ..
            } if hit => {
                ticket.rounds.retain(|id| !ids.contains(id));
                // Interrupted to take a new prompt, the Session carries on
                // with the same context; the sender gets where it ends up.
                ticket.adopts_next_turn |= is_interrupt(*action);
                let waits = ticket.adopts_next_turn || !ticket.rounds.is_empty() || delegating;
                (!is_interrupt(*action) && (is_stop_reason(stop_reason) || !waits))
                    .then(|| answer_body(stop_reason, message, *action))
            }
            TurnEvent::Failed { message } if hit => {
                Some(format!("The Session failed to answer: {message}"))
            }
            TurnEvent::Removed { action } if hit => {
                ticket.rounds.retain(|id| !ids.contains(id));
                let waits = ticket.adopts_next_turn || !ticket.rounds.is_empty() || delegating;
                (!waits).then(|| {
                    action.map_or_else(
                        || "Your message was removed before the Session read it.".to_owned(),
                        TurnAction::notice,
                    )
                })
            }
            // Someone closed it: nothing is coming, whatever the ticket waits on.
            TurnEvent::SessionEnded {
                action: Some(action),
            } => Some(action.notice()),
            // A ticket with nothing running only waits on a reply or a form,
            // and either one starts the Session again, so idle retirement
            // must not fail it.
            TurnEvent::SessionEnded { action: None } if !ticket.rounds.is_empty() => {
                Some("The Session ended before it finished.".to_owned())
            }
            _ => None,
        };
        match outcome {
            Some(body) => {
                done.push(settled(ticket, body));
                false
            }
            None => true,
        }
    });
    if tickets.is_empty() {
        open.remove(chat);
    }
    // The sender's own tickets keep waiting until it has read this reply.
    for reply in &done {
        if let Some(tickets) = open.get_mut(&reply.from) {
            for ticket in tickets {
                ticket.rounds.insert(reply.reply_round.clone());
            }
        }
    }
    done
}

fn close_ticket(reply: &Settled) {
    let removed = {
        let conn = database::connection();
        graph_db::delete_pending_message(&conn, &reply.msg_id).is_ok()
    };
    if removed {
        broadcast_radio_event(RadioEvent::PendingChanged {
            project_id: reply.project.clone(),
            task_id: reply.task.clone(),
            msg_id: reply.msg_id.clone(),
            from_chat_id: reply.from.clone(),
            to_chat_id: reply.replier.id.clone(),
            op: "deleted".to_string(),
            body_excerpt: None,
        });
    }
}

/// Send one settled ticket back to its sender. The ticket closes only once the
/// reply is in the sender's queue, so there is never a gap in which the sender
/// could send again with its previous answer in neither place.
async fn deliver(first: Settled) {
    let mut work = vec![first];
    while let Some(reply) = work.pop() {
        let result = tools::deliver_reply(
            &reply.project,
            &reply.task,
            &reply.from,
            &reply.replier,
            &reply.body,
            reply.reply_round.clone(),
        )
        .await;
        close_ticket(&reply);
        if let Err(error) = result {
            eprintln!("[Agent Graph] Reply to {} failed: {error}", reply.from);
            work.extend(observe(
                &reply.from,
                std::slice::from_ref(&reply.reply_round),
                &TurnEvent::Removed { action: None },
            ));
        }
    }
}

/// Start following Radio. Call once when the server starts. Agents do not
/// survive a restart, so tickets left from the last run can never be answered
/// and would block their senders for good.
pub fn start() {
    if let Err(error) = graph_db::clear_pending_messages(&database::connection()) {
        eprintln!("[Agent Graph] Clearing stale tickets failed: {error}");
    }
    let mut events = crate::radio::subscribe();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            let RadioEvent::Turn {
                chat_id,
                message_ids,
                event,
                ..
            } = &event
            else {
                continue;
            };
            for reply in observe(chat_id, message_ids, event) {
                // A cold sender takes a while to start; keep consuming events.
                tokio::spawn(deliver(reply));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch_(from: &str, target: &str, msg_id: &str) {
        let replier = tasks::ChatSession {
            id: target.to_owned(),
            title: target.to_owned(),
            agent: "claude".to_owned(),
            acp_session_id: None,
            created_at: chrono::Utc::now(),
            duty: None,
        };
        watch("p", "t", from, &replier, msg_id);
    }

    fn stopped(action: Option<TurnAction>) -> TurnEvent {
        TurnEvent::Completed {
            stop_reason: "Cancelled".into(),
            message: "partial".into(),
            quiet: false,
            action,
        }
    }

    fn completed(message: &str) -> TurnEvent {
        TurnEvent::Completed {
            stop_reason: "EndTurn".into(),
            message: message.into(),
            quiet: false,
            action: None,
        }
    }

    fn fold_(chat: &str, ids: &[String], event: &TurnEvent) -> Vec<Settled> {
        fold(chat, ids, event, false)
    }

    fn ids(id: &str) -> Vec<String> {
        vec![id.to_owned()]
    }

    fn open(chat: &str) -> usize {
        OPEN.lock().unwrap().get(chat).map_or(0, Vec::len)
    }

    #[test]
    fn final_response_settles_the_ticket() {
        watch_("reply-a", "reply-b", "m1");
        assert!(fold_("reply-b", &ids("m1"), &TurnEvent::Started).is_empty());
        assert!(fold_("reply-b", &ids("other"), &completed("no")).is_empty());
        let done = fold_("reply-b", &ids("m1"), &completed("answer"));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].from, "reply-a");
        assert_eq!(done[0].replier.id, "reply-b");
        assert_eq!(done[0].msg_id, "m1");
        assert_eq!(done[0].body, "answer");
        assert_eq!(open("reply-b"), 0);
    }

    #[test]
    fn merged_prompts_each_get_the_answer() {
        watch_("merge-a", "merge-b", "m1");
        watch_("merge-c", "merge-b", "m2");
        let merged = vec!["m1".to_owned(), "m2".to_owned()];
        assert_eq!(
            fold_("merge-b", &merged, &completed("both")).len(),
            2,
            "a Compact merge answers every sender"
        );
    }

    #[test]
    fn failure_cancel_and_session_end_are_reported() {
        watch_("bad-a", "bad-b", "m1");
        let failed = TurnEvent::Failed {
            message: "boom".into(),
        };
        assert!(fold_("bad-b", &ids("m1"), &failed)[0].body.contains("boom"));

        watch_("bad-a", "bad-b", "m2");
        let body = fold_("bad-b", &ids("m2"), &stopped(None)).remove(0).body;
        assert!(body.contains("stopped") && body.contains("partial"));
        assert!(!body.contains("deliberate"));

        watch_("bad-a", "bad-b", "m3");
        assert_eq!(
            fold_("bad-b", &[], &TurnEvent::SessionEnded { action: None }).len(),
            1
        );
    }

    #[test]
    fn removed_from_the_queue_is_reported() {
        watch_("gone-a", "gone-b", "m1");
        let body = fold_("gone-b", &ids("m1"), &TurnEvent::Removed { action: None })
            .remove(0)
            .body;
        assert!(body.contains("removed"));
    }

    #[test]
    fn ask_form_waits_for_the_answer_turn() {
        watch_("form-a", "form-b", "m1");
        let form = TurnEvent::AskFormRequired {
            form_id: "f".into(),
            definition: serde_json::from_value(serde_json::json!({"title":"t","questions":[]}))
                .unwrap(),
        };
        assert!(fold_("form-b", &ids("m1"), &form).is_empty());
        assert!(fold_("form-b", &ids("m1"), &completed("asked")).is_empty());
        // The Agent can be retired while the user thinks.
        assert!(fold_("form-b", &[], &TurnEvent::SessionEnded { action: None }).is_empty());
        assert!(fold_("form-b", &ids("answer"), &TurnEvent::Started).is_empty());
        assert_eq!(
            fold_("form-b", &ids("answer"), &completed("final"))[0].body,
            "final"
        );
    }

    #[test]
    fn user_actions_read_as_deliberate() {
        watch_("act-a", "act-b", "m1");
        let cancel = stopped(Some(TurnAction::user(TurnActionKind::Cancel)));
        let body = fold_("act-b", &ids("m1"), &cancel).remove(0).body;
        assert!(body.starts_with("The user stopped this Session on purpose"));
        assert!(body.contains("do not retry") && body.contains("partial"));

        watch_("act-a", "act-b", "m2");
        let removed = TurnEvent::Removed {
            action: Some(TurnAction::user(TurnActionKind::Remove)),
        };
        let body = fold_("act-b", &ids("m2"), &removed).remove(0).body;
        assert!(body.contains("The user removed the message"));
    }

    #[test]
    fn interrupted_session_answers_from_where_it_ends_up() {
        watch_("int-a", "int-b", "m1");
        let interrupt = stopped(Some(TurnAction::user(TurnActionKind::Interrupt)));
        assert!(fold_("int-b", &ids("m1"), &interrupt).is_empty());
        assert!(fold_("int-b", &ids("correction"), &TurnEvent::Started).is_empty());
        assert_eq!(
            fold_("int-b", &ids("correction"), &completed("redone"))[0].body,
            "redone"
        );
    }

    #[test]
    fn closing_a_session_answers_even_a_ticket_with_nothing_running() {
        watch_("end-a", "end-b", "m1");
        assert!(fold("end-b", &ids("m1"), &completed("asked"), true).is_empty());
        let closed = TurnEvent::SessionEnded {
            action: Some(TurnAction::user(TurnActionKind::EndSession)),
        };
        let done = fold_("end-b", &[], &closed);
        assert!(done[0].body.contains("The user closed this Session"));
        assert_eq!(done[0].replier.title, "end-b");
    }

    #[test]
    fn delegated_reply_continues_the_ticket() {
        // chain-a → chain-b → chain-c. b's first turn only delegates.
        watch_("chain-a", "chain-b", "ab");
        watch_("chain-b", "chain-c", "bc");
        assert!(
            fold("chain-b", &ids("ab"), &completed("asked c"), true).is_empty(),
            "b still owes a's answer"
        );
        // Nothing runs now, so b may be retired while it waits.
        assert!(fold_("chain-b", &[], &TurnEvent::SessionEnded { action: None }).is_empty());
        // c answers: b reads it, and that turn's response goes back to a.
        let reply = fold_("chain-c", &ids("bc"), &completed("from c")).remove(0);
        assert_eq!(reply.from, "chain-b");
        let done = fold_("chain-b", &ids(&reply.reply_round), &completed("merged"));
        assert_eq!(done[0].from, "chain-a");
        assert_eq!(done[0].body, "merged");
    }

    #[test]
    fn reply_landing_during_the_turn_holds_the_answer() {
        watch_("race-a", "race-b", "ab");
        watch_("race-b", "race-c", "bc");
        // c finished first, so b no longer awaits it, but has not read it yet.
        let reply = fold_("race-c", &ids("bc"), &completed("c")).remove(0);
        assert!(fold_("race-b", &ids("ab"), &completed("asked")).is_empty());
        assert_eq!(
            fold_("race-b", &ids(&reply.reply_round), &completed("merged"))[0].body,
            "merged"
        );
    }

    #[test]
    fn a_lost_inner_reply_still_answers_the_sender() {
        watch_("lost-a", "lost-b", "ab");
        watch_("lost-b", "lost-c", "bc");
        let reply = fold_("lost-c", &ids("bc"), &completed("c")).remove(0);
        assert!(fold_("lost-b", &ids("ab"), &completed("asked")).is_empty());
        assert_eq!(
            fold_(
                "lost-b",
                &ids(&reply.reply_round),
                &TurnEvent::Removed { action: None }
            )
            .len(),
            1
        );
    }

    #[test]
    fn only_the_last_round_finishes_a_ticket() {
        watch_("last-a", "last-b", "m1");
        assert!(turn_finishes_ticket("last-b", &ids("m1")));
        assert!(!turn_finishes_ticket("last-b", &ids("user-turn")));
        OPEN.lock().unwrap().get_mut("last-b").unwrap()[0]
            .rounds
            .insert("reply".into());
        assert!(!turn_finishes_ticket("last-b", &ids("m1")));
    }
}
