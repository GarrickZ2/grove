// Shared state + actions for the task Agent graph. Both presentations
// (Workbench `TaskGraph` and Orbit `OrbitTaskGraph`) drive the same
// /graph hydration, RadioEvents state machines and graph mutations from here,
// so only the markup differs between them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  updateChatTitle,
  sendGraphChatMessage,
  getTaskGraph,
  spawnGraphNode,
  addGraphEdge,
  updateGraphChatDuty,
  updateGraphEdgePurpose,
  deleteGraphEdge,
  remindGraphEdge,
  getConfig,
  deleteChat,
} from "../../../api";
import type { NodeStatus } from "../../../api/walkieTalkie";
import { useRadioEvents } from "../../../hooks/useRadioEvents";
import { agentOptions } from "../../../data/agents";
import { useACPAvailability } from "./useACPAvailability";
import type { GraphNode, GraphEdge } from "./graphShared";

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type EdgeLiveState = "idle" | "in_flight" | "blocked";

export const ERROR_HINTS: Record<string, string> = {
  name_taken: "Name already taken",
  cycle_would_form: "Would create a cycle",
  bidirectional_edge: "Reverse edge already exists",
  duplicate_edge: "Edge already exists",
  same_task_required: "Cannot connect across tasks",
  target_not_found: "Target not found",
  no_pending_to_remind: "No pending message to remind",
  target_not_idle: "Target is not idle",
  target_is_busy: "Target is busy",
  duty_forbidden: "Duty is locked",
  timeout: "Operation timed out",
  agent_spawn_failed: "Agent failed to start",
  internal_error: "Internal error",
};

export function graphApiError(e: unknown): { code: string; message: string } {
  if (e && typeof e === "object") {
    const data = (e as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const payload = data as { code?: unknown; error?: unknown; message?: unknown };
      return {
        code: typeof payload.code === "string" ? payload.code : "internal_error",
        message:
          typeof payload.error === "string"
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : String(e),
      };
    }
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return { code: "internal_error", message };
  }
  return { code: "internal_error", message: String(e) };
}

export const pendingKey = (from: string, to: string) => `${from}::${to}`;

/** Fill the optional fields the backend may omit. */
export function sanitizeGraph(raw: Partial<GraphData> | null | undefined): GraphData {
  return {
    nodes: (raw?.nodes ?? []).map((n) => ({
      ...n,
      pending_in: n.pending_in ?? 0,
      pending_out: n.pending_out ?? 0,
      pending_messages: n.pending_messages ?? [],
    })),
    edges: (raw?.edges ?? []).map((e) => ({
      ...e,
      pending_message: e.pending_message ?? undefined,
    })),
  };
}

/** Seed the live status / pending maps from a /graph snapshot. */
export function seedLiveMaps(data: GraphData): {
  statuses: Map<string, NodeStatus>;
  pending: Map<string, string | undefined>;
} {
  const statuses = new Map<string, NodeStatus>();
  for (const n of data.nodes) statuses.set(n.chat_id, n.status as NodeStatus);
  const pending = new Map<string, string | undefined>();
  for (const e of data.edges) {
    if (e.state !== "idle") pending.set(pendingKey(e.from, e.to), e.pending_message?.body_excerpt);
  }
  return { statuses, pending };
}

/** Live edge state: a queued message is in flight while its target works, blocked otherwise. */
export function edgeLiveState(
  pending: Map<string, string | undefined>,
  statuses: Map<string, NodeStatus>,
  fromId: string,
  toId: string,
): EdgeLiveState {
  if (!pending.has(pendingKey(fromId, toId))) return "idle";
  return (statuses.get(toId) ?? "disconnected") === "busy" ? "in_flight" : "blocked";
}

export type EdgeValidity = { ok: true } | { ok: false; reason: string };

/**
 * Client-side pre-flight for a new `from -> to` edge: surface obvious errors
 * before the server rejects. The server remains the source of truth.
 */
