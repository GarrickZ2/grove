/**
 * Model + persistence + migration for the Blitz FlexLayout workspace.
 *
 * Each FlexLayout tab is one pinned chat. The tab's `config` carries the
 * full coordinates ({project, task, chat}) so the factory can render the
 * right `<TaskChat pinnedChatId>` per tab — unlike the single-task
 * FlexLayoutContainer whose factory hardcodes one task.
 *
 * Storage:
 *   - New: `grove:blitz-flexlayout` holds the serialized IJsonModel.
 *   - Legacy: `grove:blitz-grid` (the fixed-preset grid) is migrated once
 *     into the new model so existing users keep their panes, then left in
 *     place as a harmless fallback.
 */
import { Model } from "flexlayout-react";
import type { IJsonModel, IJsonRowNode, IJsonTabSetNode, IJsonTabNode } from "flexlayout-react";
import type { GridLayout, SlotAssignment } from "./useBlitzGrid";

export const BLITZ_FLEX_STORAGE_KEY = "grove:blitz-flexlayout";
const LEGACY_GRID_STORAGE_KEY = "grove:blitz-grid";

/** Per-tab config — the full coordinates of a pinned chat. */
export interface BlitzTabConfig {
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  /** Absent while `needsSession` (a dropped task awaiting a session pick). */
  chatId?: string;
  chatName?: string;
  /** True between a task-drop and the user choosing a session (Phase 2). */
  needsSession?: boolean;
}

export const BLITZ_TAB_COMPONENT = "blitz-chat";

/** dataTransfer MIME a dragged task carries so the canvas can accept it. */
export const GROVE_TASK_MIME = "application/x-grove-task";

const GLOBAL: IJsonModel["global"] = {
  tabEnableClose: true,
  tabEnableRename: false,
  tabSetEnableDeleteWhenEmpty: true,
  tabSetEnableDrop: true,
  tabSetEnableDrag: true,
  tabSetEnableDivide: true,
  tabSetEnableMaximize: true,
  splitterSize: 6,
};

function emptyModel(): IJsonModel {
  return { global: GLOBAL, borders: [], layout: { type: "row", weight: 100, children: [] } };
}

/**
 * Build a tab node from a pinned-chat config. Intentionally omits `id` so
 * FlexLayout generates a unique one — deriving the id from chatId would throw
 * `duplicate id` if the same chat were pinned twice. We identify a chat's tab
 * by `config.chatId` instead (see addChat / migration dedup).
 */
export function tabNodeFor(cfg: BlitzTabConfig): IJsonTabNode {
  return {
    type: "tab",
    name: cfg.chatName || cfg.taskName,
    component: BLITZ_TAB_COMPONENT,
    config: cfg,
    enableClose: true,
  };
}

function tabSetWith(cfg: BlitzTabConfig): IJsonTabSetNode {
  return { type: "tabset", weight: 100, children: [tabNodeFor(cfg)] };
}

/** Like tabNodeFor but preserves an existing tab id (used when re-tiling so
 *  panels keep their identity and chats don't remount/reconnect). */
function tabNodeWithId(id: string, cfg: BlitzTabConfig): IJsonTabNode {
  return {
    type: "tab",
    id,
    name: cfg.chatName || cfg.taskName,
    component: BLITZ_TAB_COMPONENT,
    config: cfg,
    enableClose: true,
  };
}

/** A currently-open tab: its FlexLayout-generated id + pinned-chat config. */
export interface OpenTab {
  id: string;
  config: BlitzTabConfig;
}

/**
 * Rebuild the model laying the given tabs into `cols` balanced columns
 * (round-robin so columns stay even), equal weights throughout. Each tab keeps
 * its existing id, so swapping to this model reconciles the panels rather than
 * remounting them — pinned chats stay connected across a re-tile.
 */
export function buildColumnsModelJson(tabs: OpenTab[], cols: number): IJsonModel {
  if (tabs.length === 0) return emptyModel();
  const colCount = Math.max(1, Math.min(cols, tabs.length));
  const columns: OpenTab[][] = Array.from({ length: colCount }, () => []);
  tabs.forEach((t, i) => columns[i % colCount].push(t));
  const children = columns
    .filter((col) => col.length > 0)
    .map((col) => {
      const tabsets: IJsonTabSetNode[] = col.map((t) => ({
        type: "tabset",
        weight: 100,
        children: [tabNodeWithId(t.id, t.config)],
      }));
      return tabsets.length === 1
        ? tabsets[0]
        : ({ type: "row", weight: 100, children: tabsets } as IJsonRowNode);
    });
  return { global: GLOBAL, borders: [], layout: { type: "row", weight: 100, children } };
}

