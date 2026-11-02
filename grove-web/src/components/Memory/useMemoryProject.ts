import { useCallback, useEffect, useRef, useState } from "react";
import { useBanner } from "../../context";
import { useAgentCatalogRevision } from "../../hooks/useAgentCatalogRevision";
import { type AutomationRun, triggerAutomation } from "../../api/automations";
import { type MemoryConfig, type MemoryOverview, getMemoryConfig, getMemoryOverview } from "../../api/memory";
import { type InstalledAgentConfig, listInstalledAgentConfigs } from "../../api/marketplace";
import { appendHmacToUrl, getApiHost } from "../../api/client";
import { errorMessage } from "./memoryFormat";
import { EMPTY_OVERVIEW, isTerminal } from "./memoryModel";

export type MemoryRunStreamUpdate = {
  automation_id: string;
  run_id: string;
  run?: AutomationRun;
  event?: Record<string, unknown>;
  sequence: number;
};

interface MemoryProjectOptions {
  /** Keep live transcript events (only while a run viewer can show them). */
  liveEvents: boolean;
  /** Installed Agents reload whenever this changes (e.g. the visible tab). */
  agentsReloadKey?: unknown;
}

/** A project's Memory config, overview, installed Agents and live run stream. */
export function useMemoryProject(projectId: string | null, { liveEvents, agentsReloadKey }: MemoryProjectOptions) {
  const catalogRevision = useAgentCatalogRevision();
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [overview, setOverview] = useState<MemoryOverview>(EMPTY_OVERVIEW);
  const [agents, setAgents] = useState<InstalledAgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [runStarting, setRunStarting] = useState(false);
  const [liveRunUpdates, setLiveRunUpdates] = useState<MemoryRunStreamUpdate[]>([]);
  const liveRunSequence = useRef(0);
  const liveEventsRef = useRef(liveEvents);
  const { showBanner } = useBanner();

  useEffect(() => {
    liveEventsRef.current = liveEvents;
  }, [liveEvents]);

  const bump = useCallback(() => setRefreshTick((value) => value + 1), []);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [configResult, overviewResult] = await Promise.allSettled([
        getMemoryConfig(projectId),
        getMemoryOverview(projectId),
      ]);
      if (configResult.status === "fulfilled") setConfig(configResult.value);
      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      const failure = [configResult, overviewResult].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") setError(errorMessage(failure.reason));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      setAgents(await listInstalledAgentConfigs());
    } catch (reason) {
      setAgentsError(errorMessage(reason));
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh, refreshTick]);

  useEffect(() => {
    void Promise.resolve().then(loadAgents);
  }, [loadAgents, agentsReloadKey, catalogRevision]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      setLiveRunUpdates([]);
      liveRunSequence.current = 0;
    });
  }, [projectId]);

  const handleRunUpdate = useCallback((update: Omit<MemoryRunStreamUpdate, "sequence">) => {
    if (update.event && !liveEventsRef.current) return;
    const sequence = ++liveRunSequence.current;
    setLiveRunUpdates((current) => [...current, { ...update, sequence }].slice(-500));
    if (!update.event || update.event.type === "complete" || (update.run && isTerminal(update.run.status))) {
      setRefreshTick((value) => value + 1);
    }
  }, []);
  useMemoryRunUpdates(projectId, config?.organization.id, handleRunUpdate);

  const runOrganization = useCallback(async () => {
    if (!projectId || !config) {
      showBanner("Save Memory settings before starting a run.", "error", 5000);
      return;
    }
    setRunStarting(true);
    try {
      const result = await triggerAutomation(projectId, config.organization.id);
      if (result.error) throw new Error(result.error);
      showBanner("Memory organization started.", "success");
      setRefreshTick((value) => value + 1);
    } catch (reason) {
      showBanner(errorMessage(reason), "error", 5000);
    } finally {
      setRunStarting(false);
    }
  }, [config, projectId, showBanner]);

  return {
    config, setConfig, overview, agents, loading, agentsLoading, agentsError, error, setError,
    refreshTick, bump, loadAgents, runStarting, runOrganization, liveRunUpdates,
  };
}

export type MemoryProjectState = ReturnType<typeof useMemoryProject>;

function useMemoryRunUpdates(projectId: string | null, automationId: string | undefined, onUpdate: (update: Omit<MemoryRunStreamUpdate, "sequence">) => void) {
  useEffect(() => {
    if (!projectId || !automationId) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    const connect = async () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = await appendHmacToUrl(`${protocol}//${getApiHost()}/api/v1/projects/${projectId}/automation-runs/ws`);
      if (disposed) return;
      ws = new WebSocket(url);
      ws.onmessage = (message) => {
        try {
          const update = JSON.parse(message.data) as {
            automation_id?: string;
            run_id?: string;
            run?: AutomationRun;
            event?: Record<string, unknown>;
          };
          const updateAutomationId = update.automation_id ?? update.run?.automation_id;
          const updateRunId = update.run_id ?? update.run?.id;
          if (updateAutomationId === automationId && updateRunId) {
            onUpdate({
              automation_id: updateAutomationId,
              run_id: updateRunId,
              run: update.run,
              event: update.event,
            });
          }
        } catch { /* ignore malformed updates */ }
      };
      ws.onclose = () => {
        if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 1500);
      };
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [projectId, automationId, onUpdate]);
}
