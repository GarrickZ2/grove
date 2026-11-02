import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { NodeStatus } from "../../../api/walkieTalkie";
import type { GraphEdge, GraphNode } from "../../../components/Tasks/TaskView/graphShared";
import type { EdgeLiveState } from "../../../components/Tasks/TaskView/useTaskGraphModel";
import { agentColor } from "../../../components/Stats/agentColors";
import { resolveAgentIcon } from "../../../utils/agentIcon";
import { StatusDot } from "../../ui";
import {
  NODE_H,
  NODE_W,
  edgeGeometry,
  fitView,
  bestLayout,
  statusMeta,
  zoomAround,
  type View,
} from "./graphLayout";

export type GraphSelection = { kind: "node"; id: string } | { kind: "edge"; id: number } | null;

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  getNodeStatus: (chatId: string) => NodeStatus;
  deriveEdgeState: (from: string, to: string) => EdgeLiveState;
  /** Messages waiting for each chat (live, from PendingChanged). */
  queuedFor: (chatId: string) => number;
  selection: GraphSelection;
  onSelect: (selection: GraphSelection) => void;
  onOpenChat: (chatId: string) => void;
  /** Double-click on empty canvas. */
  onCanvasDoubleClick: () => void;
  /** Bump to fit the graph to the view again (e.g. from a header button). */
  fitNonce?: number;
  /** The fit button lives elsewhere (the panel header); keep the cluster to zoom. */
  hideFitButton?: boolean;
}

const DRAG_THRESHOLD_PX = 4;
/** Height reserved at the top of the canvas for the zoom cluster. */
const ZOOM_INSET = 30;

function shiftDown(view: View, dy: number): View {
  return { ...view, y: view.y + dy };
}
const NODE_SPRING = { type: "spring", stiffness: 360, damping: 34, mass: 0.9 } as const;

