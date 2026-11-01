import { expect, it } from "vitest";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent } from "./buddyTimelineState";
import { visibleRows } from "./visibleRows";

const run = (events: BuddyEvent[]) => events.reduce((state, event, i) => reduceBuddyEvent(state, event, 1000 + i * 1000), emptyBuddyTimeline());
const describe = (events: BuddyEvent[]) => {
  const state = run(events);
  return visibleRows(state).map(row => {
    if (row.kind !== "message") return row.kind;
    const message = state.messages[row.index];
    return `${message.type}:${message.type === "user" || message.type === "assistant" ? message.content : ""}`;
  });
};
const turn: BuddyEvent[] = [
  { type: "user_message", text: "Check my repo" },
  { type: "prompt_started" },
  { type: "permission_request", id: "p", title: "mcp__grove_buddy__list_projects", options: [{ option_id: "yes", name: "Yes", kind: "allow_once" }] },
  { type: "permission_response", id: "p", option_id: "yes" },
  { type: "message_chunk", text: "Positions are in. Working out P&L…" },
  { type: "tool_call", id: "t", title: "Read" },
  { type: "message_chunk", text: "Here is the summary." },
];

it("keeps only the final answer of a finished turn", () => {
  expect(describe([...turn, { type: "complete" }])).toEqual(["user:Check my repo", "assistant:Here is the summary."]);
  const state = run([...turn, { type: "complete" }]);
  const rows = visibleRows(state);
  expect(rows[1].kind === "message" && state.messages[rows[1].index]).toMatchObject({ startTs: 2, endTs: 8 });
});

it("shows the turn in progress whole, including handled approvals and interim text", () => {
  expect(describe(turn)).toEqual(["user:Check my repo", "activity", "approval", "assistant:Positions are in. Working out P&L…", "assistant:Here is the summary."]);
});

it("treats hidden prompts as turn boundaries and keeps pending requests", () => {
  const rows = describe([...turn, { type: "complete" }, { type: "user_message", text: "routine", sender: "automation:a" }, { type: "message_chunk", text: "Routine reply" }, { type: "permission_request", id: "q", title: "Write", options: [] }, { type: "complete" }]);
  expect(rows.slice(2)).toEqual(["user:routine", "assistant:Routine reply", "approval"]);
});
