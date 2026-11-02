import type { ReviewCommentEntry, TaskStatsResponse } from "../../../api";
import { formatDay } from "../../ui/format";

/** "src/api/tasks.ts" → { dir: "src/api/", name: "tasks.ts" }. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export interface ActivityDay {
  /** "Today", "Yesterday" or "Oct 26". */
  label: string;
  /** Edits per local hour, 0–23. */
  hours: number[];
  total: number;
  peak: number;
}

const localDayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * The most recent local day with edits, bucketed by hour. Null when the task
 * has no recorded activity.
 */
export function latestActivityDay(hourly: TaskStatsResponse["hourly_activity"], now: number = Date.now()): ActivityDay | null {
  const active = hourly
    .map((entry) => ({ at: new Date(entry.hour), total: entry.total }))
    .filter((entry) => entry.total > 0 && !Number.isNaN(entry.at.getTime()));
  if (active.length === 0) return null;
  const latest = active.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a)).at;
  const key = localDayKey(latest);
  const hours = Array<number>(24).fill(0);
  for (const entry of active) {
    if (localDayKey(entry.at) === key) hours[entry.at.getHours()] += entry.total;
  }
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const label = key === localDayKey(today) ? "Today" : key === localDayKey(yesterday) ? "Yesterday" : formatDay(latest, { now });
  return { label, hours, total: hours.reduce((a, b) => a + b, 0), peak: Math.max(...hours) };
}

/** Where a review comment points: "tasks.ts:L12–18", "tasks.ts", or "Whole change". */
export function commentLocation(comment: Pick<ReviewCommentEntry, "comment_type" | "file_path" | "start_line" | "end_line">): { label: string; title: string } {
  const type = comment.comment_type || "inline";
  if (type === "project" || !comment.file_path) return { label: "Whole change", title: "Project-level comment" };
  const { name } = splitPath(comment.file_path);
  if (type === "file" || comment.start_line === undefined) return { label: name || comment.file_path, title: comment.file_path };
  const end = comment.end_line ?? comment.start_line;
  const lines = end !== comment.start_line ? `L${comment.start_line}–${end}` : `L${comment.start_line}`;
  return { label: `${name}:${lines}`, title: `${comment.file_path} ${lines}` };
}

export type CommentFilter = "open" | "all" | "resolved";

/** Open includes outdated, matching Code Review's own counts. */
export function filterComments(comments: ReviewCommentEntry[], filter: CommentFilter): ReviewCommentEntry[] {
  if (filter === "all") return comments;
  if (filter === "resolved") return comments.filter((comment) => comment.status === "resolved");
  return comments.filter((comment) => comment.status === "open" || comment.status === "outdated");
}

/** English count with the noun pluralized: "1 file", "3 files". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
