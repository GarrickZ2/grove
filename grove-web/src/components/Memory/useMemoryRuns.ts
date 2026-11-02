import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AutomationRun,
  cancelAutomationRun,
  finishAutomationRun,
  listAutomationRuns,
} from "../../api/automations";
import { type MemoryConfig, type MemoryOverview, deleteMemoryRun, getMemoryRunHistory } from "../../api/memory";
import { errorMessage } from "./memoryFormat";
import { isAgentRunning } from "./memoryModel";
import type { MemoryRunStreamUpdate } from "./useMemoryProject";

interface MemoryRunsOptions {
  projectId: string;
  config: MemoryConfig | null;
  refreshTick: number;
  liveUpdates: MemoryRunStreamUpdate[];
  /** Opens the run whose session is this chat once the list has it. */
  openRunChatId?: string;
  onChanged: () => void;
}

/** Memory organization runs: list, live updates, the open run's history, and actions. */
export function useMemoryRuns({ projectId, config, refreshTick, liveUpdates, openRunChatId, onChanged }: MemoryRunsOptions) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [historyUsage, setHistoryUsage] = useState<MemoryOverview["usage"] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [finishingRunId, setFinishingRunId] = useState<string | null>(null);
  const historySequenceRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    if (!config || config.project_id !== projectId) {
      setRuns([]);
      setError(null);
      setLoading(Boolean(config && config.project_id !== projectId));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextRuns = await listAutomationRuns(projectId, config.organization.id);
      if (generation === loadGenerationRef.current) setRuns(nextRuns);
    } catch (reason) {
      if (generation === loadGenerationRef.current) setError(errorMessage(reason));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [projectId, config]);
  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshTick]);

  const latestUpdate = liveUpdates[liveUpdates.length - 1];
  useEffect(() => {
    if (!latestUpdate || latestUpdate.automation_id !== config?.organization.id) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (latestUpdate.run) {
        if (!isAgentRunning(latestUpdate.run.status)) {
          setFinishingRunId((current) =>
            current === latestUpdate.run_id ? null : current,
          );
        }
        setRuns((current) => {
          const index = current.findIndex((run) => run.id === latestUpdate.run_id);
          if (index < 0) return [latestUpdate.run!, ...current];
          const next = [...current];
          next[index] = latestUpdate.run!;
          return next;
        });
      }
      if (
        expanded === latestUpdate.run_id
        && latestUpdate.event
        && latestUpdate.sequence > historySequenceRef.current
      ) {
        historySequenceRef.current = latestUpdate.sequence;
        setHistory((current) => [...current, latestUpdate.event!]);
        if (latestUpdate.event.type === "complete") {
          void getMemoryRunHistory(projectId, latestUpdate.run_id)
            .then((response) => {
              if (!active) return;
              setHistory(response.events);
              setHistoryUsage(response.usage);
            })
            .catch((reason) => { if (active) setError(errorMessage(reason)); });
        }
      }
    });
    return () => { active = false; };
  }, [config?.organization.id, expanded, latestUpdate, projectId]);

  const toggle = (runId: string) => {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    historySequenceRef.current = liveUpdates[liveUpdates.length - 1]?.sequence ?? 0;
    setHistoryLoading(true);
    setHistory([]);
    setHistoryUsage(null);
  };
  // Open the requested run once the list has it (only the first time).
  const openedRunChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openRunChatId || openedRunChatRef.current === openRunChatId) return;
    const run = runs.find((candidate) => candidate.resolved_chat_id === openRunChatId);
    if (!run) return;
    openedRunChatRef.current = openRunChatId;
    void Promise.resolve().then(() => toggle(run.id));
    // toggle reads current state; only a newly loaded run list should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRunChatId, runs]);
  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    const loadHistory = async () => {
      try {
        const response = await getMemoryRunHistory(projectId, expanded);
        if (disposed) return;
        setHistory(response.events);
        setHistoryUsage(response.usage);
        historySequenceRef.current = liveUpdates[liveUpdates.length - 1]?.sequence ?? 0;
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        if (!disposed) setHistoryLoading(false);
      }
    };
    void loadHistory();
    return () => { disposed = true; };
    // WebSocket events keep an active run current after this initial snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, projectId]);

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deleteMemoryRun(projectId, deleteTarget.id);
      setRuns((current) => current.filter((run) => run.id !== deleteTarget.id));
      if (expanded === deleteTarget.id) {
        setExpanded(null);
        setHistory([]);
        setHistoryUsage(null);
      }
      setDeleteTarget(null);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  const finishRun = async (run: AutomationRun) => {
    if (!config || finishingRunId) return;
    setFinishingRunId(run.id);
    try {
      await finishAutomationRun(projectId, config.organization.id, run.id);
    } catch (reason) {
      setFinishingRunId(null);
      setError(errorMessage(reason));
    }
  };

  const cancelRun = (run: AutomationRun) => {
    if (!config) return;
    void cancelAutomationRun(projectId, config.organization.id, run.id);
  };

  const selectedRun = expanded
    ? runs.find((run) => run.id === expanded) ?? null
    : null;

  return {
    runs, loading, expanded, setExpanded, toggle, selectedRun,
    history, historyUsage, historyLoading, error, setError,
    deleteTarget, setDeleteTarget, deleting, confirmDelete,
    finishingRunId, finishRun, cancelRun,
  };
}

export type MemoryRunsState = ReturnType<typeof useMemoryRuns>;
