/**
 * Statistics page — wide-screen single-viewport dashboard.
 *
 * Two scopes:
 *  - Global: aggregates across every project
 *  - Project: a single project; falls back to "select a project" when none.
 *
 * All data comes from `chat_token_usage` (per-turn token + duration rows);
 * no other sources. Range and bucket are user-selectable; incompatible
 * combinations (e.g. 24h + Monthly) auto-disable.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { Globe2, Folder, RefreshCw, Loader2 } from "lucide-react";

import {
  getGlobalStatistics,
  getProjectStatistics,
  type Bucket,
  type StatisticsResponse,
} from "../../api/statistics";
import { KpiRow } from "./components/KpiRow";
import { ActivityOverTime } from "./components/ActivityOverTime";
import { AgentShare } from "./components/AgentShare";
import { ModelsList } from "./components/ModelsList";
import { TopList } from "./components/TopList";
import { ActivityHeatmap } from "./components/ActivityHeatmap";

// ── Range & bucket presets ──────────────────────────────────────────────

type RangeId = "24h" | "7d" | "30d" | "90d" | "1y";

const RANGE_SECS: Record<RangeId, number> = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
  "90d": 90 * 24 * 3600,
  "1y": 365 * 24 * 3600,
};

const RANGE_OPTIONS: { id: RangeId; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "1y", label: "1y" },
];

const BUCKET_OPTIONS: { id: Bucket; label: string }[] = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

/**
 * Bucket compatibility matrix:
 *   - 24h: only Hourly makes sense (Daily would be 1 point)
 *   - 7d:  Hourly produces 168 buckets — fine. Daily preferred. Weekly/Monthly too coarse.
 *   - 30d: Hourly = 720 buckets, allowed but heavy. Daily/Weekly are sweet spot.
 *   - 90d: Hourly disabled (renders too many points). Daily/Weekly/Monthly OK.
 *   - 1y:  Hourly disabled. Daily allowed but dense. Weekly/Monthly preferred.
 */
const ALLOWED_BUCKETS: Record<RangeId, Bucket[]> = {
  "24h": ["hourly"],
  "7d": ["hourly", "daily"],
  "30d": ["hourly", "daily", "weekly"],
  "90d": ["daily", "weekly", "monthly"],
  "1y": ["daily", "weekly", "monthly"],
};

const DEFAULT_BUCKET: Record<RangeId, Bucket> = {
  "24h": "hourly",
  "7d": "daily",
  "30d": "daily",
  "90d": "weekly",
  "1y": "monthly",
};

// ── Page ────────────────────────────────────────────────────────────────

type Scope = "global" | "project";

interface ProjectStatsPageProps {
  projectId?: string;
}

export function ProjectStatsPage({ projectId }: ProjectStatsPageProps) {
  const [scopeRaw, setScopeRaw] = useState<Scope>(
    projectId ? "project" : "global",
  );
  const [range, setRange] = useState<RangeId>("7d");
  const [bucket, setBucket] = useState<Bucket>(DEFAULT_BUCKET["7d"]);
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derived: if user picked Project but no project is loaded, fall back to
  // Global for fetching purposes. We render the empty state separately.
  const effectiveScope: Scope =
    scopeRaw === "project" && !projectId ? "global" : scopeRaw;

  // Switching range can leave the current bucket invalid — collapse onto
  // a sensible default *for fetching*, while letting the UI stay in sync
  // via setRange's wrapper below.
  const setRangeAndCoerce = useCallback(
    (newRange: RangeId) => {
      setRange(newRange);
      if (!ALLOWED_BUCKETS[newRange].includes(bucket)) {
        setBucket(DEFAULT_BUCKET[newRange]);
      }
    },
    [bucket],
  );

  const allowedBuckets = useMemo(() => ALLOWED_BUCKETS[range], [range]);

  const fetchData = useCallback(async () => {
    if (effectiveScope === "project" && !projectId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    const now = Math.floor(Date.now() / 1000);
    const from = now - RANGE_SECS[range];
    try {
      const resp =
        effectiveScope === "global"
          ? await getGlobalStatistics({ from, to: now, bucket })
          : await getProjectStatistics(projectId!, { from, to: now, bucket });
      setData(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [effectiveScope, projectId, range, bucket]);

  useEffect(() => {
    // Fetching is an external-system call; setState inside the callback is
    // the canonical loading-state pattern. Lint exemption is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  return (
    <div className="flex flex-col h-full overflow-hidden gap-3 select-none">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-[var(--color-text)] mr-3">
          Statistics
        </h1>

        {/* Scope toggle */}
        <ScopeToggle
          scope={scopeRaw}
          onChange={setScopeRaw}
          projectAvailable={!!projectId}
        />

        <Spacer />

        <Label>Range</Label>
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={range}
          onChange={(v) => setRangeAndCoerce(v as RangeId)}
        />

        <Label>Bucket</Label>
        <SegmentedControl
          options={BUCKET_OPTIONS.map((opt) => ({
            ...opt,
            disabled: !allowedBuckets.includes(opt.id),
          }))}
          value={bucket}
          onChange={(v) => setBucket(v as Bucket)}
        />

        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          aria-label="Refresh"
          className="rounded-lg border border-[var(--color-border)] p-1.5 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 transition-colors"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
          ) : (
            <RefreshCw className="w-4 h-4 text-[var(--color-text-muted)]" />
          )}
        </button>
      </div>

      {/* ── Error banner ───────────────────────────────────────────── */}
      {error && (
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      {/* ── Empty state when Project scope without project ─────────── */}
      {scopeRaw === "project" && !projectId && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-sm text-[var(--color-text-muted)]">
            Select a project from the sidebar to view its statistics.
          </div>
        </div>
      )}

      {/* ── Dashboard grid ─────────────────────────────────────────── */}
      {(scopeRaw === "global" || projectId) && (
        <>
          <KpiRow current={data?.current.kpi} previous={data?.previous.kpi} />

          <div className="flex-1 grid grid-cols-12 grid-rows-2 gap-3 min-h-0">
            <div className="col-span-8 row-span-1 min-h-0">
              <ActivityOverTime buckets={data?.current.timeseries ?? []} />
            </div>
            <div className="col-span-4 row-span-1 min-h-0">
              <AgentShare items={data?.current.agent_share ?? []} />
            </div>

            <div className="col-span-4 row-span-1 min-h-0">
              <ModelsList items={data?.current.models ?? []} />
            </div>
            <div className="col-span-4 row-span-1 min-h-0">
              <TopList
                scope={effectiveScope}
                items={data?.current.top ?? []}
              />
            </div>
            <div className="col-span-4 row-span-1 min-h-0">
              <ActivityHeatmap
                cells={data?.current.heatmap ?? []}
                rangeId={range}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Header sub-components ───────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] font-semibold">
      {children}
    </span>
  );
}

function Spacer() {
  return <div className="flex-1" />;
}

function ScopeToggle({
  scope,
  onChange,
  projectAvailable,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
  projectAvailable: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5">
      <ScopeButton
        active={scope === "global"}
        onClick={() => onChange("global")}
        icon={<Globe2 className="w-3.5 h-3.5" />}
        label="Global"
      />
      <ScopeButton
        active={scope === "project"}
        onClick={() => onChange("project")}
        icon={<Folder className="w-3.5 h-3.5" />}
        label="Project"
        disabled={!projectAvailable}
        title={!projectAvailable ? "Select a project from the sidebar" : ""}
      />
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  icon,
  label,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => !opt.disabled && onChange(opt.id)}
          disabled={opt.disabled}
          title={opt.disabled ? "Not compatible with current range" : ""}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            value === opt.id
              ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
