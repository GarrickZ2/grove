// Automation listing for the current project.
//
// Card-style rows over a Skills/Tasks-page-ish header. Delete confirmation
// goes through ConfirmDialog (NOT window.confirm — that's blocked inside the
// Tauri webview and silently fails closed). Empty state and the "+ New"
// CTA use the same icon-pill + Plus-icon convention as NewTaskDialog so the
// whole page reads as one design system.

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import cronstrue from "cronstrue";
import {
  Plus,
  Repeat,
  Play,
  Pencil,
  Trash2,
  CircleCheck,
  CircleX,
  Clock,
  Calendar,
  Clock4,
  Sparkles,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  Loader2,
  Wand2,
  Zap,
  Hand,
  PauseCircle,
  X,
  RotateCcw,
} from "lucide-react";
import { useProject } from "../../context";
import { useCommand, useContextKey } from "../../keyboard";
import { ConfirmDialog } from "../Dialogs/ConfirmDialog";
import {
  type Automation,
  type AutomationRun,
  type AutomationUpsert,
  cancelAutomationRun,
  createAutomation,
  deleteAutomation,
  listAutomations,
  listAutomationRuns,
  triggerAutomation,
  updateAutomation,
} from "../../api/automations";
import { AutomationDialog } from "./AutomationDialog";

interface AutomationPageProps {
  /** Open the chat session that an automation run resolved to. Wired up
   *  from App.tsx via setActiveItem("tasks") + setNavigationData. */
  onOpenChat?: (taskId: string, chatId: string) => void;
}

