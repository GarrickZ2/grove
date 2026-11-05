import { describe, expect, it } from "vitest";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent } from "./buddyTimelineState";
import { quietTurnText, visibleRows } from "./visibleRows";
const run = (events: BuddyEvent[]) => events.reduce((state, event, i) => reduceBuddyEvent(state, event, 1000 + i * 1000), emptyBuddyTimeline());
it("hides non-human prompts while retaining replies and IM prompts", () => {
  const state = run([{ type: "user_message", text: "routine", sender: "automation:a" }, { type: "message_chunk", text: "Daily summary" }, { type: "user_message", text: "Hello", sender: "connect" }]);
  expect(state.messages.filter(m => m.type !== "user" || !m.sender || m.sender === "connect").map(m => "content" in m ? m.content : "")).toEqual(["Daily summary", "Hello"]);
});
it("combines tools, thinking and plans into one activity per turn", () => {
  const state = run([{ type: "prompt_started" }, { type: "thought_chunk", text: "private thought" }, { type: "tool_call", id: "t", title: "Read files", input: "secret" }, { type: "tool_call_update", id: "t", title: "Read files", status: "completed" }, { type: "plan", entries: [] }, { type: "complete" }]);
  expect(state.rows).toHaveLength(1);
  expect(state.rows[0]).toMatchObject({ kind: "activity", started: 1000, ended: 6000, steps: [{ id: "working", title: "Working…" }, { id: "thinking", title: "Thinking…" }, { id: "t", title: "Read files" }, { id: "plan", title: "Planning next steps" }] });
  expect(JSON.stringify(state.rows)).not.toContain("secret");
});
it("shows accepted queued inputs once, including a compact combined echo", () => {
  const state = run([{ type: "buddy_input", client_message_id: "1", text: "One" }, { type: "input_accepted", client_message_id: "1" }, { type: "buddy_input", client_message_id: "2", text: "Two" }, { type: "input_accepted", client_message_id: "2" }, { type: "prompt_started", message_ids: ["1", "2"] }, { type: "user_message", text: "One\nTwo" }]);
  expect(state.messages.map(m => "content" in m ? m.content : "")).toEqual(["One", "Two"]);
});
it("deduplicates pending requests and resolves only the response request id", () => {
  const state = run([{ type: "permission_request", id: "a", title: "Run", options: [] }, { type: "permission_request", id: "a", title: "Run", options: [] }, { type: "permission_request", id: "b", title: "Write", options: [] }, { type: "permission_response", id: "a", option_id: "allow" }]);
  expect(state.rows).toHaveLength(2); expect(state.rows[0]).toMatchObject({ resolved: "allow" }); expect(state.rows[1]).not.toHaveProperty("resolved");
});
it("keeps ask_form pending after Complete and supports elicitation validation retry", () => {
  const state = run([{ type: "ask_form", form_id: "f", definition: { title: "Choice", questions: [] } }, { type: "complete" }, { type: "elicitation_request", request_id: "e", agent_name: "Agent", request: { mode: "form", message: "Email" } }, { type: "elicitation_validation_error", request_id: "e", message: "Invalid" }]);
  expect(state.rows[0]).not.toHaveProperty("resolved"); expect(state.rows[1]).toMatchObject({ error: "Invalid" });
});
it("renders ACP v2 text via the existing reducer", () => {
  const state = run([{ type: "v2_message_update", update: { messageId: "a", sessionUpdate: "agent_message", content: [{ type: "text", text: "Hello" }] } }]);
  expect(state.messages[0]).toMatchObject({ type: "assistant", content: "Hello" });
});
it("keeps routine replies in separate turns without displaying the routine prompt", () => {
  const state = run([{ type: "message_chunk", text: "First" }, { type: "complete" }, { type: "user_message", sender: "routine", text: "Internal prompt" }, { type: "message_chunk", text: "Second" }]);
  expect(state.messages.filter(m => m.type === "assistant").map(m => m.content)).toEqual(["First", "Second"]);
  // The prompt is kept (hidden) so the timeline can mark where it arrived.
  expect(state.messages[1]).toMatchObject({ type: "user", sender: "routine", content: "Internal prompt" });
});
it("only displays an elicitation answer after the server accepts it", () => {
  const start = [{ type: "elicitation_request", request_id: "e", agent_name: "Agent", request: { mode: "form", message: "Name" } }, { type: "buddy_answer", id: "e", text: "Alice" }];
  expect(run(start).messages).toHaveLength(0);
  expect(run([...start, { type: "elicitation_validation_error", request_id: "e", message: "Try again" }]).messages).toHaveLength(0);
  expect(run([...start, { type: "elicitation_resolved", request_id: "e", action: "accept" }]).messages[0]).toMatchObject({ type: "user", content: "Alice" });
});
it("adds one delegation row per buddy_delegate call and reads its id from the tool result", () => {
  const result = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ id: "del-1", buddy_id: "b", status: "running" }) }] });
  const state = run([{ type: "prompt_started" }, { type: "tool_call", id: "t", title: "mcp__grove-buddy__buddy_delegate", input: [{ label: "title", value: "Audit auth" }] }, { type: "tool_call_update", id: "t", status: "completed", content: result }, { type: "tool_call", id: "l", title: "mcp__grove-buddy__buddy_delegations" }, { type: "complete" }]);
  const delegations = state.rows.filter(row => row.kind === "delegation");
  expect(delegations).toEqual([{ kind: "delegation", id: "delegation-t", title: "Audit auth", delegationId: "del-1", failed: false }]);
});
it("adds a delegation row only for a send that starts a new Session", () => {
  const result = JSON.stringify({ message_id: "m", followup: { id: "fu-1", status: "running" } });
  const state = run([
    { type: "v2_tool_update", update: { toolCallId: "n", title: "mcp__grove_buddy__send", rawInput: { text: "Audit auth", new: { title: "Audit auth", target: { kind: "self" } } }, status: "completed", rawOutput: result } },
    { type: "v2_tool_update", update: { toolCallId: "e", title: "mcp__grove_buddy__send", rawInput: { text: "status?", session: "s" }, status: "completed" } },
  ]);
  expect(state.rows.filter(row => row.kind === "delegation")).toEqual([{ kind: "delegation", id: "delegation-n", title: "Audit auth", delegationId: "fu-1", failed: false }]);
});
it("marks a delegation row failed when the delegate tool fails", () => {
  const state = run([{ type: "v2_tool_update", update: { toolCallId: "v", title: "buddy_delegate", rawInput: { title: "Fix CI" }, status: "failed" } }]);
  expect(state.rows.find(row => row.kind === "delegation")).toMatchObject({ title: "Fix CI", failed: true, delegationId: undefined });
});
it("recognizes renamed Buddy tools and names routine events after the routine", () => {
  const state = run([{ type: "tool_call", id: "d", title: "mcp__grove_buddy__delegate", input: [{ label: "title", value: "Fix CI" }] }, { type: "tool_call", id: "r", title: "mcp__grove_buddy__create_routine", input: [{ label: "name", value: "Daily check" }] }, { type: "tool_call_update", id: "r", status: "completed" }, { type: "tool_call", id: "l", title: "mcp__grove_buddy__list_delegations" }]);
  expect(state.rows.filter(row => row.kind === "delegation").map(row => row.id)).toEqual(["delegation-d"]);
  expect(state.rows.find(row => row.kind === "event")).toMatchObject({ text: "Created routine · Daily check" });
});
it("times a replayed turn without prompt_started or tools from its complete stamp", () => {
  const state = [{ type: "user_message", text: "Hi" }, { type: "message_chunk", text: "Hello" }, { type: "complete", start_ts: 100, end_ts: 172 }].reduce((value, event) => reduceBuddyEvent(value, event, 5_000), emptyBuddyTimeline());
  expect(state.messages[1]).toMatchObject({ startTs: 100, endTs: 172 });
});
it("takes turn timing and send times from backend stamps, not the replay clock", () => {
  const state = [
    { type: "user_message", text: "Hi", client_message_id: "c1" },
    { type: "user_message_time", sent_at: 1_793_505_584_895, client_message_id: "c1" },
    { type: "prompt_started" },
    { type: "message_chunk", text: "Hello" },
    { type: "complete", start_ts: 1_793_505_584, end_ts: 1_793_505_656 },
  ].reduce((value, event) => reduceBuddyEvent(value, event, 5_000), emptyBuddyTimeline());
  expect(state.rows.find(row => row.kind === "activity")).toMatchObject({ started: 1_793_505_584_000, ended: 1_793_505_656_000 });
  expect(state.messages[0]).toMatchObject({ sentAt: 1_793_505_584_895 });
  expect(state.messages[1]).toMatchObject({ startTs: 1_793_505_584, endTs: 1_793_505_656 });
});
it("takes the recipient and text from the tool result when the call carries no input", () => {
  // MCP text content wrapping the JSON result, as agents report it.
  const state = run([
    { type: "tool_call", id: "m", title: "mcp__grove_buddy__message_buddy" },
    { type: "tool_call_update", id: "m", status: "completed", content: [{ type: "content", content: { type: "text", text: JSON.stringify({ message_id: "x", to: { id: "demo-1", name: "Demo" }, text: "Hello from Release Captain" }) } }] },
  ]);
  expect(state.rows.find(row => row.id === "buddy-chat-m")).toMatchObject({ notice: { lead: "Sent to", name: "Demo", buddyId: "demo-1", detail: "Hello from Release Captain" } });
});
it("shows a message to another Buddy as a notice with its text, named from the tool result", () => {
  const state = run([
    { type: "tool_call", id: "m", title: "mcp__grove_buddy__message_buddy", input: [{ label: "buddy", value: "bob" }, { label: "text", value: "Is the release branch cut?" }] },
    { type: "tool_call_update", id: "m", status: "completed", content: JSON.stringify({ message_id: "x", to: { id: "bob", name: "Bob" } }) },
    { type: "tool_call", id: "r", title: "mcp__grove_buddy__message_buddy", rawInput: { buddy: "Bob", text: "Thanks, go ahead", reply_to: "y" }, status: "failed" },
  ]);
  const notices = state.rows.filter(row => row.kind === "event");
  expect(notices).toMatchObject([
    { id: "buddy-chat-m", notice: { lead: "Sent to", name: "Bob", buddyId: "bob", detail: "Is the release branch cut?", tone: "neutral" } },
    { id: "buddy-chat-r", notice: { lead: "Couldn't reply to", name: "Bob", tone: "error" } },
  ]);
});

