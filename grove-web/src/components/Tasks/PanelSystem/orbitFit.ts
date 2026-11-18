// Orbit free layout: the smallest size a layout can take before its panels
// stop working. The minimums are the docked layout's (orbitDock.ts), so both
// layouts give a panel the same room. Where the workspace is smaller than a
// layout's minimum, Orbit shows the docked layout instead (TaskView).

import type { IJsonModel, IJsonRowNode, IJsonTabSetNode } from "flexlayout-react";
import { ORBIT_BOTTOM_MIN, ORBIT_CHAT_MIN, ORBIT_SIDE_MIN } from "../IDELayout/orbitDock";

/** Orbit draws hairline splitters. */
export const ORBIT_FREE_SPLITTER = 1;
export const ORBIT_FREE_MIN_WIDTH = ORBIT_SIDE_MIN;
export const ORBIT_FREE_MIN_HEIGHT = ORBIT_BOTTOM_MIN;

export function flexLayoutStorageKey(projectId: string, taskId: string): string {
  return `grove-flexlayout-${projectId}-${taskId}`;
}

export function readSavedFlexLayout(projectId: string, taskId: string): IJsonModel | null {
  try {
    const raw = localStorage.getItem(flexLayoutStorageKey(projectId, taskId));
    return raw ? (JSON.parse(raw) as IJsonModel) : null;
  } catch {
    return null;
  }
}

type LayoutNode = IJsonRowNode | IJsonTabSetNode;

/** A tabset holding an Agent is as wide as the Agent needs. */
export function tabsetHoldsAgent(children: readonly { component?: string }[] | undefined): boolean {
  return (children ?? []).some((tab) => tab.component === "chat");
}

function nodeMin(node: LayoutNode, horizontal: boolean): { w: number; h: number } {
  if (node.type === "tabset") {
    const tabset = node as IJsonTabSetNode;
    if (!tabset.children?.length) return { w: 0, h: 0 };
    return { w: tabsetHoldsAgent(tabset.children) ? ORBIT_CHAT_MIN : ORBIT_FREE_MIN_WIDTH, h: ORBIT_FREE_MIN_HEIGHT };
  }
  // A row lays out across its parent's direction.
  const parts = ((node as IJsonRowNode).children ?? []).map((child) => nodeMin(child as LayoutNode, !horizontal)).filter((m) => m.w > 0);
  if (parts.length === 0) return { w: 0, h: 0 };
  const splitters = (parts.length - 1) * ORBIT_FREE_SPLITTER;
  return horizontal
    ? { w: parts.reduce((s, m) => s + m.w, 0) + splitters, h: Math.max(...parts.map((m) => m.h)) }
    : { w: Math.max(...parts.map((m) => m.w)), h: parts.reduce((s, m) => s + m.h, 0) + splitters };
}

/** The smallest workspace a free layout fits in; 0×0 for an empty one. */
export function freeLayoutMinSize(json: IJsonModel | null | undefined): { w: number; h: number } {
  if (!json?.layout) return { w: 0, h: 0 };
  return nodeMin(json.layout, !json.global?.rootOrientationVertical);
}

/** Per-tabset minimums are set at run time in Orbit; they aren't saved with the layout. */
export function stripTabsetMins(node: LayoutNode | undefined): void {
  if (!node) return;
  if (node.type === "tabset") {
    delete (node as IJsonTabSetNode).minWidth;
    delete (node as IJsonTabSetNode).minHeight;
    return;
  }
  for (const child of (node as IJsonRowNode).children ?? []) stripTabsetMins(child as LayoutNode);
}
