import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "framer-motion";
import { Check, Maximize2, Minus, Plus } from "lucide-react";
import type { GraphEdge, GraphNode } from "../../../components/Tasks/TaskView/graphShared";
import type { EdgeLiveState, EdgeValidity } from "../../../components/Tasks/TaskView/useTaskGraphModel";
import { agentColor } from "../../../components/Stats/agentColors";
import { resolveAgentIcon } from "../../../utils/agentIcon";
import {
  DENSE_COUNT,
  METRICS,
  boundsOf,
  chooseLayout,
  edgeGeometry,
  fitView,
  keepsLabel,
  layoutGraph,
  showsEdgeLabel,
  statusMeta,
  statusRing,
  type GraphNodeStatus,
  zoomAround,
  type Point,
  type View,
} from "./graphLayout";

export type GraphSelection = { kind: "node"; id: string } | { kind: "edge"; id: number } | null;

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Displayed status: live status, or the settled error / done outcome once idle. */
  getNodeStatus: (chatId: string) => GraphNodeStatus;
  deriveEdgeState: (from: string, to: string) => EdgeLiveState;
  /** Messages waiting for each chat (live, from PendingChanged). */
  queuedFor: (chatId: string) => number;
  checkEdge: (from: string, to: string) => EdgeValidity;
  selection: GraphSelection;
  /** Edge pick or clear (empty-canvas click). */
  onSelect: (selection: GraphSelection) => void;
  /** Click on a card: select it and switch the chat to it (legacy behaviour). */
  onPickNode: (chatId: string) => void;
  /** Double-click on a card. */
  onEditNode: (chatId: string) => void;
  /** The agent's hover "+". */
  onSpawnFrom: (chatId: string) => void;
  /** A connect drag released on another card; `anchor` is the target's center in canvas pixels. */
  onConnectDrop: (from: string, to: string, anchor: Point) => void;
  /** Double-click on empty canvas. */
  onCanvasDoubleClick: () => void;
  /** A connection waiting for its inline prompt, drawn dashed. */
  pendingLink?: { from: string; to: string } | null;
  /** Bump to fit the graph to the view again (e.g. from a header button). */
  fitNonce?: number;
  /** Bump to drop the user's arrangement and lay the graph out again. */
  tidyNonce?: number;
  /** The fit button lives elsewhere (the panel header); keep the cluster to zoom. */
  hideFitButton?: boolean;
}

const DRAG_THRESHOLD_PX = 4;
/** Height reserved at the top of the canvas for the zoom cluster. */
const ZOOM_INSET = 30;
/** Height kept clear at the bottom for the action bar and the hint. */
const BAR_INSET = 44;
const NODE_SPRING = { type: "spring", stiffness: 360, damping: 34, mass: 0.9 } as const;
const INSTANT = { duration: 0 } as const;

type Gesture =
  | { kind: "pan"; pointer: number; x: number; y: number; view: View; moved: boolean }
  | { kind: "node"; pointer: number; chat: string; x: number; y: number; origin: Point; moved: boolean }
  | { kind: "link"; pointer: number; from: string };

interface LinkDrag {
  from: string;
  to: Point;
  hover: { id: string; ok: boolean; reason?: string } | null;
}

/** Agents placed by hand. Valid only for the tidy generation it was made in. */
interface Arrangement {
  tidy: number;
  /** Node size when the arrangement was made, kept so a resize doesn't reshape it. */
  compact: boolean;
  pos: Map<string, Point>;
}

