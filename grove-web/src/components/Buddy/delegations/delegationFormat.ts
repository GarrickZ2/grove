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

export type FinishedPeriod = "Today" | "Yesterday" | "This week" | "Earlier";

export function finishedAt(delegation: BuddyDelegation): number {
  return Date.parse(delegation.completed_at ?? delegation.updated_at);
}

function finishedPeriod(time: number, now: number): FinishedPeriod {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (time >= today.getTime()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (time >= yesterday.getTime()) return "Yesterday";
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return time >= monday.getTime() ? "This week" : "Earlier";
}

/** Finished work by when it ended, newest first. Empty periods are left out. */
export function groupFinished(items: BuddyDelegation[], now = Date.now()): { period: FinishedPeriod; items: BuddyDelegation[] }[] {
  const newest = [...items].sort((a, b) => finishedAt(b) - finishedAt(a));
  return (["Today", "Yesterday", "This week", "Earlier"] as const)
    .map(period => ({ period, items: newest.filter(item => finishedPeriod(finishedAt(item), now) === period) }))
    .filter(group => group.items.length > 0);
}

/** When it ended, with no more than its group's heading leaves out. */
export function finishedLabel(delegation: BuddyDelegation, now = Date.now()): string {
  const ended = new Date(finishedAt(delegation));
  const period = finishedPeriod(ended.getTime(), now);
  if (period === "Today" || period === "Yesterday") return ended.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (period === "This week") return ended.toLocaleDateString([], { weekday: "short" });
  const otherYear = ended.getFullYear() !== new Date(now).getFullYear();
  return ended.toLocaleDateString([], { month: "short", day: "numeric", ...(otherYear ? { year: "numeric" } : {}) });
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
