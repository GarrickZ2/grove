import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent, type BuddyTimelineState } from "./buddyTimelineState";

export interface BuddySegmentHistory {
  session_id: string;
  ended_at: string;
  events: BuddyEvent[];
}

export function restoreBuddyHistory(events: BuddyEvent[]): BuddyTimelineState {
  return events.reduce((state, event) => reduceBuddyEvent(state, event, Number(event.timestamp) * 1000 || Date.now()), emptyBuddyTimeline());
}

/** Reduce each ended Session independently: ACP IDs and pending requests are Session-scoped. */
export function restorePreviousSegments(segments: BuddySegmentHistory[]): BuddyTimelineState {
  const result = emptyBuddyTimeline();
  for (const segment of segments) {
    const history = restoreBuddyHistory(segment.events);
    const closed = reduceBuddyEvent(history, { type: "session_ended" }, Date.parse(segment.ended_at) || Date.now());
    const reconciled = reduceBuddyEvent(closed, { type: "buddy_reconcile" });
    const offset = result.messages.length;
    result.messages.push(...reconciled.messages);
    result.rows.push(...reconciled.rows.map(row => ({ ...row, id: `${segment.session_id}:${row.id}`, ...(row.kind === "message" ? { index: row.index + offset } : {}) })));
  }
  return result;
}

/** Only current state receives live events or supplies runtime/pending state. */
export function withPreviousSegments(previous: BuddyTimelineState, current: BuddyTimelineState): BuddyTimelineState {
  if (!previous.rows.length) return current;
  return {
    ...current,
    messages: [...previous.messages, ...current.messages],
    rows: [...previous.rows, ...current.rows.map(row => row.kind === "message" ? { ...row, index: row.index + previous.messages.length } : row)],
  };
}
