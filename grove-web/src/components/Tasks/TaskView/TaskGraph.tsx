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
              }}
              onMouseEnter={(e) =>
                showHover("edge", link, e.clientX, e.clientY)
              }
              onMouseLeave={hideHover}
            />
          );
        })}

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
                    window.dispatchEvent(new CustomEvent("grove:select-chat", { detail: { chatId: node.id } }));
                  }
                  window.removeEventListener("mousemove", onMouseMove);
                  window.removeEventListener("mouseup", onMouseUp);
                };
                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              onMouseEnter={(e) =>
                showHover("node", node, e.clientX, e.clientY)
              }
              onMouseLeave={hideHover}
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
            </g>
          );
        })}
        </g>
      </svg>

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
            return (
              <div className="text-xs space-y-1">
                <div className="font-medium text-[var(--color-text)]">
                  {srcName}{" \u2192 "}{tgtName}
                </div>
                <div className="text-[var(--color-text-muted)]">State: {link.state}</div>
                {link.purpose && (
                  <div className="text-[var(--color-text-muted)]">Purpose: {link.purpose}</div>
                )}
                {link.pending_message && (
                  <div className="border-t border-[var(--color-border)] pt-1 mt-1 space-y-0.5">
                    <div className="text-[var(--color-text-muted)]">
                      From: {link.pending_message.from_name}
                    </div>
                    <div className="text-[var(--color-text-muted)]">
                      {truncate(link.pending_message.body_excerpt, 80)}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
