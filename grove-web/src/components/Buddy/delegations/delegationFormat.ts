import { useEffect, useState } from "react";
import type { BuddyDelegation } from "../../../api/buddies";

export function elapsedLabel(from: string, to = Date.now()): string {
  const seconds = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function delegationStatusLabel(delegation: BuddyDelegation, now = Date.now()): string {
  switch (delegation.status) {
    case "running": return `Subagent working · ${elapsedLabel(delegation.created_at, now)}`;
    case "waiting": return "Needs you";
    case "done": return "Done";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

/** Re-renders while `active`, so running elapsed time stays current. */
export function useNow(active: boolean, interval = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [active, interval]);
  return now;
}

/** Match `buddy_delegate` rows to records: by id from the tool result, else by creation order. */
export function resolveDelegationRows(rows: { id: string; delegationId?: string; failed?: boolean }[], delegations: BuddyDelegation[]): Map<string, BuddyDelegation> {
  const byId = new Map(delegations.map(item => [item.id, item]));
  const claimed = new Set(rows.flatMap(row => row.delegationId && byId.has(row.delegationId) ? [row.delegationId] : []));
  const unclaimed = [...delegations].sort((a, b) => a.created_at.localeCompare(b.created_at)).filter(item => !claimed.has(item.id));
  const result = new Map<string, BuddyDelegation>();
  for (const row of rows) {
    const match = row.delegationId ? byId.get(row.delegationId) : undefined;
    const next = match ?? (row.failed ? undefined : unclaimed.shift());
    if (next) result.set(row.id, next);
  }
  return result;
}
