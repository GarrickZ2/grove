// Pure helpers for the Design panel: board geometry, comment placement, and
// the open-design request a chat chip raises.
import type { Design, DesignAnchor, DesignComment, DesignPage } from "../../../api/designs";

/** Board → screen: `screen = world * k + (x, y)`. */
export interface BoardView {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.03;
export const MAX_ZOOM = 2;
/** World-pixel text sizes of board labels. */
export const LABEL_SIZE = { title: 56, subtitle: 28 } as const;
/** Width of the design system's DESIGN.md card on the board. */
export const GUIDE_WIDTH = 760;

export function pageHeight(page: DesignPage): number {
  return Math.max(page.height, page.rendered_height ?? 0);
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box around every artboard and label; null for an empty board. */
export function boardBounds(design: Design, extra: Bounds[] = []): Bounds | null {
  const boxes: Bounds[] = [
    ...design.pages.map((page) => ({ left: page.x, top: page.y - 44, right: page.x + page.width, bottom: page.y + pageHeight(page) })),
    ...design.labels.map((label) => ({
      left: label.x,
      top: label.y,
      right: label.x + label.text.length * LABEL_SIZE[label.size] * 0.55,
      bottom: label.y + LABEL_SIZE[label.size] * 1.25,
    })),
    ...extra,
  ];
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

/** The view that shows all of `bounds` centred in a viewport, with a margin. */
export function fitView(bounds: Bounds | null, viewport: { width: number; height: number }, margin = 48): BoardView {
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) return { x: margin, y: margin, k: 0.25 };
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const k = clampZoom(Math.min((viewport.width - margin * 2) / width, (viewport.height - margin * 2) / height, 1));
  return {
    k,
    x: (viewport.width - width * k) / 2 - bounds.left * k,
    y: (viewport.height - height * k) / 2 - bounds.top * k,
  };
}

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Zoom by `factor`, keeping the board point under (cx, cy) where it is. */
export function zoomAt(view: BoardView, factor: number, cx: number, cy: number): BoardView {
  const k = clampZoom(view.k * factor);
  const ratio = k / view.k;
  return { k, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio };
}

/** Where to guide placement of the design system's DESIGN.md card: right of everything. */
export function guidePosition(design: Design): { x: number; y: number } {
  const bounds = boardBounds(design);
  return bounds ? { x: bounds.right + 160, y: bounds.top + 44 } : { x: 0, y: 0 };
}

export function pageKey(design: string, file: string): string {
  return `${design}/${file}`;
}

/** Open comments of one page, oldest first. */
export function pageComments(comments: DesignComment[], design: string, file: string, includeResolved = false): DesignComment[] {
  return comments.filter((comment) => comment.design === design && comment.page === file && (includeResolved || comment.status === "open"));
}

/** Where a comment's pin goes: the element's top-right corner, or the page's. */
export function pinPosition(
  anchor: DesignAnchor | null,
  located: { x: number; y: number; width: number; height: number } | undefined,
  page: { width: number },
  index: number,
): { x: number; y: number } {
  const box = located ?? anchor;
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return { x: page.width - 28 - index * 34, y: 28 };
  return { x: Math.min(page.width, box.x + box.width), y: Math.max(0, box.y) };
}

/** `AB` from "Ada Byron"; one letter for a single name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 1) : words[0].slice(0, 1) + words[words.length - 1].slice(0, 1);
  return letters.toUpperCase();
}

/** A stable hue per author so pins of one person look alike. */
export function authorHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

// ── design:// references ────────────────────────────────────────────────────

export const OPEN_DESIGN_EVENT = "grove:open-design";

export interface OpenDesignDetail {
  projectId: string;
  taskId: string;
  design: string;
  page?: string;
}

const DESIGN_REF_RE = /^([A-Za-z0-9_][A-Za-z0-9._-]*)(?:\/([A-Za-z0-9_][A-Za-z0-9._-]*\.html))?$/;

/** `design://insight-ui/overview.html` → { design, page }. */
export function parseDesignRef(href: string): { design: string; page?: string } | null {
  if (!href.startsWith("design://")) return null;
  const match = DESIGN_REF_RE.exec(href.slice("design://".length).replace(/\/$/, ""));
  return match ? { design: match[1], page: match[2] } : null;
}

// The panel may mount after the chip is clicked; it picks the request up here.
let pendingOpen: OpenDesignDetail | null = null;

export function requestOpenDesign(detail: OpenDesignDetail) {
  pendingOpen = detail;
  window.dispatchEvent(new CustomEvent<OpenDesignDetail>(OPEN_DESIGN_EVENT, { detail }));
}

export function takePendingOpen(projectId: string, taskId: string): OpenDesignDetail | null {
  if (!pendingOpen || pendingOpen.projectId !== projectId || pendingOpen.taskId !== taskId) return null;
  const detail = pendingOpen;
  pendingOpen = null;
  return detail;
}
