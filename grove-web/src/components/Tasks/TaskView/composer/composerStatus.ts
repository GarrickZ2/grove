import { useMemo } from "react";
import type { PlanEntry } from "../planEntries";

/** The tray (or docked agent request) the Orbit composer's status zone has open. */
export type OrbitTray = "plan" | "subagents" | "queue" | "memory" | "comments" | "ask";

/** What the TaskChat composer panel state maps to in Orbit. */
export type ComposerPanelId =
  | "auth" | "permission" | "ask_form" | "subagents" | "memory" | "todo" | "plan"
  | "pending" | "previewComments" | "quota" | "context";

export function orbitTrayForPanel(panel: ComposerPanelId | null): OrbitTray | null {
  switch (panel) {
    case "todo":
    case "plan": return "plan";
    case "subagents": return "subagents";
    case "pending": return "queue";
    case "memory": return "memory";
    case "previewComments": return "comments";
    case "auth":
    case "permission":
    case "ask_form": return "ask";
    default: return null;
  }
}

export type AskKind = "auth" | "permission" | "survey" | "external";

export type PlanChip =
  /** Todo/plan entries: the current step's name and progress. */
  | { kind: "steps"; label: string; done: number; total: number; live: boolean }
  /** Only a plan document (markdown / file): no steps to count. */
  | { kind: "doc"; label: string; live: boolean }
  /** A running turn with no plan at all. */
  | { kind: "working" };

export interface ComposerStatus {
  running: boolean;
  plan: PlanChip | null;
  subagents: { count: number; running: number; avatars: string[] } | null;
  queue: { count: number; failed: number } | null;
  memory: number | null;
  comments: number | null;
  ask: AskKind | null;
}

export interface ComposerStatusInput {
  running: boolean;
  /** Todo entries in display order. */
  planEntries: readonly PlanEntry[];
  /** Title of the latest plan document, when the session has one. */
  planDocTitle: string | null;
  subagents: readonly { sessionId: string; status: string }[];
  queue: { count: number; failed: number };
  memoryCount: number;
  commentCount: number;
  ask: AskKind | null;
}

/**
 * The step the plan chip names: the one in progress, else the next one not
 * done. Null once everything is complete.
 */
export function currentPlanStep(entries: readonly PlanEntry[]): PlanEntry | null {
  return entries.find((entry) => entry.status === "in_progress")
    ?? entries.find((entry) => entry.status !== "completed")
    ?? null;
}

/**
 * Plan chip. Todos (ACP plan entries) and plan documents are one idea to the
 * user — "the plan" — so they share a chip: entries give the step name and
 * progress, a document alone gives its title, and with neither a running turn
 * reads "Working".
 */
export function planChip(input: Pick<ComposerStatusInput, "running" | "planEntries" | "planDocTitle">): PlanChip | null {
  const { running, planEntries, planDocTitle } = input;
  if (planEntries.length > 0) {
    const done = planEntries.filter((entry) => entry.status === "completed").length;
    const current = currentPlanStep(planEntries);
    return { kind: "steps", label: current?.content ?? "Plan complete", done, total: planEntries.length, live: running };
  }
  if (planDocTitle !== null) return { kind: "doc", label: planDocTitle, live: running };
  // Elapsed time lives on the transcript's live work group, not here.
  if (running) return { kind: "working" };
  return null;
}

export function buildComposerStatus(input: ComposerStatusInput): ComposerStatus {
  const runningSubagents = input.subagents.filter((agent) => agent.status === "Running").length;
  return {
    running: input.running,
    plan: planChip(input),
    subagents: input.subagents.length > 0
      ? { count: input.subagents.length, running: runningSubagents, avatars: input.subagents.slice(0, 3).map((agent) => agent.sessionId) }
      : null,
    queue: input.queue.count > 0 ? { ...input.queue } : null,
    memory: input.memoryCount > 0 ? input.memoryCount : null,
    comments: input.commentCount > 0 ? input.commentCount : null,
    ask: input.ask,
  };
}

