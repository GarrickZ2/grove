/**
 * 5 KPI cards across the top of the Statistics page. Each card shows the
 * current period's value plus a Δ delta versus the previous period of equal
 * length. Δ color is green when "more activity" (turns/tokens up), neutral
 * for nominal metrics (avg tokens/turn, avg duration) — we don't editorialize
 * "good" vs "bad", just show the direction.
 */

import {
  RefreshCcw,
  Infinity as InfinityIcon,
  Clock,
  Hash,
  Zap,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

import type { KpiData } from "../../../api/statistics";
import {
  formatTokens,
  formatDuration,
  formatNumber,
  computeDelta,
} from "../formatters";

export function KpiRow({
  current,
  previous,
}: {
  current?: KpiData;
  previous?: KpiData;
}) {
  return (
    <div className="grid grid-cols-5 gap-3 shrink-0">
      <KpiCard
        icon={<RefreshCcw className="w-3.5 h-3.5" />}
        label="Prompt Turns"
        value={formatNumber(current?.turns ?? 0)}
        delta={computeDelta(current?.turns, previous?.turns)}
      />
      <KpiCard
        icon={<InfinityIcon className="w-3.5 h-3.5" />}
        label="Tokens"
        value={formatTokens(current?.tokens_total ?? 0)}
        sub={
          current
            ? `${formatTokens(current.tokens_in)} in · ${formatTokens(
                current.tokens_out,
              )} out · ${formatTokens(current.tokens_cached)} cached`
            : undefined
        }
        delta={computeDelta(current?.tokens_total, previous?.tokens_total)}
      />
      <KpiCard
        icon={<Clock className="w-3.5 h-3.5" />}
        label="Agent Compute"
        value={formatDuration(current?.agent_compute_secs ?? 0)}
        sub="cumulative end−start"
        delta={computeDelta(
          current?.agent_compute_secs,
          previous?.agent_compute_secs,
        )}
      />
      <KpiCard
        icon={<Hash className="w-3.5 h-3.5" />}
        label="Avg Tokens / Turn"
        value={formatTokens(current?.avg_tokens_per_turn ?? 0)}
        delta={computeDelta(
          current?.avg_tokens_per_turn,
          previous?.avg_tokens_per_turn,
        )}
      />
      <KpiCard
        icon={<Zap className="w-3.5 h-3.5" />}
        label="Avg Duration / Turn"
        value={formatDuration(current?.avg_duration_secs ?? 0, true)}
        sub={
          current
            ? `p50 ${formatDuration(current.p50_duration_secs, true)}`
            : undefined
        }
        delta={computeDelta(
          current?.avg_duration_secs,
          previous?.avg_duration_secs,
        )}
      />
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
  delta,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  delta: { pct: number | null; direction: 1 | -1 | 0 };
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        <span className="w-5 h-5 rounded-md bg-[color-mix(in_srgb,var(--color-highlight)_15%,transparent)] inline-flex items-center justify-center text-[var(--color-highlight)]">
          {icon}
        </span>
        {label}
      </div>
      <div className="text-2xl font-bold text-[var(--color-text)] tabular-nums leading-tight">
        {value}
      </div>
      <DeltaLine delta={delta} sub={sub} />
    </div>
  );
}

function DeltaLine({
  delta,
  sub,
}: {
  delta: { pct: number | null; direction: 1 | -1 | 0 };
  sub?: string;
}) {
  const Icon =
    delta.direction === 1
      ? TrendingUp
      : delta.direction === -1
        ? TrendingDown
        : Minus;
  const color =
    delta.direction === 1
      ? "var(--color-success)"
      : delta.direction === -1
        ? "var(--color-error)"
        : "var(--color-text-muted)";
  const pctText =
    delta.pct == null
      ? "—"
      : delta.pct === Infinity
        ? "new"
        : `${Math.abs(delta.pct).toFixed(1)}%`;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
      <Icon className="w-3 h-3" style={{ color }} />
      <span style={{ color }} className="font-semibold">
        {pctText}
      </span>
      <span className="truncate">{sub ?? "vs prev period"}</span>
    </div>
  );
}