/** Columns × rows for each legacy preset. */
function shapeFor(layout: GridLayout): { cols: number; rows: number } {
  switch (layout) {
    case "1": return { cols: 1, rows: 1 };
    case "2": return { cols: 2, rows: 1 };
    case "2x2": return { cols: 2, rows: 2 };
    case "3x2": return { cols: 3, rows: 2 };
  }
}

/**
 * Recreate a layout tree from legacy grid assignments. Non-null assignments
 * are chunked into columns of `rows` tabsets each, approximating the old
 * grid shape (a full 2×2 reconstructs exactly; gaps compact). FlexLayout
 * alternates orientation by nesting depth, so the root row is horizontal and
 * each child row stacks its tabsets vertically.
 */
function layoutFromAssignments(
  assignments: Array<SlotAssignment | null>,
  layout: GridLayout,
): IJsonRowNode {
  // Dedup by chatId — legacy state could pin the same chat in multiple slots,
  // which would otherwise produce duplicate panels (and previously crashed on
  // duplicate node ids). Keep the first occurrence.
  const seen = new Set<string>();
  const items = assignments
    .filter((a): a is SlotAssignment => a !== null)
    .filter((a) => (seen.has(a.chatId) ? false : (seen.add(a.chatId), true)));
  if (items.length === 0) return { type: "row", weight: 100, children: [] };

  const { rows } = shapeFor(layout);
  const columns: IJsonTabSetNode[][] = [];
  items.forEach((item, i) => {
    const col = Math.floor(i / rows);
    (columns[col] ??= []).push(tabSetWith(item));
  });

  const children = columns.map((col) =>
    col.length === 1 ? col[0] : ({ type: "row", weight: 100, children: col } as IJsonRowNode),
  );
  return { type: "row", weight: 100, children };
}

function migrateLegacy(raw: string): IJsonModel | null {
  let parsed: { layout?: GridLayout; assignments?: Array<SlotAssignment | null> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const layout: GridLayout = parsed.layout ?? "2x2";
  const assignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];
  const tree = layoutFromAssignments(assignments, layout);
  if (tree.children.length === 0) return null;
  return { global: GLOBAL, borders: [], layout: tree };
}

/** Recursively drop the transient `maximized` flag before persisting. */
function stripMaximized(node: { maximized?: boolean; children?: unknown[] }): void {
  if (node.maximized) delete node.maximized;
  if (Array.isArray(node.children)) {
    for (const c of node.children) stripMaximized(c as { maximized?: boolean; children?: unknown[] });
  }
}

function parseSavedJson(raw: string): IJsonModel | null {
  try {
    const json = JSON.parse(raw) as IJsonModel;
    if (!json.global) json.global = GLOBAL;
    return json;
  } catch {
    return null;
  }
}

/** Construct a Model from JSON, returning null instead of throwing on invalid
 *  data (e.g. duplicate ids from a previous buggy write). */
function safeModel(json: IJsonModel | null): Model | null {
  if (!json) return null;
  try {
    return Model.fromJson(json);
  } catch (err) {
    console.warn("[blitzFlex] discarding invalid layout", err);
    return null;
  }
}

/**
 * Build the initial Model: saved → migrated-from-legacy → empty. Never throws —
 * a corrupt saved layout is validated, discarded, and removed so grid mode
 * can't be bricked by bad localStorage.
 */
export function createInitialModel(): Model {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(BLITZ_FLEX_STORAGE_KEY);
      if (saved) {
        const m = safeModel(parseSavedJson(saved));
        if (m) return m;
        try {
          window.localStorage.removeItem(BLITZ_FLEX_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn("[blitzFlex] failed to read saved layout", err);
    }
    try {
      const legacy = window.localStorage.getItem(LEGACY_GRID_STORAGE_KEY);
      if (legacy) {
        const m = safeModel(migrateLegacy(legacy));
        if (m) return m;
      }
    } catch (err) {
      console.warn("[blitzFlex] legacy migration failed", err);
    }
  }
  return Model.fromJson(emptyModel());
}

/** Serialize + persist a model's JSON to localStorage (maximized stripped). */
export function persistModelJson(json: IJsonModel): void {
  if (typeof window === "undefined") return;
  try {
    stripMaximized(json.layout);
    window.localStorage.setItem(BLITZ_FLEX_STORAGE_KEY, JSON.stringify(json));
  } catch (err) {
    console.warn("[blitzFlex] failed to persist layout", err);
  }
}
