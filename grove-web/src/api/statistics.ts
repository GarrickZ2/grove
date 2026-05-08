// Statistics API client — backed by chat_token_usage.

import { apiClient } from "./client";

// ── Types ───────────────────────────────────────────────────────────────

export interface KpiData {
  turns: number;
  tokens_total: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  agent_compute_secs: number;
  avg_tokens_per_turn: number;
  avg_duration_secs: number;
  p50_duration_secs: number;
}

export interface AgentBucket {
  agent: string;
  tokens: number;
  turns: number;
}

export interface TimeseriesBucket {
  bucket_start: number; // unix seconds
  turns: number;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  per_agent: AgentBucket[];
}

export interface AgentShareItem {
  agent: string;
  turns: number;
  tokens: number;
  percent: number;
}

export interface ModelItem {
  model: string;
  agent: string;
  tokens: number;
  cached_tokens: number;
  turns: number;
}

export interface TopItem {
  id: string;
  name: string;
  turns: number;
  tokens: number;
  agent_split: AgentBucket[];
}

export interface HeatmapCell {
  weekday: number; // 0=Sun..6=Sat
  hour: number; // 0..23
  turns: number;
}

export interface PeriodData {
  kpi: KpiData;
  timeseries: TimeseriesBucket[];
  agent_share: AgentShareItem[];
  models: ModelItem[];
  top: TopItem[];
  heatmap: HeatmapCell[];
}

export interface StatisticsResponse {
  current: PeriodData;
  previous: { kpi: KpiData };
}

export type Bucket = "hourly" | "daily" | "weekly" | "monthly";

// ── Fetchers ────────────────────────────────────────────────────────────

interface QueryArgs {
  from?: number;
  to?: number;
  bucket?: Bucket;
}

function buildQuery(args: QueryArgs): string {
  const params = new URLSearchParams();
  if (args.from != null) params.set("from", String(args.from));
  if (args.to != null) params.set("to", String(args.to));
  if (args.bucket) params.set("bucket", args.bucket);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function getGlobalStatistics(
  args: QueryArgs = {},
): Promise<StatisticsResponse> {
  return apiClient.get<StatisticsResponse>(
    `/api/v1/statistics/global${buildQuery(args)}`,
  );
}

export function getProjectStatistics(
  projectId: string,
  args: QueryArgs = {},
): Promise<StatisticsResponse> {
  return apiClient.get<StatisticsResponse>(
    `/api/v1/statistics/project/${projectId}${buildQuery(args)}`,
  );
}
