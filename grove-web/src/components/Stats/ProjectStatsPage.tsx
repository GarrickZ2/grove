import { useState, useMemo, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Zap, GitMerge, Code2, Bot, Target, FileCode2, Sparkles,
  User, ArrowRight, CheckCircle2, Trophy, Loader2,
} from "lucide-react";
import { compactPath } from "../../utils/pathUtils";
import { TimeRangePicker, type TimeRangeValue } from "./TimeRangePicker";
import { AgentAvatar } from "../Review/AgentAvatar";
import { getProjectStatistics } from "../../api/statistics";
import type { ProjectStatisticsResponse } from "../../api/statistics";

// ─── Types (mirroring backend response) ───────────────────────────────────────

interface BriefDataPoint {
  briefLength: number;
  interventions: number;
  userMessages: number;
  toolCalls: number;
  planUpdates: number;
}
interface HotFile { path: string; taskCount: number }

interface CommentFlow {
  total: number;
  humanTotal: number;
  agentTotal: number;
  humanResolved: number;
  humanOpen: number;
  humanOutdated: number;
  agentResolved: number;
  agentOpen: number;
  agentOutdated: number;
  avgAiRoundsOnHumanComments: number;
}

interface AgentStat {
  agent: string;
  displayName: string;
  chatTasks: number;
  chatTotalToolCalls: number;
  chatAvgToolCallsPerTask: number;
  reviewComments: number;
  reviewHitRate: number;
  contributionScore: number;
}

interface StatsData {
  timeSavedHours: number;
  parallelMultiplier: number;
  peakConcurrency: number;
  totalActiveMinutes: number;
  tasksCompleted: number;
  tasksCreated: number;
  tasksInProgress: number;
  agentAutonomyRate: number;
  codeAdditions: number;
  codeDeletions: number;
  avgBriefLength: number;
  avgInterventionsPerTask: number;
  briefInsightData: BriefDataPoint[];
  totalToolCalls: number;
  avgToolCallsPerTask: number;
  avgPlanUpdatesPerTask: number;
  hotFiles: HotFile[];
  avgFilesPerTask: number;
  totalFilesChanged: number;
  commentFlow: CommentFlow;
  agentLeaderboard: AgentStat[];
}

// ─── Convert backend response to local StatsData ──────────────────────────────

