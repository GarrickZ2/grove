import { useEffect, useState } from "react";
import type { BuddySummary } from "../api/buddies";
import { readBuddyPreference, writeBuddyPreference } from "../components/Buddy/buddyStorage";

type Seen = Record<string, string>;
const time = (value: string | null | undefined) => (value ? Date.parse(value) : 0) || 0;

function readSeen(): Seen {
  try { const value = JSON.parse(readBuddyPreference("seen", "{}")); return value && typeof value === "object" ? value as Seen : {}; } catch { return {}; }
}

/** Viewing a Buddy marks its latest activity read. Buddies never seen before start read, so upgrades don't flood the list. */
function mark(seen: Seen, items: BuddySummary[], viewing: string): Seen {
  let next = seen;
  for (const item of items) {
    const at = item.last_activity_at ?? "";
    if (item.id in seen && (item.id !== viewing || seen[item.id] === at)) continue;
    if (next === seen) next = { ...seen };
    next[item.id] = at;
  }
  return next;
}

/** Local per-viewer unread state: a Buddy is unread when its activity is newer than the last time it was viewed. */
export function useBuddyUnread(items: BuddySummary[], viewing: string): Set<string> {
  const [seen, setSeen] = useState(readSeen);
  const next = mark(seen, items, viewing);
  if (next !== seen) setSeen(next);
  useEffect(() => { writeBuddyPreference("seen", JSON.stringify(seen)); }, [seen]);
  return new Set(items.filter(item => item.id !== viewing && time(item.last_activity_at) > time(seen[item.id])).map(item => item.id));
}
