import type { ShareItems, ShareScope, ShareScopeKind } from "../../api/shares";

export const SCOPE_KINDS: { kind: ShareScopeKind; label: string; one: string; many: string }[] = [
  { kind: "reviews", label: "Code review", one: "review", many: "reviews" },
  { kind: "designs", label: "Designs", one: "design", many: "designs" },
  { kind: "sketches", label: "Sketches", one: "sketch", many: "sketches" },
  { kind: "files", label: "Files", one: "file", many: "files" },
];

export interface ScopeItem {
  id: string;
  name: string;
  /** For a file: the folder it is in, with a trailing slash; "" at the top. */
  folder?: string;
}

export function scopeItemsOf(items: ShareItems, kind: ShareScopeKind): ScopeItem[] {
  if (kind === "files") {
    return items.files.map((path) => {
      const cut = path.lastIndexOf("/");
      return { id: path, name: path.slice(cut + 1), folder: cut >= 0 ? path.slice(0, cut + 1) : "" };
    });
  }
  return items[kind];
}

/** How many of a kind's items a scope takes. */
export function chosenCount(scope: ShareScope | null, items: ShareItems, kind: ShareScopeKind): number {
  const all = scopeItemsOf(items, kind);
  const chosen = scope?.[kind];
  return chosen === undefined ? all.length : all.filter((item) => chosen.includes(item.id)).length;
}

/** "Whole task", or what the link shows: "All designs · 1 file". */
export function scopeSummary(scope: ShareScope | null, items: ShareItems | null): string {
  if (!scope) return "Whole task";
  if (!items) return "Part of the task";
  const parts: string[] = [];
  for (const { kind, label, one, many } of SCOPE_KINDS) {
    const total = scopeItemsOf(items, kind).length;
    const count = chosenCount(scope, items, kind);
    if (total === 0 || count === 0) continue;
    parts.push(scope[kind] === undefined ? `All ${label.toLowerCase()}` : `${count} ${count === 1 ? one : many}`);
  }
  return parts.length === 0 ? "Nothing" : parts.join(" · ");
}

/** What to save: no scope when every kind is whole; a kind with nothing in
 *  it yet stays out once anything is narrowed, so later additions don't
 *  appear on their own. */
export function finishScope(draft: ShareScope, items: ShareItems): ShareScope | null {
  const kinds = SCOPE_KINDS.map(({ kind }) => kind);
  if (kinds.every((kind) => draft[kind] === undefined)) return null;
  const scope: ShareScope = { ...draft };
  for (const kind of kinds) {
    if (scopeItemsOf(items, kind).length === 0 && scope[kind] === undefined) scope[kind] = [];
  }
  return scope;
}

/** The kinds a task has anything of: "Designs · Sketches · Files". */
export function scopeKindsText(items: ShareItems | null): string {
  if (!items) return "";
  return SCOPE_KINDS.filter(({ kind }) => scopeItemsOf(items, kind).length > 0).map(({ label }) => label).join(" · ");
}