export function checkEdge(data: GraphData | null, from: string, to: string): EdgeValidity {
  if (from === to) return { ok: false, reason: "Cannot connect a node to itself" };
  if (!data) return { ok: true };
  for (const e of data.edges) {
    if (e.from === from && e.to === to) return { ok: false, reason: ERROR_HINTS.duplicate_edge };
    if (e.from === to && e.to === from) return { ok: false, reason: ERROR_HINTS.bidirectional_edge };
  }
  // Cycle: would `from -> to` create a cycle? Yes iff `from` is reachable from `to`.
  const adj = new Map<string, string[]>();
  for (const e of data.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return { ok: false, reason: ERROR_HINTS.cycle_would_form };
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nb of adj.get(cur) ?? []) stack.push(nb);
  }
  return { ok: true };
}

/**
 * /graph hydration plus the RadioEvents-driven state machines. After the first
 * fetch, node status and pending pairs are kept live by events; topology
 * changes (chat list) trigger a re-fetch that re-seeds them.
 */
export function useTaskGraphData(projectId: string, taskId: string) {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [nodeStatusMap, setNodeStatusMap] = useState<Map<string, NodeStatus>>(new Map());
  const [pendingPairsMap, setPendingPairsMap] = useState<Map<string, string | undefined>>(new Map());

  // Monotonic counter for /graph fetches. Each fetch records its seq at the
  // moment it's issued; on response we drop it iff a newer fetch has already
  // been issued (a still-newer response will arrive). Events DON'T poison
  // future fetches — they only invalidate fetches whose seq <= a "discard
  // up to" watermark captured at the moment the event was processed. This
  // keeps spawn-then-event-then-fetch sequences from silently dropping the
  // refresh of newly-added topology.
  const fetchSeqRef = useRef(0);
  const discardFetchUpToRef = useRef(0);

  const applySnapshot = useCallback((sanitized: GraphData) => {
    setData(sanitized);
    const { statuses, pending } = seedLiveMaps(sanitized);
    setNodeStatusMap(statuses);
    setPendingPairsMap(pending);
  }, []);

  const refreshGraph = useCallback(async () => {
    fetchSeqRef.current += 1;
    const mySeq = fetchSeqRef.current;
    try {
      const raw = (await getTaskGraph(projectId, taskId)) as GraphData;
      // Drop iff: a newer fetch was issued after us (it'll deliver fresher
      // data), OR an event was processed while we were in flight (its
      // mutation is on top of older state than ours and ours is older than
      // the event's view).
      if (mySeq < fetchSeqRef.current || mySeq <= discardFetchUpToRef.current) return;
      applySnapshot(sanitizeGraph(raw));
    } catch (e) {
      console.error("Failed to refresh graph", e);
    }
  }, [projectId, taskId, applySnapshot]);

  // Pure event-driven sync: chat-grained ChatStatus and PendingChanged
  // mutate local maps; topology changes (chat list) still trigger a full
  // /graph refetch. No polling, no wholesale refresh on every status flip.
  useRadioEvents({
    onChatStatus: (evtProjectId, evtTaskId, chatId, status) => {
      if (evtProjectId !== projectId || evtTaskId !== taskId) return;
      // Only discard fetches issued STRICTLY BEFORE this event. The current
      // in-flight fetch (if any) was triggered by an event sibling like
      // ChatListChanged and contains the topology change we still need —
      // killing it would leave the graph stuck without the new node until
      // another event happens.
      discardFetchUpToRef.current = Math.max(
        discardFetchUpToRef.current,
        fetchSeqRef.current - 1,
      );
      setNodeStatusMap((prev) => {
        if (prev.get(chatId) === status) return prev;
        const next = new Map(prev);
        next.set(chatId, status);
        return next;
      });
    },
    onPendingChanged: (evtProjectId, evtTaskId, payload) => {
      if (evtProjectId !== projectId || evtTaskId !== taskId) return;
      discardFetchUpToRef.current = Math.max(
        discardFetchUpToRef.current,
        fetchSeqRef.current - 1,
      );
      setPendingPairsMap((prev) => {
        const next = new Map(prev);
        const k = pendingKey(payload.from_chat_id, payload.to_chat_id);
        if (payload.op === "inserted") next.set(k, payload.body_excerpt);
        else next.delete(k);
        return next;
      });
    },
    onChatListChanged: (evtProjectId, evtTaskId) => {
      if (evtProjectId === projectId && evtTaskId === taskId) {
        void refreshGraph();
      }
    },
    onConnected: () => {
      // WS just (re)opened — re-sync everything in case events were missed
      // during the disconnect window.
      void refreshGraph();
    },
  });

  useEffect(() => {
    const fetchGraph = async () => {
      fetchSeqRef.current += 1;
      const mySeq = fetchSeqRef.current;
      try {
        const raw = (await getTaskGraph(projectId, taskId)) as GraphData;
        if (mySeq < fetchSeqRef.current || mySeq <= discardFetchUpToRef.current) return;
        // Initial hydration of the in-memory state machines.
        applySnapshot(sanitizeGraph(raw));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load graph");
      } finally {
        setLoading(false);
      }
    };
    fetchGraph();
  }, [projectId, taskId, reloadKey, applySnapshot]);

  /** Retry after a failed first load. */
  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const getNodeStatus = useCallback(
    (chatId: string): NodeStatus => nodeStatusMap.get(chatId) ?? "disconnected",
    [nodeStatusMap],
  );
  const deriveEdgeState = useCallback(
    (fromId: string, toId: string): EdgeLiveState =>
      edgeLiveState(pendingPairsMap, nodeStatusMap, fromId, toId),
    [pendingPairsMap, nodeStatusMap],
  );

  return {
    data,
    loading,
    error,
    reload,
    refreshGraph,
    nodeStatusMap,
    pendingPairsMap,
    getNodeStatus,
    deriveEdgeState,
  };
}

