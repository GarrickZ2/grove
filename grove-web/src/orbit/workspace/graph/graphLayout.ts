// Pure geometry for the Orbit Agent graph. Delegating agents sit on a
// spread-out tree (roots on top, each agent one row below its deepest parent,
// children under their parents); agents without delegations line up in a
// tidy grid below. Spacing follows the panel's size. No simulation and no
// randomness, so the same graph in the same panel always lands in the same
// place.

import type { NodeOutcome, NodeStatus } from "../../../api/walkieTalkie";
import type { StatusTone } from "../../ui";
import type { GraphNode } from "../../../components/Tasks/TaskView/graphShared";

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayoutResult {
  /** Center of each agent's circle, in world space. */
  positions: Map<string, Point>;
  /** Bounding box of the circles and their labels in world space. */
  bounds: Bounds;
  /** A tree row was wider than the panel and had to wrap. */
  wrapped: boolean;
  /** Even at the tightest row spacing the rows are taller than the panel. */
  tall: boolean;
}

export interface View {
  x: number;
  y: number;
  k: number;
}

/** Node sizes: regular, and the shrunk nodes of a crowded narrow panel. */
export interface NodeMetrics {
  /** Circle radius. */
  r: number;
  /** Widest label under the circle. */
  labelW: number;
  /** Label height under the circle (gap included). */
  labelH: number;
  /** Horizontal distance between neighbours: at least, at most. */
  slotMin: number;
  slotMax: number;
  /** Vertical distance between rows: at least, at most. */
  rowMin: number;
  rowMax: number;
}

export const METRICS: Record<"regular" | "compact", NodeMetrics> = {
  regular: { r: 22, labelW: 132, labelH: 40, slotMin: 150, slotMax: 300, rowMin: 112, rowMax: 220 },
  compact: { r: 16, labelW: 74, labelH: 22, slotMin: 76, slotMax: 140, rowMin: 78, rowMax: 150 },
};

/** Narrower than this is a dock: 2-column grid, and nodes may shrink. */
export const NARROW_WIDTH = 560;
/** Columns of the grid of agents without delegations. */
export const GRID_COLS = { wide: 4, narrow: 2 } as const;

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;
/** The layout is already sized to the panel; fit never enlarges past 100%. */
const FIT_MAX_ZOOM = 1;
const FIT_MIN_ZOOM = 0.5;

type Pair = { from: string; to: string };

function validEdges(ids: string[], edges: Pair[]): Pair[] {
  const known = new Set(ids);
  return edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
}

/** Longest-path layer of each node; nodes on a cycle (never expected) fall back to 0. */
export function computeLayers(ids: string[], edges: Pair[]): Map<string, number> {
  const valid = validEdges(ids, edges);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of valid) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
      const left = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return layer;
}

/**
 * Layers ordered by the mean position of their neighbours (a few up/down
 * sweeps) so edges cross as little as cheaply possible; ties keep the input
 * order, so the result is stable.
 */
function orderedLayers(ids: string[], edges: Pair[]): string[][] {
  const layerOf = computeLayers(ids, edges);
  const count = ids.reduce((max, id) => Math.max(max, (layerOf.get(id) ?? 0) + 1), 0);
  const layers: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layerOf.get(id) ?? 0].push(id);
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of edges) {
    parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  }
  const indexIn = new Map<string, number>();
  const reindex = () => layers.forEach((layer) => layer.forEach((id, i) => indexIn.set(id, i)));
  reindex();
  const sortBy = (layer: string[], neighbours: Map<string, string[]>) => {
    const score = new Map<string, number>();
    layer.forEach((id, i) => {
      const ns = (neighbours.get(id) ?? []).map((n) => indexIn.get(n) ?? 0);
      score.set(id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i);
    });
    layer.sort((a, b) => (score.get(a)! - score.get(b)!) || (indexIn.get(a)! - indexIn.get(b)!));
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    if (sweep % 2 === 0) for (let i = 1; i < layers.length; i++) { sortBy(layers[i], parents); reindex(); }
    else for (let i = layers.length - 2; i >= 0; i--) { sortBy(layers[i], children); reindex(); }
  }
  return layers;
}

