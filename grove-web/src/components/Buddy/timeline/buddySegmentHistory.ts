import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent, type BuddyTimelineState } from "./buddyTimelineState";

export interface BuddySegmentHistory {
  session_id: string;
  ended_at: string;
  events: BuddyEvent[];
}

export function restoreBuddyHistory(events: BuddyEvent[]): BuddyTimelineState {
  return events.reduce((state, event) => reduceBuddyEvent(state, event, Number(event.timestamp) * 1000 || Date.now()), emptyBuddyTimeline());
}

/** An earlier page is settled history: close its open activity (when its Session ended) and its requests. */
export function settleHistory(events: BuddyEvent[], endedAt?: string): BuddyTimelineState {
  const history = restoreBuddyHistory(events);
  const closed = endedAt ? reduceBuddyEvent(history, { type: "session_ended" }, Date.parse(endedAt) || Date.now()) : history;
  return reduceBuddyEvent(closed, { type: "buddy_reconcile" });
}

/** Put an earlier page in front. Each page is reduced on its own (ACP IDs and requests are Session-scoped), so its row ids get `key` as a prefix. */
export function prependHistory(page: BuddyTimelineState, key: string, older: BuddyTimelineState): BuddyTimelineState {
  const keyed = { ...page, rows: page.rows.map(row => ({ ...row, id: `${key}:${row.id}` })) };
  if (!older.rows.length) return keyed;
  return { ...older, messages: [...keyed.messages, ...older.messages], rows: [...keyed.rows, ...older.rows.map(row => row.kind === "message" ? { ...row, index: row.index + keyed.messages.length } : row)] };
}

/** Reduce each ended Session independently: ACP IDs and pending requests are Session-scoped. */
export function restorePreviousSegments(segments: BuddySegmentHistory[]): BuddyTimelineState {
  return [...segments].reverse().reduce((older, segment) => prependHistory(settleHistory(segment.events, segment.ended_at), segment.session_id, older), emptyBuddyTimeline());
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
