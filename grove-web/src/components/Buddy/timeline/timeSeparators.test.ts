import { expect, it } from "vitest";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent } from "./buddyTimelineState";
import { SEPARATOR_GAP_MS, separatorLabel, timeSeparators } from "./timeSeparators";

const at = (time: number) => new Date(2026, 9, 31, ...([Math.floor(time / 60), time % 60] as const)).getTime();

it("marks the first message and any message after a quiet stretch", () => {
  const events: [BuddyEvent, number][] = [
    [{ type: "user_message", text: "close out the card", message_id: "u1" }, at(9 * 60)],
    [{ type: "user_message", text: "and the hotel", message_id: "u2" }, at(9 * 60 + 5)],
    [{ type: "user_message", text: "two nights", message_id: "u3" }, at(9 * 60 + 5) + SEPARATOR_GAP_MS],
  ];
  const state = events.reduce((value, [event, ms]) => reduceBuddyEvent(value, event, ms), emptyBuddyTimeline());
  const marks = timeSeparators(state.rows, state);
  expect([...marks.keys()]).toEqual([state.rows[0].id, state.rows[2].id]);
});

it("labels today by clock, then yesterday, weekday and date", () => {
  const now = at(18 * 60);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(separatorLabel(at(16 * 60 + 59), now)).toBe(clock(at(16 * 60 + 59)));
  const yesterday = at(21 * 60 + 59) - 24 * 60 * 60 * 1000;
  expect(separatorLabel(yesterday, now)).toBe(`Yesterday ${clock(yesterday)}`);
  const lastWeek = now - 3 * 24 * 60 * 60 * 1000;
  expect(separatorLabel(lastWeek, now)).toContain(new Date(lastWeek).toLocaleDateString([], { weekday: "long" }));
  expect(separatorLabel(new Date(2025, 0, 2, 9).getTime(), now)).toContain("2025");
});