/**
 * Split a row into the fewest sub-rows of at most `max`, dealt round-robin so
 * each sub-row keeps one child per parent under that parent. `stagger` is
 * each sub-row's sideways offset, in slots, so the stacked children fan out
 * and the edges to the lower ones pass between the upper ones.
 */
function wrapRow(row: string[], max: number): { ids: string[]; stagger: number }[] {
  if (row.length <= max) return [{ ids: row, stagger: 0 }];
  const n = Math.ceil(row.length / max);
  return Array.from({ length: n }, (_, j) => ({
    ids: row.filter((_, i) => i % n === j),
    stagger: (j - (n - 1) / 2) * (0.9 / n),
  }));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface LayoutOptions {
  /** Panel size in pixels; spacing spreads to use it. */
  width: number;
  height: number;
  compact: boolean;
}

/**
 * Tree for agents that delegate, grid for those that don't. Children sit under
 * the mean of their parents, pushed apart to one slot; rows wider than the
 * panel wrap into balanced sub-rows.
 */
export function layoutGraph(ids: string[], edges: Pair[], { width, height, compact }: LayoutOptions): LayoutResult {
  const m = compact ? METRICS.compact : METRICS.regular;
  const valid = validEdges(ids, edges);
  const linked = new Set(valid.flatMap((e) => [e.from, e.to]));
  const treeIds = ids.filter((id) => linked.has(id));
  const loose = ids.filter((id) => !linked.has(id));
  const narrow = width < NARROW_WIDTH;
  const pad = narrow ? 20 : 40;
  const innerW = Math.max(m.slotMin, width - pad * 2);
  const maxCols = Math.max(1, Math.floor(innerW / m.slotMin));

  let wrapped = false;
  const subRows: { ids: string[]; stagger: number }[] = [];
  for (const layer of treeIds.length ? orderedLayers(treeIds, valid) : []) {
    if (layer.length > maxCols) wrapped = true;
    subRows.push(...wrapRow(layer, maxCols));
  }
  const rows = subRows.map((r) => r.ids);
  const gridCols = Math.max(1, Math.min(loose.length, narrow ? GRID_COLS.narrow : GRID_COLS.wide, maxCols));
  const gridRows = Math.ceil(loose.length / gridCols);

  const widest = Math.max(gridCols, ...rows.map((r) => r.length));
  const slotW = Math.round(clamp(innerW / widest, m.slotMin, m.slotMax));
  const totalRows = rows.length + gridRows;
  const innerH = height - pad * 2 - m.labelH - m.r;
  const rowH = Math.round(totalRows > 1 ? clamp(innerH / (totalRows - 1), m.rowMin, m.rowMax) : m.rowMin);

  const parents = new Map<string, string[]>();
  for (const e of valid) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const positions = new Map<string, Point>();
  rows.forEach((row, ri) => {
    const y = ri * rowH;
    const offset = subRows[ri].stagger * slotW;
    const desired = row.map((id, i) => {
      const xs = (parents.get(id) ?? []).map((p) => positions.get(p)?.x).filter((x): x is number => x !== undefined);
      return (xs.length ? mean(xs) : (i - (row.length - 1) / 2) * slotW) + offset;
    });
    const order = row.map((_, i) => i).sort((a, b) => (desired[a] - desired[b]) || a - b);
    const xs: number[] = [];
    order.forEach((idx, j) => { xs[j] = j === 0 ? desired[idx] : Math.max(desired[idx], xs[j - 1] + slotW); });
    // Pushing apart drifts right; shift back so the row stays under its parents.
    const shift = mean(order.map((i) => desired[i])) - mean(xs);
    order.forEach((idx, j) => positions.set(row[idx], { x: Math.round(xs[j] + shift), y }));
  });

  let cx = 0;
  if (positions.size) {
    const tx = [...positions.values()].map((p) => p.x);
    cx = (Math.min(...tx) + Math.max(...tx)) / 2;
  }
  const gridTop = rows.length * rowH;
  loose.forEach((id, i) => {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    positions.set(id, { x: Math.round(cx + (col - (gridCols - 1) / 2) * slotW), y: gridTop + row * rowH });
  });

  // Keep the input order in the map so callers iterate predictably.
  const ordered = new Map<string, Point>();
  for (const id of ids) {
    const p = positions.get(id);
    if (p) ordered.set(id, p);
  }
  const tall = (totalRows - 1) * m.rowMin > innerH;
  return { positions: ordered, bounds: boundsOf(ordered.values(), m), wrapped, tall };
}

/**
 * The layout for this panel: regular nodes, unless the panel is a narrow dock
 * the graph would crowd (a row must wrap, or it is taller than the panel), in
 * which case nodes shrink.
 */
export function chooseLayout(ids: string[], edges: Pair[], width: number, height: number): { compact: boolean; layout: LayoutResult } {
  const regular = layoutGraph(ids, edges, { width, height, compact: false });
  if (width >= NARROW_WIDTH) return { compact: false, layout: regular };
  if (!regular.wrapped && !regular.tall) return { compact: false, layout: regular };
  return { compact: true, layout: layoutGraph(ids, edges, { width, height, compact: true }) };
}

/**
 * Curved arrow between two circles of radius `r`: a gentle quadratic bend,
 * trimmed to leave a gap at both ends and room for the arrowhead. An end that
 * leaves downward also clears the `below`-tall name label under its circle.
 * `label` is the curve's midpoint, where the task pill sits.
 */
export function edgeGeometry(from: Point, to: Point, r: number = METRICS.regular.r, below = 0): { d: string; label: Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Steeper downward ends skip more of the label, never more than half the edge.
  const clear = (down: number) => (down > 0.35 ? Math.min(below * down, len * 0.25) : 0);
  const gapS = r + 6 + clear(uy);
  const gapT = r + 9 + clear(-uy);
  const sx = from.x + ux * gapS, sy = from.y + uy * gapS;
  const tx = to.x - ux * gapT, ty = to.y - uy * gapT;
  const bend = Math.min(36, len * 0.12);
  const cx = (sx + tx) / 2 - uy * bend, cy = (sy + ty) / 2 + ux * bend;
  const f = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M ${f(sx)} ${f(sy)} Q ${f(cx)} ${f(cy)} ${f(tx)} ${f(ty)}`,
    label: { x: f(0.25 * sx + 0.5 * cx + 0.25 * tx), y: f(0.25 * sy + 0.5 * cy + 0.25 * ty) },
  };
}

/** Bounds of circles (and their labels) centered at `points`. */
export function boundsOf(points: Iterable<Point>, m: NodeMetrics = METRICS.regular): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const half = Math.max(m.labelW / 2, m.r + 6);
  for (const p of points) {
    minX = Math.min(minX, p.x - half);
    maxX = Math.max(maxX, p.x + half);
    minY = Math.min(minY, p.y - m.r - 6);
    maxY = Math.max(maxY, p.y + m.r + m.labelH);
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** View that centers the bounds in a `width` x `height` viewport. */
export function fitView(bounds: Bounds, width: number, height: number, padding = 16): View {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const k = Math.max(FIT_MIN_ZOOM, clampZoom(Math.min(FIT_MAX_ZOOM, (width - padding * 2) / bw, (height - padding * 2) / bh)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Zoom by `factor`, keeping the viewport point `origin` fixed. */
export function zoomAround(view: View, factor: number, origin: Point): View {
  const k = clampZoom(view.k * factor);
  const gx = (origin.x - view.x) / view.k;
  const gy = (origin.y - view.y) / view.k;
  return { k, x: origin.x - gx * k, y: origin.y - gy * k };
}

export interface StatusMeta {
  label: string;
  /** Longer wording for tooltips and screen readers, when the label is a shorthand. */
  detail?: string;
  tone: StatusTone;
  pulse: boolean;
}

/** What an agent node shows: its live status, or the settled outcome of its last turn once idle. */
export type GraphNodeStatus = NodeStatus | NodeOutcome;

/**
 * Status a node displays. The live status wins while the agent works, asks or
 * is offline; an idle agent shows its last turn's outcome. `done` also needs
 * no message still waiting for its reply (`owesReply`), so a new ask that is
 * queued but not delivered yet does not read as finished.
 */
export function nodeDisplayStatus(status: NodeStatus, outcome: NodeOutcome | undefined, owesReply = false): GraphNodeStatus {
  if (status !== "idle" || !outcome) return status;
  if (outcome === "done" && owesReply) return status;
  return outcome;
}

/** Live status label, including the settled `error` / `done` outcomes. */
export function statusMeta(status: GraphNodeStatus): StatusMeta {
  switch (status) {
    case "busy":
      return { label: "Working", tone: "live", pulse: true };
    case "permission_required":
      return { label: "Needs you", detail: "Needs permission", tone: "waiting", pulse: false };
    case "connecting":
      return { label: "Connecting", tone: "info", pulse: true };
    case "idle":
      return { label: "Idle", tone: "ok", pulse: false };
    case "error":
      return { label: "Error", detail: "Last turn failed", tone: "fail", pulse: false };
    case "done":
      return { label: "Done", detail: "Replied and finished", tone: "ok", pulse: false };
    default:
      return { label: "Not running", tone: "off", pulse: false };
  }
}

/** The ring drawn around an agent's circle. */
export type NodeRing = "work" | "ask" | "err" | "done" | "connecting" | "ready" | "off";

export function statusRing(status: GraphNodeStatus | string): NodeRing {
  switch (status) {
    case "busy": return "work";
    case "permission_required": return "ask";
    case "error": return "err";
    case "done": return "done";
    case "connecting": return "connecting";
    case "idle": return "ready";
    default: return "off";
  }
}

/** Whether an agent shows its name. Only a dense team in a narrow dock runs out
 *  of room; there, agents that need no attention show it on hover. */
export function keepsLabel(ring: NodeRing, crowded: boolean, selected: boolean): boolean {
  return !crowded || selected || ring === "work" || ring === "ask" || ring === "err" || ring === "connecting";
}

/**
 * Whether a delegation's task pill shows. Pills on edges touching the
 * selection always do. Otherwise a crowded dock keeps only in-flight pills
 * (none once the team is dense), and a dense wide panel hides the pills on
 * quiet (done) edges.
 */
export function showsEdgeLabel(state: "idle" | "in_flight" | "blocked", opts: { compact: boolean; dense: boolean; hot: boolean }): boolean {
  if (opts.hot) return true;
  if (opts.compact) return !opts.dense && state === "in_flight";
  return !(opts.dense && state === "idle");
}

/** Twelve or more agents make a dense team, even in a wide panel. */
export const DENSE_COUNT = 12;

export const EDGE_STATE_LABEL = {
  idle: "No messages waiting",
  in_flight: "Delivering",
  blocked: "Queued",
} as const;

/** "4 agents · 1 working · 1 needs permission · 1 error · 1 done · 2 queued" from live state. */
export function graphSummary(nodes: GraphNode[], getNodeStatus: (chatId: string) => GraphNodeStatus, queuedCount: number): string {
  const count = (status: GraphNodeStatus) => nodes.filter((n) => getNodeStatus(n.chat_id) === status).length;
  const working = count("busy");
  const asking = count("permission_required");
  const failed = count("error");
  const done = count("done");
  const parts = [`${nodes.length} ${nodes.length === 1 ? "agent" : "agents"}`];
  if (working) parts.push(`${working} working`);
  if (asking) parts.push(`${asking} need${asking === 1 ? "s" : ""} permission`);
  if (failed) parts.push(`${failed} ${failed === 1 ? "error" : "errors"}`);
  if (done) parts.push(`${done} done`);
  if (queuedCount) parts.push(`${queuedCount} queued`);
  return parts.join(" · ");
}