/** Pan/zoom viewport over the layered agent DAG. */
export function GraphCanvas(props: GraphCanvasProps) {
  const { nodes, edges, getNodeStatus, deriveEdgeState, queuedFor, selection, onSelect, onOpenChat, onCanvasDoubleClick, fitNonce = 0, hideFitButton = false } = props;
  const reduceMotion = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) => (prev && prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ids = useMemo(() => nodes.map((n) => n.chat_id), [nodes]);
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const { direction, layout } = useMemo(
    () => bestLayout(ids, edges.map((e) => ({ from: e.from, to: e.to })), w || 400, h || 400),
    [ids, edges, w, h],
  );

  // The view follows the fit until the user pans or zooms; a topology or
  // direction change fits again.
  const fitKey = `${fitNonce}|${direction}|${ids.join(",")}|${edges.map((e) => `${e.from}>${e.to}`).join(",")}`;
  const [manual, setManual] = useState<{ key: string; view: View } | null>(null);
  // Fit below the zoom cluster so the top layer never sits under it.
  const fitted = size ? shiftDown(fitView(layout.bounds, size.w, size.h - ZOOM_INSET), ZOOM_INSET) : { x: 0, y: 0, k: 1 };
  const view = manual && manual.key === fitKey ? manual.view : fitted;
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  const setView = (next: View) => setManual({ key: fitKey, view: next });
  const fitKeyRef = useRef(fitKey);
  useEffect(() => {
    fitKeyRef.current = fitKey;
  });

  // Wheel: pinch / ⌘-scroll zooms around the cursor, plain scroll pans.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      const rect = el.getBoundingClientRect();
      const next = event.ctrlKey || event.metaKey
        ? zoomAround(current, Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top })
        : { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY };
      setManual({ key: fitKeyRef.current, view: next });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const panRef = useRef<{ id: number; x: number; y: number; view: View; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-graph-hit]")) return;
    panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.id !== event.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      pan.moved = true;
      setPanning(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    setView({ ...pan.view, x: pan.view.x + dx, y: pan.view.y + dy });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.id !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    // A click on empty canvas clears the selection; a pan doesn't.
    if (!pan.moved) onSelect(null);
  };

  const zoomBy = (factor: number) => {
    if (!size) return;
    setView(zoomAround(view, factor, { x: size.w / 2, y: size.h / 2 }));
  };

  const selectedNode = selection?.kind === "node" ? selection.id : null;
  const selectedEdge = selection?.kind === "edge" ? selection.id : null;
  const focusEdge = selectedEdge != null ? edges.find((e) => e.edge_id === selectedEdge) ?? null : null;
  // With a node or edge selected, everything not touching it steps back.
  const touches = (id: string) =>
    selectedNode ? id === selectedNode || edges.some((e) => (e.from === selectedNode && e.to === id) || (e.to === selectedNode && e.from === id))
      : focusEdge ? id === focusEdge.from || id === focusEdge.to
        : true;

  return (
    <div
      ref={viewportRef}
      className={`ogr-canvas${panning ? " is-panning" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { panRef.current = null; setPanning(false); }}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest("[data-graph-hit]")) return;
        onCanvasDoubleClick();
      }}
    >
      <div
        className="ogr-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="ogr-edges" width="1" height="1" aria-hidden="true">
          <defs>
            {(["idle", "in_flight", "blocked"] as const).map((state) => (
              <marker key={state} id={`ogr-arrow-${state}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" className={`ogr-arrow is-${state}`} />
              </marker>
            ))}
          </defs>
          {edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const { d } = edgeGeometry(from, to, direction);
            const state = deriveEdgeState(edge.from, edge.to);
            const selected = selectedEdge === edge.edge_id;
            const dim = selection !== null && !selected && !(selectedNode && (edge.from === selectedNode || edge.to === selectedNode));
            return (
              <g key={edge.edge_id} className={`ogr-edge is-${state}${selected ? " is-sel" : ""}${dim ? " is-dim" : ""}`}>
                <motion.path
                  className="ogr-edge-line"
                  initial={false}
                  animate={{ d }}
                  transition={NODE_SPRING}
                  markerEnd={`url(#ogr-arrow-${state})`}
                />
                {state === "in_flight" && !reduceMotion ? (
                  // A message travelling along the edge — only while one is actually being delivered.
                  <circle className="ogr-pulse" r="3.5">
                    <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
                  </circle>
                ) : null}
                <path
                  className="ogr-edge-hit"
                  d={d}
                  data-graph-hit=""
                  onClick={(event) => { event.stopPropagation(); onSelect({ kind: "edge", id: edge.edge_id }); }}
                >
                  <title>{edgeTitle(edge, nodes)}</title>
                </path>
              </g>
            );
          })}
        </svg>

        {edges.map((edge) => {
          const purpose = edge.purpose?.trim();
          const from = layout.positions.get(edge.from);
          const to = layout.positions.get(edge.to);
          if (!purpose || !from || !to) return null;
          const { mid } = edgeGeometry(from, to, direction);
          const selected = selectedEdge === edge.edge_id;
          return (
            <motion.button
              key={`label-${edge.edge_id}`}
              type="button"
              data-graph-hit=""
              className={`ogr-elabel${selected ? " is-sel" : ""}${selection !== null && !selected && !(selectedNode && (edge.from === selectedNode || edge.to === selectedNode)) ? " is-dim" : ""}`}
              initial={false}
              animate={{ x: mid.x, y: mid.y }}
              transition={NODE_SPRING}
              title={purpose}
              onClick={(event) => { event.stopPropagation(); onSelect({ kind: "edge", id: edge.edge_id }); }}
            >
              <span>{purpose}</span>
            </motion.button>
          );
        })}

        {nodes.map((node, index) => {
          const p = layout.positions.get(node.chat_id);
          if (!p) return null;
          const status = getNodeStatus(node.chat_id);
          const meta = statusMeta(status);
          const agent = resolveAgentIcon(node.agent);
          const Icon = agent.Component;
          const queued = queuedFor(node.chat_id);
          const selected = selectedNode === node.chat_id;
          return (
            <motion.button
              key={node.chat_id}
              type="button"
              data-graph-hit=""
              data-graph-node={node.chat_id}
              className={`ogr-node is-${status}${selected ? " is-sel" : ""}${touches(node.chat_id) ? "" : " is-dim"}`}
              style={{ width: NODE_W, height: NODE_H, "--ogr-agent": agentColor(node.agent) } as CSSProperties}
              initial={{ x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, opacity: 0, scale: 0.86 }}
              animate={{ x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, opacity: 1, scale: 1 }}
              transition={{ ...NODE_SPRING, opacity: { duration: 0.24, delay: Math.min(index, 8) * 0.04 }, scale: { ...NODE_SPRING, delay: Math.min(index, 8) * 0.04 } }}
              aria-pressed={selected}
              aria-label={`${node.name}, ${agent.label}, ${meta.label}${queued ? `, ${queued} queued` : ""}`}
              onClick={(event) => { event.stopPropagation(); onSelect(selected ? null : { kind: "node", id: node.chat_id }); }}
              onDoubleClick={(event) => { event.stopPropagation(); onOpenChat(node.chat_id); }}
            >
              <span className="ogr-tile is-md" aria-hidden="true">
                <Icon size={16} />
                <StatusDot className="ogr-node-dot" tone={meta.tone} pulse={meta.pulse && !reduceMotion} />
              </span>
              <span className="ogr-node-copy">
                <b className="oui-truncate">{node.name}</b>
                <small className="oui-truncate">{agent.label} · {meta.label}</small>
              </span>
              {queued > 0 ? <span className="ogr-node-q oui-tnum" title={`${queued} queued ${queued === 1 ? "message" : "messages"}`}>{queued}</span> : null}
            </motion.button>
          );
        })}
      </div>

      <div className="ogr-zoom" data-graph-hit="" onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out"><Minus /></button>
        <span className="oui-tnum">{Math.round(view.k * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in"><Plus /></button>
        {hideFitButton ? null : (
          <>
            <i aria-hidden="true" />
            <button type="button" onClick={() => setManual(null)} aria-label="Fit graph to view" title="Fit to view" disabled={!manual || manual.key !== fitKey}><Maximize2 /></button>
          </>
        )}
      </div>
    </div>
  );
}

function edgeTitle(edge: GraphEdge, nodes: GraphNode[]): string {
  const name = (id: string) => nodes.find((n) => n.chat_id === id)?.name ?? id;
  return `${name(edge.from)} → ${name(edge.to)}${edge.purpose ? ` · ${edge.purpose}` : ""}`;
}
