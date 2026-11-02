// Pure geometry for the Orbit Agent graph: a layered DAG layout (roots first,
// each agent one layer below its deepest parent), edge curves and fit-to-view.
// No simulation, so the same graph always lands in the same place.

import type { NodeStatus } from "../../../api/walkieTalkie";
import type { StatusTone } from "../../ui";
import type { GraphNode } from "../../../components/Tasks/TaskView/graphShared";

export type GraphDirection = "TB" | "LR";

export interface Point {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Point>;
  /** Bounding box of the node cards in world space. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface View {
  x: number;
  y: number;
  k: number;
}

export const NODE_W = 188;
export const NODE_H = 54;
/** Distance between layers and between siblings, per direction. */
const GAPS: Record<GraphDirection, { layer: number; sibling: number }> = {
  TB: { layer: 64, sibling: 22 },
  LR: { layer: 84, sibling: 20 },
};

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;
/** Fit never blows a small graph up past this, nor shrinks cards past legibility. */
const FIT_MAX_ZOOM = 1.1;
const FIT_MIN_ZOOM = 0.55;

/** Longest-path layer of each node; nodes on a cycle (never expected) fall back to 0. */
export function computeLayers(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const known = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue;
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
 * Layered layout. Within a layer, nodes are ordered by the mean position of
 * their neighbours (a few up/down sweeps) so edges cross as little as cheaply
 * possible; ties keep the input order, so the layout is stable.
 */
export function layoutGraph(
  ids: string[],
  edges: { from: string; to: string }[],
  direction: GraphDirection,
): LayoutResult {
  const layerOf = computeLayers(ids, edges);
  const layerCount = ids.reduce((max, id) => Math.max(max, (layerOf.get(id) ?? 0) + 1), 0);
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) layers[layerOf.get(id) ?? 0].push(id);

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (!layerOf.has(e.from) || !layerOf.has(e.to)) continue;
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

  const gap = GAPS[direction];
  const along = direction === "TB" ? NODE_H : NODE_W; // size on the layer axis
  const across = direction === "TB" ? NODE_W : NODE_H; // size on the sibling axis
  const positions = new Map<string, Point>();
  layers.forEach((layer, li) => {
    const main = li * (along + gap.layer);
    layer.forEach((id, i) => {
      const cross = (i - (layer.length - 1) / 2) * (across + gap.sibling);
      positions.set(id, direction === "TB" ? { x: cross, y: main } : { x: main, y: cross });
    });
  });

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x - NODE_W / 2);
    maxX = Math.max(maxX, p.x + NODE_W / 2);
    minY = Math.min(minY, p.y - NODE_H / 2);
    maxY = Math.max(maxY, p.y + NODE_H / 2);
  }
  if (!positions.size) minX = minY = maxX = maxY = 0;
  return { positions, bounds: { minX, minY, maxX, maxY } };
}

/** Curve from the source card's leading edge to the target card's trailing edge. */
export function edgeGeometry(from: Point, to: Point, direction: GraphDirection): { d: string; mid: Point } {
  // Leave room for the arrowhead before the target card.
  const tip = 5;
  if (direction === "TB") {
    const sx = from.x, sy = from.y + NODE_H / 2;
    const tx = to.x, ty = to.y - NODE_H / 2 - tip;
    const bend = Math.max(24, Math.abs(ty - sy) / 2);
    return {
      d: `M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`,
      mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 },
    };
  }
  const sx = from.x + NODE_W / 2, sy = from.y;
  const tx = to.x - NODE_W / 2 - tip, ty = to.y;
  const bend = Math.max(28, Math.abs(tx - sx) / 2);
  return {
    d: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`,
    mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 },
  };
}

/** View that centers the bounds in a `width` x `height` viewport. */
export function fitView(bounds: LayoutResult["bounds"], width: number, height: number, padding = 28): View {
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

/** Wide canvases lay layers left to right; tall or narrow ones top to bottom. */
export function pickDirection(width: number, height: number): GraphDirection {
  return width > height * 1.35 ? "LR" : "TB";
}

function rawFit(bounds: LayoutResult["bounds"], width: number, height: number): number {
  return Math.min((width - 56) / Math.max(1, bounds.maxX - bounds.minX), (height - 56) / Math.max(1, bounds.maxY - bounds.minY));
}

/**
 * Lay the graph out in whichever direction shows it largest in this canvas
 * (e.g. side-by-side roots stack vertically in a tall, narrow dock). Near
 * ties follow the canvas shape.
 */
export function bestLayout(
  ids: string[],
  edges: { from: string; to: string }[],
  width: number,
  height: number,
): { direction: GraphDirection; layout: LayoutResult } {
  const tb = layoutGraph(ids, edges, "TB");
  const lr = layoutGraph(ids, edges, "LR");
  const kTb = rawFit(tb.bounds, width, height);
  const kLr = rawFit(lr.bounds, width, height);
  if (Math.abs(kTb - kLr) <= Math.max(kTb, kLr) * 0.05) {
    return pickDirection(width, height) === "LR" ? { direction: "LR", layout: lr } : { direction: "TB", layout: tb };
  }
  return kLr > kTb ? { direction: "LR", layout: lr } : { direction: "TB", layout: tb };
}

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  pulse: boolean;
}

export function statusMeta(status: NodeStatus): StatusMeta {
  switch (status) {
    case "busy":
      return { label: "Working", tone: "live", pulse: true };
    case "permission_required":
      return { label: "Needs permission", tone: "waiting", pulse: false };
    case "connecting":
      return { label: "Connecting", tone: "info", pulse: true };
    case "idle":
      return { label: "Idle", tone: "ok", pulse: false };
    default:
      return { label: "Not running", tone: "off", pulse: false };
  }
}

export const EDGE_STATE_LABEL = {
  idle: "No messages waiting",
  in_flight: "Delivering",
  blocked: "Queued",
} as const;

/** "4 agents · 1 working · 1 needs permission · 2 queued" from live state. */
export function graphSummary(nodes: GraphNode[], getNodeStatus: (chatId: string) => NodeStatus, queuedCount: number): string {
  const working = nodes.filter((n) => getNodeStatus(n.chat_id) === "busy").length;
  const asking = nodes.filter((n) => getNodeStatus(n.chat_id) === "permission_required").length;
  const parts = [`${nodes.length} ${nodes.length === 1 ? "agent" : "agents"}`];
  if (working) parts.push(`${working} working`);
  if (asking) parts.push(`${asking} need${asking === 1 ? "s" : ""} permission`);
  if (queuedCount) parts.push(`${queuedCount} queued`);
  return parts.join(" · ");
}
