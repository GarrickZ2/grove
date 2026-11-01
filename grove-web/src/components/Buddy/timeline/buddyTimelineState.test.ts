import { expect, it } from "vitest";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent } from "./buddyTimelineState";
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