function fromApiResponse(r: ProjectStatisticsResponse): StatsData {
  return {
    timeSavedHours: r.time_saved_hours,
    parallelMultiplier: r.parallel_multiplier,
    peakConcurrency: r.peak_concurrency,
    totalActiveMinutes: r.total_active_minutes,
    tasksCompleted: r.tasks_completed,
    tasksCreated: r.tasks_created,
    tasksInProgress: r.tasks_in_progress,
    agentAutonomyRate: r.agent_autonomy_rate,
    codeAdditions: r.code_additions,
    codeDeletions: r.code_deletions,
    avgBriefLength: r.avg_brief_length,
    avgInterventionsPerTask: r.avg_interventions_per_task,
    briefInsightData: r.brief_insight_data.map((p) => ({
      briefLength: p.brief_length,
      interventions: p.interventions,
      userMessages: p.user_messages,
      toolCalls: p.tool_calls,
      planUpdates: p.plan_updates,
    })),
    totalToolCalls: r.total_tool_calls,
    avgToolCallsPerTask: r.avg_tool_calls_per_task,
    avgPlanUpdatesPerTask: r.avg_plan_updates_per_task,
    hotFiles: r.hot_files.map((f) => ({
      path: f.path,
      taskCount: f.task_count,
    })),
    avgFilesPerTask: r.avg_files_per_task,
    totalFilesChanged: r.total_files_changed,
    commentFlow: {
      total: r.comment_flow.total,
      humanTotal: r.comment_flow.human_total,
      agentTotal: r.comment_flow.agent_total,
      humanResolved: r.comment_flow.human_resolved,
      humanOpen: r.comment_flow.human_open,
      humanOutdated: r.comment_flow.human_outdated,
      agentResolved: r.comment_flow.agent_resolved,
      agentOpen: r.comment_flow.agent_open,
      agentOutdated: r.comment_flow.agent_outdated,
      avgAiRoundsOnHumanComments: r.comment_flow.avg_ai_rounds_on_human_comments,
    },
    agentLeaderboard: r.agent_leaderboard.map((a) => ({
      agent: a.agent,
      displayName: a.display_name,
      chatTasks: a.chat_tasks,
      chatTotalToolCalls: a.chat_total_tool_calls,
      chatAvgToolCallsPerTask: Number(a.chat_avg_tool_calls_per_task.toFixed(1)),
      reviewComments: a.review_comments,
      reviewHitRate: a.review_hit_rate,
      contributionScore: Math.round(a.contribution_score),
    })),
  };
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function startOfWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function startOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function startOfYear(): string {
  const d = new Date();
  d.setMonth(0, 1);
  return d.toISOString().slice(0, 10);
}

/** Convert TimeRangeValue to {from, to} strings */
function timeRangeToParams(range: TimeRangeValue): { from: string; to: string } {
  if (range.from && range.to) {
    return { from: range.from, to: range.to };
  }
  const to = todayStr();
  const presetMap: Record<string, string> = {
    "7d": daysAgoStr(7),
    "14d": daysAgoStr(14),
    "30d": daysAgoStr(30),
    "90d": daysAgoStr(90),
    "this-week": startOfWeek(),
    "this-month": startOfMonth(),
    "this-year": startOfYear(),
    "all": "2020-01-01",
  };
  const from = range.presetId ? (presetMap[range.presetId] ?? daysAgoStr(30)) : daysAgoStr(30);
  return { from, to };
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtTimeSaved(hours: number): string {
  if (hours <= 0) return "0min";
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes}min`;
  return `${hours.toFixed(1)}h`;
}

function fmtMultiplier(m: number): string {
  return m.toFixed(2) + "x";
}

function fmtMinutes(minutes: number): string {
  if (minutes <= 0) return "0min";
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function trendLine(pts: BriefDataPoint[], xMin: number, xMax: number): [number, number, number, number] {
  const n = pts.length;
  if (n < 2) return [xMin, 0, xMax, 0];
  const sx = pts.reduce((s, p) => s + p.briefLength, 0);
  const sy = pts.reduce((s, p) => s + p.interventions, 0);
  const sxy = pts.reduce((s, p) => s + p.briefLength * p.interventions, 0);
  const sx2 = pts.reduce((s, p) => s + p.briefLength ** 2, 0);
  const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  const intercept = (sy - slope * sx) / n;
  return [xMin, slope * xMin + intercept, xMax, slope * xMax + intercept];
}

// ─── Empty stats (shown when no data) ─────────────────────────────────────────

const EMPTY_STATS: StatsData = {
  timeSavedHours: 0, parallelMultiplier: 1, peakConcurrency: 0, totalActiveMinutes: 0,
  tasksCompleted: 0, tasksCreated: 0, tasksInProgress: 0, agentAutonomyRate: 0,
  codeAdditions: 0, codeDeletions: 0,
  avgBriefLength: 0, avgInterventionsPerTask: 0,
  briefInsightData: [],
  totalToolCalls: 0, avgToolCallsPerTask: 0, avgPlanUpdatesPerTask: 0,
  hotFiles: [],
  avgFilesPerTask: 0, totalFilesChanged: 0,
  commentFlow: {
    total: 0, humanTotal: 0, agentTotal: 0,
    humanResolved: 0, humanOpen: 0, humanOutdated: 0,
    agentResolved: 0, agentOpen: 0, agentOutdated: 0,
    avgAiRoundsOnHumanComments: 0,
  },
  agentLeaderboard: [],
};

// ─── Sub-components ─────────────────────────────────────────────────────────────

function ScatterChart({ data }: { data: BriefDataPoint[] }) {
  const W = 280, H = 110, pL = 28, pR = 12, pT = 8, pB = 22;
  const maxX = Math.max(...data.map((d) => d.briefLength), 600);
  const maxY = Math.max(...data.map((d) => d.interventions), 6);
  const sx = (x: number) => pL + (x / maxX) * (W - pL - pR);
  const sy = (y: number) => pT + ((maxY - y) / maxY) * (H - pT - pB);
  const [tx1, ty1, tx2, ty2] = trendLine(data, 0, maxX);
  const yTicks = [0, Math.round(maxY / 2), maxY];
  const xTicks = [0, Math.round(maxX / 2), maxX];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 110 }}>
      {yTicks.map((v) => (
        <line key={v} x1={pL} x2={W - pR} y1={sy(v)} y2={sy(v)}
          stroke="var(--color-border)" strokeWidth={0.5} />
      ))}
      {yTicks.map((v) => (
        <text key={v} x={pL - 4} y={sy(v) + 3} textAnchor="end" fontSize={8}
          fill="var(--color-text-muted)">{v}</text>
      ))}
      {xTicks.map((v) => (
        <text key={v} x={sx(v)} y={H - 4} textAnchor="middle" fontSize={8}
          fill="var(--color-text-muted)">{v === 0 ? "0" : fmt(v)}</text>
      ))}
      <line x1={sx(tx1)} y1={sy(ty1)} x2={sx(tx2)} y2={sy(ty2)}
        stroke="var(--color-highlight)" strokeWidth={1} strokeDasharray="3 2" opacity={0.5} />
      {data.map((d, i) => (
        <circle key={i} cx={sx(d.briefLength)} cy={sy(d.interventions)}
          r={3} fill="var(--color-highlight)" opacity={0.75} />
      ))}
    </svg>
  );
}

interface MetricCardProps {
  icon: React.ElementType; label: string; value: string; sub?: string; color?: string; delay?: number;
}
function MetricCard({ icon: Icon, label, value, sub, color, delay = 0 }: MetricCardProps) {
  const c = color ?? "var(--color-text-muted)";
  const bg = color ? `${color}18` : "var(--color-bg-tertiary)";
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-center gap-2 mb-3 select-none">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: bg }}>
          <Icon className="w-3.5 h-3.5" style={{ color: c }} />
        </div>
        <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-bold" style={{ color: color ? c : "var(--color-text)" }}>{value}</div>
      {sub && <div className="text-xs text-[var(--color-text-muted)] mt-1 select-none">{sub}</div>}
    </motion.div>
  );
}

interface AgentCardProps {
  stat: AgentStat;
  rank: number;
  delay?: number;
}
function AgentCard({ stat, rank, delay = 0 }: AgentCardProps) {
  const rankColors = ["#f59e0b", "#9ca3af", "#b45309"];
  const rankColor = rankColors[rank - 1] ?? "var(--color-text-muted)";

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center bg-[var(--color-bg-tertiary)]">
            <AgentAvatar name={stat.agent} size={28} />
          </div>
          <div>
            <div className="text-sm font-semibold text-[var(--color-text)]">{stat.displayName}</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Score{" "}
              <span className="font-medium" style={{ color: "var(--color-highlight)" }}>
                {stat.contributionScore}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Trophy className="w-3.5 h-3.5" style={{ color: rankColor }} />
          <span className="text-sm font-bold" style={{ color: rankColor }}>#{rank}</span>
        </div>
      </div>

      <div className="h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden mb-3">
        <motion.div className="h-full rounded-full" style={{ backgroundColor: "var(--color-highlight)" }}
          initial={{ width: 0 }}
          animate={{ width: `${stat.contributionScore}%` }}
          transition={{ delay: delay + 0.1, duration: 0.7, ease: "easeOut" }} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* Work panel */}
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-2.5">
          <div className="flex items-center gap-1 mb-1.5">
            <Bot className="w-3 h-3 text-[var(--color-text-muted)]" />
            <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
              Work
            </span>
          </div>
          <div className="space-y-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Tasks</span>
              <span className="font-medium text-[var(--color-text)]">{stat.chatTasks}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Tool calls</span>
              <span className="font-medium text-[var(--color-text)]">{fmt(stat.chatTotalToolCalls)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Avg / task</span>
              <span className="font-medium text-[var(--color-text)]">{stat.chatAvgToolCallsPerTask}</span>
            </div>
          </div>
        </div>
        {/* Review panel */}
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-2.5">
          <div className="flex items-center gap-1 mb-1.5">
            <CheckCircle2 className="w-3 h-3 text-[var(--color-text-muted)]" />
            <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
              Review
            </span>
          </div>
          <div className="space-y-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Suggestions</span>
              <span className="font-medium text-[var(--color-text)]">{stat.reviewComments}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Hit rate</span>
              <span className="font-medium" style={{
                color: stat.reviewComments > 0 && stat.reviewHitRate >= 0.5
                  ? "rgb(100,200,100)" : "var(--color-text)",
              }}>
                {stat.reviewComments > 0 ? pct(stat.reviewHitRate) : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

interface ProjectStatsPageProps {
  projectId?: string;
}

export function ProjectStatsPage({ projectId }: ProjectStatsPageProps) {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>({ label: "Last 30 days", presetId: "30d" });
  const [data, setData] = useState<StatsData>(EMPTY_STATS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (range: TimeRangeValue) => {
    if (!projectId) {
      setData(EMPTY_STATS);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { from, to } = timeRangeToParams(range);
      const response = await getProjectStatistics(projectId, from, to);
      setData(fromApiResponse(response));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load statistics";
      setError(msg);
      setData(EMPTY_STATS);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchStats(timeRange));
  }, [timeRange, fetchStats]);

  const d = data;

  const heroLabel = useMemo(() => {
    const id = timeRange.presetId;
    if (!id || id === "all") return "total";
    if (id === "this-week" || id === "7d" || id === "14d") return "recently";
    return "this month";
  }, [timeRange]);

  const shortBriefAvg = useMemo(() => {
    const pts = d.briefInsightData.filter((p) => p.briefLength < 100);
    return pts.length ? (pts.reduce((s, p) => s + p.interventions, 0) / pts.length).toFixed(1) : "—";
  }, [d]);
  const longBriefAvg = useMemo(() => {
    const pts = d.briefInsightData.filter((p) => p.briefLength >= 400);
    return pts.length ? (pts.reduce((s, p) => s + p.interventions, 0) / pts.length).toFixed(1) : "—";
  }, [d]);

  const toolCallsPerMsg = useMemo(() => {
    const totalMsgs = d.briefInsightData.reduce((s, p) => s + p.userMessages, 0);
    return totalMsgs > 0 ? Math.round(d.totalToolCalls / totalMsgs) : null;
  }, [d.briefInsightData, d.totalToolCalls]);

  const maxHotFile = Math.max(...d.hotFiles.map((f) => f.taskCount), 1);

  const { commentFlow: cf } = d;

  return (
    <div className="space-y-6 pb-8">

      {/* Header */}
      <div className="flex items-center justify-between select-none">
        <div className="select-none">
          <h1 className="text-xl font-semibold text-[var(--color-text)] select-none">Statistics</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-0.5 select-none">Productivity insights · this project</p>
        </div>
        <div className="flex items-center gap-3">
          {loading && (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
          )}
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* No project selected */}
      {!projectId && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Select a project to view statistics.
        </div>
      )}

      {projectId && (
        <>
          {/* Hero */}
          <motion.div key={timeRange.presetId ?? timeRange.label}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "var(--color-highlight)20" }}>
                <Zap className="w-5 h-5" style={{ color: "var(--color-highlight)" }} />
              </div>
              <div>
                <p className="text-sm text-[var(--color-text-muted)] mb-1 select-none">
                  Grove has generated {heroLabel}
                </p>
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl font-bold" style={{ color: "var(--color-highlight)" }}>
                    {fmtTimeSaved(d.timeSavedHours)}
                  </span>
                  <span className="text-lg font-semibold text-[var(--color-text)]">of extra capacity</span>
                </div>
                <p className="text-sm text-[var(--color-text-muted)] mt-1 select-none">
                  1 real minute ={" "}
                  <span className="font-medium text-[var(--color-text)]">{fmtMultiplier(d.parallelMultiplier)}</span>{" "}
                  minutes of output, peak{" "}
                  <span className="font-medium text-[var(--color-text)]">{d.peakConcurrency}</span>{" "}
                  tasks in parallel ·{" "}
                  <span className="font-medium text-[var(--color-text)]">{fmtMinutes(d.totalActiveMinutes)}</span>{" "}
                  total work
                </p>
              </div>
            </div>
          </motion.div>

          {/* Metric cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard icon={Zap}       label="Tasks Created"  value={String(d.tasksCreated)}
              sub={`${Math.round(d.agentAutonomyRate * 100)}% AI autonomous`}
              color="var(--color-highlight)" delay={0.05} />
            <MetricCard icon={GitMerge}  label="Tasks Done"    value={String(d.tasksCompleted)}
              sub={`${d.tasksInProgress} in progress`}
              color="#3b82f6" delay={0.1} />
            <MetricCard icon={Code2}     label="Code Output"   value={`+${fmt(d.codeAdditions)}`}
              sub={`-${fmt(d.codeDeletions)} lines`}
              color="#a855f7" delay={0.15} />
            <MetricCard icon={FileCode2} label="Files Touched" value={`~${d.avgFilesPerTask}`}
              sub={`${d.totalFilesChanged} total, avg per task`}
              color="#f59e0b" delay={0.2} />
          </div>

          {/* AI Work Breakdown */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.3 }}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
            <div className="flex items-center gap-2 mb-4 select-none">
              <Bot className="w-4 h-4 text-[var(--color-text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--color-text)]">AI Work Breakdown</h2>
              <span className="text-xs text-[var(--color-text-muted)]">active tasks only</span>
            </div>

            {/* 3 inline stats */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
                <div className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1 select-none">
                  Tool Calls / Task
                </div>
                <div className="text-xl font-bold text-[var(--color-text)]">
                  {Math.round(d.avgToolCallsPerTask)}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 select-none">AI workload</div>
              </div>
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
                <div className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1 select-none">
                  Plans / Task
                </div>
                <div className="text-xl font-bold text-[var(--color-text)]">
                  {d.avgPlanUpdatesPerTask.toFixed(1)}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 select-none">structured thinking</div>
              </div>
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
                <div className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1 select-none">
                  Tool Calls / Msg
                </div>
                <div className="text-xl font-bold text-[var(--color-text)]">
                  {toolCallsPerMsg ?? "—"}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 select-none">tool calls per user msg</div>
              </div>
            </div>

            {/* Scatter: Notes length vs Interventions */}
            <div className="pt-4 border-t border-[var(--color-border)]">
              <div className="flex items-center gap-1.5 mb-3 select-none">
                <Sparkles className="w-3.5 h-3.5" style={{ color: "var(--color-highlight)" }} />
                <span className="text-xs font-medium text-[var(--color-text)]">Spec Length vs Interventions</span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  — avg {d.avgInterventionsPerTask.toFixed(1)} corrections / task
                </span>
              </div>
              {d.briefInsightData.length > 0 ? (
                <>
                  <ScatterChart data={d.briefInsightData} />
                  <div className="flex items-center justify-between mt-2 text-xs text-[var(--color-text-muted)] select-none">
                    <span>← Spec length (chars)</span><span>Corrections after initial brief ↑</span>
                  </div>
                  <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-muted)] space-y-1 select-none">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: "var(--color-highlight)", opacity: 0.5, display: "inline-block" }} />
                      Spec &lt; 100 chars → avg{" "}
                      <span className="text-[var(--color-text)] font-medium">{shortBriefAvg}</span> corrections
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: "var(--color-highlight)", display: "inline-block" }} />
                      Spec ≥ 400 chars → avg{" "}
                      <span className="text-[var(--color-text)] font-medium">{longBriefAvg}</span> corrections
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
                  No active task data yet
                </p>
              )}
            </div>
          </motion.div>

          {/* Review Intelligence */}
          {cf.total > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.3 }}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
            <div className="flex items-center gap-2 mb-4 select-none">
              <ArrowRight className="w-4 h-4 text-[var(--color-text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Review Intelligence</h2>
            </div>

            {/* 3 headline metrics */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
                <div className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1 select-none">AI Review Share</div>
                <div className="text-xl font-bold text-[var(--color-text)]">
                  {cf.total > 0 ? pct(cf.agentTotal / cf.total) : "—"}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 select-none">
                  {cf.agentTotal} of {cf.total} comments
                </div>
              </div>
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
                <div className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1 select-none">AI Hit Rate</div>
                <div className="text-xl font-bold" style={{
                  color: cf.agentTotal > 0 && cf.agentResolved / cf.agentTotal >= 0.5
                    ? "rgb(100,200,100)" : "var(--color-text)"
                }}>
                  {cf.agentTotal > 0 ? pct(cf.agentResolved / cf.agentTotal) : "—"}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 select-none">AI suggestions resolved</div>
              </div>
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
                <div className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1 select-none">AI Rounds / Fix</div>
                <div className="text-xl font-bold text-[var(--color-text)]">
                  {cf.humanResolved > 0 ? cf.avgAiRoundsOnHumanComments.toFixed(1) : "—"}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 select-none">AI replies per your comment</div>
              </div>
            </div>

            {/* Comparison bars */}
            <div className="space-y-4">
              {/* Your comments */}
              {cf.humanTotal > 0 && (
                <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.55, duration: 0.3 }}>
                  <div className="flex items-center justify-between mb-2 select-none">
                    <div className="flex items-center gap-2">
                      <User className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                      <span className="text-sm font-medium text-[var(--color-text)]">Your Comments</span>
                      <span className="text-xs text-[var(--color-text-muted)]">{cf.humanTotal} total</span>
                    </div>
                    <span className="text-xs font-medium" style={{ color: "rgb(100,200,100)" }}>
                      {pct(cf.humanResolved / cf.humanTotal)} resolved by AI
                    </span>
                  </div>
                  <div className="h-5 rounded-md bg-[var(--color-bg-tertiary)] overflow-hidden flex">
                    <motion.div className="h-full" style={{ backgroundColor: "rgb(100,200,100)" }}
                      initial={{ width: 0 }}
                      animate={{ width: `${cf.humanResolved / cf.humanTotal * 100}%` }}
                      transition={{ delay: 0.6, duration: 0.5, ease: "easeOut" }} />
                    <motion.div className="h-full" style={{ backgroundColor: "rgb(255,140,50)", opacity: 0.7 }}
                      initial={{ width: 0 }}
                      animate={{ width: `${cf.humanOpen / cf.humanTotal * 100}%` }}
                      transition={{ delay: 0.65, duration: 0.5, ease: "easeOut" }} />
                    <motion.div className="h-full" style={{ backgroundColor: "rgb(100,130,160)", opacity: 0.5 }}
                      initial={{ width: 0 }}
                      animate={{ width: `${cf.humanOutdated / cf.humanTotal * 100}%` }}
                      transition={{ delay: 0.7, duration: 0.5, ease: "easeOut" }} />
                  </div>
                  <div className="flex gap-4 mt-1.5 text-[10px] text-[var(--color-text-muted)] select-none">
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: "rgb(100,200,100)" }} />{cf.humanResolved} resolved</span>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: "rgb(255,140,50)", opacity: 0.7 }} />{cf.humanOpen} open</span>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: "rgb(100,130,160)", opacity: 0.5 }} />{cf.humanOutdated} outdated</span>
                  </div>
                </motion.div>
              )}

              {/* AI comments */}
              {cf.agentTotal > 0 && (
                <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.6, duration: 0.3 }}>
                  <div className="flex items-center justify-between mb-2 select-none">
                    <div className="flex items-center gap-2">
                      <Bot className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                      <span className="text-sm font-medium text-[var(--color-text)]">AI Suggestions</span>
                      <span className="text-xs text-[var(--color-text-muted)]">{cf.agentTotal} total</span>
                    </div>
                    <span className="text-xs font-medium text-[var(--color-text-muted)]">
                      {cf.agentOpen} pending
                    </span>
                  </div>
                  <div className="h-5 rounded-md bg-[var(--color-bg-tertiary)] overflow-hidden flex">
                    <motion.div className="h-full" style={{ backgroundColor: "rgb(80,160,220)" }}
                      initial={{ width: 0 }}
                      animate={{ width: `${cf.agentResolved / cf.agentTotal * 100}%` }}
                      transition={{ delay: 0.65, duration: 0.5, ease: "easeOut" }} />
                    <motion.div className="h-full" style={{ backgroundColor: "rgb(255,140,50)", opacity: 0.7 }}
                      initial={{ width: 0 }}
                      animate={{ width: `${cf.agentOpen / cf.agentTotal * 100}%` }}
                      transition={{ delay: 0.7, duration: 0.5, ease: "easeOut" }} />
                    <motion.div className="h-full" style={{ backgroundColor: "rgb(100,130,160)", opacity: 0.5 }}
                      initial={{ width: 0 }}
                      animate={{ width: `${cf.agentOutdated / cf.agentTotal * 100}%` }}
                      transition={{ delay: 0.75, duration: 0.5, ease: "easeOut" }} />
                  </div>
                  <div className="flex gap-4 mt-1.5 text-[10px] text-[var(--color-text-muted)] select-none">
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: "rgb(80,160,220)" }} />{cf.agentResolved} acted on</span>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: "rgb(255,140,50)", opacity: 0.7 }} />{cf.agentOpen} pending</span>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: "rgb(100,130,160)", opacity: 0.5 }} />{cf.agentOutdated} outdated</span>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
          )}

          {/* Agent Contribution Leaderboard */}
          {d.agentLeaderboard.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.65, duration: 0.3 }}>
              <div className="flex items-center gap-2 mb-3 select-none">
                <Trophy className="w-4 h-4 text-[var(--color-text-muted)]" />
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Agent Leaderboard</h2>
                <span className="text-xs text-[var(--color-text-muted)]">Chat + Review composite score</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {d.agentLeaderboard.map((stat, i) => (
                  <AgentCard key={stat.agent} stat={stat} rank={i + 1} delay={0.7 + i * 0.06} />
                ))}
              </div>
            </motion.div>
          )}

          {/* Hot files */}
          {d.hotFiles.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.75, duration: 0.3 }}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
              <div className="flex items-center justify-between mb-4 select-none">
                <div className="flex items-center gap-2 select-none">
                  <Target className="w-4 h-4 text-[var(--color-text-muted)]" />
                  <h2 className="text-sm font-semibold text-[var(--color-text)]">Hot Files</h2>
                </div>
                <span className="text-xs text-[var(--color-text-muted)]">
                  avg {d.avgFilesPerTask} files / task
                </span>
              </div>
              <div className="space-y-2">
                {d.hotFiles.map((file, i) => (
                  <motion.div key={file.path}
                    initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.8 + i * 0.04, duration: 0.25 }}
                    className="flex items-center gap-3">
                    <span className="text-xs font-mono text-[var(--color-text-muted)] flex-shrink-0 w-52 truncate"
                      title={file.path}>
                      {compactPath(file.path, 30)}
                    </span>
                    <div className="flex-1 h-5 bg-[var(--color-bg-tertiary)] rounded-sm overflow-hidden">
                      <motion.div className="h-full rounded-sm"
                        style={{
                          backgroundColor: i === 0 ? "rgb(255,100,100)" : i === 1 ? "rgb(255,180,50)"
                            : i === 2 ? "rgb(100,200,100)" : "rgb(80,160,180)",
                        }}
                        initial={{ width: 0 }}
                        animate={{ width: `${(file.taskCount / maxHotFile) * 100}%` }}
                        transition={{ delay: 0.85 + i * 0.04, duration: 0.4, ease: "easeOut" }} />
                    </div>
                    <span className="text-xs text-[var(--color-text-muted)] tabular-nums w-14 text-right flex-shrink-0">
                      {file.taskCount} tasks
                    </span>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Empty state when no archived tasks */}
          {!loading && d.tasksCompleted === 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-8 text-center">
              <GitMerge className="w-8 h-8 mx-auto mb-3 text-[var(--color-text-muted)]" />
              <p className="text-sm font-medium text-[var(--color-text)]">No completed tasks yet</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                Archive tasks to see statistics for this period.
              </p>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
