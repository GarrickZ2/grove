//! Agent Graph — agent-to-agent communication tools.
//!
//! Tools (`grove_agent_spawn` / `_send` / `_reply` / `_contacts` / `_capability`)
//! used by ACP agents inside a Grove task to communicate with sibling sessions
//! over the agent_graph DAG.
//!
//! Architecture (Phase 2 / WO-006):
//! - This module defines the **transport-agnostic** tool logic. Each tool is a
//!   pure async fn taking a `ToolContext` (caller chat_id, db, session map)
//!   plus typed input, returning typed output.
//! - The HTTP MCP transport layer (`src/api/handlers/agent_graph_mcp.rs`,
//!   added in Commit 2 of this WO) wraps these functions as MCP `tools/call`
//!   handlers exposed at `http://127.0.0.1:<mcp_port>/mcp/<token>`. The token
//!   is the binding from HTTP request → caller chat_id.
//! - On send / reply, messages are injected into the target session via
//!   `AcpSessionHandle::send_prompt(text, attachments, sender, terminal=false)`
//!   when target is idle, or `AcpSessionHandle::queue_message(QueuedMessage{
//!   text, attachments, sender })` when target is busy. Both paths surface to
//!   the frontend via the existing `AcpUpdate::UserMessage` / `QueueUpdate`
//!   broadcast and persist to `chat_history.jsonl`.
//! - `sender` is `Some("agent:<caller_chat_id>")` for agent-injected prompts,
//!   `None` for normal user input. This is the canonical sender identity used
//!   by storage and UI; the `<grove-meta>{...}</grove-meta>` envelope at the
//!   head of the prompt body (see `inject::build_injected_prompt`) is woven in
//!   for AI context + frontend rendering and is not the source of truth.

pub mod error;
pub mod inject;
pub mod tools;
pub mod user_ops;

/// Truncate a string to at most `max` chars, appending an ellipsis if and
/// only if there were more characters. Char-based (not byte-based) so CJK /
/// emoji counts are intuitive.
pub fn excerpt_chars(body: &str, max: usize) -> String {
    let mut iter = body.chars();
    let head: String = iter.by_ref().take(max).collect();
    if iter.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Pending message body excerpt for the popup card / `PendingChanged` event.
/// Same input yields identical output across event push and `GET /graph`
/// re-hydration (both surfaces call this).
pub fn pending_body_excerpt(body: &str) -> String {
    excerpt_chars(body, 120)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_short_passes_through() {
        assert_eq!(pending_body_excerpt("hi"), "hi");
    }

    #[test]
    fn excerpt_truncates_long_text_at_char_boundary() {
        let s = "a".repeat(200);
        let e = pending_body_excerpt(&s);
        assert_eq!(e.chars().count(), 121); // 120 + ellipsis
        assert!(e.ends_with('…'));
    }

    #[test]
    fn excerpt_handles_multibyte() {
        let s = "你".repeat(200);
        let e = pending_body_excerpt(&s);
        assert_eq!(e.chars().count(), 121);
        assert!(e.ends_with('…'));
        assert!(e.starts_with("你"));
    }

    /// Boundary: exactly MAX chars must NOT be truncated (and must NOT
    /// collapse to a lone ellipsis).
    #[test]
    fn excerpt_exactly_at_boundary_returns_original() {
        let s = "a".repeat(120);
        assert_eq!(pending_body_excerpt(&s), s);
        let cjk = "你".repeat(120);
        assert_eq!(pending_body_excerpt(&cjk), cjk);
    }

    /// One past boundary: one ellipsis appended.
    #[test]
    fn excerpt_one_past_boundary_truncates_one() {
        let s = "a".repeat(121);
        let e = pending_body_excerpt(&s);
        assert_eq!(e.chars().count(), 121);
        assert!(e.ends_with('…'));
    }
}
