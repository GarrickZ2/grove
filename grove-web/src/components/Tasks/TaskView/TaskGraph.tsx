import { useEffect, useRef, useState, useCallback } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
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
import { DialogShell } from "../../ui/DialogShell";

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

interface AgentInfo {
  id: string;
  display_name: string;
}

const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 600;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD_PX = 4;

const STATUS_COLORS: Record<string, string> = {
  busy: "var(--color-error)",
  idle: "var(--color-success)",
  permission_required: "var(--color-warning)",
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
  name_taken: "名称已被占用",
  cycle_would_form: "会形成环，无法连接",
  bidirectional_edge: "已存在反向边",
  duplicate_edge: "边已存在",
  same_task_required: "无法跨 Task 连接",
  target_not_found: "目标不存在",
  no_pending_to_remind: "没有待回复消息",
  target_is_busy: "目标正在工作中",
  duty_forbidden: "Duty 已锁定，不可修改",
  timeout: "操作超时",
  agent_spawn_failed: "Agent 启动失败",
  internal_error: "内部错误",
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

export function TaskGraph({ projectId, taskId }: TaskGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    type: "node" | "edge";
    data: unknown;
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [tick, setTick] = useState(0);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNodeData = data?.nodes.find((n) => n.chat_id === selectedNodeId) ?? null;
  const [showSpawnModal, setShowSpawnModal] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [spawnForm, setSpawnForm] = useState({ agent: "", name: "", duty: "", purpose: "" });
  const [spawnLoading, setSpawnLoading] = useState(false);
  const [dragEdge, setDragEdge] = useState<{ from: string } | null>(null);
  const [dragMousePos, setDragMousePos] = useState<{ x: number; y: number } | null>(null);
  const [showEdgeModal, setShowEdgeModal] = useState(false);
  const [edgeForm, setEdgeForm] = useState({ from: "", to: "", duty: "", purpose: "" });
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [edgeActionPos, setEdgeActionPos] = useState<{ x: number; y: number; edgeId: number } | null>(null);
  const [showPurposeEdit, setShowPurposeEdit] = useState(false);
  const [purposeEditValue, setPurposeEditValue] = useState("");
  const [purposeEditEdgeId, setPurposeEditEdgeId] = useState<number | null>(null);
  const [editingDuty, setEditingDuty] = useState<string | null>(null);
  const [dutyValue, setDutyValue] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "error" | "success" } | null>(null);
  const [directMessage, setDirectMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const showError = useCallback((code: string, message: string) => {
    const hint = ERROR_HINTS[code] || message;
    setToast({ message: hint, type: "error" });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);

  const showHover = useCallback(
    (
      type: "node" | "edge",
      itemData: unknown,
      clientX: number,
      clientY: number,
    ) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      const rect = containerRef.current?.getBoundingClientRect();
      const x = rect ? clientX - rect.left : clientX;
      const y = rect ? clientY - rect.top : clientY;
      setHover({ x, y, type, data: itemData });
    },
    [],
  );

  const hideHover = useCallback(() => {
    hoverTimer.current = setTimeout(() => setHover(null), 200);
  }, []);

  const refreshGraph = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph`);
      if (res.ok) {
        const raw = (await res.json()) as GraphData;
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
      }
    } catch (e) {
      console.error("Failed to refresh graph", e);
    }
  }, [projectId, taskId]);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/skills/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
      }
    } catch (e) {
      console.error("Failed to fetch agents", e);
    }
  }, []);

  const handleSpawn = useCallback(async () => {
    setSpawnLoading(true);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_chat_id: null,
          agent: spawnForm.agent,
          name: spawnForm.name,
          duty: spawnForm.duty || undefined,
          purpose: spawnForm.purpose || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        showError(err.code, err.error);
        return;
      }
      setShowSpawnModal(false);
      setSpawnForm({ agent: "", name: "", duty: "", purpose: "" });
      refreshGraph();
      setToast({ message: "节点创建成功", type: "success" });
      setTimeout(() => setToast(null), 2000);
    } catch (e) {
      showError("internal_error", String(e));
    } finally {
      setSpawnLoading(false);
    }
  }, [projectId, taskId, spawnForm, showError, refreshGraph]);

  const handleAddEdge = useCallback(async () => {
    setEdgeLoading(true);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph/edges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: edgeForm.from,
          to: edgeForm.to,
          duty: edgeForm.duty || undefined,
          purpose: edgeForm.purpose || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        showError(err.code, err.error);
        return;
      }
      setShowEdgeModal(false);
      refreshGraph();
      setToast({ message: "连接创建成功", type: "success" });
      setTimeout(() => setToast(null), 2000);
    } catch (e) {
      showError("internal_error", String(e));
    } finally {
      setEdgeLoading(false);
    }
  }, [projectId, taskId, edgeForm, showError, refreshGraph]);

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
        setToast({ message: "Duty 已更新", type: "success" });
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
      if (!window.confirm("确定删除此连接？该边上的 pending message 也会被清除。")) return;
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
        setToast({ message: "连接已删除", type: "success" });
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
        hideHover();
        refreshGraph();
        setToast({ message: "已发送提醒", type: "success" });
        setTimeout(() => setToast(null), 2000);
      } catch (e) {
        showError("internal_error", String(e));
      }
    },
    [projectId, taskId, showError, refreshGraph, hideHover],
  );

  const handleDirectMessage = useCallback(
    async (chatId: string, text: string) => {
      setSendingMessage(true);
      try {
        setToast({ message: "直接发消息功能需要后端支持", type: "error" });
        setTimeout(() => setToast(null), 3000);
        void chatId;
        void text;
      } catch (e) {
        showError("internal_error", String(e));
      } finally {
        setSendingMessage(false);
        setDirectMessage("");
      }
    },
    [showError],
  );

  useEffect(() => {
    const fetchGraph = async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as GraphData;
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

  const clientDeltaToGraph = useCallback(
    (dx: number, dy: number) => {
      const width = svgRef.current?.clientWidth ?? VIEWBOX_WIDTH;
      const height = svgRef.current?.clientHeight ?? VIEWBOX_HEIGHT;
      return {
        dx: (dx * VIEWBOX_WIDTH) / width / view.k,
        dy: (dy * VIEWBOX_HEIGHT) / height / view.k,
      };
    },
    [view.k],
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

  const pointFromMouseEvent = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: VIEWBOX_WIDTH / 2, y: VIEWBOX_HEIGHT / 2 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * VIEWBOX_HEIGHT,
    };
  }, []);

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

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-[var(--color-bg)]">
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
        style={{ cursor: panRef.current ? "grabbing" : "grab" }}
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

          const onMouseMove = (ev: MouseEvent) => {
            const pan = panRef.current;
            if (!pan) return;
            const width = svgRef.current?.clientWidth ?? VIEWBOX_WIDTH;
            const height = svgRef.current?.clientHeight ?? VIEWBOX_HEIGHT;
            setView((current) => ({
              ...current,
              x: pan.viewX + ((ev.clientX - pan.x) * VIEWBOX_WIDTH) / width,
              y: pan.viewY + ((ev.clientY - pan.y) * VIEWBOX_HEIGHT) / height,
            }));
          };

          const onMouseUp = () => {
            panRef.current = null;
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
          };

          window.addEventListener("mousemove", onMouseMove);
          window.addEventListener("mouseup", onMouseUp);
        }}
        onClick={() => {
          setSelectedNode(null);
          setSelectedEdge(null);
          setSelectedNodeId(null);
          setEdgeActionPos(null);
          setShowPurposeEdit(false);
        }}
        onDoubleClick={(e) => {
          if ((e.target as SVGElement).tagName === "svg") {
            setShowSpawnModal(true);
            fetchAgents();
          }
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
          const src = getNode(
            typeof link.source === "string" ? link.source : link.source.id,
          );
          const tgt = getNode(
            typeof link.target === "string" ? link.target : link.target.id,
          );
          const sx = src.x ?? 0;
          const sy = src.y ?? 0;
          const tx = tgt.x ?? 0;
          const ty = tgt.y ?? 0;
          const isSelected = selectedEdge === link.edge_id;
          const color = EDGE_COLORS[link.state] || EDGE_COLORS.idle;
          const markerId =
            link.state === "in_flight"
              ? "url(#arrowhead-in_flight)"
              : link.state === "blocked"
                ? "url(#arrowhead-blocked)"
                : "url(#arrowhead)";

          return (
            <line
              key={`edge-${link.edge_id}`}
              x1={sx}
              y1={sy}
              x2={tx}
              y2={ty}
              stroke={color}
              strokeWidth={isSelected ? 3 / view.k : 1.5 / view.k}
              markerEnd={markerId}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedEdge(link.edge_id);
                setSelectedNode(null);
                setSelectedNodeId(null);
                const rect = containerRef.current?.getBoundingClientRect();
                if (rect) {
                  const midX = ((sx + tx) / 2 / VIEWBOX_WIDTH) * rect.width * view.k + view.x + rect.left - rect.left;
                  const midY = ((sy + ty) / 2 / VIEWBOX_HEIGHT) * rect.height * view.k + view.y + rect.top - rect.top;
                  setEdgeActionPos({ x: midX, y: midY, edgeId: link.edge_id });
                }
              }}
              onMouseEnter={(e) =>
                showHover("edge", link, e.clientX, e.clientY)
              }
              onMouseLeave={hideHover}
            />
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

          {nodes.map((node) => {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const isSelected = selectedNode === node.id;
          const color = STATUS_COLORS[node.status] || STATUS_COLORS.disconnected;

          return (
            <g
              key={node.id}
              transform={`translate(${x}, ${y})`}
              style={{ cursor: "grab" }}
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
                const onMouseUp = () => {
                  handleNodeDragEnd(node.id, didDrag);
                  if (!didDrag) {
                    setSelectedNode(node.id);
                    setSelectedEdge(null);
                    setSelectedNodeId(node.id);
                    window.dispatchEvent(new CustomEvent("grove:select-chat", { detail: { chatId: node.id } }));
                  }
                  window.removeEventListener("mousemove", onMouseMove);
                  window.removeEventListener("mouseup", onMouseUp);
                };
                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
              }}
              onMouseUp={() => {
                if (dragEdge && dragEdge.from !== node.id) {
                  const toNode = data?.nodes.find((n) => n.chat_id === node.id);
                  setEdgeForm({
                    from: dragEdge.from,
                    to: node.id,
                    duty: toNode?.duty ? "" : "",
                    purpose: "",
                  });
                  setShowEdgeModal(true);
                  setDragEdge(null);
                  setDragMousePos(null);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              onMouseEnter={(e) => {
                showHover("node", node, e.clientX, e.clientY);
                setHoveredNodeId(node.id);
              }}
              onMouseLeave={() => {
                hideHover();
                setHoveredNodeId(null);
              }}
            >
              {isSelected && (
                <circle r="26" fill="none" stroke="var(--color-highlight)" strokeWidth="2" />
              )}
              <circle
                r="22"
                fill="var(--color-bg-secondary)"
                stroke={color}
                strokeWidth={2}
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
              <text
                y="34"
                textAnchor="middle"
                fill="var(--color-text)"
                fontSize="9"
                fontWeight="500"
              >
                {truncate(node.name, 16)}
              </text>
              <circle
                cx="22"
                cy="0"
                r="4"
                fill="var(--color-highlight)"
                opacity={hoveredNodeId === node.id ? 0.7 : 0}
                style={{ cursor: "crosshair", transition: "opacity 0.15s" }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setDragEdge({ from: node.id });
                  const onMove = (ev: MouseEvent) => {
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (rect) {
                      setDragMousePos({
                        x: ((ev.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH / view.k - view.x / view.k,
                        y: ((ev.clientY - rect.top) / rect.height) * VIEWBOX_HEIGHT / view.k - view.y / view.k,
                      });
                    }
                  };
                  const onUp = () => {
                    setDragEdge(null);
                    setDragMousePos(null);
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              />
            </g>
          );
        })}
        </g>
      </svg>

      {selectedNodeData && (
        <div className="absolute right-0 top-0 bottom-0 w-1/3 min-w-[320px] max-w-[420px] bg-[var(--color-bg)] border-l border-[var(--color-border)] z-30 flex flex-col shadow-lg">
          <div className="flex items-center gap-3 p-4 border-b border-[var(--color-border)]">
            <img
              src={agentIconUrl(selectedNodeData.agent)}
              className="w-8 h-8"
              alt={selectedNodeData.agent}
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <div className="flex-1">
              <div className="font-medium text-[var(--color-text)]">{selectedNodeData.name}</div>
              <div className="text-xs text-[var(--color-text-muted)]">{selectedNodeData.agent}</div>
            </div>
            <span
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: (STATUS_COLORS[selectedNodeData.status] || STATUS_COLORS.disconnected) + "22",
                color: STATUS_COLORS[selectedNodeData.status] || STATUS_COLORS.disconnected,
              }}
            >
              {selectedNodeData.status}
            </span>
          </div>

          <div className="p-4 space-y-3 border-b border-[var(--color-border)]">
            <div>
              <label className="text-xs text-[var(--color-text-muted)]">Duty</label>
              {editingDuty === selectedNodeData.chat_id ? (
                <div className="flex gap-1 mt-1">
                  <input
                    className="flex-1 px-2 py-1 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                    value={dutyValue}
                    onChange={(e) => setDutyValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleUpdateDuty(selectedNodeData.chat_id, dutyValue);
                      }
                      if (e.key === "Escape") {
                        setEditingDuty(null);
                      }
                    }}
                    autoFocus
                  />
                  <button
                    onClick={() => handleUpdateDuty(selectedNodeData.chat_id, dutyValue)}
                    className="px-2 py-1 text-xs rounded bg-[var(--color-highlight)] text-white"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditingDuty(null)}
                    className="px-2 py-1 text-xs rounded border border-[var(--color-border)]"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div
                  className="text-sm text-[var(--color-text)] mt-1 cursor-pointer hover:text-[var(--color-highlight)]"
                  onClick={() => {
                    setEditingDuty(selectedNodeData.chat_id);
                    setDutyValue(selectedNodeData.duty || "");
                  }}
                >
                  {selectedNodeData.duty || (
                    <span className="text-[var(--color-text-muted)] italic">点击设置 duty</span>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-muted)]">Chat ID</label>
              <div className="text-xs font-mono text-[var(--color-text-muted)] mt-1">
                {selectedNodeData.chat_id}
              </div>
            </div>
          </div>

          {(selectedNodeData.pending_in > 0 || selectedNodeData.pending_out > 0) && (
            <div className="p-4 border-b border-[var(--color-border)]">
              <div className="text-xs font-medium text-[var(--color-text)] mb-2">Pending Messages</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {selectedNodeData.pending_messages?.map((pm, i) => (
                  <div key={i} className="text-xs text-[var(--color-text-muted)] flex items-center gap-1">
                    <span>{pm.from_name}</span>
                    <span>→</span>
                    <span>{pm.to_name}</span>
                    <span className="truncate">: {pm.body_excerpt}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="p-3 border-b border-[var(--color-border)]">
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                placeholder="直接发消息..."
                value={directMessage}
                onChange={(e) => setDirectMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && directMessage.trim()) {
                    handleDirectMessage(selectedNodeData.chat_id, directMessage);
                  }
                }}
              />
              <button
                onClick={() => {
                  if (directMessage.trim()) {
                    handleDirectMessage(selectedNodeData.chat_id, directMessage);
                  }
                }}
                disabled={sendingMessage || !directMessage.trim()}
                className="px-3 py-2 text-sm rounded bg-[var(--color-highlight)] text-white disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>

          <div className="p-3">
            <button
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("grove:select-chat", { detail: { chatId: selectedNodeData.chat_id } }),
                );
              }}
              className="w-full px-3 py-2 text-sm rounded border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
            >
              进入 Chat 页
            </button>
          </div>

          <button
            onClick={() => setSelectedNodeId(null)}
            className="absolute top-2 right-2 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
      )}

      {showSpawnModal && (
        <DialogShell isOpen={showSpawnModal} onClose={() => setShowSpawnModal(false)}>
          <div className="p-6">
            <h3 className="text-lg font-medium text-[var(--color-text)] mb-4">Spawn 新节点</h3>

            <div className="mb-4">
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Agent</label>
              <select
                className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                value={spawnForm.agent}
                onChange={(e) => setSpawnForm({ ...spawnForm, agent: e.target.value })}
              >
                <option value="">选择 Agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">名称 *</label>
              <input
                className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                value={spawnForm.name}
                onChange={(e) => setSpawnForm({ ...spawnForm, name: e.target.value })}
                placeholder="任务内唯一"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Duty（可选）</label>
              <input
                className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                value={spawnForm.duty}
                onChange={(e) => setSpawnForm({ ...spawnForm, duty: e.target.value })}
                placeholder="留空则 AI 首次 send 时设置"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Purpose（可选）</label>
              <input
                className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                value={spawnForm.purpose}
                onChange={(e) => setSpawnForm({ ...spawnForm, purpose: e.target.value })}
                placeholder="连边描述"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowSpawnModal(false)}
                className="px-4 py-2 text-sm rounded border border-[var(--color-border)]"
              >
                取消
              </button>
              <button
                onClick={handleSpawn}
                disabled={spawnLoading || !spawnForm.agent || !spawnForm.name}
                className="px-4 py-2 text-sm rounded bg-[var(--color-highlight)] text-white disabled:opacity-50"
              >
                {spawnLoading ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </DialogShell>
      )}

      {showEdgeModal && (() => {
        const fromNode = data?.nodes.find((n) => n.chat_id === edgeForm.from);
        const toNode = data?.nodes.find((n) => n.chat_id === edgeForm.to);
        const toHasDuty = !!toNode?.duty;
        return (
          <DialogShell isOpen={showEdgeModal} onClose={() => setShowEdgeModal(false)}>
            <div className="p-6">
              <h3 className="text-lg font-medium text-[var(--color-text)] mb-4">创建连接</h3>
              <div className="text-sm text-[var(--color-text-muted)] mb-4">
                {fromNode?.name} → {toNode?.name}
              </div>
              {!toHasDuty && (
                <div className="mb-4">
                  <label className="block text-sm text-[var(--color-text-muted)] mb-1">Duty *</label>
                  <input
                    className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                    value={edgeForm.duty}
                    onChange={(e) => setEdgeForm({ ...edgeForm, duty: e.target.value })}
                    placeholder="目标节点尚无 duty，必须设置"
                  />
                </div>
              )}
              <div className="mb-4">
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">Purpose（可选）</label>
                <input
                  className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                  value={edgeForm.purpose}
                  onChange={(e) => setEdgeForm({ ...edgeForm, purpose: e.target.value })}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowEdgeModal(false)}
                  className="px-4 py-2 text-sm rounded border border-[var(--color-border)]"
                >
                  取消
                </button>
                <button
                  onClick={handleAddEdge}
                  disabled={edgeLoading || (!toHasDuty && !edgeForm.duty)}
                  className="px-4 py-2 text-sm rounded bg-[var(--color-highlight)] text-white disabled:opacity-50"
                >
                  {edgeLoading ? "创建中..." : "创建"}
                </button>
              </div>
            </div>
          </DialogShell>
        );
      })()}

      {edgeActionPos && (() => {
        const edge = data?.edges.find((e) => e.edge_id === edgeActionPos.edgeId);
        return (
          <div
            className="absolute z-40 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg p-2"
            style={{ left: edgeActionPos.x, top: edgeActionPos.y }}
          >
            {!showPurposeEdit ? (
              <div className="flex flex-col gap-1">
                <button
                  onClick={() => {
                    setPurposeEditEdgeId(edgeActionPos.edgeId);
                    setPurposeEditValue(edge?.purpose || "");
                    setShowPurposeEdit(true);
                  }}
                  className="px-3 py-1.5 text-sm rounded text-left hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
                >
                  编辑 purpose
                </button>
                <button
                  onClick={() => handleDeleteEdge(edgeActionPos.edgeId)}
                  className="px-3 py-1.5 text-sm rounded text-left hover:bg-[var(--color-bg-tertiary)] text-[var(--color-error)]"
                >
                  删除
                </button>
              </div>
            ) : (
              <div className="flex gap-1">
                <input
                  className="flex-1 px-2 py-1 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
                  value={purposeEditValue}
                  onChange={(e) => setPurposeEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && purposeEditEdgeId !== null) {
                      handleUpdatePurpose(purposeEditEdgeId, purposeEditValue);
                    }
                  }}
                  autoFocus
                />
                <button
                  onClick={() => purposeEditEdgeId !== null && handleUpdatePurpose(purposeEditEdgeId, purposeEditValue)}
                  className="px-2 py-1 text-xs rounded bg-[var(--color-highlight)] text-white"
                >
                  保存
                </button>
                <button
                  onClick={() => setShowPurposeEdit(false)}
                  className="px-2 py-1 text-xs rounded border border-[var(--color-border)]"
                >
                  取消
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {hover && (
        <div
          className="absolute pointer-events-none z-50 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
          style={{
            left: hover.x + 12,
            top: hover.y + 12,
            maxWidth: 280,
          }}
        >
          {hover.type === "node" && (() => {
            const node = hover.data as SimNode;
            return (
              <div className="text-xs space-y-1">
                <div className="font-medium text-[var(--color-text)]">{node.name}</div>
                <div className="text-[var(--color-text-muted)]">Agent: {node.agent}</div>
                <div className="text-[var(--color-text-muted)]">Status: {node.status}</div>
                {node.duty && (
                  <div className="text-[var(--color-text-muted)]">Duty: {node.duty}</div>
                )}
                {(node.pending_in > 0 || node.pending_out > 0) && (
                  <div className="text-[var(--color-text-muted)] border-t border-[var(--color-border)] pt-1 mt-1">
                    {node.pending_in > 0 && <div>Pending in: {node.pending_in}</div>}
                    {node.pending_out > 0 && <div>Pending out: {node.pending_out}</div>}
                  </div>
                )}
                {node.pending_messages.length > 0 && (
                  <div className="border-t border-[var(--color-border)] pt-1 mt-1 space-y-0.5">
                    {node.pending_messages.map((pm, i) => (
                      <div key={i} className="text-[var(--color-text-muted)]">
                        {pm.from_name}{"\u2192"}{pm.to_name}: {truncate(pm.body_excerpt, 50)}
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[var(--color-text-muted)] font-mono">{node.id}</div>
              </div>
            );
          })()}
          {hover.type === "edge" && (() => {
            const link = hover.data as SimLink;
            const srcName = typeof link.source === "string" ? link.source : link.source.name;
            const tgtName = typeof link.target === "string" ? link.target : link.target.name;
            const tgtNode = nodes.find((n) => n.id === (typeof link.target === "string" ? link.target : link.target.id));
            const showRemind = link.state === "blocked" && tgtNode?.status === "idle";

            return (
              <div className="text-xs space-y-1">
                <div className="font-medium text-[var(--color-text)]">{srcName}{" \u2192 "}{tgtName}</div>
                <div className="text-[var(--color-text-muted)]">State: {link.state}</div>
                {link.purpose && <div className="text-[var(--color-text-muted)]">Purpose: {link.purpose}</div>}
                {link.pending_message && (
                  <div className="border-t border-[var(--color-border)] pt-1 mt-1 space-y-0.5">
                    <div className="text-[var(--color-text-muted)]">From: {link.pending_message.from_name}</div>
                    <div className="text-[var(--color-text-muted)]">{truncate(link.pending_message.body_excerpt, 80)}</div>
                  </div>
                )}
                {showRemind && (
                  <div className="border-t border-[var(--color-border)] pt-1 mt-1">
                    <button
                      className="pointer-events-auto px-2 py-1 text-xs rounded bg-[var(--color-warning)] text-white hover:opacity-90"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemind(link.edge_id);
                      }}
                    >
                      ⏰ Remind
                    </button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

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