/**
 * Pan/zoom canvas over the agent DAG. Agents are circles with a status ring,
 * placed on a spread-out tree (or a grid when they don't delegate) and free to
 * drag anywhere; drag an agent's handle onto another agent to connect them.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  const {
    nodes, edges, getNodeStatus, deriveEdgeState, queuedFor, checkEdge, selection,
    onSelect, onPickNode, onEditNode, onSpawnFrom, onConnectDrop, onCanvasDoubleClick,
    pendingLink = null, fitNonce = 0, tidyNonce = 0, hideFitButton = false,
  } = props;
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

  // ── Positions: the user's arrangement over the computed layout ───────────
  const ids = useMemo(() => nodes.map((n) => n.chat_id), [nodes]);
  const pairs = useMemo(() => edges.map((e) => ({ from: e.from, to: e.to })), [edges]);
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const [rawArrangement, setArrangement] = useState<Arrangement | null>(null);
  const arrangement = rawArrangement && rawArrangement.tidy === tidyNonce ? rawArrangement : null;
  const arrangedCompact = arrangement ? arrangement.compact : null;
  const { compact, layout } = useMemo(() => {
    const lw = w || 400;
    const lh = Math.max(160, (h || 400) - ZOOM_INSET - BAR_INSET);
    // Once the user has arranged agents the node size is frozen, so new
    // agents land consistently and a resize only refits the view.
    if (arrangedCompact !== null) return { compact: arrangedCompact, layout: layoutGraph(ids, pairs, { width: lw, height: lh, compact: arrangedCompact }) };
    return chooseLayout(ids, pairs, lw, lh);
  }, [ids, pairs, w, h, arrangedCompact]);
  const metrics = compact ? METRICS.compact : METRICS.regular;
  const dense = ids.length >= DENSE_COUNT;
  const positionOf = (id: string): Point | undefined => arrangement?.pos.get(id) ?? layout.positions.get(id);
  const positions = new Map<string, Point>();
  for (const id of ids) {
    const p = positionOf(id);
    if (p) positions.set(id, p);
  }

  // ── View: follows the fit until the user pans, zooms or drags ────────────
  const fitKey = `${fitNonce}|${tidyNonce}|${compact ? "s" : "m"}|${ids.join(",")}`;
  const [manual, setManual] = useState<{ key: string; view: View } | null>(null);
  const fittedRaw = size ? fitView(boundsOf(positions.values(), metrics), size.w, size.h - ZOOM_INSET - BAR_INSET) : { x: 0, y: 0, k: 1 };
  // Fit between the zoom cluster and the action bar so neither covers an agent.
  const fitted = { ...fittedRaw, y: fittedRaw.y + (size ? ZOOM_INSET : 0) };
  const view = manual && manual.key === fitKey ? manual.view : fitted;
  const isManual = !!manual && manual.key === fitKey;
  const latest = useRef({ view, fitKey });
  useEffect(() => {
    latest.current = { view, fitKey };
  });
  const setView = (next: View) => setManual({ key: fitKey, view: next });

  // Wheel zooms around the cursor (as in Workbench); pinch zooms faster;
  // a sideways trackpad swipe pans.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { view: current, fitKey: key } = latest.current;
      const rect = el.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const next = !event.ctrlKey && Math.abs(dx) > Math.abs(dy)
        ? { ...current, x: current.x - dx }
        : zoomAround(current, Math.exp(-dy * (event.ctrlKey ? 0.01 : 0.0015)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      setManual({ key, view: next });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Pointer gestures: pan, drag a card, drag a connection ────────────────
  const gesture = useRef<Gesture | null>(null);
  const [panning, setPanning] = useState(false);
  const [draggingCard, setDraggingCard] = useState<string | null>(null);
  const [link, setLink] = useState<LinkDrag | null>(null);

  const toWorld = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const v = latest.current.view;
    return { x: ((clientX - (rect?.left ?? 0)) - v.x) / v.k, y: ((clientY - (rect?.top ?? 0)) - v.y) / v.k };
  };
  const cardUnder = (clientX: number, clientY: number): string | null => {
    const hit = document.elementFromPoint?.(clientX, clientY);
    return hit?.closest<HTMLElement>("[data-graph-node]")?.dataset.graphNode ?? null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    const handle = target.closest<HTMLElement>("[data-graph-handle]");
    if (handle) {
      event.preventDefault();
      const from = handle.dataset.graphHandle!;
      gesture.current = { kind: "link", pointer: event.pointerId, from };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setLink({ from, to: toWorld(event.clientX, event.clientY), hover: null });
      return;
    }
    if (target.closest("[data-graph-hit]")) return;
    const card = target.closest<HTMLElement>("[data-graph-node]");
    if (card) {
      const chat = card.dataset.graphNode!;
      const origin = positionOf(chat);
      if (!origin) return;
      gesture.current = { kind: "node", pointer: event.pointerId, chat, x: event.clientX, y: event.clientY, origin, moved: false };
      return;
    }
    gesture.current = { kind: "pan", pointer: event.pointerId, x: event.clientX, y: event.clientY, view, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    if (g.kind === "link") {
      const over = cardUnder(event.clientX, event.clientY);
      const hover = over && over !== g.from
        ? (() => { const v = checkEdge(g.from, over); return v.ok ? { id: over, ok: true } : { id: over, ok: false, reason: v.reason }; })()
        : null;
      setLink({ from: g.from, to: toWorld(event.clientX, event.clientY), hover });
      return;
    }
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (g.kind === "pan") setPanning(true);
      else {
        setDraggingCard(g.chat);
        // Freeze the view so dragging never refits under the pointer.
        if (!isManual) setManual({ key: fitKey, view });
      }
    }
    if (g.kind === "pan") {
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      return;
    }
    const k = latest.current.view.k;
    const next = { x: g.origin.x + dx / k, y: g.origin.y + dy / k };
    // The first drag pins every agent where it is, as Workbench keeps its layout.
    const pos = new Map(arrangement?.pos ?? positions);
    pos.set(g.chat, next);
    setArrangement({ tidy: tidyNonce, compact, pos });
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    setPanning(false);
    setDraggingCard(null);
    if (g.kind === "link") {
      const hover = cancelled ? null : link?.hover ?? null;
      setLink(null);
      const to = hover?.id ?? (cancelled ? null : cardUnder(event.clientX, event.clientY));
      if (to && to !== g.from) {
        const p = positionOf(to);
        const v = latest.current.view;
        onConnectDrop(g.from, to, p ? { x: v.x + p.x * v.k, y: v.y + p.y * v.k } : { x: 0, y: 0 });
      }
      return;
    }
    if (cancelled || g.moved) return;
    if (g.kind === "node") onPickNode(g.chat);
    else onSelect(null);
  };

  const zoomBy = (factor: number) => {
    if (!size) return;
    setView(zoomAround(view, factor, { x: size.w / 2, y: size.h / 2 }));
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  const selectedEdge = selection?.kind === "edge" ? selection.id : null;
  const focusEdge = selectedEdge != null ? edges.find((e) => e.edge_id === selectedEdge) ?? null : null;
  // With an agent or edge selected, everything not touching it steps back.
  const touches = (id: string) =>
    selectedNode ? id === selectedNode || edges.some((e) => (e.from === selectedNode && e.to === id) || (e.to === selectedNode && e.from === id))
      : focusEdge ? id === focusEdge.from || id === focusEdge.to
        : true;
  const isHot = (edge: GraphEdge) =>
    selectedEdge === edge.edge_id || (!!selectedNode && (edge.from === selectedNode || edge.to === selectedNode));
  const edgeDim = (edge: GraphEdge) => selection !== null && !isHot(edge);
  const moveTransition = draggingCard ? INSTANT : NODE_SPRING;
  const r = metrics.r;
  // Edges leaving downward start below the agent's name.
  const below = metrics.labelH - 4;

  const linkFrom = link ? positions.get(link.from) : undefined;
  const pendingFrom = pendingLink ? positions.get(pendingLink.from) : undefined;
  const pendingTo = pendingLink ? positions.get(pendingLink.to) : undefined;

  return (
    <div
      ref={viewportRef}
      className={`ogr-canvas${compact ? " is-compact" : ""}${panning ? " is-panning" : ""}${link ? " is-linking" : ""}${draggingCard ? " is-dragging" : ""}`}
      style={{ "--ogr-r": `${r}px`, "--ogr-lw": `${metrics.labelW}px` } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endGesture(event)}
      onPointerCancel={(event) => endGesture(event, true)}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest("[data-graph-hit],[data-graph-node]")) return;
        onCanvasDoubleClick();
      }}
    >
      <div className="ogr-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="ogr-edges" width="1" height="1" aria-hidden="true">
          <defs>
            {(["idle", "in_flight", "blocked", "draft"] as const).map((state) => (
              <marker key={state} id={`ogr-arrow-${state}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={`ogr-arrow is-${state}`} />
              </marker>
            ))}
          </defs>
          {edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const { d } = edgeGeometry(from, to, r, below);
            const state = deriveEdgeState(edge.from, edge.to);
            const selected = selectedEdge === edge.edge_id;
            return (
              <g key={edge.edge_id} className={`ogr-edge is-${state}${selected ? " is-sel" : ""}${isHot(edge) ? " is-hot" : ""}${edgeDim(edge) ? " is-dim" : ""}`}>
                <motion.path className="ogr-edge-line" initial={false} animate={{ d }} transition={moveTransition} markerEnd={`url(#ogr-arrow-${state})`} />
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
          {link && linkFrom ? (
            <path className={`ogr-draft${link.hover ? (link.hover.ok ? " is-ok" : " is-bad") : ""}`} d={`M ${linkFrom.x} ${linkFrom.y} L ${link.to.x} ${link.to.y}`} markerEnd="url(#ogr-arrow-draft)" />
          ) : null}
          {pendingFrom && pendingTo ? <path className="ogr-draft is-ok" d={edgeGeometry(pendingFrom, pendingTo, r, below).d} markerEnd="url(#ogr-arrow-draft)" /> : null}
        </svg>

        {edges.map((edge) => {
          const purpose = edge.purpose?.trim();
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!purpose || !from || !to) return null;
          const state = deriveEdgeState(edge.from, edge.to);
          if (!showsEdgeLabel(state, { compact, dense, hot: isHot(edge) })) return null;
          const { label } = edgeGeometry(from, to, r, below);
          const selected = selectedEdge === edge.edge_id;
          return (
            <motion.button
              key={`label-${edge.edge_id}`}
              type="button"
              data-graph-hit=""
              className={`ogr-elabel is-${state}${selected ? " is-sel" : ""}${edgeDim(edge) ? " is-dim" : ""}`}
              initial={false}
              animate={{ x: label.x, y: label.y }}
              transition={moveTransition}
              title={purpose}
              onClick={(event) => { event.stopPropagation(); onSelect({ kind: "edge", id: edge.edge_id }); }}
            >
              <span>{purpose}</span>
            </motion.button>
          );
        })}

        {nodes.map((node, index) => {
          const p = positions.get(node.chat_id);
          if (!p) return null;
          const status = getNodeStatus(node.chat_id);
          const meta = statusMeta(status);
          const ring = statusRing(status);
          const agent = resolveAgentIcon(node.agent);
          const Icon = agent.Component;
          const queued = queuedFor(node.chat_id);
          const selected = selectedNode === node.chat_id;
          const labelled = keepsLabel(ring, compact, selected);
          const drop = link?.hover?.id === node.chat_id ? (link.hover.ok ? " is-drop-ok" : " is-drop-bad") : "";
          const delay = Math.min(index, 8) * 0.04;
          return (
            <motion.div
              key={node.chat_id}
              role="button"
              tabIndex={0}
              data-graph-node={node.chat_id}
              className={`ogr-node is-${ring} is-${status}${selected ? " is-sel" : ""}${labelled ? "" : " is-quiet"}${touches(node.chat_id) || link ? "" : " is-dim"}${draggingCard === node.chat_id ? " is-dragged" : ""}${drop}`}
              style={{ "--ogr-agent": agentColor(node.agent) } as CSSProperties}
              initial={{ x: p.x, y: p.y, opacity: 0, scale: 0.86 }}
              animate={{ x: p.x, y: p.y, opacity: 1, scale: 1 }}
              transition={draggingCard === node.chat_id ? { ...INSTANT, opacity: { duration: 0.24 } } : { ...NODE_SPRING, opacity: { duration: 0.24, delay }, scale: { ...NODE_SPRING, delay } }}
              aria-pressed={selected}
              aria-label={`${node.name}, ${agent.label}, ${meta.detail ?? meta.label}${queued ? `, ${queued} queued` : ""}`}
              title={drop === " is-drop-bad" ? link?.hover?.reason : undefined}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPickNode(node.chat_id); }
              }}
              onDoubleClick={(event) => { event.stopPropagation(); onEditNode(node.chat_id); }}
            >
              <span className="ogr-av" aria-hidden="true">
                <span className="ogr-ring" />
                <span className="ogr-icon"><Icon size={compact ? 17 : 22} /></span>
                {ring === "ask" || ring === "err" ? <span className={`ogr-badge is-${ring}`}>!</span> : null}
                {ring === "done" ? <span className="ogr-badge is-done"><Check /></span> : null}
                {queued > 0 ? <span className="ogr-node-q oui-tnum" title={`${queued} queued ${queued === 1 ? "message" : "messages"}`}>{queued}</span> : null}
                {/* Hover affordances: drag the handle onto another agent to connect; "+" spawns a child. */}
                <span className="ogr-handle" data-graph-handle={node.chat_id} title="Drag onto another agent to connect" />
              </span>
              <button
                type="button"
                className="ogr-node-spawn"
                data-graph-hit=""
                aria-label={`Spawn a child of ${node.name}`}
                title="Spawn child"
                onClick={(event) => { event.stopPropagation(); onSpawnFrom(node.chat_id); }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Plus />
              </button>
              <span className="ogr-nl">
                <b>{node.name}</b>
                {compact ? null : <small title={meta.detail}>{agent.label} · {meta.label}</small>}
              </span>
            </motion.div>
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
            <button type="button" onClick={() => setManual(null)} aria-label="Fit graph to view" title="Fit to view" disabled={!isManual}><Maximize2 /></button>
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
