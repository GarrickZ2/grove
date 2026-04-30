import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
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
  checkCommands,
  getConfig,
  deleteChat,
  listCustomAgents,
} from "../../../api";
import type { CustomAgentServer, CustomAgentPersona } from "../../../api";
import type { NodeStatus } from "../../../api/walkieTalkie";
import { useRadioEvents } from "../../../hooks/useRadioEvents";
import { AgentPicker } from "../../ui/AgentPicker";
import {
  agentOptions,
  applyAcpAvailability,
  getAcpAvailabilityCommands,
} from "../../../data/agents";
import {
  agentIconComponent,
  agentIconUrl,
  loadCustomAgentPersonas as loadCustomAgentPersonasIcon,
  usePersonaRegistry,
} from "../../../utils/agentIcon";
import {
  ZoomIn,
  ZoomOut,
  X,
  Pencil,
  Trash2,
  Bell,
  Send,
  Loader2,
  Plus,
  GitBranch,
  MessageSquare,
} from "lucide-react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import type { Simulation, SimulationNodeDatum } from "d3-force";
interface GraphNode {
  chat_id: string;
  name: string;
  agent: string;
  duty?: string;
  status: string;
  pending_in: number;
  pending_out: number;
  pending_messages: PendingMessageInfo[];
}

interface PendingMessageInfo {
  from: string;
  from_name: string;
  to: string;
  to_name: string;
  body_excerpt: string;
}

