import type { ReviewCommentEntry } from "../../../api";
import type { TimeseriesBucket } from "../../../api/statistics";
import { formatDay } from "../../ui/format";

/** "src/api/tasks.ts" → { dir: "src/api/", name: "tasks.ts" }. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export interface UsageDay {
  /** Local midnight. */
  start: Date;
  /** "Today", "Yesterday" or "Oct 26". */
  label: string;
  tokens: number;
  turns: number;
}

const localDayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Hourly usage buckets folded into the last `days` local days, oldest first,
 * zero-filled. Null when nothing was used in that window.
 */
export function usageDays(buckets: TimeseriesBucket[], days: number, now: number = Date.now()): UsageDay[] | null {
  const today = new Date(now);
  const out: UsageDay[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const label = back === 0 ? "Today" : back === 1 ? "Yesterday" : formatDay(start, { now });
    out.push({ start, label, tokens: 0, turns: 0 });
  }
  const byKey = new Map(out.map((day) => [localDayKey(day.start), day]));
  for (const bucket of buckets) {
    const day = byKey.get(localDayKey(new Date(bucket.bucket_start * 1000)));
    if (!day) continue;
    // Total tokens, as the KPIs and sessions count them.
    day.tokens += bucket.per_agent.reduce((sum, agent) => sum + agent.tokens, 0);
    day.turns += bucket.turns;
  }
  return out.some((day) => day.turns > 0) ? out : null;
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
