import { expect, it } from "vitest";
import { restoreBuddyHistory, restorePreviousSegments, withPreviousSegments } from "./buddySegmentHistory";
import { emptyBuddyTimeline, reduceBuddyEvent } from "./buddyTimelineState";

it("retains prior messages with an empty new Segment and isolates reused message IDs across Agents", () => {
  const previous = restorePreviousSegments([
    { session_id: "first", ended_at: "2026-10-31T01:00:00Z", events: [{ type: "user_message", message_id: "u", text: "Original request" }, { type: "message_chunk", message_id: "a", text: "First answer" }] },
    { session_id: "second", ended_at: "2026-10-31T02:00:00Z", events: [{ type: "user_message", message_id: "u", text: "Follow-up" }, { type: "message_chunk", message_id: "a", text: "Second answer" }] },
  ]);
  expect(withPreviousSegments(previous, emptyBuddyTimeline()).messages.map(message => "content" in message ? message.content : undefined)).toEqual(["Original request", "First answer", "Follow-up", "Second answer"]);
  let current = restoreBuddyHistory([{ type: "user_message", message_id: "u", text: "New Agent request" }, { type: "message_chunk", message_id: "a", text: "New answer" }]);
  current = reduceBuddyEvent(current, { type: "message_chunk", message_id: "a", text: " continues" });
  const joined = withPreviousSegments(previous, current);
  expect(joined.messages.map(message => "content" in message ? message.content : undefined)).toEqual(["Original request", "First answer", "Follow-up", "Second answer", "New Agent request", "New answer continues"]);
  expect(joined.rows.filter(row => row.kind === "message").map(row => row.index)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(new Set(joined.rows.map(row => row.id)).size).toBe(joined.rows.length);
  expect(previous.messages.map(message => "content" in message ? message.content : undefined)).toEqual(["Original request", "First answer", "Follow-up", "Second answer"]);
});

it("closes old activities and requests without resolving matching requests on the active Segment", () => {
  const events = [
    { type: "prompt_started", message_ids: ["prompt"] },
    { type: "permission_request", id: "permission", options: [] },
    { type: "ask_form", form_id: "form", definition: { title: "Question", questions: [] } },
  ];
  const previous = restorePreviousSegments([{ session_id: "old", ended_at: "2026-10-31T01:00:00Z", events }]);
  const current = restoreBuddyHistory(events);
  const joined = withPreviousSegments(previous, current);
  expect(previous.rows.find(row => row.kind === "activity")).toMatchObject({ ended: Date.parse("2026-10-31T01:00:00Z") });
  expect(previous.rows.filter(row => row.kind === "approval" || row.kind === "question").every(row => row.resolved === "No longer pending")).toBe(true);
  expect(joined.rows.find(row => row.id === "permission")).not.toHaveProperty("resolved");
  expect(joined.rows.find(row => row.id === "form")).not.toHaveProperty("resolved");
  expect(joined.busy).toBe(true);
  expect(joined.activity).toBe(current.activity);
});
