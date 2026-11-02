// Automation data + actions shared by the Workbench page and Orbit's page.
// Each hook owns one concern: the project's rows (and every write on them),
// one row's run history (with in-flight polling), and the keyboard commands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCommand, useContextKey } from "../../keyboard";
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
import { isRunInFlight, toUpsert } from "./automationModel";

/// Heartbeat hook: re-renders the caller every `intervalMs` so any
/// `formatRelative(...)` it computes during render stays in sync with wall
/// time. Memo-safe — each component that renders relative time calls this
/// directly so a React.memo wrapping a parent can't break the refresh.
export function useNow(intervalMs: number = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface PatchResult {
  ok: boolean;
  error?: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useProjectAutomations(projectId: string | null) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  // Row whose PUT is in flight. The toggle itself flips optimistically;
  // this only drives the disabled/dim affordance.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Bumped when something happens that might affect a visible run list
  // (manual trigger, cancel). Run panels re-fetch on increment.
  const [runsRefreshTick, setRunsRefreshTick] = useState(0);

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
      setErrorMsg(null);
    } catch (e) {
      setErrorMsg(errorText(e));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    const recovered = () => { void refresh(); };
    window.addEventListener("grove:transport-ready", recovered);
    return () => window.removeEventListener("grove:transport-ready", recovered);
  }, [refresh]);

  /** Create (no `editing`) or replace an existing row. Throws so the dialog can show the error. */
  const submit = useCallback(async (editing: Automation | null, input: AutomationUpsert) => {
    if (!projectId) return;
    if (editing) await updateAutomation(projectId, editing.id, input);
    else await createAutomation(projectId, input);
    void refresh();
  }, [projectId, refresh]);

  /** Manual run. Resolves true once the run is queued. */
  const trigger = useCallback(async (id: string): Promise<boolean> => {
    if (!projectId) return false;
    setTriggeringId(id);
    try {
      const result = await triggerAutomation(projectId, id);
      setErrorMsg(result.error ?? null);
      // Trigger is async — the run is `queued` and the agent completes in
      // the background. Open run panels re-fetch on the tick; the rows
      // refresh so last-run state updates once record_run_result lands.
      setRunsRefreshTick((n) => n + 1);
      void refresh();
      return true;
    } catch (e) {
      setErrorMsg(errorText(e));
      return false;
    } finally {
      setTriggeringId(null);
    }
  }, [projectId, refresh]);

  /// The backend decides whether to dequeue (queued) or send ACP Cancel
  /// (running); polling sweeps the visible status afterwards.
  const cancelRun = useCallback(async (automationId: string, runId: string) => {
    if (!projectId) return;
    try {
      await cancelAutomationRun(projectId, automationId, runId);
      setRunsRefreshTick((n) => n + 1);
      void refresh();
    } catch (e) {
      setErrorMsg(errorText(e));
    }
  }, [projectId, refresh]);

  const remove = useCallback(async (id: string) => {
    if (!projectId) return;
    try {
      await deleteAutomation(projectId, id);
      void refresh();
    } catch (e) {
      setErrorMsg(errorText(e));
    }
  }, [projectId, refresh]);

  /** Optimistic partial update of one row (enable flag, name, prompt).
   *  Resolves with the server's verdict; `error` is set when it refused
   *  (the follow-up refresh clears `errorMsg`, so callers that need to keep
   *  showing it hold on to this). Skipped while another write is in flight. */
  const patch = useCallback(async (a: Automation, changes: Partial<AutomationUpsert>): Promise<PatchResult> => {
    if (!projectId || togglingId) return { ok: false };
    setTogglingId(a.id);
    // Optimistic — the control must react on click, not when the PUT
    // round-trips. `refresh()` reconciles with the server row afterwards.
    setAutomations((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...changes } : x)));
    try {
      await updateAutomation(projectId, a.id, toUpsert(a, changes));
      void refresh();
      return { ok: true };
    } catch (e) {
      setErrorMsg(errorText(e));
      // The optimistic change must never survive a failed request.
      void refresh();
      return { ok: false, error: errorText(e) };
    } finally {
      setTogglingId(null);
    }
  }, [projectId, togglingId, refresh]);

  const toggleEnabled = useCallback((a: Automation) => patch(a, { enabled: !a.enabled }), [patch]);

  return {
    automations, isLoading, errorMsg, setErrorMsg, runsRefreshTick, triggeringId, togglingId,
    refresh, submit, trigger, cancelRun, remove, patch, toggleEnabled,
  };
}

/** Recent runs of one Automation, polled every 3s while one is in flight.
 *  `onSettle` fires when the last in-flight run finishes. */
export function useAutomationRuns(
  projectId: string,
  automationId: string,
  refreshTick: number,
  { limit = 10, onSettle }: { limit?: number; onSettle?: () => void } = {},
) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(async () => {
      try {
        const all = await listAutomationRuns(projectId, automationId);
        if (alive) {
          // The backend already trims to 100 when persisting; here we keep
          // the UI density manageable.
          setRuns(all.slice(0, limit));
          setError(null);
        }
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    });
    return () => {
      alive = false;
    };
  }, [projectId, automationId, refreshTick, limit]);

  // A boolean dependency so the polling effect below isn't torn down and
  // rebuilt on every successful poll (each one sets a new array).
  const hasInflight = useMemo(() => runs?.some(isRunInFlight) ?? false, [runs]);

  const settleRef = useRef(onSettle);
  useEffect(() => { settleRef.current = onSettle; });
  const wasInflight = useRef(false);
  useEffect(() => {
    if (wasInflight.current && !hasInflight) settleRef.current?.();
    wasInflight.current = hasInflight;
  }, [hasInflight]);

  // Poll while anything is queued or running, and pause while the tab is
  // hidden so a background window doesn't generate ~20 reqs/min per open
  // panel for the duration of a long agent turn.
  useEffect(() => {
    if (!hasInflight) return;
    const fetchRuns = async () => {
      try {
        const all = await listAutomationRuns(projectId, automationId);
        setRuns(all.slice(0, limit));
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
        // Refetch on re-show so stale rows don't linger until the next tick.
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
  }, [hasInflight, projectId, automationId, limit]);

  return { runs, error };
}

/** Catalog commands (`automation.*`). `current` is the editable row the
 *  edit / delete / run commands act on; system-managed rows never qualify.
 *  Handlers are read through refs by useCommand, so they needn't be stable. */
export function useAutomationCommands({
  projectId,
  current,
  onNew,
  onEdit,
  onDelete,
  onRun,
}: {
  projectId: string | null;
  current: Automation | null;
  onNew: () => void;
  onEdit: (a: Automation) => void;
  onDelete: (a: Automation) => void;
  onRun: (a: Automation) => void;
}) {
  useCommand("automation.new", onNew, { enabled: () => !!projectId }, [projectId]);
  useContextKey("automationSelected", !!current);
  useCommand(
    "automation.edit",
    () => { if (current) onEdit(current); },
    { enabled: () => !!current },
    [current],
  );
  useCommand(
    "automation.delete",
    () => { if (current) onDelete(current); },
    { enabled: () => !!current },
    [current],
  );
  useCommand(
    "automation.run",
    () => { if (current) onRun(current); },
    { enabled: () => !!current },
    [current],
  );
}
