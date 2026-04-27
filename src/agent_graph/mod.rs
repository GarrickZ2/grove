// Dead-code allow: the public surface is consumed by Commit 2 (HTTP MCP listener)
// and Commit 3 (per-session URL injection); during Commit 1 nothing inside Grove
// calls these symbols yet. Tests exercise the validation paths.
#![allow(dead_code)]

//! Agent Graph — agent-to-agent communication tools.
//!
//! 5 tools (`grove_agent_spawn` / `_send` / `_reply` / `_contacts` / `_capability`)
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
//!   by storage and UI; the human-readable `[from:<name> · session=<id> ·
//!   kind=<send|reply>]` prefix is woven into the prompt body for AI context
//!   only and is not the source of truth.

pub mod error;
pub mod inject;
pub mod tools;
pub mod user_ops;
