import { memo } from "react";
import { Brain, CheckCircle2, ChevronRight, CircleAlert, Eye, Globe, Pencil, Plug, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { useNow } from "../../../../orbit/ui/useNow";
import { formatElapsed } from "../composer/composerStatus";
import type { LiveStepKind, LiveWorkStep, LiveWorkSummary } from "./liveWork";

const STEP_ICONS: Record<LiveStepKind, LucideIcon> = {
  run: Terminal,
  read: Eye,
  edit: Pencil,
  search: Search,
  fetch: Globe,
  mcp: Plug,
  thinking: Brain,
  tool: Wrench,
};

/** A start older than this is a stale message, not this turn: omit the time. */
const MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;

/** "· 1m 12s"; the only part of the group that ticks. */
const LiveElapsed = memo(function LiveElapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  if (now < startedAt || now - startedAt >= MAX_ELAPSED_MS) return null;
  return <span className="ocv-live-meta ocv-tabular">{formatElapsed(now - startedAt)}</span>;
});

/** The "now" line under the header: the step the agent is on. */
const LiveStepLine = memo(function LiveStepLine({ step }: { step: LiveWorkStep }) {
  const Icon = STEP_ICONS[step.kind];
  return (
    // Keyed by the step, so a new step fades in once; streaming output of
    // the same step does not restart it.
    <div className={`ocv-live-now${step.failed ? " is-failed" : ""}`} key={`${step.kind}:${step.verb}:${step.subject}`}>
      <Icon className="ocv-live-now-icon" aria-hidden="true" />
      {step.verb && <span className="ocv-live-now-verb">{step.verb}</span>}
      <span className={`ocv-live-now-subject${step.mono ? " is-mono" : ""}${step.kind === "thinking" ? " thought-status-shimmer" : ""}`} title={step.subject}>
        {step.subject}
      </span>
    </div>
  );
});

/**
 * Header of the running turn's work group: a live dot, "Working", the
 * elapsed time and the step count, then the current step. It occupies the
 * same place as the settled "Worked for …" row, which replaces it when the
 * turn finishes.
 */
export const OrbitLiveWorkHeader = memo(function OrbitLiveWorkHeader({
  sectionId,
  summary,
  startedAt,
  expanded,
  onToggle,
}: {
  sectionId: string;
  summary: LiveWorkSummary;
  startedAt?: number;
  expanded: boolean;
  onToggle: (sectionId: string) => void;
}) {
  const { steps, failedSteps, current } = summary;
  return (
    <div className="ocv-live">
      <button
        type="button"
        className="ocv-work-head is-live"
        aria-expanded={expanded}
        onClick={() => onToggle(sectionId)}
      >
        <span className="ocv-live-dot" aria-hidden="true" />
        <span className="ocv-work-title">Working</span>
        {startedAt !== undefined && <LiveElapsed startedAt={startedAt} />}
        {steps > 0 && <span className="ocv-live-meta">{steps} {steps === 1 ? "step" : "steps"}</span>}
        {failedSteps > 0 && <span className="ocv-live-meta is-failed">{failedSteps} failed</span>}
        <ChevronRight className={`ocv-work-chev${expanded ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {!expanded && current && <LiveStepLine step={current} />}
    </div>
  );
});

/** A finished turn's work row: "Worked for 1m 12s", in the live header's place. */
export const OrbitSettledWorkHeader = memo(function OrbitSettledWorkHeader({
  sectionId,
  title,
  failedLabel,
  expanded,
  onToggle,
}: {
  sectionId: string;
  title: string;
  failedLabel?: string;
  expanded: boolean;
  onToggle: (sectionId: string) => void;
}) {
  return (
    <button
      type="button"
      className="ocv-work-head"
      aria-expanded={expanded}
      onClick={() => onToggle(sectionId)}
    >
      {failedLabel
        ? <CircleAlert className="text-[var(--color-error)]" aria-hidden="true" />
        : <CheckCircle2 aria-hidden="true" />}
      <span className="ocv-work-title">{title}</span>
      {failedLabel && <span className="ocv-work-fail" title={failedLabel}>· Failed: {failedLabel}</span>}
      <ChevronRight className={`ocv-work-chev${expanded ? " is-open" : ""}`} aria-hidden="true" />
    </button>
  );
});