/** The status zone shows only while it has something to say. */
export function hasComposerStatus(status: ComposerStatus | null): status is ComposerStatus {
  return !!status && (
    status.running || !!status.plan || !!status.subagents || !!status.queue
    || status.memory !== null || status.comments !== null || status.ask !== null
  );
}

/**
 * Status for the Orbit composer, kept referentially stable while its content
 * is unchanged — the inputs are rebuilt on every streamed chunk, the status
 * bar should not be. Null (and nothing computed) when disabled.
 */
export function useComposerStatus(input: ComposerStatusInput | null): ComposerStatus | null {
  const status = input ? buildComposerStatus(input) : null;
  const key = status ? JSON.stringify(status) : "";
  // The key captures every field of `status`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => status, [key]);
}

/** "42s", "1m 12s", "1h 3m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Modes that skip approvals get the amber tint in the setup chip. */
export function isRiskyMode(mode: { value?: string; label?: string } | null | undefined): boolean {
  if (!mode) return false;
  const text = `${mode.value ?? ""} ${mode.label ?? ""}`.toLowerCase();
  return /bypass|yolo|danger|skip[\s_-]*permission|full[\s_-]*access|no[\s_-]*approval/.test(text);
}

/**
 * One button for send and stop. Mirrors TaskChat's existing button logic
 * exactly; only the presentation is unified.
 */
export type OrbAction = "save" | "send" | "queue" | "stop" | "sendNow" | "idle";

export function resolveOrbAction(state: {
  editing: boolean;
  permissionPending: boolean;
  busy: boolean;
  hasContent: boolean;
  pendingCount: number;
  /** Sending stops the running turn instead of queueing. */
  interrupt?: boolean;
}): OrbAction {
  if (state.editing) return "save";
  if (state.permissionPending) return state.busy ? "stop" : "idle";
  if (!state.busy) return state.hasContent ? "send" : "idle";
  if (state.hasContent) return state.interrupt ? "send" : "queue";
  return state.pendingCount > 0 ? "sendNow" : "stop";
}

/** Usage ring: context fill when known, else quota used. Amber near the limit. */
export type UsageTone = "ok" | "warn" | "critical";

/** Same thresholds as `contextHealthColor` / `quotaHealthColor`, so the ring matches its popover. */
function contextTone(percentUsed: number): UsageTone {
  return percentUsed >= 70 ? "critical" : percentUsed >= 50 ? "warn" : "ok";
}

function quotaTone(percentRemaining: number): UsageTone {
  return percentRemaining < 20 ? "critical" : percentRemaining < 50 ? "warn" : "ok";
}

const TONE_RANK: Record<UsageTone, number> = { ok: 0, warn: 1, critical: 2 };

/** The ring shows context use when known, else quota use; its tone is the worse of the two. */
export function usageRingModel(contextPercent: number | null, quotaRemaining: number | null): { percent: number; tone: UsageTone; source: "context" | "quota" } | null {
  const tones = [contextPercent !== null ? contextTone(contextPercent) : null, quotaRemaining !== null ? quotaTone(quotaRemaining) : null]
    .filter((tone): tone is UsageTone => tone !== null);
  const tone = tones.reduce<UsageTone>((worst, next) => (TONE_RANK[next] > TONE_RANK[worst] ? next : worst), "ok");
  if (contextPercent !== null) return { percent: contextPercent, tone, source: "context" };
  if (quotaRemaining !== null) return { percent: Math.max(0, Math.min(100, 100 - quotaRemaining)), tone, source: "quota" };
  return null;
}

/**
 * Chip-sized label for a setting value: drops parentheticals ("Default
 * (recommended)" → "Default") and, for long multi-word modes, keeps the
 * first word ("Bypass permissions" → "Bypass") so it never truncates
 * mid-word. Full names stay in the menu.
 */
export function shortSettingLabel(label: string, kind: "model" | "mode"): string {
  const plain = label.replace(/\s*[(（][^)）]*[)）]\s*/g, " ").replace(/\s+/g, " ").trim() || label.trim();
  if (kind !== "mode" || plain.length <= 12) return plain;
  const first = plain.split(" ")[0];
  return first.length >= 3 ? first : plain;
}
