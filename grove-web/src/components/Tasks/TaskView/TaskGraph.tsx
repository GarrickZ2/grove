import { useEffect, useRef, useState, useCallback } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCenter } from "d3-force";
import type { Simulation, SimulationNodeDatum } from "d3-force";

interface GraphNode {
  chat_id: string;
  name: string;
  agent: string;
  duty?: string;
  status: string;
}

interface GraphEdge {
  edge_id: number;
  from: string;
  to: string;
  purpose?: string;
  state: string;
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
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  state: string;
  purpose?: string;
  edge_id: number;
}

interface TaskGraphProps {
  projectId: string;
  taskId: string;
}

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

function agentIconUrl(agent: string): string {
  const lower = agent.toLowerCase();
  return `/agent-icon/${lower}-color.svg`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}

export function TaskGraph({ projectId, taskId }: TaskGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
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
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const fetchGraph = async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/tasks/${taskId}/graph`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GraphData;
        setData(json);
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

    const nodes: SimNode[] = data.nodes.map((n) => ({
      id: n.chat_id,
      name: n.name,
      agent: n.agent,
      duty: n.duty,
      status: n.status,
      x: undefined,
      y: undefined,
      fx: undefined,
      fy: undefined,
    }));

    const links: SimLink[] = data.edges.map((e) => ({
      source: e.from,
      target: e.to,
      state: e.state,
      purpose: e.purpose,
      edge_id: e.edge_id,
    }));

    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation<SimNode>(nodes)
      .force("charge", forceManyBody().strength(-300))
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(120),
      )
      .force("center", forceCenter(400, 300))
      .on("tick", () => {
        setTick((t) => t + 1);
      });

    simRef.current = sim;

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [data]);

  const handleNodeDragStart = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node || !simRef.current) return;
      node.fx = node.x;
      node.fy = node.y;
      simRef.current.alpha(0.3).restart();
    },
    [],
  );

  const handleNodeDrag = useCallback(
    (nodeId: string, dx: number, dy: number) => {
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node || !simRef.current) return;
      node.fx = (node.fx ?? node.x ?? 0) + dx;
      node.fy = (node.fy ?? node.y ?? 0) + dy;
      simRef.current.alpha(0.3).restart();
    },
    [],
  );

  const handleNodeDragEnd = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return;
    node.fx = undefined;
    node.fy = undefined;
  }, []);

  const showHover = useCallback(
    (
      type: "node" | "edge",
      itemData: unknown,
      clientX: number,
      clientY: number,
    ) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      setHover({ x: clientX, y: clientY, type, data: itemData });
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
    <div className="relative w-full h-full overflow-hidden bg-[var(--color-bg)]">
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid meet"
        data-tick={tick}
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
              strokeWidth={isSelected ? 3 : 1.5}
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
                handleNodeDragStart(node.id);

                const onMouseMove = (ev: MouseEvent) => {
                  const dx =
                    ((ev.clientX - startX) * 800) /
                    (svgRef.current?.clientWidth ?? 800);
                  const dy =
                    ((ev.clientY - startY) * 600) /
                    (svgRef.current?.clientHeight ?? 600);
                  handleNodeDrag(node.id, dx, dy);
                };
                const onMouseUp = () => {
                  handleNodeDragEnd(node.id);
                  window.removeEventListener("mousemove", onMouseMove);
                  window.removeEventListener("mouseup", onMouseUp);
                };
                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedNode(node.id);
                setSelectedEdge(null);
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
                fontSize="11"
                fontWeight="500"
              >
                {truncate(node.name, 16)}
              </text>
            </g>
          );
        })}
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
                <div className="text-[var(--color-text-muted)] font-mono">{node.id}</div>
              </div>
            );
          })()}
          {hover.type === "edge" && (() => {
            const link = hover.data as SimLink;
            return (
              <div className="text-xs space-y-1">
                <div className="font-medium text-[var(--color-text)]">
                  {typeof link.source === "string" ? link.source : link.source.id}
                  {" \u2192 "}
                  {typeof link.target === "string" ? link.target : link.target.id}
                </div>
                <div className="text-[var(--color-text-muted)]">State: {link.state}</div>
                {link.purpose && (
                  <div className="text-[var(--color-text-muted)]">Purpose: {link.purpose}</div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