export function AutomationPage({ onOpenChat }: AutomationPageProps = {}) {
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id ?? null;

  const [automations, setAutomations] = useState<Automation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [deletingTarget, setDeletingTarget] = useState<Automation | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Single-expand model — opening a card collapses the previous one so the
  // run history isn't competing for attention with another card's data.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Bumped when something happens that might affect the visible run list
  // (manual trigger, delete-with-runs). Cards re-fetch on increment.
  const [runsRefreshTick, setRunsRefreshTick] = useState(0);
  // Page-level relative-time tick. The heartbeat lives in the reusable
  // `useNow` hook below so RunRow / any nested component that renders
  // relative time can opt in directly — that way a future React.memo on
  // a row component won't silently kill the refresh by blocking prop
  // bubbling from this page.
  useNow();

  const refresh = useCallback(async () => {
    if (!projectId) {
      setAutomations([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const data = await listAutomations(projectId);
      setAutomations(data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  async function handleSubmit(input: AutomationUpsert) {
    if (!projectId) return;
    if (editing) {
      await updateAutomation(projectId, editing.id, input);
    } else {
      await createAutomation(projectId, input);
    }
    void refresh();
  }

  async function handleTrigger(id: string) {
    if (!projectId) return;
    setTriggeringId(id);
    try {
      const result = await triggerAutomation(projectId, id);
      setErrorMsg(result.status === "failed" ? result.error ?? "Trigger failed" : null);
      // Trigger is async now — the row is `queued` and the agent will
      // complete in the background. Bump the refresh tick so any open
      // run-history panel re-fetches and shows the new row immediately,
      // plus refresh the cards so last-run pills update once the agent
      // finishes (the parent automation row is updated by record_run_result).
      setRunsRefreshTick((n) => n + 1);
      // Auto-open the row so the user sees their run land in the queue.
      setExpandedId(id);
      void refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTriggeringId(null);
    }
  }

  /// Cancel callback wired into each RunRow. The backend decides whether
  /// to dequeue (status=queued) or send ACP Cancel (status=running) — we
  /// just kick the request and let the watcher's polling refresh sweep
  /// the visible status badge.
  async function handleCancelRun(automationId: string, runId: string) {
    if (!projectId) return;
    try {
      await cancelAutomationRun(projectId, automationId, runId);
      setRunsRefreshTick((n) => n + 1);
      void refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  /// Rerun is a glorified manual trigger — same lifecycle, new run row.
  /// Reuses `handleTrigger` so polling, expansion, and last-run pill
  /// behave identically to the ▶ button.
  async function handleRerun(automationId: string) {
    await handleTrigger(automationId);
  }

  async function confirmDelete() {
    if (!projectId || !deletingTarget) return;
    const id = deletingTarget.id;
    setDeletingTarget(null);
    try {
      await deleteAutomation(projectId, id);
      void refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggleEnabled(a: Automation) {
    if (!projectId) return;
    try {
      const payload: AutomationUpsert = {
        name: a.name,
        enabled: !a.enabled,
        task_mode: a.task_mode,
        task_id: a.task_id,
        task_template: a.task_template,
        session_mode: a.session_mode,
        chat_id: a.chat_id,
        session_template: a.session_template,
        prompt: a.prompt,
        schedule_cron: a.schedule_cron,
      };
      await updateAutomation(projectId, a.id, payload);
      void refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  // Catalog-declared "New Automation" command — opens the create dialog,
  // same path the header "New Automation" button takes. Gated on having a
  // project context; without one the page itself shows a placeholder.
  useCommand(
    "automation.new",
    () => {
      setEditing(null);
      setDialogOpen(true);
    },
    { enabled: () => !!projectId },
    [projectId],
  );

  // The expanded row is the "current" automation for edit / delete / run —
  // those commands gate on `automationSelected`. Expanding a card selects it.
  const expandedAutomation = useMemo(
    () => automations.find((a) => a.id === expandedId) ?? null,
    [automations, expandedId],
  );
  useContextKey("automationSelected", !!expandedAutomation);
  useCommand(
    "automation.edit",
    () => {
      if (!expandedAutomation) return;
      setEditing(expandedAutomation);
      setDialogOpen(true);
    },
    { enabled: () => !!expandedAutomation },
    [expandedAutomation],
  );
  useCommand(
    "automation.delete",
    () => {
      if (expandedAutomation) setDeletingTarget(expandedAutomation);
    },
    { enabled: () => !!expandedAutomation },
    [expandedAutomation],
  );
  useCommand(
    "automation.run",
    () => {
      if (expandedAutomation) void handleTrigger(expandedAutomation.id);
    },
    { enabled: () => !!expandedAutomation },
    [expandedAutomation],
  );

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
        Select a project to manage automations.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[var(--color-highlight)]/10 flex-shrink-0">
            <Repeat className="w-5 h-5 text-[var(--color-highlight)]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[var(--color-text)] leading-tight">
              Automation
            </h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              Cron-driven prompts injected into a chat session. Only fires while
              Grove is running.
            </p>
          </div>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium
            bg-[var(--color-highlight)] hover:opacity-90 text-white shadow-sm flex-shrink-0 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          New Automation
        </motion.button>
      </div>

      {errorMsg && (
        <div className="flex items-start gap-2 mb-3 px-3 py-2 text-sm rounded-lg bg-[var(--color-error)]/10 border border-[var(--color-error)]/30 text-[var(--color-error)]">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            className="text-[var(--color-error)]/70 hover:text-[var(--color-error)] text-xs"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Body */}
      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="w-6 h-6 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : automations.length === 0 ? (
        <EmptyState
          onCreate={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        />
      ) : (
        // `pt-1.5` carves out the 1-2px lift `whileHover { y: -1 }` does on
        // each card so the top row doesn't clip into the page header on
        // hover. Without this the first card visually loses its top border.
        <div className="space-y-2 overflow-y-auto flex-1 pr-1 pt-1.5">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              projectId={projectId}
              expanded={expandedId === a.id}
              refreshTick={runsRefreshTick}
              triggering={triggeringId === a.id}
              onToggleExpand={() =>
                setExpandedId((prev) => (prev === a.id ? null : a.id))
              }
              onEdit={() => {
                setEditing(a);
                setDialogOpen(true);
              }}
              onTrigger={() => handleTrigger(a.id)}
              onDelete={() => setDeletingTarget(a)}
              onToggleEnabled={() => handleToggleEnabled(a)}
              onOpenChat={onOpenChat}
              onCancelRun={(runId) => handleCancelRun(a.id, runId)}
              onRerun={() => handleRerun(a.id)}
            />
          ))}
        </div>
      )}

      <AutomationDialog
        isOpen={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        projectId={projectId}
        initial={editing}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        isOpen={!!deletingTarget}
        title="Delete automation"
        message={
          deletingTarget ? (
            <span>
              Delete <strong>{deletingTarget.name}</strong>? Its run history will
              be removed too. This can't be undone.
            </span>
          ) : (
            ""
          )
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeletingTarget(null)}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────

interface CardProps {
  automation: Automation;
  projectId: string;
  expanded: boolean;
  refreshTick: number;
  triggering: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onTrigger: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onOpenChat?: (taskId: string, chatId: string) => void;
  onCancelRun: (runId: string) => void;
  onRerun: () => void;
}

function AutomationCard({
  automation,
  projectId,
  expanded,
  refreshTick,
  triggering,
  onToggleExpand,
  onEdit,
  onTrigger,
  onDelete,
  onToggleEnabled,
  onOpenChat,
  onCancelRun,
  onRerun,
}: CardProps) {
  let scheduleDescription = automation.schedule_cron;
  try {
    scheduleDescription = cronstrue.toString(automation.schedule_cron, {
      use24HourTimeFormat: true,
    });
  } catch {
    // fall through with the raw expression
  }

  const lastRun = automation.last_run_at
    ? new Date(automation.last_run_at * 1000)
    : null;
  const nextRun = automation.next_run_at
    ? new Date(automation.next_run_at * 1000)
    : null;

  return (
    <motion.div
      layout
      whileHover={{ y: -1 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={`group rounded-xl border bg-[var(--color-bg-secondary)] transition-all duration-150 ${
        automation.enabled
          ? "border-[var(--color-border)] hover:border-[var(--color-highlight)]/50 hover:shadow-sm"
          : "border-[var(--color-border)] opacity-70"
      }`}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <ToggleSwitch value={automation.enabled} onChange={onToggleEnabled} />

        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-[var(--color-text)] truncate">
              {automation.name}
            </h3>
            <StatusBadge status={automation.last_run_status} />
            <ModeChip text={taskTargetLabel(automation)} />
            <ModeChip text={sessionTargetLabel(automation)} />
          </div>

          {/* Schedule */}
          <div className="flex items-center gap-1.5 mt-1.5 text-xs text-[var(--color-text-muted)]">
            <Calendar className="w-3.5 h-3.5 text-[var(--color-highlight)]" />
            <span>{scheduleDescription}</span>
            <code className="ml-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
              {automation.schedule_cron}
            </code>
          </div>

          {/* Last / Next pills */}
          <div className="flex items-center gap-3 mt-2 text-[11px] text-[var(--color-text-muted)]">
            {nextRun && (
              <span className="inline-flex items-center gap-1">
                <Clock4 className="w-3 h-3" />
                Next {formatRelative(nextRun)}
              </span>
            )}
            {lastRun && (
              <span className="inline-flex items-center gap-1">
                <span>Last {formatRelative(lastRun)}</span>
              </span>
            )}
          </div>

          {automation.last_run_error && (
            <div
              className="mt-2 text-[11px] text-[var(--color-error)] truncate"
              title={automation.last_run_error}
            >
              {automation.last_run_error}
            </div>
          )}
        </div>

        {/* Actions — always visible when expanded so the user can act on
            the history they're inspecting without hover gymnastics. */}
        <div
          className={`flex items-center gap-0.5 flex-shrink-0 transition-opacity ${
            expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <IconButton title="Run now" onClick={onTrigger} disabled={triggering}>
            <Play className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton title="Edit" onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton title="Delete" onClick={onDelete} danger>
            <Trash2 className="w-3.5 h-3.5" />
          </IconButton>
        </div>

        {/* Expand toggle */}
        <button
          type="button"
          onClick={onToggleExpand}
          title={expanded ? "Hide run history" : "Show run history"}
          className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors flex-shrink-0"
        >
          {expanded ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Expanded run history */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="runs"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden border-t border-[var(--color-border)]"
          >
            <RunsPanel
              projectId={projectId}
              automationId={automation.id}
              refreshTick={refreshTick}
              onOpenChat={onOpenChat}
              onCancelRun={onCancelRun}
              onRerun={onRerun}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Run history (expanded card body) ──────────────────────────────────

interface RunsPanelProps {
  projectId: string;
  automationId: string;
  refreshTick: number;
  onOpenChat?: (taskId: string, chatId: string) => void;
  onCancelRun: (runId: string) => void;
  onRerun: () => void;
}

function RunsPanel({
  projectId,
  automationId,
  refreshTick,
  onOpenChat,
  onCancelRun,
  onRerun,
}: RunsPanelProps) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(async () => {
      try {
        const all = await listAutomationRuns(projectId, automationId);
        if (alive) {
          // Cap to the 10 most recent. The backend already trims to 100
          // when persisting; here we keep the UI density manageable.
          setRuns(all.slice(0, 10));
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      alive = false;
    };
  }, [projectId, automationId, refreshTick]);

  // Whether any visible run is still in flight. Derived state with a
  // `useMemo` so the polling effect below can depend on a boolean rather
  // than the full `runs` array — without this the effect would tear down
  // and rebuild its interval+listener on every successful 3s poll (which
  // setRuns'd a new array reference even when in-flight presence didn't
  // change), introducing a small per-poll drift on the cadence.
  const hasInflight = useMemo(
    () => runs?.some((r) => r.status === "queued" || r.status === "running") ?? false,
    [runs],
  );

  // Poll while any visible run is still queued OR running so the
  // in-flight agent turn updates in place once Complete lands on the
  // backend. Stops on its own when nothing is in flight, and pauses when
  // the tab is hidden so a background window doesn't generate ~20 reqs/min
  // per open card for the entire duration of a 30-min agent turn.
  useEffect(() => {
    if (!hasInflight) return;
    const fetchRuns = async () => {
      try {
        const all = await listAutomationRuns(projectId, automationId);
        setRuns(all.slice(0, 10));
      } catch {
        /* swallow — refreshTick path will surface persistent errors */
      }
    };
    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void fetchRuns();
      }, 3000);
    };
    const stop = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Immediately refetch on re-show so the user doesn't stare at
        // stale rows for up to 3 seconds before the next interval fires.
        void fetchRuns();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasInflight, projectId, automationId]);

  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--color-error)]">
        Failed to load run history: {error}
      </div>
    );
  }
  if (runs === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-xs text-[var(--color-text-muted)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading recent runs…
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="px-4 py-4 text-xs text-[var(--color-text-muted)] text-center">
        No runs yet. Click <Play className="inline w-3 h-3 mx-0.5" /> to trigger
        this automation now.
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-2 bg-[var(--color-bg)]/40">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        <span>Recent runs ({runs.length})</span>
        <span>Latest 10 · history capped at 100</span>
      </div>
      <div className="space-y-1.5">
        {runs.map((r) => (
          <RunRow
            key={r.id}
            run={r}
            onOpenChat={onOpenChat}
            onCancel={() => onCancelRun(r.id)}
            onRerun={onRerun}
          />
        ))}
      </div>
    </div>
  );
}

function RunRow({
  run,
  onOpenChat,
  onCancel,
  onRerun,
}: {
  run: AutomationRun;
  onOpenChat?: (taskId: string, chatId: string) => void;
  onCancel: () => void;
  onRerun: () => void;
}) {
  useNow(); // re-render every 60s so the relative time stays fresh
  const triggeredAt = new Date(run.triggered_at * 1000);
  const durationMs = run.completed_at
    ? (run.completed_at - run.triggered_at) * 1000
    : null;

  const canJump = !!(run.resolved_task_id && run.resolved_chat_id && onOpenChat);
  const handleJump = () => {
    if (canJump) onOpenChat!(run.resolved_task_id!, run.resolved_chat_id!);
  };

  // Row-level actions depend on the run's terminal-ness:
  //   queued / running  → Cancel
  //   failed / timeout / interrupted / cancelled → Rerun (manual trigger)
  //   success           → no action (use Open Session to inspect)
  const inFlight = run.status === "queued" || run.status === "running";
  const reRunnable =
    run.status === "failed" ||
    run.status === "timeout" ||
    run.status === "interrupted" ||
    run.status === "cancelled";

  // Body content depends on status. Success with text → show excerpt; success
  // without text → friendly "tool-only" note; failure / timeout / interrupted
  // → render the error so users don't have to dig into the DB.
  const body = renderRunBody(run);

  return (
    <div
      onClick={canJump ? handleJump : undefined}
      role={canJump ? "button" : undefined}
      tabIndex={canJump ? 0 : undefined}
      onKeyDown={(e) => {
        if (canJump && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          handleJump();
        }
      }}
      className={`group/run rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 transition-colors ${
        canJump ? "cursor-pointer hover:border-[var(--color-highlight)]/50" : ""
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <RunStatusBadge status={run.status} />
        <TriggerKindBadge kind={run.trigger_kind} />
        <span className="text-[var(--color-text-muted)]">
          {formatRelative(triggeredAt)}
        </span>
        {durationMs !== null && (
          <span className="text-[var(--color-text-muted)]">
            · {formatDuration(durationMs)}
          </span>
        )}
        <div className="ml-auto inline-flex items-center gap-2">
          {inFlight && (
            <RowAction
              variant="danger"
              icon={<X className="w-3 h-3" />}
              onClick={onCancel}
            >
              Cancel
            </RowAction>
          )}
          {reRunnable && (
            <RowAction
              variant="primary"
              icon={<RotateCcw className="w-3 h-3" />}
              onClick={onRerun}
            >
              {/* Label is "Run now" because the action fires a fresh trigger
                  with the *current* automation config (current prompt,
                  current target), not a replay of this row's
                  `prompt_snapshot`. "Rerun" suggested historical replay
                  which the implementation doesn't do. */}
              Run now
            </RowAction>
          )}
          {canJump && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-text-muted)] group-hover/run:text-[var(--color-highlight)] transition-colors">
              Open session
              <ArrowUpRight className="w-3 h-3" />
            </span>
          )}
        </div>
      </div>
      {body && <div className="mt-1.5 text-xs leading-relaxed">{body}</div>}
    </div>
  );
}

/// Small inline action button for run rows. Stops click propagation so a
/// cancel/rerun tap doesn't also fire the row-level "Open session" click.
function RowAction({
  children,
  icon,
  variant,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  variant: "primary" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-md transition-colors ${
        variant === "danger"
          ? "text-rose-500 hover:bg-rose-500/10"
          : "text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function renderRunBody(run: AutomationRun): React.ReactNode {
  switch (run.status) {
    case "queued":
      return (
        <span className="text-[var(--color-text-muted)] italic">
          Waiting for agent…
        </span>
      );
    case "running":
      return (
        <span className="text-[var(--color-text-muted)] italic">
          Agent is processing…
        </span>
      );
    case "cancelled":
      return (
        <span className="text-[var(--color-text-muted)]">
          {run.error ?? "Cancelled by user"}
        </span>
      );
    case "success":
      if (run.agent_response && run.agent_response.trim()) {
        return (
          <pre
            className="whitespace-pre-wrap break-words text-[var(--color-text)] font-sans line-clamp-3"
            title={run.agent_response}
          >
            {run.agent_response}
          </pre>
        );
      }
      return (
        <span className="text-[var(--color-text-muted)] italic">
          Completed (agent ran tools only — no text response)
        </span>
      );
    case "failed":
      return (
        <div className="text-[var(--color-error)]">
          {run.phase && (
            <span className="text-[10px] uppercase tracking-wider mr-1.5 px-1.5 py-0.5 rounded bg-[var(--color-error)]/10">
              {run.phase}
            </span>
          )}
          <span className="whitespace-pre-wrap break-words">
            {run.error ?? "Unknown failure"}
          </span>
        </div>
      );
    case "timeout":
      return (
        <span className="text-amber-500">
          Agent did not report completion within the timeout window
          {run.agent_response && " (captured partial output)"}
        </span>
      );
    case "interrupted":
      return (
        <span className="text-[var(--color-text-muted)]">
          Grove restarted before the agent finished
        </span>
      );
    default:
      return null;
  }
}

function RunStatusBadge({ status }: { status: string }) {
  const styles: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    success: {
      label: "success",
      icon: <CircleCheck className="w-3 h-3" />,
      cls: "bg-emerald-500/15 text-emerald-500",
    },
    failed: {
      label: "failed",
      icon: <CircleX className="w-3 h-3" />,
      cls: "bg-rose-500/15 text-rose-500",
    },
    timeout: {
      label: "timeout",
      icon: <Clock className="w-3 h-3" />,
      cls: "bg-amber-500/15 text-amber-500",
    },
    interrupted: {
      label: "interrupted",
      icon: <PauseCircle className="w-3 h-3" />,
      cls: "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]",
    },
    queued: {
      label: "queued",
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      cls: "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]",
    },
    running: {
      label: "running",
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      cls: "bg-sky-500/15 text-sky-500",
    },
    cancelled: {
      label: "cancelled",
      icon: <X className="w-3 h-3" />,
      cls: "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]",
    },
  };
  const s = styles[status] ?? {
    label: status,
    icon: null,
    cls: "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${s.cls}`}
    >
      {s.icon}
      {s.label}
    </span>
  );
}

function TriggerKindBadge({ kind }: { kind: string }) {
  if (kind === "manual") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
        title="Triggered manually via the Run-now button"
      >
        <Hand className="w-3 h-3" />
        manual
      </span>
    );
  }
  if (kind === "cron") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
        title="Triggered by the cron schedule"
      >
        <Zap className="w-3 h-3" />
        cron
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      <Wand2 className="w-3 h-3" />
      {kind}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 text-center">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-[var(--color-highlight)]/10 mb-4">
        <Sparkles className="w-7 h-7 text-[var(--color-highlight)]" />
      </div>
      <h2 className="text-base font-semibold text-[var(--color-text)]">
        No automations yet
      </h2>
      <p className="text-sm text-[var(--color-text-muted)] mt-1.5 max-w-md">
        Schedule a prompt to fire into a chat session on a cron interval — daily
        summaries, hourly status checks, weekly reports.
      </p>
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium
          bg-[var(--color-highlight)] hover:opacity-90 text-white shadow-sm transition-opacity"
      >
        <Plus className="w-4 h-4" />
        Create your first automation
      </motion.button>
    </div>
  );
}

/// Parent-row last-run badge. Delegates to the same renderer
/// `RunStatusBadge` uses, so cancelled / timeout / interrupted get the
/// same colored pill as in the run history (instead of falling through to
/// a generic grey chip that's visually identical to currently-running).
/// The label maps `success → ok` for the parent surface — shorter, fits
/// next to the automation name in the card header.
function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-emerald-500/15 text-emerald-500">
        <CircleCheck className="w-3 h-3" />
        ok
      </span>
    );
  }
  return <RunStatusBadge status={status} />;
}

/// Human-friendly target description for the task chip. Reserved internal
/// ids (`_local`) are translated to the label users actually recognise.
/// IDs are truncated with a trailing `…` so they don't look like complete
/// short identifiers (two unrelated tasks could share an 8-char prefix).
function taskTargetLabel(a: Automation): string {
  if (a.task_mode === "new") return "→ New task";
  if (a.task_id === "_local") return "→ Local task";
  const id = a.task_id ?? "";
  // `>= 8` (not `> 8`) so a task id that's exactly 8 chars still gets the
  // ellipsis. Otherwise two unrelated 8-char-prefix tasks would render to
  // an identical chip.
  return id.length >= 8 ? `→ Task ${id.slice(0, 8)}…` : `→ Task ${id}`;
}

function sessionTargetLabel(a: Automation): string {
  if (a.session_mode === "new") return "→ New session";
  const id = a.chat_id ?? "";
  if (!id) return "→ session";
  return id.length >= 12 ? `→ ${id.slice(0, 12)}…` : `→ ${id}`;
}

function ModeChip({ text }: { text: string }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-muted)] truncate max-w-[160px]">
      {text}
    </span>
  );
}

function ToggleSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      title={value ? "Disable" : "Enable"}
      className="mt-1 flex-shrink-0"
    >
      <span
        className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${
          value ? "bg-[var(--color-highlight)]" : "bg-[var(--color-bg-tertiary)]"
        }`}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className={`block w-4 h-4 rounded-full bg-white shadow-sm absolute top-0.5 ${
            value ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function IconButton({
  children,
  onClick,
  title,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`p-1.5 rounded-md transition-colors ${
        disabled
          ? "text-[var(--color-text-muted)]/40 cursor-not-allowed"
          : danger
          ? "text-[var(--color-text-muted)] hover:text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
      }`}
    >
      {children}
    </motion.button>
  );
}

/// Heartbeat hook: re-renders the caller every `intervalMs` so any
/// `formatRelative(...)` it computes during render stays in sync with wall
/// time. Memo-safe — each component that renders relative time calls this
/// directly so a React.memo wrapping a parent can't break the refresh.
function useNow(intervalMs: number = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Render a date as a short relative-or-absolute string. Anything within a
// day rolls up to "in 3h" / "5m ago"; further out we just show a short date.
function formatRelative(d: Date): string {
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const absMs = Math.abs(diffMs);
  const isFuture = diffMs > 0;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (absMs < min) return isFuture ? "in <1m" : "<1m ago";
  if (absMs < hour) {
    const m = Math.round(absMs / min);
    return isFuture ? `in ${m}m` : `${m}m ago`;
  }
  if (absMs < day) {
    const h = Math.round(absMs / hour);
    return isFuture ? `in ${h}h` : `${h}h ago`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
