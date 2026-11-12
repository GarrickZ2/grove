import type { SketchAnchor, SketchAnchorItem, SketchBox } from "../../../api";

/** The fields of an Excalidraw element a comment's place is worked out from. */
export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  containerId?: string | null;
  groupIds?: readonly string[];
  text?: string;
  points?: readonly (readonly [number, number])[];
}

/** An element's box in scene coordinates. */
export function boxOf(element: SceneElement): SketchBox {
  if (element.points && element.points.length) {
    const xs = element.points.map((point) => point[0]);
    const ys = element.points.map((point) => point[1]);
    const left = element.x + Math.min(...xs);
    const top = element.y + Math.min(...ys);
    return { x: left, y: top, width: element.x + Math.max(...xs) - left, height: element.y + Math.max(...ys) - top };
  }
  return {
    x: Math.min(element.x, element.x + element.width),
    y: Math.min(element.y, element.y + element.height),
    width: Math.abs(element.width),
    height: Math.abs(element.height),
  };
}

/** The box around several boxes. */
export function unionOf(boxes: SketchBox[]): SketchBox | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const live = (elements: readonly SceneElement[]) => elements.filter((element) => !element.isDeleted);

/** A label stands for its shape: the shape is what a comment is on. */
function owner(element: SceneElement, byId: Map<string, SceneElement>): SceneElement {
  const container = element.containerId ? byId.get(element.containerId) : undefined;
  return container && !container.isDeleted ? container : element;
}

/** What an element reads: its own text, or its label's. */
function textOf(elements: readonly SceneElement[], element: SceneElement): string | undefined {
  const own = element.type === "text" ? element.text : elements.find((entry) => entry.containerId === element.id && !entry.isDeleted)?.text;
  const text = own?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

/** A comment's place on these elements: each as it reads now, and the box around them. */
export function anchorOn(elements: readonly SceneElement[], ids: Iterable<string>): SketchAnchor | null {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const chosen = new Map<string, SceneElement>();
  for (const id of ids) {
    const element = byId.get(id);
    if (!element || element.isDeleted) continue;
    const shape = owner(element, byId);
    chosen.set(shape.id, shape);
  }
  const list = [...chosen.values()];
  const box = unionOf(list.map(boxOf));
  if (!box) return null;
  const items: SketchAnchorItem[] = list.map((element) => {
    const text = textOf(elements, element);
    return text ? { id: element.id, type: element.type, text } : { id: element.id, type: element.type };
  });
  return { items, box };
}

/** A comment's place on an area dragged out: the box, and the elements whose middle is inside it. */
export function anchorOnArea(elements: readonly SceneElement[], box: SketchBox): SketchAnchor {
  const inside = live(elements).filter((element) => {
    if (element.containerId) return false;
    const own = boxOf(element);
    const cx = own.x + own.width / 2;
    const cy = own.y + own.height / 2;
    return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
  });
  const items = anchorOn(elements, inside.map((element) => element.id))?.items ?? [];
  return { items, box, area: true };
}

/**
 * What a click picks: the front-most element under the point, with the rest
 * of its outermost group. Frames only when nothing else is there.
 */
export function idsAt(elements: readonly SceneElement[], x: number, y: number, zoom: number): string[] {
  const slack = 6 / zoom;
  const all = live(elements);
  const byId = new Map(all.map((element) => [element.id, element]));
  let hit: SceneElement | null = null;
  let frame: SceneElement | null = null;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const element = all[index];
    const box = boxOf(element);
    if (x < box.x - slack || x > box.x + box.width + slack || y < box.y - slack || y > box.y + box.height + slack) continue;
    if (element.type === "frame" || element.type === "magicframe") {
      frame ??= element;
      continue;
    }
    hit = owner(element, byId);
    break;
  }
  hit ??= frame;
  if (!hit) return [];
  const group = hit.groupIds?.at(-1);
  if (!group) return [hit.id];
  return all.filter((element) => element.groupIds?.includes(group)).map((element) => element.id);
}

/**
 * Where a comment is on the canvas now: around its elements as they are, or
 * the area dragged out. Stale when none of its elements are left.
 */
export function placeOf(anchor: SketchAnchor | null | undefined, byId: Map<string, SceneElement>): { box: SketchBox; stale: boolean } | null {
  if (!anchor?.box) return null;
  if (anchor.area) return { box: anchor.box, stale: false };
  const now = (anchor.items ?? [])
    .map((item) => byId.get(item.id))
    .filter((element): element is SceneElement => Boolean(element && !element.isDeleted));
  const box = unionOf(now.map(boxOf));
  return box ? { box, stale: false } : { box: anchor.box, stale: true };
}

const quoted = (text: string) => `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;

/** How a comment's place reads in a thread's title and the comment list. */
export function placeLabel(anchor: SketchAnchor | null | undefined): string {
  const items = anchor?.items ?? [];
  if (anchor?.area) return items.length ? `An area · ${items.length === 1 ? "1 element" : `${items.length} elements`}` : "An empty area";
  if (items.length === 1) return items[0].text ? quoted(items[0].text) : `A ${items[0].type}`;
  if (items.length > 1) return `${items.length} elements`;
  return "The sketch";
}

/** The place for the agent: the elements by id, type and text, and the area when there is one. */
export function describePlace(anchor: SketchAnchor | null | undefined): string {
  if (!anchor) return "the sketch";
  const items = anchor.items ?? [];
  const list = items
    .slice(0, 20)
    .map((item) => `\`${item.id}\` (${item.type}${item.text ? `, "${item.text}"` : ""})`)
    .join(", ") + (items.length > 20 ? `, and ${items.length - 20} more` : "");
  if (anchor.area && anchor.box) {
    const { x, y, width, height } = anchor.box;
    const area = `the area x=${Math.round(x)} y=${Math.round(y)} w=${Math.round(width)} h=${Math.round(height)}`;
    return items.length ? `${area}, which holds ${list}` : `${area}, which is empty`;
  }
  if (items.length === 0) return "the sketch";
  return items.length === 1 ? `the element ${list}` : `the elements ${list}`;
}
