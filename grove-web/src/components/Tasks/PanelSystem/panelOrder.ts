// The one order of a workspace's panels: the toolbar, its More menu and the
// touch layouts all list them this way. `MORE` is a place in it like any
// panel's: what comes before it is on the toolbar, what comes after is under
// More. Where the toolbar runs out of room, its last ones go under More too.

type Keyed = { key: string };

export const MORE = "more";

/** Grove's own order, in the groups its menus draw dividers between. The first
 *  group is on the toolbar, the rest under More. */
const DEFAULT_GROUPS = {
  coding: [
    ["review", "editor", "terminal"],
    ["browser", "git", "comments", "notes", "graph", "stats"],
  ],
  studio: [
    ["design", "sketch", "artifacts"],
    ["browser", "review", "editor", "terminal"],
    ["notes", "graph", "stats"],
  ],
};

const groupsFor = (isStudio: boolean) => (isStudio ? DEFAULT_GROUPS.studio : DEFAULT_GROUPS.coding);

/** The user's order with MORE and every available panel in it. Panels that aren't
 *  available now (a plugin turned off) keep their place; one the user's order
 *  doesn't know comes after the panel it follows by default, plugins last. */
export function fullPanelOrder(available: readonly string[], saved: readonly string[] | null | undefined, isStudio: boolean): string[] {
  const [shown, ...rest] = groupsFor(isStudio);
  const defaults = [...shown, MORE, ...rest.flat()];
  const order = [...new Set(saved ?? [])];
  const builtIn = defaults.filter((key) => key === MORE || available.includes(key));
  const plugins = available.filter((key) => !defaults.includes(key));
  for (const key of [...builtIn, ...plugins]) {
    if (order.includes(key)) continue;
    const at = defaults.indexOf(key);
    if (at < 0) {
      order.push(key);
      continue;
    }
    const before = defaults.slice(0, at).reverse().find((k) => order.includes(k));
    const place = before ? order.indexOf(before) + 1 : 0;
    // It starts on the side of MORE it has by default.
    const more = order.indexOf(MORE);
    order.splice(more < 0 ? place : at > defaults.indexOf(MORE) ? Math.max(place, more + 1) : Math.min(place, more), 0, key);
  }
  return order;
}

/** Panels in the user's order. */
export function orderPanels<T extends Keyed>(panels: readonly T[], saved: readonly string[] | null | undefined, isStudio: boolean): T[] {
  const order = fullPanelOrder(panels.map((p) => p.key), saved, isStudio);
  return [...panels].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Panels in the user's order, split into the toolbar's and More's. */
export function splitPanels<T extends Keyed>(panels: readonly T[], saved: readonly string[] | null | undefined, isStudio: boolean): { shown: T[]; more: T[] } {
  const order = fullPanelOrder(panels.map((p) => p.key), saved, isStudio);
  const at = order.indexOf(MORE);
  const ordered = orderPanels(panels, saved, isStudio);
  return {
    shown: ordered.filter((p) => order.indexOf(p.key) < at),
    more: ordered.filter((p) => order.indexOf(p.key) > at),
  };
}

/** Ordered panels split where a menu draws a divider. A group the user
 *  has mixed with another no longer means anything, so then it is one list. */
export function groupPanels<T extends Keyed>(ordered: readonly T[], isStudio: boolean): T[][] {
  const groups = groupsFor(isStudio);
  const out: T[][] = [];
  const seen: number[] = [];
  for (const panel of ordered) {
    const found = groups.findIndex((keys) => keys.includes(panel.key));
    const group = found < 0 ? groups.length : found;
    if (seen[seen.length - 1] === group) {
      out[out.length - 1].push(panel);
      continue;
    }
    if (seen.includes(group)) return [[...ordered]];
    seen.push(group);
    out.push([panel]);
  }
  return out;
}

export interface PanelMove {
  key: string;
  /** The panel it was dropped beside, or MORE. */
  target: string;
  side: "before" | "after";
}

export function movePanel(order: readonly string[], { key, target, side }: PanelMove): string[] {
  if (key === target) return [...order];
  const next = order.filter((k) => k !== key);
  const at = next.indexOf(target);
  if (at < 0) return [...order];
  next.splice(side === "before" ? at : at + 1, 0, key);
  return next;
}
