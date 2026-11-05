//! Settled outcome of an agent's last turn, shown beside its live status.
//!
//! The live status (`busy` / `permission_required` / `idle` / ...) says what
//! the session is doing now. Once it is idle, the outcome says how its last
//! turn ended, from two signals Grove already records:
//!
//! - **error** — the ACP `session/prompt` request itself failed (JSON-RPC
//!   error, auth required, transport failure). Cancels, kills and other stop
//!   reasons are not errors.
//! - **done** — its last turn answered the message it was given: the final
//!   response went back to the sender (see `replies`), the turn ended with
//!   `end_turn`, and it owes no other reply. This is completion in the graph
//!   sense: a delegated agent handed its result back to whoever asked.
//!
//! Both live on the in-memory session handle, so they reset when the session
//! starts a new turn and disappear with the session (the node then reads as
//! disconnected).

/// How the most recent turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TurnEnd {
    /// No turn yet, or one is still running.
    #[default]
    Running,
    /// The agent ended its turn normally (`end_turn`).
    EndTurn,
    /// The prompt request failed.
    Failed,
    /// Cancelled, killed, or stopped for another reason (max tokens, refusal).
    Stopped,
}

impl TurnEnd {
    /// Map a stop reason as Grove records it (`format!("{:?}")` of the ACP
    /// `StopReason`, e.g. `EndTurn`, or the snake_case wire form) to a turn end.
    pub fn from_stop_reason(stop_reason: &str) -> Self {
        let normalized: String = stop_reason
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if normalized == "endturn" {
            TurnEnd::EndTurn
        } else {
            TurnEnd::Stopped
        }
    }
}

/// Per-session record of the current/last turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TurnRecord {
    /// This turn's final response answers a graph message.
    pub replied: bool,
    pub end: TurnEnd,
}

impl TurnRecord {
    /// A new turn started: forget the previous outcome.
    pub fn start(&mut self) {
        *self = Self::default();
    }

    /// This turn answers a graph message.
    pub fn record_reply(&mut self) {
        self.replied = true;
    }

    pub fn finish(&mut self, end: TurnEnd) {
        self.end = end;
    }
}

/// Outcome wire values for `GraphNode.outcome` / `ChatStatus.outcome`.
pub const OUTCOME_ERROR: &str = "error";
pub const OUTCOME_DONE: &str = "done";

/// Derive the outcome shown for a node. Only an idle node has one: a busy or
/// asking node is described by its live status alone. `owes_reply` is true
/// when a graph message addressed to this node is still waiting for its reply.
pub fn node_outcome(status: &str, record: TurnRecord, owes_reply: bool) -> Option<&'static str> {
    if status != "idle" {
        return None;
    }
    match record.end {
        TurnEnd::Failed => Some(OUTCOME_ERROR),
        TurnEnd::EndTurn if record.replied && !owes_reply => Some(OUTCOME_DONE),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ended(end: TurnEnd, replied: bool) -> TurnRecord {
        TurnRecord { replied, end }
    }

    #[test]
    fn stop_reason_mapping() {
        assert_eq!(TurnEnd::from_stop_reason("EndTurn"), TurnEnd::EndTurn);
        assert_eq!(TurnEnd::from_stop_reason("end_turn"), TurnEnd::EndTurn);
        assert_eq!(TurnEnd::from_stop_reason("Cancelled"), TurnEnd::Stopped);
        assert_eq!(TurnEnd::from_stop_reason("MaxTokens"), TurnEnd::Stopped);
        assert_eq!(TurnEnd::from_stop_reason("Refusal"), TurnEnd::Stopped);
        assert_eq!(TurnEnd::from_stop_reason("killed"), TurnEnd::Stopped);
    }

    #[test]
    fn failed_turn_is_error_even_after_a_reply() {
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::Failed, false), false),
            Some("error")
        );
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::Failed, true), false),
            Some("error")
        );
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::Failed, false), true),
            Some("error")
        );
    }

    #[test]
    fn replied_and_ended_normally_is_done() {
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::EndTurn, true), false),
            Some("done")
        );
    }

    #[test]
    fn not_done_without_reply_or_with_reply_owed() {
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::EndTurn, false), false),
            None
        );
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::EndTurn, true), true),
            None
        );
    }

    #[test]
    fn stopped_or_running_has_no_outcome() {
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::Stopped, true), false),
            None
        );
        assert_eq!(
            node_outcome("idle", ended(TurnEnd::Running, true), false),
            None
        );
        assert_eq!(node_outcome("idle", TurnRecord::default(), false), None);
    }

    #[test]
    fn only_idle_nodes_have_an_outcome() {
        for status in ["busy", "permission_required", "connecting", "disconnected"] {
            assert_eq!(
                node_outcome(status, ended(TurnEnd::Failed, false), false),
                None
            );
            assert_eq!(
                node_outcome(status, ended(TurnEnd::EndTurn, true), false),
                None
            );
        }
    }

    #[test]
    fn starting_a_turn_clears_the_record() {
        let mut record = ended(TurnEnd::EndTurn, true);
        record.start();
        assert_eq!(record, TurnRecord::default());
        record.record_reply();
        record.finish(TurnEnd::EndTurn);
        assert_eq!(node_outcome("idle", record, false), Some("done"));
        record.start();
        record.finish(TurnEnd::Failed);
        assert_eq!(node_outcome("idle", record, false), Some("error"));
    }
}
