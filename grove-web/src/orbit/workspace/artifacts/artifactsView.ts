// View model for the Orbit Artifacts body: folder navigation over the flat
// recursive listing, search / kind filter / sort, folder totals, and the
// windowing math that keeps thousands of files cheap to render.
import type { ArtifactFile, ArtifactsResponse } from "../../../api";
import { fileKind } from "../../studio/studioView";
import { parentPath } from "../../../components/Tasks/TaskInfoPanel/tabs/artifactsModel";

/** `output` = files the agent wrote, `input` = files the user gave it, `linked` = linked host folders. */
export type ArtifactSource = "output" | "input" | "linked";
export type ArtifactSort = "recent" | "name" | "size";
export type ArtifactView = "list" | "grid";
export type KindFilter = "all" | "image" | "doc" | "code" | "other";

export const KIND_LABELS: Record<Exclude<KindFilter, "all">, string> = {
  image: "Images",
  doc: "Docs",
  code: "Code",
  other: "Other",
};

const KIND_ORDER: Exclude<KindFilter, "all">[] = ["image", "doc", "code", "other"];

export interface FolderTotals {
  /** Files anywhere below the folder. */
  files: number;
  bytes: number;
  /** Newest modification below the folder (ms), 0 when unknown. */
  latest: number;
}

export interface FolderIndex {
  totals: Map<string, FolderTotals>;
  /** Every folder path in the listing ("" is the root). */
  folders: Set<string>;
}

export interface ArtifactEntry {
  file: ArtifactFile;
  /** Path below the folder being viewed; differs from the name for search hits in subfolders. */
  rel: string;
}

export function filterKind(name: string): Exclude<KindFilter, "all"> {
  const kind = fileKind(name);
  if (kind === "image") return "image";
  if (kind === "doc" || kind === "pdf" || kind === "sheet" || kind === "slides") return "doc";
  if (kind === "code") return "code";
  return "other";
}

function timeOf(file: ArtifactFile): number {
  const ms = file.modified_at ? new Date(file.modified_at).getTime() : 0;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Recursive totals for every folder in one pass (O(files × depth)). */
export function indexFolders(files: ArtifactFile[]): FolderIndex {
  const totals = new Map<string, FolderTotals>();
  const folders = new Set<string>([""]);
  const bump = (path: string, file: ArtifactFile) => {
    const entry = totals.get(path) ?? { files: 0, bytes: 0, latest: 0 };
    entry.files += 1;
    entry.bytes += file.size;
    entry.latest = Math.max(entry.latest, timeOf(file));
    totals.set(path, entry);
  };
  for (const file of files) {
    if (file.is_dir) {
      folders.add(file.path);
      continue;
    }
    let dir = parentPath(file.path);
    bump(dir, file);
    while (dir !== "") {
      dir = parentPath(dir);
      bump(dir, file);
    }
  }
  return { totals, folders };
}

export function totalsFor(index: FolderIndex, path: string): FolderTotals {
  return index.totals.get(path) ?? { files: 0, bytes: 0, latest: 0 };
}

/** The deepest folder of `path` that still exists (a folder can vanish between refreshes). */
export function existingFolder(path: string, index: FolderIndex): string {
  let current = path;
  while (current !== "" && !index.folders.has(current)) current = parentPath(current);
  return current;
}

function isBelow(path: string, folder: string): boolean {
  return folder === "" ? true : path.startsWith(`${folder}/`);
}

function relativeTo(path: string, folder: string): string {
  return folder === "" ? path : path.slice(folder.length + 1);
}

/**
 * What the folder shows before the kind filter: its direct children, or with a
 * query, every file and folder anywhere below it whose name matches.
 */
export function scopeEntries(files: ArtifactFile[], folder: string, query: string): ArtifactEntry[] {
  const q = query.trim().toLowerCase();
  const out: ArtifactEntry[] = [];
  for (const file of files) {
    if (q) {
      if (isBelow(file.path, folder) && file.name.toLowerCase().includes(q)) {
        out.push({ file, rel: relativeTo(file.path, folder) });
      }
    } else if (parentPath(file.path) === folder) {
      out.push({ file, rel: file.name });
    }
  }
  return out;
}

/** Counts per kind among the scope's files, in display order, omitting empty kinds. */
export function kindCounts(entries: ArtifactEntry[]): { kind: Exclude<KindFilter, "all">; count: number }[] {
  const counts = new Map<Exclude<KindFilter, "all">, number>();
  for (const { file } of entries) {
    if (file.is_dir) continue;
    const kind = filterKind(file.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind)! }));
}

const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

/** Kind filter, then sort: folders first, then by the chosen key (name breaks ties). */
export function arrangeEntries(
  entries: ArtifactEntry[],
  { kind, sort }: { kind: KindFilter; sort: ArtifactSort },
  index: FolderIndex,
): ArtifactEntry[] {
  const filtered = kind === "all"
    ? entries.slice()
    : entries.filter(({ file }) => !file.is_dir && filterKind(file.name) === kind);
  const sizeOf = (file: ArtifactFile) => (file.is_dir ? totalsFor(index, file.path).bytes : file.size);
  const recentOf = (file: ArtifactFile) => (file.is_dir ? Math.max(totalsFor(index, file.path).latest, timeOf(file)) : timeOf(file));
  return filtered.sort((a, b) => {
    if (a.file.is_dir !== b.file.is_dir) return a.file.is_dir ? -1 : 1;
    let diff = 0;
    if (sort === "recent") diff = recentOf(b.file) - recentOf(a.file);
    else if (sort === "size") diff = sizeOf(b.file) - sizeOf(a.file);
    return diff !== 0 ? diff : collator.compare(a.rel, b.rel);
  });
}

export function breadcrumbTrail(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** Open on the agent's output when it has written anything, else on the user's uploads. */
export function defaultSource(listing: Pick<ArtifactsResponse, "input" | "output">): ArtifactSource {
  const hasFiles = (files: ArtifactFile[]) => files.some((file) => !file.is_dir);
  if (hasFiles(listing.output)) return "output";
  return hasFiles(listing.input) ? "input" : "output";
}

export function fileCount(files: ArtifactFile[]): number {
  let count = 0;
  for (const file of files) if (!file.is_dir) count += 1;
  return count;
}

/** Grid columns that fit `width` with tiles at least `minTile` wide. */
export function gridColumns(width: number, minTile: number, gap: number): number {
  if (width <= 0) return 2;
  return Math.max(2, Math.floor((width + gap) / (minTile + gap)));
}

/** Rows to mount for a scroll position: the visible window plus `overscan` rows each side. */
export function windowRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  if (count === 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(viewport, rowHeight) / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start: Math.min(start, end), end };
}

/** The files a drag starting on `file` carries: every selected file when the
 * row is part of the selection (folders stay out, as for a single drag). */
export function artifactDragFiles(
  file: ArtifactFile,
  selection: { has: (path: string) => boolean; files: readonly ArtifactFile[] },
): ArtifactFile[] {
  if (!selection.has(file.path)) return [file];
  const files = selection.files.filter((item) => !item.is_dir);
  return files.length > 0 ? files : [file];
}
