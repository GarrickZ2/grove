import type { BoardMember, SessionStatus, SyncStatus } from "./types";

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? "?";
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function memberByEmail(members: BoardMember[], email?: string | null): BoardMember | undefined {
  if (!email) return undefined;
  return members.find((m) => m.email === email);
}

export type SessionTone = "highlight" | "muted" | "warning" | "error";

export const SESSION_STATUS_META: Record<
  SessionStatus,
  { label: string; dot: string; text: string; tone: SessionTone; tintVar: string }
> = {
  working: {
    label: "Working",
    dot: "bg-[var(--color-highlight)]",
    text: "text-[var(--color-highlight)]",
    tone: "highlight",
    tintVar: "var(--color-highlight)",
  },
  idle: {
    label: "Resting",
    dot: "bg-[var(--color-warning)]",
    text: "text-[var(--color-warning)]",
    tone: "warning",
    tintVar: "var(--color-warning)",
  },
  done: {
    label: "Done",
    dot: "bg-[var(--color-text-muted)]",
    text: "text-[var(--color-text-muted)]",
    tone: "muted",
    tintVar: "var(--color-text-muted)",
  },
  failed: {
    label: "Failed",
    dot: "bg-[var(--color-error)]",
    text: "text-[var(--color-error)]",
    tone: "error",
    tintVar: "var(--color-error)",
  },
};

export const SYNC_META: Record<
  SyncStatus,
  { label: string; dot: string; text: string }
> = {
  synced: { label: "Synced", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  syncing: { label: "Syncing", dot: "bg-sky-500 animate-pulse", text: "text-sky-600 dark:text-sky-400" },
  offline: { label: "Local only", dot: "bg-[var(--color-accent)]", text: "text-[var(--color-accent)]" },
  failed: { label: "Sync failed", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
};

export const MODE_BADGE: Record<
  "online" | "offline",
  { label: string; cls: string }
> = {
  online: {
    label: "Online",
    cls: "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]",
  },
  offline: {
    label: "Local",
    cls: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  },
};

export function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r === 0 ? `${m}m` : `${m}m ${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

export function sessionTimingLabel(opts: {
  status: SessionStatus;
  elapsedSeconds?: number;
  durationSeconds?: number;
}): string | null {
  if (opts.status === "done" && opts.durationSeconds != null) {
    return formatDuration(opts.durationSeconds);
  }
  if (opts.elapsedSeconds != null) {
    return formatDuration(opts.elapsedSeconds);
  }
  return null;
}

export function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
