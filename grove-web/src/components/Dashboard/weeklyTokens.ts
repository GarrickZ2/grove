import type { AgentBucket, StatisticsResponse } from "../../api/statistics";

export interface WeeklyTokenDay {
  total: number;
  segments: AgentBucket[];
}

export interface WeeklyTokenSummary {
  /** Weekday labels oldest→newest, matching `series`. */
  dayLabels: string[];
  /** 7 days oldest→newest, zero-filled. */
  series: WeeklyTokenDay[];
  total: number;
  /** Tallest bar's value, never below 1 (safe to divide by). */
  peak: number;
  /** Largest day's value (0 when there was no activity). */
  maxValue: number;
  /** Index of the largest day, or -1 without activity. */
  peakIdx: number;
  /** Agent with the most tokens over the week ("" without activity). */
  topAgent: string;
  /** Per-agent totals over the week, largest first. */
  agents: { agent: string; tokens: number }[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Last-7-days token series for the Dashboard.
 *
 * Backend buckets `chat_token_usage.end_ts` by UTC date (sqlite
 * strftime('%Y-%m-%d', end_ts, 'unixepoch') runs in UTC). To align the
 * weekday labels with the data they represent, weekday is also derived
 * from UTC. Otherwise users east of UTC see "today's" turns under
 * yesterday's column for the late-night part of the day.
 *
 * Backend returns ascending buckets but may skip days with zero activity,
 * so we walk dates explicitly and zero-fill missing days.
 */
export function summarizeWeeklyTokens(stats: StatisticsResponse | null, now: Date = new Date()): WeeklyTokenSummary {
  const todayIdx = now.getUTCDay();
  const dayLabels: string[] = [];
  for (let i = 6; i >= 0; i--) dayLabels.push(DAYS[(todayIdx - i + 7) % 7]);

  const buckets = stats?.current.timeseries ?? [];
  // Anchor "today" at UTC midnight so each iterated key matches the
  // backend's UTC-bucketed `bucket_start` values exactly.
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const series: WeeklyTokenDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - i);
    const key = day.toISOString().slice(0, 10);
    const match = buckets.find((b) => new Date(b.bucket_start * 1000).toISOString().slice(0, 10) === key);
    const segments = match?.per_agent ?? [];
    series.push({ total: segments.reduce((sum, a) => sum + a.tokens, 0), segments });
  }

  const total = series.reduce((sum, d) => sum + d.total, 0);
  const maxValue = Math.max(...series.map((d) => d.total), 0);
  const peakIdx = maxValue > 0 ? series.findIndex((d) => d.total === maxValue) : -1;

  const totals = new Map<string, number>();
  for (const day of series) {
    for (const segment of day.segments) totals.set(segment.agent, (totals.get(segment.agent) ?? 0) + segment.tokens);
  }
  let topAgent = "";
  let best = 0;
  for (const [agent, tokens] of totals) {
    if (tokens > best) {
      topAgent = agent;
      best = tokens;
    }
  }

  const agents = [...totals].map(([agent, tokens]) => ({ agent, tokens })).filter((row) => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  return { dayLabels, series, total, peak: Math.max(maxValue, 1), maxValue, peakIdx, topAgent, agents };
}