export interface GraphToast {
  message: string;
  type: "error" | "success";
}

export interface SpawnInput {
  fromChatId: string | null;
  agent: string;
  name: string;
  duty: string;
  /** Edge purpose; only sent when spawning from a parent. */
  purpose?: string;
}

/**
 * Graph mutations (spawn / connect / edit / delete / remind / send) with the
 * shared toast + error-hint handling, plus the spawn agent options. Each
 * action resolves to `true` on success so callers can close their form.
 */
export function useTaskGraphActions(
  projectId: string,
  taskId: string,
  data: GraphData | null,
  refreshGraph: () => Promise<void>,
) {
  const {
    baseAgents,
    customAgents,
    customAgentPersonas,
    acpAvailabilityLoaded,
  } = useACPAvailability();
  // Default agent for the spawn form — read from Settings (acp.agent_command)
  // so the user's preferred agent is pre-selected.
  const [defaultAgent, setDefaultAgent] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((cfg) => {
        if (!cancelled && cfg.acp?.agent_command)
          setDefaultAgent(cfg.acp.agent_command);
      })
      .catch(() => {
        /* fail-open */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Spawn picker options from launchable marketplace rows. Wait for backend
  // availability before offering spawn candidates.
  const acpAgentOptions = useMemo(() => {
    if (!acpAvailabilityLoaded) return [];
    return baseAgents
      .filter((b) => b.available)
      .map((b) => {
        const local = agentOptions.find(
          (a) => a.value === b.id || a.id === b.id,
        );
        const opt = local ?? { id: b.id, label: b.display_name, value: b.id };
        return { ...opt, label: b.display_name, value: b.id };
      });
  }, [baseAgents, acpAvailabilityLoaded]);

  const [toast, setToast] = useState<GraphToast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.type === "error" ? 4000 : 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showError = useCallback((code: string, message: string) => {
    const hint = ERROR_HINTS[code] || message;
    setToast({ message: hint, type: "error" });
  }, []);

  const [spawnLoading, setSpawnLoading] = useState(false);
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);

  const sendMessage = useCallback(
    async (chatId: string, text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      setSendingMessage(true);
      try {
        await sendGraphChatMessage(projectId, taskId, chatId, trimmed);
        setToast({ message: "Message sent", type: "success" });
        // No manual refresh — the backend's ChatStatus(busy)/PendingChanged
        // events drive the graph. Calling refreshGraph here would race the
        // events and could overwrite live state with stale /graph data.
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("internal_error", msg);
        return false;
      } finally {
        setSendingMessage(false);
      }
    },
    [projectId, taskId, showError],
  );

  const spawnNode = useCallback(
    async (input: SpawnInput): Promise<boolean> => {
      if (!input.agent || !input.name.trim()) return false;
      setSpawnLoading(true);
      try {
        const purpose = input.purpose?.trim();
        await spawnGraphNode(projectId, taskId, {
          from_chat_id: input.fromChatId ?? null,
          agent: input.agent,
          name: input.name.trim(),
          duty: input.duty.trim() || undefined,
          // purpose only travels along an edge — drop it for orphan spawns.
          purpose: input.fromChatId && purpose ? purpose : undefined,
        });
        refreshGraph();
        setToast({ message: "Node created", type: "success" });
        return true;
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
        return false;
      } finally {
        setSpawnLoading(false);
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const createEdge = useCallback(
    async (
      from: string,
      to: string,
      opts?: { duty?: string; purpose?: string },
    ): Promise<boolean> => {
      setEdgeLoading(true);
      try {
        await addGraphEdge(projectId, taskId, {
          from,
          to,
          duty: opts?.duty?.trim() || undefined,
          purpose: opts?.purpose?.trim() || undefined,
        });
        refreshGraph();
        setToast({ message: "Connection created", type: "success" });
        return true;
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
        return false;
      } finally {
        setEdgeLoading(false);
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const checkEdgeValidity = useCallback(
    (from: string, to: string) => checkEdge(data, from, to),
    [data],
  );

  // Guards against the Enter→onBlur double-fire of a name save.
  const nameSaveInFlightRef = useRef<Set<string>>(new Set());
  const saveName = useCallback(
    async (chatId: string, next: string) => {
      const trimmed = next.trim();
      if (!trimmed) return;
      if (nameSaveInFlightRef.current.has(chatId)) return;
      nameSaveInFlightRef.current.add(chatId);
      try {
        await updateChatTitle(projectId, taskId, chatId, trimmed);
        refreshGraph();
      } catch (e) {
        showError("internal_error", String(e));
      } finally {
        nameSaveInFlightRef.current.delete(chatId);
      }
    },
    [projectId, taskId, refreshGraph, showError],
  );

  const updateDuty = useCallback(
    async (chatId: string, duty: string) => {
      try {
        await updateGraphChatDuty(projectId, taskId, chatId, duty || undefined);
        refreshGraph();
        setToast({ message: "Duty updated", type: "success" });
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  /** Save a node's name and duty; only the fields that changed are sent. */
  const saveNode = useCallback(
    async (chatId: string, nextName: string, nextDuty: string) => {
      const fresh = data?.nodes.find((n) => n.chat_id === chatId);
      const tasks: Promise<unknown>[] = [];
      if (nextName.trim() && nextName.trim() !== fresh?.name) {
        tasks.push(saveName(chatId, nextName));
      }
      if (nextDuty !== (fresh?.duty ?? "")) {
        tasks.push(updateDuty(chatId, nextDuty));
      }
      await Promise.all(tasks);
    },
    [data, saveName, updateDuty],
  );

  const updatePurpose = useCallback(
    async (edgeId: number, purpose: string) => {
      try {
        await updateGraphEdgePurpose(projectId, taskId, edgeId, purpose || undefined);
        refreshGraph();
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const deleteEdge = useCallback(
    async (edgeId: number): Promise<boolean> => {
      try {
        await deleteGraphEdge(projectId, taskId, edgeId);
        refreshGraph();
        setToast({ message: "Connection deleted", type: "success" });
        return true;
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
        return false;
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const remindEdge = useCallback(
    async (edgeId: number) => {
      try {
        await remindGraphEdge(projectId, taskId, edgeId);
        refreshGraph();
        setToast({ message: "Reminder sent", type: "success" });
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const deleteNode = useCallback(
    async (chatId: string): Promise<boolean> => {
      try {
        await deleteChat(projectId, taskId, chatId);
        refreshGraph();
        setToast({ message: "Session deleted", type: "success" });
        return true;
      } catch (e) {
        showError("internal_error", String(e));
        return false;
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  return {
    customAgents,
    customAgentPersonas,
    acpAvailabilityLoaded,
    acpAgentOptions,
    defaultAgent,
    toast,
    setToast,
    showError,
    spawnLoading,
    edgeLoading,
    sendingMessage,
    sendMessage,
    spawnNode,
    createEdge,
    checkEdgeValidity,
    saveName,
    updateDuty,
    saveNode,
    updatePurpose,
    deleteEdge,
    remindEdge,
    deleteNode,
  };
}

/** Ask the chat panel to switch to this session. */
export function openGraphChat(chatId: string) {
  window.dispatchEvent(new CustomEvent("grove:open-chat", { detail: { chatId } }));
}
