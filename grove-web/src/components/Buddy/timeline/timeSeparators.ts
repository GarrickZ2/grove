import type { BuddyRow, BuddyTimelineState } from "./buddyTimelineState";

// Like a chat app: a centered time label before the first message and before
// any message that follows a quiet stretch.
export const SEPARATOR_GAP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a message row happened, in ms; other rows (cards, events) carry no time. */
export function rowTime(row: BuddyRow, state: BuddyTimelineState): number | null {
  if (row.kind !== "message") return null;
  const message = state.messages[row.index];
  if (message?.type === "user") return message.sentAt ?? null;
  if (message?.type === "assistant") {
    const seconds = message.startTs ?? message.endTs;
    return seconds != null ? seconds * 1000 : null;
  }
  return null;
}

/** Row ids that get a separator above them, mapped to the time to show. */
export function timeSeparators(rows: BuddyRow[], state: BuddyTimelineState): Map<string, number> {
  const result = new Map<string, number>();
  let previous: number | null = null;
  for (const row of rows) {
    const time = rowTime(row, state);
    if (time == null) continue;
    if (previous == null || time - previous >= SEPARATOR_GAP_MS) result.set(row.id, time);
    previous = time;
  }
  return result;
}

export function separatorLabel(time: number, now = Date.now()): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (time >= startOfToday) return clock;
  if (time >= startOfToday - DAY_MS) return `Yesterday ${clock}`;
  if (time >= startOfToday - 6 * DAY_MS) return `${date.toLocaleDateString([], { weekday: "long" })} ${clock}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString([], { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} ${clock}`;
}