interface GraphEdge {
  edge_id: number;
  from: string;
  to: string;
  purpose?: string;
  state: string;
  pending_message?: PendingMessageInfo;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function graphApiError(e: unknown): { code: string; message: string } {
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

interface SimNode extends SimulationNodeDatum {
  id: string;
  name: string;
  agent: string;
  duty?: string;
  status: string;
  pending_in: number;
  pending_out: number;
  pending_messages: PendingMessageInfo[];
  /**
   * `true` if this node's fx/fy was set by the layout-preservation effect
   * (not by the user dragging). When the simulation settles we clear these
   * synthetic pins so the node is free again. Distinguishing user-set pins
   * from synthetic ones is critical for re-runs that fire before the prior
   * release callback (otherwise the synthetic pin gets promoted to a
   * "user pin" and never releases).
   */
  syntheticPin?: boolean;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  state: string;
  purpose?: string;
  edge_id: number;
  pending_message?: PendingMessageInfo;
}

interface TaskGraphProps {
  projectId: string;
  taskId: string;
}

const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 600;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD_PX = 4;

const STATUS_COLORS: Record<string, string> = {
  // Visual hierarchy: busy / permission grab attention; idle is neutral so it
  // doesn't compete; connecting is informational; disconnected ghosts out.
  busy: "var(--color-error)",
  idle: "var(--color-border)",
  permission_required: "var(--color-warning)",
  connecting: "var(--color-info)",
  disconnected: "var(--color-text-muted)",
};

const EDGE_COLORS: Record<string, string> = {
  idle: "var(--color-border)",
  in_flight: "var(--color-info)",
  blocked: "var(--color-warning)",
};

const ERROR_HINTS: Record<string, string> = {
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

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}

export function TaskGraph({ projectId, taskId }: TaskGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const panMovedRef = useRef(false);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  // Tracks whether at least one non-empty node set has been laid out. The
  // first such build runs with full alpha=1 so the layout actually forms;
  // subsequent builds use a low alpha to avoid rearranging existing positions.
  // `nodesRef.current.length === 0` is NOT a reliable proxy because data can
  // arrive empty first (loading state) and then populated.
  const hasBuiltOnceRef = useRef(false);
  const linksRef = useRef<SimLink[]>([]);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [tick, setTick] = useState(0);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNodeData = data?.nodes.find((n) => n.chat_id === selectedNodeId) ?? null;
  const [spawnBubble, setSpawnBubble] = useState<
    | {
        x: number;
        y: number;
        agent: string;
        name: string;
        duty: string;
        /** When set, the new session is spawned with an edge from this chat —
         *  toolbar's "Spawn Child" button populates it. */
        fromChatId?: string;
      }
    | null
  >(null);
  const [spawnLoading, setSpawnLoading] = useState(false);
  const [dragEdge, setDragEdge] = useState<{ from: string } | null>(null);
  // Mirror of dragEdge in a ref so the document-level mouseup listener and
  // the per-node onMouseUp handler agree on whether a drop is in progress
  // regardless of React batching / listener invocation order.
  // NOTE: only edge-drag flow uses this ref; node-drag and pan flows do not
  // touch it.
  const dragEdgeRef = useRef<{ from: string } | null>(null);
  const [dragMousePos, setDragMousePos] = useState<{ x: number; y: number } | null>(null);

  // Tracks every window-level listener attached by drag/pan handlers so we
  // can tear them all down on unmount. Without this, navigating away mid-drag
  // leaks listeners that fire setState on an unmounted component.
  const activeListenersRef = useRef<Set<() => void>>(new Set());
  useEffect(() => {
    const listeners = activeListenersRef.current;
    return () => {
      for (const teardown of listeners) teardown();
      listeners.clear();
    };
  }, []);
  const [edgeBubble, setEdgeBubble] = useState<
    | {
        from: string;
        to: string;
        x: number;
        y: number;
        duty: string;
      }
    | null
  >(null);
  const [edgeLoading, setEdgeLoading] = useState(false);
  /**
   * The floating toolbar morphs between four modes. `null` is the default
   * compact pill (context info + action buttons). Other modes expand the
   * pill into an inline form. Each form carries its own draft so Cancel
   * discards cleanly.
   */
  type ToolbarMode =
    | { kind: "send"; chatId: string }
    | { kind: "edit"; chatId: string; name: string; duty: string }
    | {
        kind: "spawn";
        fromChatId: string | null;
        agent: string;
        name: string;
        duty: string;
        /** Edge purpose (only when spawning a child from an existing node;
         *  ignored otherwise). */
        purpose: string;
      }
    | { kind: "edit-edge"; edgeId: number; purpose: string }
    | { kind: "confirm-delete-node"; chatId: string; name: string }
    | { kind: "confirm-delete-edge"; edgeId: number };
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode | null>(null);
  const [directMessage, setDirectMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);

  // ─── In-memory state machines, kept live by RadioEvents ────────────────
  // After the initial /graph hydration these maps become the source of truth
  // for node status and edge derivation. Subsequent /graph re-fetches (only
  // for topology changes — chat list / edges / duty) re-seed them.
  const [nodeStatusMap, setNodeStatusMap] = useState<Map<string, NodeStatus>>(new Map());
  const [pendingPairsMap, setPendingPairsMap] = useState<Map<string, string | undefined>>(new Map());
  const pendingKey = (from: string, to: string) => `${from}::${to}`;

  // Stable ref to refreshGraph (assigned in a later useEffect) — lets handlers
  // declared above the refreshGraph definition still trigger a refresh.
  const refreshGraphRef = useRef<(() => Promise<void>) | null>(null);

  // Monotonic counter for /graph fetches. Each fetch records its seq at the
  // moment it's issued; on response we drop it iff a newer fetch has already
  // been issued (a still-newer response will arrive). Events DON'T poison
  // future fetches — they only invalidate fetches whose seq <= a "discard
  // up to" watermark captured at the moment the event was processed. This
  // keeps spawn-then-event-then-fetch sequences from silently dropping the
  // refresh of newly-added topology.
  const fetchSeqRef = useRef(0);
  const discardFetchUpToRef = useRef(0);
  const [acpAgentAvailability, setAcpAgentAvailability] = useState<Record<string, boolean>>({});
  const [acpAvailabilityLoaded, setAcpAvailabilityLoaded] = useState(false);
  const [customAgents, setCustomAgents] = useState<CustomAgentServer[]>([]);
  const [customAgentPersonas, setCustomAgentPersonas] = useState<CustomAgentPersona[]>([]);
  // Re-render on persona registry mutations so node icons & spawn pill labels
  // pick up adds/edits/deletes from any other page without manual refetch.
  usePersonaRegistry();
  // Default agent for the Spawn bubble — read from Settings (acp.agent_command)
  // so the user's preferred agent is pre-selected instead of forcing them to
  // pick from scratch every time.
  const [defaultAgent, setDefaultAgent] = useState<string>("");

  // Mirror TaskChat's filter: only show agents whose ACP CLI is actually
  // installed. Avoids letting users spawn a node that will fail on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cmdResults, cfg, personas] = await Promise.all([
          checkCommands(getAcpAvailabilityCommands()),
          getConfig(),
          loadCustomAgentPersonasIcon(() =>
            listCustomAgents().catch(() => [] as CustomAgentPersona[]),
          ),
        ]);
        if (cancelled) return;
        setAcpAgentAvailability(cmdResults);
        setCustomAgents(cfg.acp?.custom_agents ?? []);
        setCustomAgentPersonas(personas);
        if (cfg.acp?.agent_command) setDefaultAgent(cfg.acp.agent_command);
      } catch {
        /* fail-open */
      }
      if (!cancelled) setAcpAvailabilityLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acpAgentOptions = useMemo(() => {
    return agentOptions
      .filter((opt) => opt.acpCheck)
      .map((opt) => applyAcpAvailability(opt, acpAgentAvailability, acpAvailabilityLoaded))
      .filter((opt) => !opt.disabled);
  }, [acpAgentAvailability, acpAvailabilityLoaded]);
  const [toast, setToast] = useState<{ message: string; type: "error" | "success" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.type === "error" ? 4000 : 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showError = useCallback((code: string, message: string) => {
    const hint = ERROR_HINTS[code] || message;
    setToast({ message: hint, type: "error" });
  }, []);

  const handleDirectSend = useCallback(
    async (chatId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSendingMessage(true);
      try {
        await sendGraphChatMessage(projectId, taskId, chatId, trimmed);
        setDirectMessage("");
        setToast({ message: "Message sent", type: "success" });
        // No manual refresh — the backend's ChatStatus(busy)/PendingChanged
        // events drive the graph. Calling refreshGraph here would race the
        // events and could overwrite live state with stale /graph data.
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("internal_error", msg);
      } finally {
        setSendingMessage(false);
      }
    },
    [projectId, taskId, showError],
  );

  const containerRef = useRef<HTMLDivElement>(null);



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
      const sanitized: GraphData = {
        nodes: (raw.nodes ?? []).map((n) => ({
          ...n,
          pending_in: n.pending_in ?? 0,
          pending_out: n.pending_out ?? 0,
          pending_messages: n.pending_messages ?? [],
        })),
        edges: (raw.edges ?? []).map((e) => ({
          ...e,
          pending_message: e.pending_message ?? undefined,
        })),
      };
      setData(sanitized);
      const ns = new Map<string, NodeStatus>();
      for (const n of sanitized.nodes) ns.set(n.chat_id, n.status as NodeStatus);
      setNodeStatusMap(ns);
      const pp = new Map<string, string | undefined>();
      for (const e of sanitized.edges) {
        if (e.state !== "idle") pp.set(pendingKey(e.from, e.to), e.pending_message?.body_excerpt);
      }
      setPendingPairsMap(pp);
    } catch (e) {
      console.error("Failed to refresh graph", e);
    }
  }, [projectId, taskId]);

  useEffect(() => {
    refreshGraphRef.current = refreshGraph;
  }, [refreshGraph]);

  // Pure event-driven sync: chat-grained ChatStatus and PendingChanged
  // mutate local maps; topology changes (chat list) still trigger a full
  // /graph refetch. No more polling, no more wholesale refresh on every
  // status flip.
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

  const submitSpawn = useCallback(async () => {
    if (!spawnBubble || !spawnBubble.agent || !spawnBubble.name.trim()) return;
    setSpawnLoading(true);
    try {
      await spawnGraphNode(projectId, taskId, {
          from_chat_id: spawnBubble.fromChatId ?? null,
          agent: spawnBubble.agent,
          name: spawnBubble.name.trim(),
          duty: spawnBubble.duty.trim() || undefined,
      });
      setSpawnBubble(null);
      refreshGraph();
      setToast({ message: "Node created", type: "success" });
    } catch (e) {
      const err = graphApiError(e);
      showError(err.code, err.message);
    } finally {
      setSpawnLoading(false);
    }
  }, [projectId, taskId, spawnBubble, showError, refreshGraph]);

  const createEdgeRequest = useCallback(
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

  // Client-side pre-flight: surface obvious errors during drag so the server doesn't
  // have to reject after the fact. Server remains the source of truth.
  const checkEdgeValidity = useCallback(
    (from: string, to: string): { ok: true } | { ok: false; reason: string } => {
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
    },
    [data],
  );

  // Guards against the Enter→onBlur double-fire: Enter handler kicks off the
  // save, the resulting setEditingName(null) re-renders and removes the input,
  // which fires onBlur → another save call. Tracking in-flight chat ids
  // collapses the duplicate into a no-op.
  const nameSaveInFlightRef = useRef<Set<string>>(new Set());
  const handleSaveName = useCallback(
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

  const handleUpdateDuty = useCallback(
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

  const handleUpdatePurpose = useCallback(
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

  const handleDeleteEdge = useCallback(
    async (edgeId: number) => {
      // Confirmation now happens in the toolbar `confirm-delete-edge` mode
      // before this is invoked — no second window.confirm.
      try {
        await deleteGraphEdge(projectId, taskId, edgeId);
        setSelectedEdge(null);
        refreshGraph();
        setToast({ message: "Connection deleted", type: "success" });
      } catch (e) {
        const err = graphApiError(e);
        showError(err.code, err.message);
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const handleRemind = useCallback(
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

  useEffect(() => {
    const fetchGraph = async () => {
      fetchSeqRef.current += 1;
      const mySeq = fetchSeqRef.current;
      try {
        const raw = (await getTaskGraph(projectId, taskId)) as GraphData;
        if (mySeq < fetchSeqRef.current || mySeq <= discardFetchUpToRef.current) return;
        const sanitized: GraphData = {
          nodes: (raw.nodes ?? []).map((n) => ({
            ...n,
            pending_in: n.pending_in ?? 0,
            pending_out: n.pending_out ?? 0,
            pending_messages: n.pending_messages ?? [],
          })),
          edges: (raw.edges ?? []).map((e) => ({
            ...e,
            pending_message: e.pending_message ?? undefined,
          })),
        };
        setData(sanitized);
        // Initial hydration of the in-memory state machines.
        const ns = new Map<string, NodeStatus>();
        for (const n of sanitized.nodes) ns.set(n.chat_id, n.status as NodeStatus);
        setNodeStatusMap(ns);
        const pp = new Map<string, string | undefined>();
        for (const e of sanitized.edges) {
          if (e.state !== "idle") pp.set(pendingKey(e.from, e.to), e.pending_message?.body_excerpt);
        }
        setPendingPairsMap(pp);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load graph");
      } finally {
        setLoading(false);
      }
    };
    fetchGraph();
  }, [projectId, taskId]);

  useEffect(() => {
    if (!data) return;
    const nodeCount = Math.max(data.nodes.length, 1);
    const radius = Math.min(170, Math.max(48, nodeCount * 22));

    // Preserve manual layout: for nodes that already exist in nodesRef, copy
    // the prior x/y (and fx/fy if the user dragged them). Only brand-new
    // nodes get an initial circular position, and we synthetically pin
    // existing nodes via fx/fy so the new force run can't shove them around —
    // only the new nodes settle. Without this, every graph refresh (after a
    // spawn / send / chat-status flip) re-simulates from scratch and undoes
    // the user's arrangement.
    //
    // We use the `syntheticPin` flag to tell synthetic pins (added by THIS
    // effect) apart from user-set pins (added by the drag handler). Without
    // the flag, a back-to-back data refresh during the release timer would
    // see fx/fy still set and treat it as a user pin — which would never
    // release.
    const priorById = new Map<string, SimNode>();
    for (const p of nodesRef.current) priorById.set(p.id, p);
    const hasNodes = data.nodes.length > 0;
    const isFirstBuild = hasNodes && !hasBuiltOnceRef.current;
    if (hasNodes) hasBuiltOnceRef.current = true;

    const nodes: SimNode[] = data.nodes.map((n, index) => {
      const prior = priorById.get(n.chat_id);
      if (prior) {
        // Existing node — keep its position. If the user already dragged it,
        // preserve the user pin (fx/fy + syntheticPin=false). Otherwise add
        // a synthetic pin around its current position to defend against the
        // re-sim, releasable on settle.
        const userPinned =
          prior.fx != null && prior.fy != null && prior.syntheticPin !== true;
        return {
          id: n.chat_id,
          name: n.name,
          agent: n.agent,
          duty: n.duty,
          status: n.status,
          pending_in: n.pending_in,
          pending_out: n.pending_out,
          pending_messages: n.pending_messages,
          x: prior.x,
          y: prior.y,
          fx: userPinned ? prior.fx : prior.x,
          fy: userPinned ? prior.fy : prior.y,
          syntheticPin: !userPinned,
        };
      }
      // New node — drop near the center on a small ring so the simulation
      // can pull it into place without distorting existing layout.
      const angle = (index / nodeCount) * Math.PI * 2;
      return {
        id: n.chat_id,
        name: n.name,
        agent: n.agent,
        duty: n.duty,
        status: n.status,
        pending_in: n.pending_in,
        pending_out: n.pending_out,
        pending_messages: n.pending_messages,
        x: VIEWBOX_WIDTH / 2 + Math.cos(angle) * radius,
        y: VIEWBOX_HEIGHT / 2 + Math.sin(angle) * radius,
        fx: undefined,
        fy: undefined,
        syntheticPin: false,
      };
    });

    const links: SimLink[] = data.edges.map((e) => ({
      source: e.from,
      target: e.to,
      state: e.state,
      purpose: e.purpose,
      edge_id: e.edge_id,
      pending_message: e.pending_message,
    }));

    nodesRef.current = nodes;
    linksRef.current = links;

    // Stop the prior simulation before creating a new one so we don't have
    // two ticking at once.
    simRef.current?.stop();

    const sim = forceSimulation<SimNode>(nodes)
      .force("charge", forceManyBody().strength(-180))
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(120)
          .strength(0.6),
      )
      .force("collide", forceCollide<SimNode>().radius(52).strength(0.5))
      .force("x", forceX<SimNode>(VIEWBOX_WIDTH / 2).strength(0.03))
      .force("y", forceY<SimNode>(VIEWBOX_HEIGHT / 2).strength(0.03))
      .force("center", forceCenter(VIEWBOX_WIDTH / 2, VIEWBOX_HEIGHT / 2))
      .alphaDecay(0.04)
      .on("tick", () => {
        setTick((t) => t + 1);
      })
      .on("end", () => {
        // Sim has converged — release every synthetic pin in one pass. User
        // pins are kept (syntheticPin === false). Doing this on `end` instead
        // of a fixed timeout means slow-converging layouts stay stable until
        // they're actually done, and fast ones release immediately.
        for (const n of nodes) {
          if (n.syntheticPin) {
            n.fx = undefined;
            n.fy = undefined;
            n.syntheticPin = false;
          }
        }
      });

    // On incremental rebuilds use a low alpha — we just want the new nodes
    // to find their place, not redo the whole layout. First build keeps
    // alpha=1 (default) so the layout actually forms.
    if (!isFirstBuild) {
      sim.alpha(0.3).restart();
    }

    simRef.current = sim;

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [data]);

  // Compute the actual SVG render geometry under preserveAspectRatio="xMidYMid meet":
  // the viewBox is uniformly scaled to fit the container and centered (letterboxed).
  const svgGeometry = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const cw = rect?.width ?? VIEWBOX_WIDTH;
    const ch = rect?.height ?? VIEWBOX_HEIGHT;
    const scale = Math.min(cw / VIEWBOX_WIDTH, ch / VIEWBOX_HEIGHT);
    return {
      cw,
      ch,
      scale,
      offsetX: (cw - VIEWBOX_WIDTH * scale) / 2,
      offsetY: (ch - VIEWBOX_HEIGHT * scale) / 2,
    };
  }, []);

  const clientDeltaToGraph = useCallback(
    (dx: number, dy: number) => {
      const { scale } = svgGeometry();
      return { dx: dx / scale / view.k, dy: dy / scale / view.k };
    },
    [view.k, svgGeometry],
  );

  const graphToScreen = useCallback(
    (gx: number, gy: number): { x: number; y: number; scale: number } => {
      const { scale, offsetX, offsetY } = svgGeometry();
      return {
        x: offsetX + (gx * view.k + view.x) * scale,
        y: offsetY + (gy * view.k + view.y) * scale,
        scale,
      };
    },
    [view, svgGeometry],
  );

  const clientToGraph = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const { scale, offsetX, offsetY } = svgGeometry();
      const sx = clientX - rect.left - offsetX;
      const sy = clientY - rect.top - offsetY;
      return {
        x: (sx / scale - view.x) / view.k,
        y: (sy / scale - view.y) / view.k,
      };
    },
    [view, svgGeometry],
  );

  const handleNodeDragEnd = useCallback((nodeId: string, wasDragged: boolean) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return;
    if (wasDragged) {
      node.fx = undefined;
      node.fy = undefined;
    }
  }, []);

  const zoomBy = useCallback((factor: number, origin?: { x: number; y: number }) => {
    setView((current) => {
      const nextK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
      const center = origin ?? { x: VIEWBOX_WIDTH / 2, y: VIEWBOX_HEIGHT / 2 };
      const graphX = (center.x - current.x) / current.k;
      const graphY = (center.y - current.y) / current.k;
      return {
        k: nextK,
        x: center.x - graphX * nextK,
        y: center.y - graphY * nextK,
      };
    });
  }, []);

  const fitView = useCallback(() => {
    setView({ x: 0, y: 0, k: 1 });
  }, []);

  // Returns the cursor position in viewBox coordinates (zoom anchor).
  const pointFromMouseEvent = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: VIEWBOX_WIDTH / 2, y: VIEWBOX_HEIGHT / 2 };
      const { scale, offsetX, offsetY } = svgGeometry();
      return {
        x: (event.clientX - rect.left - offsetX) / scale,
        y: (event.clientY - rect.top - offsetY) / scale,
      };
    },
    [svgGeometry],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-full text-[var(--color-text-muted)] text-sm">
        Loading graph...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center w-full h-full text-[var(--color-error)] text-sm">
        {error}
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-full text-[var(--color-text-muted)] text-sm">
        No graph data
      </div>
    );
  }

  const nodes = nodesRef.current;
  const links = linksRef.current;

  const getNode = (id: string) =>
    nodes.find((n) => n.id === id) ?? { x: 0, y: 0 };

  // Live derivations from in-memory state machines. These ignore the
  // potentially stale `node.status` / `link.state` baked into sim data.
  const getNodeStatus = (chatId: string): NodeStatus =>
    nodeStatusMap.get(chatId) ?? "disconnected";
  const deriveEdgeState = (
    fromId: string,
    toId: string,
  ): "idle" | "in_flight" | "blocked" => {
    if (!pendingPairsMap.has(pendingKey(fromId, toId))) return "idle";
    return getNodeStatus(toId) === "busy" ? "in_flight" : "blocked";
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-[var(--color-bg)]"
      style={{ cursor: dragEdge ? "crosshair" : undefined }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        data-tick={tick}
        style={{
          cursor: panRef.current ? "grabbing" : "grab",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        onWheel={(e) => {
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? 1.12 : 0.89, pointFromMouseEvent(e));
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          panRef.current = {
            x: e.clientX,
            y: e.clientY,
            viewX: view.x,
            viewY: view.y,
          };
          panMovedRef.current = false;

          const onMouseMove = (ev: MouseEvent) => {
            const pan = panRef.current;
            if (!pan) return;
            const dx = ev.clientX - pan.x;
            const dy = ev.clientY - pan.y;
            if (!panMovedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            panMovedRef.current = true;
            const { scale } = svgGeometry();
            setView((current) => ({
              ...current,
              x: pan.viewX + dx / scale,
              y: pan.viewY + dy / scale,
            }));
          };

          const teardown = () => {
            panRef.current = null;
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            activeListenersRef.current.delete(teardown);
          };
          const onMouseUp = () => teardown();

          window.addEventListener("mousemove", onMouseMove);
          window.addEventListener("mouseup", onMouseUp);
          activeListenersRef.current.add(teardown);
        }}
        onClick={() => {
          // Suppress deselect that follows a pan gesture.
          if (panMovedRef.current) {
            panMovedRef.current = false;
            return;
          }
          setSelectedNode(null);
          setSelectedEdge(null);
          setSelectedNodeId(null);
          setEdgeBubble(null);
          setSpawnBubble(null);
          // Empty-canvas click also cancels any open inline form so the
          // toolbar returns to its neutral compact state.
          setToolbarMode(null);
        }}
        onDoubleClick={(e) => {
          if ((e.target as SVGElement).tagName !== "svg") return;
          e.preventDefault();
          const rect = containerRef.current?.getBoundingClientRect();
          const x = rect ? e.clientX - rect.left : VIEWBOX_WIDTH / 2;
          const y = rect ? e.clientY - rect.top : VIEWBOX_HEIGHT / 2;
          setSpawnBubble({ x, y, agent: defaultAgent, name: "", duty: "" });
        }}
      >
        <defs>
          {/* userSpaceOnUse so arrow size is stable across selected/in-flight/idle
              (default `strokeWidth` units make the arrow scale with line thickness,
              which produced the chunky overshoot near the edge label). refX is
              tuned so the tip lands just outside the 24px node radius. */}
          <marker
            id="arrowhead"
            markerUnits="userSpaceOnUse"
            markerWidth="10"
            markerHeight="8"
            refX="34"
            refY="4"
            orient="auto"
          >
            <path
              d="M0 0 L10 4 L0 8 Z"
              fill="var(--color-text-muted)"
              strokeLinejoin="round"
            />
          </marker>
          <marker
            id="arrowhead-in_flight"
            markerUnits="userSpaceOnUse"
            markerWidth="10"
            markerHeight="8"
            refX="34"
            refY="4"
            orient="auto"
          >
            <path
              d="M0 0 L10 4 L0 8 Z"
              fill={EDGE_COLORS.in_flight}
              strokeLinejoin="round"
            />
          </marker>
          <marker
            id="arrowhead-blocked"
            markerUnits="userSpaceOnUse"
            markerWidth="10"
            markerHeight="8"
            refX="34"
            refY="4"
            orient="auto"
          >
            <path
              d="M0 0 L10 4 L0 8 Z"
              fill={EDGE_COLORS.blocked}
              strokeLinejoin="round"
            />
          </marker>
        </defs>

        <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
          {links.map((link) => {
          const fromId = typeof link.source === "string" ? link.source : link.source.id;
          const toId = typeof link.target === "string" ? link.target : link.target.id;
          const src = getNode(fromId);
          const tgt = getNode(toId);
          const sx = src.x ?? 0;
          const sy = src.y ?? 0;
          const tx = tgt.x ?? 0;
          const ty = tgt.y ?? 0;
          const isSelected = selectedEdge === link.edge_id;
          const liveState = deriveEdgeState(fromId, toId);
          const color = EDGE_COLORS[liveState] || EDGE_COLORS.idle;
          const markerId =
            liveState === "in_flight"
              ? "url(#arrowhead-in_flight)"
              : liveState === "blocked"
                ? "url(#arrowhead-blocked)"
                : "url(#arrowhead)";

          const onPickEdge = (e: React.MouseEvent) => {
            e.stopPropagation();
            setSelectedEdge(link.edge_id);
            setSelectedNode(null);
            setSelectedNodeId(null);
            setToolbarMode(null);
          };
          const mx = (sx + tx) / 2;
          const my = (sy + ty) / 2;
          const purpose = link.purpose?.trim();
          return (
            <g key={`edge-${link.edge_id}`} style={{ cursor: "pointer" }} onClick={onPickEdge}>
              {/* Wide transparent hit-area so users don't have to pixel-aim */}
              <line
                x1={sx}
                y1={sy}
                x2={tx}
                y2={ty}
                stroke="transparent"
                strokeWidth={Math.max(14, 14 / view.k)}
              />
              <line
                x1={sx}
                y1={sy}
                x2={tx}
                y2={ty}
                stroke={color}
                strokeWidth={
                  isSelected
                    ? 3 / view.k
                    : liveState === "idle"
                      ? 1.5 / view.k
                      : 2.4 / view.k
                }
                markerEnd={markerId}
                strokeDasharray={
                  liveState === "in_flight" || liveState === "blocked"
                    ? `${8 / view.k} ${4 / view.k}`
                    : undefined
                }
                className={liveState === "in_flight" ? "graph-edge-in-flight" : undefined}
                pointerEvents="none"
              />
              {purpose && (() => {
                // Smaller than node names so it doesn't compete for attention.
                const fontSize = 8 / view.k;
                const padX = 5 / view.k;
                const padY = 2.5 / view.k;
                const charW = fontSize * 0.58;
                const maxChars = 18;
                const truncated = purpose.length > maxChars;
                const display = truncated ? purpose.slice(0, maxChars - 1) + "…" : purpose;
                const w = display.length * charW + padX * 2;
                const h = fontSize + padY * 2;
                return (
                  <g>
                    {/* Native SVG tooltip — shows full purpose on hover */}
                    <title>{purpose}</title>
                    <rect
                      x={mx - w / 2}
                      y={my - h / 2}
                      width={w}
                      height={h}
                      rx={h / 2}
                      ry={h / 2}
                      fill="var(--color-bg)"
                      stroke="color-mix(in srgb, var(--color-border) 70%, transparent)"
                      strokeWidth={0.75 / view.k}
                    />
                    <text
                      x={mx}
                      y={my + fontSize * 0.34}
                      textAnchor="middle"
                      fontSize={fontSize}
                      fill="var(--color-text-muted)"
                      pointerEvents="none"
                    >
                      {display}
                    </text>
                  </g>
                );
              })()}
            </g>
          );
        })}

          {dragEdge && dragMousePos && (() => {
            const fromNode = nodes.find((n) => n.id === dragEdge.from);
            const fx = fromNode?.x ?? 0;
            const fy = fromNode?.y ?? 0;
            return (
              <line
                x1={fx}
                y1={fy}
                x2={dragMousePos.x}
                y2={dragMousePos.y}
                stroke="var(--color-highlight)"
                strokeWidth={2 / view.k}
                strokeDasharray={`${4 / view.k}`}
                pointerEvents="none"
              />
            );
          })()}

          {edgeBubble && (() => {
            const fromNode = nodes.find((n) => n.id === edgeBubble.from);
            const toNode = nodes.find((n) => n.id === edgeBubble.to);
            if (!fromNode || !toNode) return null;
            return (
              <line
                x1={fromNode.x ?? 0}
                y1={fromNode.y ?? 0}
                x2={toNode.x ?? 0}
                y2={toNode.y ?? 0}
                stroke="var(--color-highlight)"
                strokeWidth={2 / view.k}
                strokeDasharray={`${4 / view.k}`}
                pointerEvents="none"
              />
            );
          })()}

          {nodes.map((node) => {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const isSelected = selectedNode === node.id;
          const liveStatus = getNodeStatus(node.id);
          const color = STATUS_COLORS[liveStatus] || STATUS_COLORS.disconnected;

          // Disconnected nodes ghost out — drop opacity and desaturate so
          // they read as inactive rather than competing with live nodes.
          const isDisconnected = liveStatus === "disconnected";
          return (
            <g
              key={node.id}
              data-graph-node={node.id}
              transform={`translate(${x}, ${y})`}
              style={{
                cursor: "grab",
                opacity: isDisconnected ? 0.4 : 1,
                filter: isDisconnected ? "grayscale(100%)" : undefined,
              }}
              onDoubleClick={(e) => {
                // Double-click → expand the toolbar into edit mode. Stop
                // propagation so the canvas's own dblclick (spawn) doesn't
                // also fire.
                e.stopPropagation();
                const fresh = data?.nodes.find((n) => n.chat_id === node.id);
                setToolbarMode({
                  kind: "edit",
                  chatId: node.id,
                  name: fresh?.name ?? node.name,
                  duty: fresh?.duty ?? "",
                });
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
                const startX = e.clientX;
                const startY = e.clientY;
                let lastX = startX;
                let lastY = startY;
                let didDrag = false;

                const onMouseMove = (ev: MouseEvent) => {
                  const totalDx = ev.clientX - startX;
                  const totalDy = ev.clientY - startY;
                  if (!didDrag && Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) {
                    return;
                  }
                  const draggedNode = nodesRef.current.find((n) => n.id === node.id);
                  if (!draggedNode || !simRef.current) return;
                  if (!didDrag) {
                    didDrag = true;
                    draggedNode.fx = draggedNode.x;
                    draggedNode.fy = draggedNode.y;
                    // Mark this as a user pin (not synthetic) so the layout
                    // effect won't release it on sim end.
                    draggedNode.syntheticPin = false;
                    simRef.current.alpha(0.12).restart();
                  }

                  const graphDelta = clientDeltaToGraph(ev.clientX - lastX, ev.clientY - lastY);
                  draggedNode.fx = (draggedNode.fx ?? draggedNode.x ?? 0) + graphDelta.dx;
                  draggedNode.fy = (draggedNode.fy ?? draggedNode.y ?? 0) + graphDelta.dy;
                  lastX = ev.clientX;
                  lastY = ev.clientY;
                };
                const teardown = () => {
                  window.removeEventListener("mousemove", onMouseMove);
                  window.removeEventListener("mouseup", onMouseUp);
                  activeListenersRef.current.delete(teardown);
                };
                const onMouseUp = () => {
                  handleNodeDragEnd(node.id, didDrag);
                  if (!didDrag) {
                    setSelectedNode(node.id);
                    setSelectedEdge(null);
                    setSelectedNodeId(node.id);
                    // Switching to a different node cancels any in-progress
                    // inline form bound to the previous selection — its
                    // draft would be stale against the new target.
                    setToolbarMode((prev) =>
                      prev &&
                      "chatId" in prev &&
                      prev.chatId !== node.id
                        ? null
                        : prev,
                    );
                    // Sync the chat panel to this node — same event the
                    // "Open Chat →" link in the popup card dispatches.
                    window.dispatchEvent(
                      new CustomEvent("grove:open-chat", {
                        detail: { chatId: node.id },
                      }),
                    );
                  }
                  teardown();
                };
                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
                activeListenersRef.current.add(teardown);
              }}
              onMouseUp={() => {
                // Read from ref so we agree with the document-level mouseup
                // listener regardless of React batching / event order.
                const dragging = dragEdgeRef.current;
                if (!dragging || dragging.from === node.id) return;
                const fromId = dragging.from;
                const toId = node.id;
                dragEdgeRef.current = null;
                setDragEdge(null);
                setDragMousePos(null);

                const validity = checkEdgeValidity(fromId, toId);
                if (!validity.ok) {
                  setToast({ message: validity.reason, type: "error" });
                  return;
                }
                const toNode = data?.nodes.find((n) => n.chat_id === toId);
                if (toNode?.duty) {
                  // Optimistic create — no extra dialog needed.
                  void createEdgeRequest(fromId, toId);
                  return;
                }
                // Target has no duty: open inline bubble near the target node.
                const sp = graphToScreen(node.x ?? 0, node.y ?? 0);
                setEdgeBubble({
                  from: fromId,
                  to: toId,
                  x: sp.x,
                  y: sp.y,
                  duty: "",
                });
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              onMouseEnter={() => setHoveredNodeId(node.id)}
              onMouseLeave={() => setHoveredNodeId(null)}
            >
              {isSelected && (
                <circle r="26" fill="none" stroke="var(--color-highlight)" strokeWidth="2" />
              )}
              {/* Busy: expanding-fading ring so in-flight work is impossible to miss */}
              {liveStatus === "busy" && (
                <circle
                  r="22"
                  fill="none"
                  stroke={STATUS_COLORS.busy}
                  strokeWidth={2}
                  className="graph-node-busy-pulse"
                />
              )}
              {dragEdge && dragEdge.from !== node.id && hoveredNodeId === node.id && (() => {
                const v = checkEdgeValidity(dragEdge.from, node.id);
                const stroke = v.ok ? "var(--color-highlight)" : "var(--color-error)";
                return (
                  <circle
                    r="28"
                    fill={stroke}
                    fillOpacity={0.12}
                    stroke={stroke}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                  />
                );
              })()}
              <circle
                r="22"
                fill="var(--color-bg-secondary)"
                stroke={color}
                strokeWidth={2}
                strokeDasharray={liveStatus === "connecting" ? "4 3" : undefined}
                className={liveStatus === "connecting" ? "graph-edge-in-flight" : undefined}
              />
              <image
                href={agentIconUrl(node.agent) ?? ""}
                x="-14"
                y="-14"
                width="28"
                height="28"
                onError={(e) => {
                  const img = e.currentTarget;
                  img.style.display = "none";
                }}
              />
              {/* Permission required: ⚠ corner badge in the top-right so
                  users immediately see "this one needs your attention" */}
              {liveStatus === "permission_required" && (
                <g>
                  <circle
                    cx={16}
                    cy={-16}
                    r={7}
                    fill="var(--color-warning)"
                    stroke="var(--color-bg)"
                    strokeWidth={1.5}
                  />
                  <text
                    x={16}
                    y={-13}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight="700"
                    fill="white"
                    pointerEvents="none"
                  >
                    !
                  </text>
                </g>
              )}
              <text
                y="34"
                textAnchor="middle"
                fill="var(--color-text)"
                fontSize="9"
                fontWeight="500"
                opacity={isDisconnected ? 0.7 : 1}
              >
                {truncate(node.name, 16)}
              </text>
              {(() => {
                const handleVisible =
                  hoveredNodeId === node.id ||
                  isSelected ||
                  (dragEdge?.from === node.id);
                return (
                  <g
                    style={{ cursor: "crosshair" }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const drag = { from: node.id };
                      dragEdgeRef.current = drag;
                      setDragEdge(drag);
                      const onMove = (ev: MouseEvent) => {
                        setDragMousePos(clientToGraph(ev.clientX, ev.clientY));
                      };
                      const teardown = () => {
                        // The React-synthetic onMouseUp on a target node runs
                        // during the bubble phase. We attach our window
                        // listener to the BUBBLE phase too (default) but the
                        // node handler is on a deeper element and runs first.
                        // Belt-and-suspenders: also try `dragEdgeRef.current`
                        // again here in case some future React version flips
                        // ordering — if a drop on a node was missed, the ref
                        // would still be set when we run.
                        window.removeEventListener("mousemove", onMove);
                        window.removeEventListener("mouseup", onUp);
                        dragEdgeRef.current = null;
                        setDragEdge(null);
                        setDragMousePos(null);
                        activeListenersRef.current.delete(teardown);
                      };
                      const onUp = (ev: MouseEvent) => {
                        // If the React node onMouseUp didn't consume the drop
                        // (e.g. dropped on empty space), `dragEdgeRef.current`
                        // is still set here; teardown() will null it out.
                        // If it did consume, ref is already null — no-op.
                        // Safety: hit-test the cursor against a node g and
                        // trigger drop if so. Future-proof against React
                        // changing event ordering relative to window listeners.
                        if (dragEdgeRef.current) {
                          const target = document.elementFromPoint(
                            ev.clientX,
                            ev.clientY,
                          );
                          const nodeG = target?.closest<SVGGElement>(
                            "g[data-graph-node]",
                          );
                          const droppedOnNodeId = nodeG?.dataset.graphNode;
                          if (droppedOnNodeId && droppedOnNodeId !== dragEdgeRef.current.from) {
                            // Re-route through the same drop logic as the
                            // node onMouseUp branch by dispatching a synthetic
                            // event isn't possible cleanly; instead, set a
                            // sentinel that the node onMouseUp would have set
                            // (it fires before us anyway when present). If we
                            // got here with dragEdgeRef still set, the node
                            // handler did NOT see the drop — process inline.
                            const fromId = dragEdgeRef.current.from;
                            const validity = checkEdgeValidity(fromId, droppedOnNodeId);
                            if (!validity.ok) {
                              setToast({ message: validity.reason, type: "error" });
                            } else {
                              const toNode = data?.nodes.find((n) => n.chat_id === droppedOnNodeId);
                              if (toNode?.duty) {
                                void createEdgeRequest(fromId, droppedOnNodeId);
                              } else {
                                const sp = graphToScreen(0, 0);
                                // Position bubble near the dropped node center
                                const sim = nodesRef.current.find((n) => n.id === droppedOnNodeId);
                                if (sim) {
                                  const psp = graphToScreen(sim.x ?? 0, sim.y ?? 0);
                                  setEdgeBubble({
                                    from: fromId,
                                    to: droppedOnNodeId,
                                    x: psp.x,
                                    y: psp.y,
                                    duty: "",
                                  });
                                } else {
                                  setEdgeBubble({
                                    from: fromId,
                                    to: droppedOnNodeId,
                                    x: sp.x,
                                    y: sp.y,
                                    duty: "",
                                  });
                                }
                              }
                            }
                          }
                        }
                        teardown();
                      };
                      window.addEventListener("mousemove", onMove);
                      window.addEventListener("mouseup", onUp);
                      activeListenersRef.current.add(teardown);
                    }}
                  >
                    {/* Larger transparent hit-target so the handle is easy to grab */}
                    <circle cx={22} cy={0} r={10} fill="transparent" />
                    <circle
                      cx={22}
                      cy={0}
                      r={5}
                      fill="var(--color-highlight)"
                      stroke="var(--color-bg)"
                      strokeWidth={1.5}
                      opacity={handleVisible ? 1 : 0}
                      style={{ transition: "opacity 0.15s" }}
                    />
                    {handleVisible && (
                      <>
                        <line
                          x1={20}
                          x2={24}
                          y1={0}
                          y2={0}
                          stroke="var(--color-bg)"
                          strokeWidth={1.2}
                          strokeLinecap="round"
                        />
                        <line
                          x1={22}
                          x2={22}
                          y1={-2}
                          y2={2}
                          stroke="var(--color-bg)"
                          strokeWidth={1.2}
                          strokeLinecap="round"
                        />
                      </>
                    )}
                  </g>
                );
              })()}
            </g>
          );
        })}
        </g>
      </svg>

      {spawnBubble && (() => {
        const containerRect = containerRef.current?.getBoundingClientRect();
        const cw = containerRect?.width ?? 800;
        const ch = containerRect?.height ?? 600;
        const bubbleW = 300;
        const bubbleH = 240;
        const margin = 8;
        const gap = 14;
        // Place to the right of the click point by default; flip / clamp as needed.
        let left =
          spawnBubble.x + gap + bubbleW + margin <= cw
            ? spawnBubble.x + gap
            : Math.max(margin, spawnBubble.x - gap - bubbleW);
        left = Math.max(margin, Math.min(left, cw - bubbleW - margin));
        let top = spawnBubble.y - bubbleH / 2;
        top = Math.max(margin, Math.min(top, ch - bubbleH - margin));

        const canSubmit = !!spawnBubble.agent && !!spawnBubble.name.trim();

        return (
          <div
            className="absolute z-40 rounded-xl border border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_92%,transparent)] backdrop-blur-xl shadow-[0_12px_40px_rgba(0,0,0,0.18)] overflow-hidden"
            style={{ left, top, width: bubbleW }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
              <div className="text-xs font-medium text-[var(--color-text)]">Spawn New Node</div>
              <button
                onClick={() => setSpawnBubble(null)}
                className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-3 py-2.5 space-y-2">
              <div>
                <label className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">Agent <span className="text-[var(--color-error)]">*</span></label>
                <div className="mt-1">
                  <AgentPicker
                    value={spawnBubble.agent}
                    onChange={(value) => setSpawnBubble({ ...spawnBubble, agent: value })}
                    placeholder={acpAvailabilityLoaded ? "Select agent..." : "Checking…"}
                    allowCustom={false}
                    options={acpAgentOptions}
                    customAgents={customAgents}
                    customAgentPersonas={customAgentPersonas}
                  />
                </div>
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">Name <span className="text-[var(--color-error)]">*</span></label>
                <input
                  autoFocus
                  className="mt-1 w-full px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  value={spawnBubble.name}
                  onChange={(e) => setSpawnBubble({ ...spawnBubble, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && canSubmit) submitSpawn();
                    else if (e.key === "Escape") setSpawnBubble(null);
                  }}
                  placeholder="Unique within task"
                />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">Duty</label>
                <textarea
                  className="mt-1 w-full px-2.5 py-2 text-[13px] leading-snug rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-y min-h-[60px]"
                  value={spawnBubble.duty}
                  onChange={(e) => setSpawnBubble({ ...spawnBubble, duty: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
                      e.preventDefault();
                      submitSpawn();
                    } else if (e.key === "Escape") setSpawnBubble(null);
                  }}
                  placeholder="Optional — AI will set on first send"
                />
              </div>
            </div>
            <div className="flex justify-end gap-1.5 px-3 pb-2.5">
              <button
                onClick={() => setSpawnBubble(null)}
                className="px-2.5 py-1 text-[11px] rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitSpawn}
                disabled={spawnLoading || !canSubmit}
                className="px-3 py-1 text-[11px] font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {spawnLoading ? "..." : "Create"}
              </button>
            </div>
          </div>
        );
      })()}

      {edgeBubble && (() => {
        const fromNode = data?.nodes.find((n) => n.chat_id === edgeBubble.from);
        const toNode = data?.nodes.find((n) => n.chat_id === edgeBubble.to);
        const containerRect = containerRef.current?.getBoundingClientRect();
        const cw = containerRect?.width ?? 800;
        const ch = containerRect?.height ?? 600;
        const bubbleW = 280;
        const bubbleH = 160;
        const gap = 14;
        const margin = 8;
        const nodeR = 22 * view.k * (graphToScreen(0, 0).scale || 1);

        const rightAvail = cw - (edgeBubble.x + nodeR) - gap - margin;
        const leftAvail = edgeBubble.x - nodeR - gap - margin;
        let left: number;
        if (rightAvail >= bubbleW) left = edgeBubble.x + nodeR + gap;
        else if (leftAvail >= bubbleW) left = edgeBubble.x - nodeR - gap - bubbleW;
        else
          left =
            rightAvail >= leftAvail
              ? Math.min(edgeBubble.x + nodeR + gap, cw - bubbleW - margin)
              : Math.max(edgeBubble.x - nodeR - gap - bubbleW, margin);
        let top = edgeBubble.y - bubbleH / 2;
        top = Math.max(margin, Math.min(top, ch - bubbleH - margin));

        const submit = async () => {
          if (!edgeBubble.duty.trim()) return;
          const ok = await createEdgeRequest(edgeBubble.from, edgeBubble.to, {
            duty: edgeBubble.duty,
          });
          if (ok) setEdgeBubble(null);
        };

        return (
          <div
            className="absolute z-40 rounded-xl border border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_92%,transparent)] backdrop-blur-xl shadow-[0_12px_40px_rgba(0,0,0,0.18)] overflow-hidden"
            style={{ left, top, width: bubbleW }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
              <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11px] text-[var(--color-text)]">
                <span className="truncate font-medium" title={fromNode?.name}>{fromNode?.name}</span>
                <span className="text-[var(--color-text-muted)] shrink-0">→</span>
                <span className="truncate font-medium" title={toNode?.name}>{toNode?.name}</span>
              </div>
              <button
                onClick={() => setEdgeBubble(null)}
                className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-3 py-2.5 space-y-2">
              <div>
                <label className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">
                  Duty <span className="text-[var(--color-error)]">*</span>
                </label>
                <textarea
                  autoFocus
                  className="mt-1 w-full px-2.5 py-2 text-[13px] leading-snug rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-y min-h-[60px]"
                  value={edgeBubble.duty}
                  onChange={(e) => setEdgeBubble({ ...edgeBubble, duty: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submit();
                    } else if (e.key === "Escape") setEdgeBubble(null);
                  }}
                  placeholder="Target has no duty — set one"
                />
                <p className="mt-1 text-[9px] text-[var(--color-text-muted)]">Click the edge later to set its purpose.</p>
              </div>
            </div>
            <div className="flex justify-end gap-1.5 px-3 pb-2.5">
              <button
                onClick={() => setEdgeBubble(null)}
                className="px-2.5 py-1 text-[11px] rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={edgeLoading || !edgeBubble.duty.trim()}
                className="px-3 py-1 text-[11px] font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {edgeLoading ? "..." : "Create"}
              </button>
            </div>
          </div>
        );
      })()}


      {/* Bottom context toolbar — replaces the legacy popup card. Always
       *  rendered, content depends on what's selected. */}
      <GraphContextToolbar
        node={selectedNodeData}
        edge={
          selectedEdge != null
            ? data?.edges.find((e) => e.edge_id === selectedEdge) ?? null
            : null
        }
        nodeStatus={selectedNodeData ? getNodeStatus(selectedNodeData.chat_id) : null}
        edgeState={(() => {
          if (selectedEdge == null) return null;
          const e = data?.edges.find((ed) => ed.edge_id === selectedEdge);
          if (!e) return null;
          return deriveEdgeState(e.from, e.to);
        })()}
        edgeTargetStatus={(() => {
          if (selectedEdge == null) return null;
          const e = data?.edges.find((ed) => ed.edge_id === selectedEdge);
          if (!e) return null;
          return getNodeStatus(e.to);
        })()}
        nodeNameById={(id) =>
          data?.nodes.find((n) => n.chat_id === id)?.name ?? id
        }
        directMessage={directMessage}
        sendingMessage={sendingMessage}
        onDirectMessageChange={setDirectMessage}
        onSendDirect={(chatId, text) => handleDirectSend(chatId, text)}
        mode={toolbarMode}
        defaultAgent={defaultAgent}
        agentOptionsList={acpAgentOptions}
        customAgentsList={customAgents}
        customAgentPersonasList={customAgentPersonas}
        onModeChange={setToolbarMode}
        onEditNode={(node) =>
          setToolbarMode({
            kind: "edit",
            chatId: node.chat_id,
            name: node.name,
            duty: node.duty ?? "",
          })
        }
        onSpawnFrom={(node) =>
          setToolbarMode({
            kind: "spawn",
            fromChatId: node.chat_id,
            agent: defaultAgent,
            name: "",
            duty: "",
            purpose: "",
          })
        }
        onSubmitEdit={async (chatId, nextName, nextDuty) => {
          const fresh = data?.nodes.find((n) => n.chat_id === chatId);
          const tasks: Promise<unknown>[] = [];
          if (nextName.trim() && nextName.trim() !== fresh?.name) {
            tasks.push(handleSaveName(chatId, nextName));
          }
          if (nextDuty !== (fresh?.duty ?? "")) {
            tasks.push(handleUpdateDuty(chatId, nextDuty));
          }
          await Promise.all(tasks);
          setToolbarMode(null);
        }}
        onSubmitSpawn={async (fromChatId, agent, name, duty, purpose) => {
          if (!agent || !name.trim()) return;
          setSpawnLoading(true);
          try {
            await spawnGraphNode(projectId, taskId, {
              from_chat_id: fromChatId,
              agent,
              name: name.trim(),
              duty: duty.trim() || undefined,
              // purpose only travels along an edge — drop it for orphan
              // spawns where there's no edge to label.
              purpose: fromChatId && purpose.trim() ? purpose.trim() : undefined,
            });
            setToolbarMode(null);
            refreshGraph();
            setToast({ message: "Node created", type: "success" });
          } catch (e) {
            const err = graphApiError(e);
            showError(err.code, err.message);
          } finally {
            setSpawnLoading(false);
          }
        }}
        spawning={spawnLoading}
        onDeleteNode={(node) =>
          setToolbarMode({
            kind: "confirm-delete-node",
            chatId: node.chat_id,
            name: node.name,
          })
        }
        onConfirmDeleteNode={async (chatId) => {
          try {
            await deleteChat(projectId, taskId, chatId);
            setSelectedNodeId(null);
            setSelectedNode(null);
            setToolbarMode(null);
            refreshGraph();
            setToast({ message: "Session deleted", type: "success" });
          } catch (e) {
            showError("internal_error", String(e));
          }
        }}
        onEditEdge={(edge) =>
          setToolbarMode({
            kind: "edit-edge",
            edgeId: edge.edge_id,
            purpose: edge.purpose ?? "",
          })
        }
        onSubmitEditEdge={async (edgeId, purpose) => {
          await handleUpdatePurpose(edgeId, purpose);
          setToolbarMode(null);
        }}
        onRemindEdge={(edge) => handleRemind(edge.edge_id)}
        onDeleteEdge={(edge) =>
          setToolbarMode({ kind: "confirm-delete-edge", edgeId: edge.edge_id })
        }
        onConfirmDeleteEdge={async (edgeId) => {
          await handleDeleteEdge(edgeId);
          setToolbarMode(null);
        }}
        onNewSession={() => {
          // No-op: New Session entry is handled by the toolbar itself, which
          // sets toolbarMode = 'spawn' (no fromChatId). Kept as a hook for
          // future telemetry / analytics if needed.
        }}
        zoomLevel={view.k}
        onZoomIn={() => zoomBy(1.18)}
        onZoomOut={() => zoomBy(0.85)}
        onZoomFit={fitView}
      />

      {toast && (
        <div
          className={`absolute bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm ${
            toast.type === "error"
              ? "bg-[var(--color-error)] text-white"
              : "bg-[var(--color-success)] text-white"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}


// ─── Bottom context toolbar ──────────────────────────────────────────────
// Single floating pill that morphs between four modes:
//   - compact     (default): context info + action buttons
//   - send                  : inline message input
//   - edit                  : name + duty form
//   - spawn                 : agent picker + name + duty form
// Shape changes are framer-motion `layout`-animated; child swaps fade with
// AnimatePresence. The user perceives the toolbar as a single live surface
// that grows / shrinks / reshapes around the active task.

type ToolbarModeShape =
  | { kind: "send"; chatId: string }
  | { kind: "edit"; chatId: string; name: string; duty: string }
  | {
      kind: "spawn";
      fromChatId: string | null;
      agent: string;
      name: string;
      duty: string;
      /** Edge purpose — only meaningful when fromChatId != null. */
      purpose: string;
    }
  | { kind: "edit-edge"; edgeId: number; purpose: string }
  | { kind: "confirm-delete-node"; chatId: string; name: string }
  | { kind: "confirm-delete-edge"; edgeId: number };

interface AcpAgentOption {
  id: string;
  value: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface ToolbarProps {
  node: GraphNode | null;
  edge: GraphEdge | null;
  nodeStatus: string | null;
  /** Live state of `edge`. `null` when no edge is selected. */
  edgeState: "idle" | "in_flight" | "blocked" | null;
  /** Live status of the selected edge's target node. */
  edgeTargetStatus: NodeStatus | null;
  nodeNameById: (id: string) => string;
  directMessage: string;
  sendingMessage: boolean;
  spawning: boolean;
  defaultAgent: string;
  agentOptionsList: AcpAgentOption[];
  customAgentsList: CustomAgentServer[];
  customAgentPersonasList: CustomAgentPersona[];
  mode: ToolbarModeShape | null;
  onModeChange: (mode: ToolbarModeShape | null) => void;
  onDirectMessageChange: (v: string) => void;
  onSendDirect: (chatId: string, text: string) => void;
  onEditNode: (node: GraphNode) => void;
  onSpawnFrom: (node: GraphNode) => void;
  onDeleteNode: (node: GraphNode) => void;
  onEditEdge: (edge: GraphEdge) => void;
  onRemindEdge: (edge: GraphEdge) => void;
  onDeleteEdge: (edge: GraphEdge) => void;
  onConfirmDeleteNode: (chatId: string) => void;
  onConfirmDeleteEdge: (edgeId: number) => void;
  onSubmitEditEdge: (edgeId: number, purpose: string) => void;
  onNewSession: () => void;
  onSubmitEdit: (chatId: string, name: string, duty: string) => void;
  onSubmitSpawn: (
    fromChatId: string | null,
    agent: string,
    name: string,
    duty: string,
    purpose: string,
  ) => void;
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
}

const FLOAT_PILL =
  "rounded-3xl select-none border border-[color-mix(in_srgb,var(--color-border)_70%,transparent)] " +
  "bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] backdrop-blur-xl " +
  "shadow-[0_10px_32px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.06)] " +
  "overflow-hidden";

const MODE_TRANSITION = {
  type: "spring" as const,
  stiffness: 380,
  damping: 32,
  mass: 0.8,
};

function GraphContextToolbar(props: ToolbarProps) {
  const {
    node,
    edge,
    nodeStatus,
    edgeState,
    edgeTargetStatus,
    nodeNameById,
    directMessage,
    sendingMessage,
    spawning,
    defaultAgent,
    agentOptionsList,
    customAgentsList,
    customAgentPersonasList,
    mode,
    onModeChange,
    onDirectMessageChange,
    onSendDirect,
    onEditNode,
    onSpawnFrom,
    onDeleteNode,
    onEditEdge,
    onRemindEdge,
    onDeleteEdge,
    onConfirmDeleteNode,
    onConfirmDeleteEdge,
    onSubmitEditEdge,
    onNewSession,
    onSubmitEdit,
    onSubmitSpawn,
    zoomLevel,
    onZoomIn,
    onZoomOut,
    onZoomFit,
  } = props;

  // Active mode key drives AnimatePresence; the pill morphs around it.
  // Cancellation when the selection moves elsewhere is handled upstream by
  // the click handler that changed the selection.
  const activeKey = mode?.kind ?? (node ? "node" : edge ? "edge" : "empty");

  return (
    <>
      <motion.div
        layout
        transition={MODE_TRANSITION}
        // Reserve ~210px on each side so the centered context toolbar never
        // overlaps the bottom-right zoom widget (or any future bottom-left
        // affordance). 1.5rem of breathing room is kept from the viewport edge.
        className={`absolute bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100%-26rem)] ${FLOAT_PILL}`}
        style={{ originY: 1 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {mode?.kind === "send" && node && nodeStatus && (
            <motion.div
              key="send"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="px-3 py-2"
            >
              <SendForm
                placeholder={
                  nodeStatus === "disconnected"
                    ? `Start and send to ${node.name}…`
                    : `Send to ${node.name}…`
                }
                value={directMessage}
                disabled={sendingMessage}
                sending={sendingMessage}
                onChange={onDirectMessageChange}
                onSend={() => {
                  if (directMessage.trim()) {
                    onSendDirect(node.chat_id, directMessage);
                    onModeChange(null);
                  }
                }}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "edit" && (
            <motion.div
              key="edit"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="p-3 w-[420px]"
            >
              <EditForm
                name={mode.name}
                duty={mode.duty}
                onNameChange={(v) =>
                  onModeChange(
                    mode.kind === "edit" ? { ...mode, name: v } : mode,
                  )
                }
                onDutyChange={(v) =>
                  onModeChange(
                    mode.kind === "edit" ? { ...mode, duty: v } : mode,
                  )
                }
                onSubmit={() =>
                  onSubmitEdit(mode.chatId, mode.name, mode.duty)
                }
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "spawn" && (
            <motion.div
              key="spawn"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="p-3 w-[420px]"
            >
              <SpawnForm
                agent={mode.agent}
                name={mode.name}
                duty={mode.duty}
                purpose={mode.purpose}
                fromName={
                  mode.fromChatId ? nodeNameById(mode.fromChatId) : null
                }
                agents={agentOptionsList}
                customAgents={customAgentsList}
                customAgentPersonas={customAgentPersonasList}
                onAgentChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, agent: v } : mode,
                  )
                }
                onNameChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, name: v } : mode,
                  )
                }
                onDutyChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, duty: v } : mode,
                  )
                }
                onPurposeChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, purpose: v } : mode,
                  )
                }
                submitting={spawning}
                onSubmit={() =>
                  onSubmitSpawn(
                    mode.fromChatId,
                    mode.agent,
                    mode.name,
                    mode.duty,
                    mode.purpose,
                  )
                }
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "edit-edge" && (
            <motion.div
              key="edit-edge"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="p-3 w-[420px]"
            >
              <EditEdgeForm
                purpose={mode.purpose}
                onPurposeChange={(v) =>
                  onModeChange(
                    mode.kind === "edit-edge"
                      ? { ...mode, purpose: v }
                      : mode,
                  )
                }
                onSubmit={() => onSubmitEditEdge(mode.edgeId, mode.purpose)}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "confirm-delete-node" && (
            <motion.div
              key="confirm-del-node"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <ConfirmDeleteRow
                label={
                  <>
                    Delete{" "}
                    <span className="font-semibold">{mode.name}</span>?
                    <span className="text-[10.5px] text-[var(--color-text-muted)] ml-1">
                      (chat + all its edges)
                    </span>
                  </>
                }
                onConfirm={() => onConfirmDeleteNode(mode.chatId)}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "confirm-delete-edge" && (
            <motion.div
              key="confirm-del-edge"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <ConfirmDeleteRow
                label={<>Delete this connection?</>}
                onConfirm={() => onConfirmDeleteEdge(mode.edgeId)}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {!mode && node && nodeStatus && (
            <motion.div
              key={`node-${node.chat_id}`}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <NodeContextSection
                node={node}
                status={nodeStatus}
                onSendClick={() =>
                  onModeChange({ kind: "send", chatId: node.chat_id })
                }
                onEditClick={() => onEditNode(node)}
                onSpawnFromClick={() => onSpawnFrom(node)}
                onDeleteClick={() => onDeleteNode(node)}
              />
            </motion.div>
          )}
          {!mode && !node && edge && (
            <motion.div
              key={`edge-${edge.edge_id}`}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <EdgeContextSection
                edge={edge}
                edgeState={edgeState}
                targetStatus={edgeTargetStatus}
                fromName={nodeNameById(edge.from)}
                toName={nodeNameById(edge.to)}
                onEditClick={() => onEditEdge(edge)}
                onRemindClick={() => onRemindEdge(edge)}
                onDeleteClick={() => onDeleteEdge(edge)}
              />
            </motion.div>
          )}
          {!mode && !node && !edge && (
            <motion.div
              key="empty"
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <EmptyContextSection
                onNewSession={() => {
                  onModeChange({
                    kind: "spawn",
                    fromChatId: null,
                    agent: defaultAgent,
                    name: "",
                    duty: "",
                    purpose: "",
                  });
                  onNewSession?.();
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Zoom widget: zoom out, current level (display-only label), zoom in,
       *  divider, "Reset" text button. The label is intentionally not a
       *  button — users were misreading it as an editable percentage. */}
      <motion.div
        layout
        transition={MODE_TRANSITION}
        className={`absolute bottom-5 right-5 z-40 flex items-center gap-0.5 px-1.5 py-1.5 ${FLOAT_PILL}`}
        key={`zoom-${activeKey}`}
      >
        <button
          type="button"
          onClick={onZoomOut}
          title="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] transition-colors"
        >
          <ZoomOut size={14} />
        </button>
        <span className="flex h-7 px-2 items-center justify-center text-[10.5px] font-mono tabular-nums text-[var(--color-text-muted)] select-none">
          {Math.round(zoomLevel * 100)}%
        </span>
        <button
          type="button"
          onClick={onZoomIn}
          title="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] transition-colors"
        >
          <ZoomIn size={14} />
        </button>
        <span
          className="mx-1 h-4 w-px bg-[color-mix(in_srgb,var(--color-border)_70%,transparent)]"
          aria-hidden
        />
        <button
          type="button"
          onClick={onZoomFit}
          title="Reset zoom and fit graph to view"
          className="flex h-7 px-3 items-center justify-center rounded-full text-[11px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] transition-colors"
        >
          Reset
        </button>
      </motion.div>
    </>
  );
}

function EmptyContextSection({ onNewSession }: { onNewSession: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onNewSession}
        className="flex items-center gap-1.5 h-7 px-3 rounded-full bg-[var(--color-highlight)] text-[12px] font-medium text-white hover:opacity-90 transition-opacity shadow-sm shrink-0 whitespace-nowrap"
        title="Create a new session"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>New Session</span>
      </button>
      <span className="text-[11px] text-[var(--color-text-muted)] truncate min-w-0">
        Click a node to switch chat · double-click to edit · drag to rearrange
      </span>
    </>
  );
}

function NodeContextSection({
  node,
  status,
  onSendClick,
  onEditClick,
  onSpawnFromClick,
  onDeleteClick,
}: {
  node: GraphNode;
  status: string;
  onSendClick: () => void;
  onEditClick: () => void;
  onSpawnFromClick: () => void;
  onDeleteClick: () => void;
}) {
  const Icon = agentIconComponent(node.agent);
  const dotColor = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span className="relative shrink-0">
          {createElement(Icon, { size: 16, className: "block" })}
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-[var(--color-bg)]"
            style={{ backgroundColor: dotColor }}
            title={status}
          />
        </span>
        <span className="text-[12px] font-medium text-[var(--color-text)] truncate max-w-[180px]">
          {node.name}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)] shrink-0">
          {status}
        </span>
      </div>
      <div className="ml-2 flex items-center gap-1 shrink-0">
        <ToolbarButton
          icon={<Send className="w-3.5 h-3.5" />}
          label="Send"
          onClick={onSendClick}
          disabled={false}
        />
        <ToolbarButton
          icon={<GitBranch className="w-3.5 h-3.5" />}
          label="Spawn Child"
          onClick={onSpawnFromClick}
        />
        <ToolbarButton
          icon={<Pencil className="w-3.5 h-3.5" />}
          label="Edit"
          onClick={onEditClick}
        />
        <ToolbarButton
          icon={<Trash2 className="w-3.5 h-3.5" />}
          label="Delete"
          onClick={onDeleteClick}
          danger
        />
      </div>
    </>
  );
}

function SendForm({
  placeholder,
  value,
  disabled,
  sending,
  onChange,
  onSend,
  onCancel,
}: {
  placeholder: string;
  value: string;
  disabled: boolean;
  sending: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 w-[480px] max-w-full">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-w-0 h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        className="h-8 w-8 flex items-center justify-center rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        title="Send (Enter)"
      >
        {sending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Send className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="h-8 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function EditForm({
  name,
  duty,
  onNameChange,
  onDutyChange,
  onSubmit,
  onCancel,
}: {
  name: string;
  duty: string;
  onNameChange: (v: string) => void;
  onDutyChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Pencil className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Name"
          className="flex-1 h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
        />
      </div>
      <textarea
        value={duty}
        onChange={(e) => onDutyChange(e.target.value)}
        placeholder="Duty — what this session is responsible for…"
        rows={3}
        className="px-3 py-2 text-[12.5px] leading-snug rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none min-h-[64px]"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          ⌘/Ctrl + Enter to save · Esc to cancel
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SpawnForm({
  agent,
  name,
  duty,
  purpose,
  fromName,
  agents,
  customAgents,
  customAgentPersonas,
  submitting,
  onAgentChange,
  onNameChange,
  onDutyChange,
  onPurposeChange,
  onSubmit,
  onCancel,
}: {
  agent: string;
  name: string;
  duty: string;
  purpose: string;
  fromName: string | null;
  agents: AcpAgentOption[];
  customAgents: CustomAgentServer[];
  customAgentPersonas: CustomAgentPersona[];
  submitting: boolean;
  onAgentChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onDutyChange: (v: string) => void;
  onPurposeChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <Plus className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">
          {fromName ? `Spawn child from ${fromName}` : "Spawn new session"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          <AgentPicker
            value={agent}
            onChange={onAgentChange}
            allowCustom={false}
            options={agents}
            customAgents={customAgents}
            customAgentPersonas={customAgentPersonas}
            triggerShape="pill"
            triggerSize="compact"
          />
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Session name"
          className="flex-1 h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
        />
      </div>
      <textarea
        value={duty}
        onChange={(e) => onDutyChange(e.target.value)}
        placeholder="Duty (optional)"
        rows={2}
        className="px-3 py-2 text-[12.5px] leading-snug rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none min-h-[48px]"
      />
      {fromName && (
        // Edge purpose only applies when there's a parent edge to label —
        // orphan spawns (no fromName) hide it to keep the form minimal.
        <input
          value={purpose}
          onChange={(e) => onPurposeChange(e.target.value)}
          placeholder="Purpose of this connection (optional)"
          className="h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
        />
      )}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          ⌘/Ctrl + Enter to spawn · Esc to cancel
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !name.trim() || !agent}
            className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}

function EdgeContextSection({
  edge,
  edgeState,
  targetStatus,
  fromName,
  toName,
  onEditClick,
  onRemindClick,
  onDeleteClick,
}: {
  edge: GraphEdge;
  edgeState: "idle" | "in_flight" | "blocked" | null;
  targetStatus: NodeStatus | null;
  fromName: string;
  toName: string;
  onEditClick: () => void;
  onRemindClick: () => void;
  onDeleteClick: () => void;
}) {
  const hasPending = edgeState !== null && edgeState !== "idle";
  const canRemind = hasPending && targetStatus === "idle";
  const remindDisabledTitle = !hasPending
    ? "No pending message on this edge"
    : targetStatus === "busy"
      ? "Target session is currently working"
      : "Target session is not idle";
  return (
    <>
      <div className="flex items-center gap-2 min-w-0 flex-1 text-[12px]">
        <MessageSquare className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
        <span
          className="font-medium text-[var(--color-text)] truncate max-w-[140px]"
          title={fromName}
        >
          {fromName}
        </span>
        <span className="text-[var(--color-text-muted)] shrink-0">→</span>
        <span
          className="font-medium text-[var(--color-text)] truncate max-w-[140px]"
          title={toName}
        >
          {toName}
        </span>
        {edge.purpose && (
          <span
            className="text-[var(--color-text-muted)] truncate min-w-0"
            title={edge.purpose}
          >
            · {edge.purpose}
          </span>
        )}
      </div>
      <div className="ml-2 flex items-center gap-1 shrink-0">
        <ToolbarButton
          icon={<Pencil className="w-3.5 h-3.5" />}
          label="Edit Purpose"
          onClick={onEditClick}
        />
        <ToolbarButton
          icon={<Bell className="w-3.5 h-3.5" />}
          label="Remind"
          onClick={onRemindClick}
          disabled={!canRemind}
          disabledTitle={remindDisabledTitle}
        />
        <ToolbarButton
          icon={<Trash2 className="w-3.5 h-3.5" />}
          label="Delete"
          onClick={onDeleteClick}
          danger
        />
      </div>
    </>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  disabledTitle,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledTitle?: string;
  danger?: boolean;
}) {
  const base =
    "flex items-center gap-1 h-7 px-2.5 rounded-full text-[11.5px] font-medium transition-colors shrink-0 whitespace-nowrap";
  const enabled = danger
    ? "text-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)]"
    : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
  const disabledCls =
    "text-[var(--color-text-muted)] opacity-50 cursor-not-allowed";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledTitle : label}
      className={`${base} ${disabled ? disabledCls : enabled}`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function EditEdgeForm({
  purpose,
  onPurposeChange,
  onSubmit,
  onCancel,
}: {
  purpose: string;
  onPurposeChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <Pencil className="w-3.5 h-3.5 shrink-0" />
        <span>Edit connection purpose</span>
      </div>
      <textarea
        autoFocus
        value={purpose}
        onChange={(e) => onPurposeChange(e.target.value)}
        placeholder="Why does this connection exist?"
        rows={2}
        className="px-3 py-2 text-[12.5px] leading-snug rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none min-h-[48px]"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          ⌘/Ctrl + Enter to save · Esc to cancel
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline confirm-delete row. Replaces window.confirm so the confirmation lives
 * in the same toolbar surface and matches the app's visual language.
 */
function ConfirmDeleteRow({
  label,
  onConfirm,
  onCancel,
}: {
  label: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 min-w-0 text-[12px] text-[var(--color-text)] pr-2">
        <Trash2 className="w-3.5 h-3.5 shrink-0 text-[var(--color-error)]" />
        <span className="truncate">{label}</span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        autoFocus
        className="h-7 px-3 text-[11.5px] font-medium rounded-full border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0 whitespace-nowrap"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-error)] text-white hover:opacity-90 transition-opacity shrink-0 whitespace-nowrap"
      >
        Confirm Delete
      </button>
    </>
  );
}
