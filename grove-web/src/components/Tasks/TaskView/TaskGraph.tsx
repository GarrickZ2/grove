import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { updateChatTitle, sendGraphChatMessage, checkCommands, getConfig } from "../../../api";
import type { CustomAgent } from "../../../api";
import type { NodeStatus } from "../../../api/walkieTalkie";
import { useRadioEvents } from "../../../hooks/useRadioEvents";
import { AgentPicker, agentOptions } from "../../ui/AgentPicker";
import { Maximize2, ZoomIn, ZoomOut, X, Pencil, Trash2, Bell, Send, Loader2 } from "lucide-react";
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

interface SimNode extends SimulationNodeDatum {
  id: string;
  name: string;
  agent: string;
  duty?: string;
  status: string;
  pending_in: number;
  pending_out: number;
  pending_messages: PendingMessageInfo[];
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

const AGENT_ICON_MAP: Record<string, string> = {
  claude: "claude-color",
  codex: "openai",
  "gpt-4": "openai",
  "gpt-4o": "openai",
  gpt: "openai",
  openai: "openai",
  gemini: "gemini-color",
  copilot: "githubcopilot",
  "github-copilot": "githubcopilot",
  githubcopilot: "githubcopilot",
  cursor: "cursor",
  trae: "trae-color",
  qwen: "qwen-color",
  kimi: "kimi-color",
  windsurf: "windsurf",
  opencode: "opencode",
  junie: "junie-color",
  openclaw: "openclaw-color",
  hermes: "hermes",
  kiro: "kiro",
};

const ERROR_HINTS: Record<string, string> = {
  name_taken: "Name already taken",
  cycle_would_form: "Would create a cycle",
  bidirectional_edge: "Reverse edge already exists",
  duplicate_edge: "Edge already exists",
  same_task_required: "Cannot connect across tasks",
  target_not_found: "Target not found",
  no_pending_to_remind: "No pending message to remind",
  target_is_busy: "Target is busy",
  duty_forbidden: "Duty is locked",
  timeout: "Operation timed out",
  agent_spawn_failed: "Agent failed to start",
  internal_error: "Internal error",
};

function agentIconUrl(agent: string): string {
  const key = agent.toLowerCase().replace(/[\s._-]+/g, "");
  const match = AGENT_ICON_MAP[key] ?? AGENT_ICON_MAP[agent.toLowerCase()];
  const file = match ?? agent.toLowerCase();
  return `/agent-icon/${file}.svg`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}

// Title that truncates by default and marquee-scrolls on hover when overflowing.
// Mirrors OverflowTitle in TaskChat.tsx for visual consistency.
function OverflowTitle({ text, className = "" }: { text: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [shift, setShift] = useState(0);

  const measure = useCallback(() => {
    const c = containerRef.current;
    const ct = contentRef.current;
    if (!c || !ct) return;
    setShift(Math.max(0, ct.scrollWidth - c.clientWidth));
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      measure();
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const c = containerRef.current;
    const ct = contentRef.current;
    if (!c || !ct) return;
    const obs = new ResizeObserver(() => measure());
    measure();
    obs.observe(c);
    obs.observe(ct);
    return () => obs.disconnect();
  }, [measure, text]);

  const shouldAnimate = hovered && shift > 8;
  const style: (CSSProperties & { "--overflow-shift"?: string }) | undefined =
    shouldAnimate ? { "--overflow-shift": `-${shift}px` } : undefined;

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden whitespace-nowrap ${className}`}
      title={text}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        ref={contentRef}
        style={style}
        className={
          shouldAnimate
            ? "overflow-title-animate inline-block whitespace-nowrap"
            : "truncate"
        }
      >
        {text}
      </div>
    </div>
  );
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
  const [edgeActionPos, setEdgeActionPos] = useState<{ x: number; y: number; edgeId: number } | null>(null);
  const [showPurposeEdit, setShowPurposeEdit] = useState(false);
  const [purposeEditValue, setPurposeEditValue] = useState("");
  const [purposeEditEdgeId, setPurposeEditEdgeId] = useState<number | null>(null);
  const [editingDuty, setEditingDuty] = useState<string | null>(null);
  const [dutyValue, setDutyValue] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
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
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
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
        const acpCheckCmds = new Set<string>();
        for (const opt of agentOptions) if (opt.acpCheck) acpCheckCmds.add(opt.acpCheck);
        const [cmdResults, cfg] = await Promise.all([
          checkCommands([...acpCheckCmds]),
          getConfig(),
        ]);
        if (cancelled) return;
        setAcpAgentAvailability(cmdResults);
        setCustomAgents(cfg.acp?.custom_agents ?? []);
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
      .map((opt) => {
        if (!acpAvailabilityLoaded) return opt;
        const cmd = opt.acpCheck!;
        if (acpAgentAvailability[cmd] === false) {
          return { ...opt, disabled: true, disabledReason: `${cmd} not found` };
        }
        return opt;
      })
      .filter((opt) => !opt.disabled);
  }, [acpAgentAvailability, acpAvailabilityLoaded]);
  const [toast, setToast] = useState<{ message: string; type: "error" | "success" } | null>(null);

  const showError = useCallback((code: string, message: string) => {
    const hint = ERROR_HINTS[code] || message;
    setToast({ message: hint, type: "error" });
    setTimeout(() => setToast(null), 4000);
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
        setTimeout(() => setToast(null), 1800);
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
      const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph`);
      if (!res.ok) return;
      const raw = (await res.json()) as GraphData;
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
      const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_chat_id: null,
          agent: spawnBubble.agent,
          name: spawnBubble.name.trim(),
          duty: spawnBubble.duty.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        showError(err.code, err.error);
        return;
      }
      setSpawnBubble(null);
      refreshGraph();
      setToast({ message: "Node created", type: "success" });
      setTimeout(() => setToast(null), 2000);
    } catch (e) {
      showError("internal_error", String(e));
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
        const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph/edges`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from,
            to,
            duty: opts?.duty?.trim() || undefined,
            purpose: opts?.purpose?.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          showError(err.code, err.error);
          return false;
        }
        refreshGraph();
        setToast({ message: "Connection created", type: "success" });
        setTimeout(() => setToast(null), 2000);
        return true;
      } catch (e) {
        showError("internal_error", String(e));
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
      if (!trimmed) {
        setEditingName(null);
        return;
      }
      if (nameSaveInFlightRef.current.has(chatId)) return;
      nameSaveInFlightRef.current.add(chatId);
      try {
        await updateChatTitle(projectId, taskId, chatId, trimmed);
        setEditingName(null);
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
        const res = await fetch(
          `/api/v1/projects/${projectId}/tasks/${taskId}/graph/chats/${chatId}/duty`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ duty: duty || undefined }),
          },
        );
        if (!res.ok) {
          const err = await res.json();
          showError(err.code, err.error);
          return;
        }
        setEditingDuty(null);
        refreshGraph();
        setToast({ message: "Duty updated", type: "success" });
        setTimeout(() => setToast(null), 2000);
      } catch (e) {
        showError("internal_error", String(e));
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const handleUpdatePurpose = useCallback(
    async (edgeId: number, purpose: string) => {
      try {
        const res = await fetch(
          `/api/v1/projects/${projectId}/tasks/${taskId}/graph/edges/${edgeId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ purpose: purpose || undefined }),
          },
        );
        if (!res.ok) {
          const err = await res.json();
          showError(err.code, err.error);
          return;
        }
        setShowPurposeEdit(false);
        setEdgeActionPos(null);
        refreshGraph();
      } catch (e) {
        showError("internal_error", String(e));
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const handleDeleteEdge = useCallback(
    async (edgeId: number) => {
      if (!window.confirm("Delete this connection? Pending messages on this edge will also be cleared.")) return;
      try {
        const res = await fetch(
          `/api/v1/projects/${projectId}/tasks/${taskId}/graph/edges/${edgeId}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const err = await res.json();
          showError(err.code, err.error);
          return;
        }
        setEdgeActionPos(null);
        setSelectedEdge(null);
        refreshGraph();
        setToast({ message: "Connection deleted", type: "success" });
        setTimeout(() => setToast(null), 2000);
      } catch (e) {
        showError("internal_error", String(e));
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  const handleRemind = useCallback(
    async (edgeId: number) => {
      try {
        const res = await fetch(
          `/api/v1/projects/${projectId}/tasks/${taskId}/graph/edges/${edgeId}/remind`,
          { method: "POST" },
        );
        if (!res.ok) {
          const err = await res.json();
          showError(err.code, err.error);
          return;
        }
        refreshGraph();
        setToast({ message: "Reminder sent", type: "success" });
        setTimeout(() => setToast(null), 2000);
      } catch (e) {
        showError("internal_error", String(e));
      }
    },
    [projectId, taskId, showError, refreshGraph],
  );

  useEffect(() => {
    const fetchGraph = async () => {
      fetchSeqRef.current += 1;
      const mySeq = fetchSeqRef.current;
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as GraphData;
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

    const nodes: SimNode[] = data.nodes.map((n, index) => {
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
      });

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
      <div className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/90 p-1 shadow-sm">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Zoom out"
          onClick={() => zoomBy(0.85)}
        >
          <ZoomOut size={14} />
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Fit graph"
          onClick={fitView}
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Zoom in"
          onClick={() => zoomBy(1.18)}
        >
          <ZoomIn size={14} />
        </button>
      </div>
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
          setEdgeActionPos(null);
          setShowPurposeEdit(false);
          setEdgeBubble(null);
          setSpawnBubble(null);
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
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="28"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--color-text-muted)" />
          </marker>
          <marker
            id="arrowhead-in_flight"
            markerWidth="10"
            markerHeight="7"
            refX="28"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill={EDGE_COLORS.in_flight} />
          </marker>
          <marker
            id="arrowhead-blocked"
            markerWidth="10"
            markerHeight="7"
            refX="28"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill={EDGE_COLORS.blocked} />
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
            const mid = graphToScreen((sx + tx) / 2, (sy + ty) / 2);
            setEdgeActionPos({ x: mid.x, y: mid.y, edgeId: link.edge_id });
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
                  setTimeout(() => setToast(null), 3000);
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
                href={agentIconUrl(node.agent)}
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
                              setTimeout(() => setToast(null), 3000);
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

      {selectedNodeData && (() => {
        const simNode = nodesRef.current.find((n) => n.id === selectedNodeId);
        if (!simNode) return null;
        const sp = graphToScreen(simNode.x ?? 0, simNode.y ?? 0);
        const containerRect = containerRef.current?.getBoundingClientRect();
        const cw = containerRect?.width ?? 800;
        const ch = containerRect?.height ?? 600;
        const cardWidth = 300;
        const cardHeight = 340;
        const gap = 14;
        const margin = 8;
        // Node radius in screen px (graph radius 22 × view zoom × svg scale).
        const nodeR = 22 * view.k * sp.scale;

        const rightAvail = cw - (sp.x + nodeR) - gap - margin;
        const leftAvail = sp.x - nodeR - gap - margin;
        let left: number;
        if (rightAvail >= cardWidth) {
          left = sp.x + nodeR + gap;
        } else if (leftAvail >= cardWidth) {
          left = sp.x - nodeR - gap - cardWidth;
        } else {
          // Neither side fits: pick the side with more room and clamp inside container.
          left =
            rightAvail >= leftAvail
              ? Math.min(sp.x + nodeR + gap, cw - cardWidth - margin)
              : Math.max(sp.x - nodeR - gap - cardWidth, margin);
        }

        let top = sp.y - cardHeight / 2;
        top = Math.max(margin, Math.min(top, ch - cardHeight - margin));
        const liveCardStatus = getNodeStatus(selectedNodeData.chat_id);
        return (
          <div
            className="absolute z-30 w-[300px] rounded-[16px] border border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_88%,transparent)] backdrop-blur-xl shadow-[0_12px_40px_rgba(0,0,0,0.14)] flex flex-col overflow-hidden"
            style={{
              left,
              top,
              maxHeight: "calc(100vh - 1.5rem)",
            }}
        >
          {/* Header */}
          <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5 select-none">
            <div className="relative shrink-0">
              <img
                src={agentIconUrl(selectedNodeData.agent)}
                className="w-7 h-7"
                alt={selectedNodeData.agent}
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
              {/* Presence dot — replaces the small status pill */}
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[var(--color-bg-secondary)]"
                style={{ backgroundColor: STATUS_COLORS[liveCardStatus] || STATUS_COLORS.disconnected }}
                title={liveCardStatus}
              />
            </div>
            <div className="flex-1 min-w-0">
              {editingName === selectedNodeData.chat_id ? (
                <input
                  autoFocus
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={() => handleSaveName(selectedNodeData.chat_id, nameValue)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter") handleSaveName(selectedNodeData.chat_id, nameValue);
                    else if (e.key === "Escape") setEditingName(null);
                  }}
                  className="w-full min-w-0 border-b border-[var(--color-highlight)] bg-transparent px-0 py-0 text-sm font-medium text-[var(--color-text)] outline-none"
                />
              ) : (
                <div
                  onDoubleClick={() => {
                    setNameValue(selectedNodeData.name);
                    setEditingName(selectedNodeData.chat_id);
                  }}
                  title="Double-click to rename"
                  className="cursor-text"
                >
                  <OverflowTitle
                    text={selectedNodeData.name}
                    className="font-medium text-[var(--color-text)] text-sm"
                  />
                </div>
              )}
              <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                <span>{selectedNodeData.agent}</span>
                <span aria-hidden>·</span>
                <span style={{ color: STATUS_COLORS[liveCardStatus] || STATUS_COLORS.disconnected }}>
                  {liveCardStatus}
                </span>
              </div>
            </div>
            <button
              onClick={() => { setSelectedNodeId(null); setSelectedNode(null); }}
              className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Duty — clearer hierarchy: subtle inset card with stronger body text */}
          <div className="px-3.5 pb-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] pt-2.5">
            <label className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">Duty</label>
            {editingDuty === selectedNodeData.chat_id ? (
              <div className="mt-1.5 space-y-1.5">
                <textarea
                  className="w-full px-2.5 py-2 text-[13px] leading-snug rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-y min-h-[68px]"
                  value={dutyValue}
                  onChange={(e) => setDutyValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleUpdateDuty(selectedNodeData.chat_id, dutyValue);
                    } else if (e.key === "Escape") {
                      setEditingDuty(null);
                    }
                  }}
                  autoFocus
                  placeholder="Describe the duty for this agent..."
                />
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-[var(--color-text-muted)]">⌘/Ctrl + Enter to save · Esc to cancel</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setEditingDuty(null)}
                      className="px-2 py-1 text-[10px] rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleUpdateDuty(selectedNodeData.chat_id, dutyValue)}
                      className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="mt-1.5 px-2.5 py-2 rounded-lg bg-[color-mix(in_srgb,var(--color-bg)_85%,transparent)] border border-[color-mix(in_srgb,var(--color-border)_30%,transparent)] text-[13px] leading-snug text-[var(--color-text)] cursor-text hover:border-[color-mix(in_srgb,var(--color-highlight)_50%,transparent)] transition-colors whitespace-pre-wrap break-words"
                onClick={() => {
                  setEditingDuty(selectedNodeData.chat_id);
                  setDutyValue(selectedNodeData.duty || "");
                }}
                title="Click to edit"
              >
                {selectedNodeData.duty || (
                  <span className="text-[var(--color-text-muted)] italic">Click to set duty…</span>
                )}
              </div>
            )}
          </div>

          {/* Pending Messages */}
          {(selectedNodeData.pending_in > 0 || selectedNodeData.pending_out > 0) && (
            <div className="px-3.5 pb-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] pt-2.5">
              <div className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold mb-1.5">Pending</div>
              <div className="space-y-0.5 max-h-16 overflow-y-auto">
                {selectedNodeData.pending_messages?.map((pm, i) => (
                  <div key={i} className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1">
                    <span className="font-medium">{pm.from_name}</span>
                    <span>→</span>
                    <span className="font-medium">{pm.to_name}</span>
                    <span className="truncate">: {pm.body_excerpt}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer: direct send + open chat */}
          <div className="px-3 pt-2 pb-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
            <div className="flex items-end gap-1.5">
              <textarea
                rows={1}
                className="flex-1 min-h-[34px] max-h-32 px-2.5 py-2 text-[13px] leading-snug rounded-lg border border-[color-mix(in_srgb,var(--color-border)_45%,transparent)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none transition-all"
                placeholder={liveCardStatus === "disconnected" ? "Agent disconnected" : "Send a message…"}
                value={directMessage}
                onChange={(e) => setDirectMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && !e.shiftKey && directMessage.trim()) {
                    e.preventDefault();
                    handleDirectSend(selectedNodeData.chat_id, directMessage);
                  }
                }}
                disabled={sendingMessage || liveCardStatus === "disconnected"}
              />
              <button
                onClick={() => handleDirectSend(selectedNodeData.chat_id, directMessage)}
                disabled={sendingMessage || !directMessage.trim() || liveCardStatus === "disconnected"}
                className="h-8 w-8 flex items-center justify-center rounded-lg bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0"
                title="Send (Enter)"
              >
                {sendingMessage ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-[9px] text-[var(--color-text-muted)]">Enter to send · Shift+Enter for newline</span>
              <button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("grove:open-chat", { detail: { chatId: selectedNodeData.chat_id } }),
                  );
                }}
                className="text-[10px] text-[var(--color-highlight)] hover:underline font-medium"
              >
                Open Chat →
              </button>
            </div>
          </div>
        </div>
        );
      })()}

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

      {edgeActionPos && (() => {
        const edge = data?.edges.find((e) => e.edge_id === edgeActionPos.edgeId);
        const toNode = data?.nodes.find((n) => n.chat_id === edge?.to);
        const fromNode = data?.nodes.find((n) => n.chat_id === edge?.from);
        // Use live state, not the stale value baked into /graph at hydration.
        const liveEdgeState = edge ? deriveEdgeState(edge.from, edge.to) : "idle";
        const liveTargetStatus = edge ? getNodeStatus(edge.to) : "disconnected";
        const showRemind = liveEdgeState === "blocked" && liveTargetStatus === "idle";
        // Edge has pending iff the key exists; the value (excerpt) MAY be
        // undefined for events that don't carry a body (e.g. PendingChanged
        // delete) but `has` is the source of truth for the chip.
        const pendingKey_ = edge ? pendingKey(edge.from, edge.to) : null;
        const hasPending = pendingKey_ ? pendingPairsMap.has(pendingKey_) : false;
        const pendingExcerpt = pendingKey_ ? pendingPairsMap.get(pendingKey_) : undefined;
        const stateLabel: Record<string, string> = {
          idle: "Idle",
          in_flight: "In flight",
          blocked: "Blocked",
        };
        const stateColor = EDGE_COLORS[liveEdgeState] || EDGE_COLORS.idle;
        const containerRect = containerRef.current?.getBoundingClientRect();
        const cw = containerRect?.width ?? 800;
        const ch = containerRect?.height ?? 600;
        const popW = showPurposeEdit ? 300 : 240;
        // Rough height estimate including the new status row + optional pending block.
        const baseH = showPurposeEdit ? 124 : showRemind ? 200 : 156;
        const popH = baseH + (hasPending ? 56 : 0);
        const left = Math.max(8, Math.min(edgeActionPos.x - popW / 2, cw - popW - 8));
        const top = Math.max(8, Math.min(edgeActionPos.y + 14, ch - popH - 8));
        return (
          <div
            className="absolute z-40 rounded-xl border border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_92%,transparent)] backdrop-blur-xl shadow-[0_12px_40px_rgba(0,0,0,0.18)] overflow-hidden"
            style={{ left, top, width: popW }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pt-2 pb-1.5 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <span className="truncate font-medium text-[var(--color-text)]" title={fromNode?.name}>{fromNode?.name}</span>
                <span className="shrink-0">→</span>
                <span className="truncate font-medium text-[var(--color-text)]" title={toNode?.name}>{toNode?.name}</span>
                <span className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${stateColor} 18%, transparent)`,
                    color: stateColor,
                  }}
                  title={`Edge state: ${liveEdgeState}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stateColor }} />
                  {stateLabel[liveEdgeState] ?? liveEdgeState}
                </span>
              </div>
            </div>
            {!showPurposeEdit && hasPending && (
              <div className="px-3 pt-2 pb-2 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
                <div className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold mb-1">Pending message</div>
                <div className="text-[11px] leading-snug text-[var(--color-text)] line-clamp-3 break-words">
                  {pendingExcerpt ?? (
                    <span className="italic text-[var(--color-text-muted)]">(message body unavailable)</span>
                  )}
                </div>
              </div>
            )}
            {!showPurposeEdit ? (
              <div className="p-1.5 flex flex-col gap-0.5">
                <button
                  onClick={() => {
                    setPurposeEditEdgeId(edgeActionPos.edgeId);
                    setPurposeEditValue(edge?.purpose || "");
                    setShowPurposeEdit(true);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] rounded-md text-left hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                  <span className="flex-1">{edge?.purpose ? "Edit purpose" : "Set purpose"}</span>
                </button>
                {showRemind && (
                  <button
                    onClick={() => handleRemind(edgeActionPos.edgeId)}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] rounded-md text-left hover:bg-[var(--color-bg-tertiary)] text-[var(--color-warning)] transition-colors"
                  >
                    <Bell className="w-3.5 h-3.5" />
                    <span className="flex-1">Remind target</span>
                  </button>
                )}
                <button
                  onClick={() => handleDeleteEdge(edgeActionPos.edgeId)}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] rounded-md text-left hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] text-[var(--color-error)] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="flex-1">Delete connection</span>
                </button>
              </div>
            ) : (
              <div className="p-2.5 space-y-1.5">
                <label className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">Purpose</label>
                <textarea
                  autoFocus
                  className="w-full px-2.5 py-2 text-[13px] leading-snug rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-y min-h-[56px]"
                  value={purposeEditValue}
                  onChange={(e) => setPurposeEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && purposeEditEdgeId !== null) {
                      e.preventDefault();
                      handleUpdatePurpose(purposeEditEdgeId, purposeEditValue);
                    } else if (e.key === "Escape") setShowPurposeEdit(false);
                  }}
                  placeholder="Why this connection exists"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => setShowPurposeEdit(false)}
                    className="px-2.5 py-1 text-[11px] rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => purposeEditEdgeId !== null && handleUpdatePurpose(purposeEditEdgeId, purposeEditValue)}
                    className="px-3 py-1 text-[11px] font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {toast && (
        <div
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm ${
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