it("keeps a Buddy's prompt as one message when the Agent echoes it back", () => {
  const text = '<grove-meta>{"v":1,"type":"buddy_message","data":{"chat":true},"system-prompt":"From Dev"}</grove-meta>\nhello';
  const state = run([
    { type: "user_message", text, sender: "buddy:dev", client_message_id: "input-1" },
    { type: "v2_message_bind", client_message_id: "input-1", message_id: "agent-1" },
    { type: "v2_message_update", update: { sessionUpdate: "user_message", messageId: "agent-1", content: [{ type: "text", text }] } },
  ]);
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]).toMatchObject({ type: "user", sender: "buddy:dev", content: text });
});

it("folds a quiet turn to one line, keeping the prompt and its words", () => {
  const state = run([
    { type: "user_message", text: "routine", sender: "automation:a" },
    { type: "message_chunk", text: "All clear" },
    { type: "quiet_turn", reason: "Nothing new" },
    { type: "complete" },
  ]);
  const rows = visibleRows(state);
  expect(rows.map(row => row.kind)).toEqual(["message", "quiet"]);
  expect(rows[1]).toMatchObject({ reason: "Nothing new" });
  expect(quietTurnText(state, rows[1].id)).toBe("All clear");
});

it("keeps a pending approval visible in a quiet turn", () => {
  const state = reduceBuddyEvent(emptyBuddyTimeline(), { type: "quiet_turn", reason: "Nothing new" });
  const pending = { ...state, rows: [...state.rows, { kind: "approval", id: "a" } as never] };
  expect(visibleRows(pending).map(row => row.id)).toEqual([state.rows[0].id, "a"]);
});

describe("sign-in", () => {
  const required = { type: "auth_required", methods: [{ id: "login", name: "Log in" }], agent_name: "Claude" };

  it("asks for it, and clears once signed in", () => {
    const asked = run([{ type: "busy", value: true }, required]);
    expect(asked.busy).toBe(false);
    expect(asked.auth).toMatchObject({ status: "idle", agentName: "Claude" });
    expect(reduceBuddyEvent(reduceBuddyEvent(asked, { type: "buddy_auth_progress", method_id: "login" }, 0), { type: "auth_succeeded" }, 0).auth).toBeNull();
  });

  it("says why a sign-in failed", () => {
    expect(run([required, { type: "auth_failed", message: "Denied" }]).auth).toMatchObject({ status: "failed", errorMessage: "Denied" });
  });
});
