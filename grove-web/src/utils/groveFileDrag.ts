// Internal file drags (FileTree, artifact rows, review sidebar) → the chat
// composer. One path travels as GROVE_FILE_DRAG_TYPE; several also travel as
// a JSON list, and the single type keeps the first path so older receivers
// still get something.

/** dataTransfer type carried by internal file drags: one path. */
export const GROVE_FILE_DRAG_TYPE = "application/x-grove-file-path";
/** dataTransfer type for a multi-file drag: a JSON array of paths, in order. */
export const GROVE_FILE_LIST_DRAG_TYPE = "application/x-grove-file-paths";
export const GROVE_FILE_IS_DIR_TYPE = "application/x-grove-file-is-dir";

/** Paths in order, without blanks or repeats. */
export function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function encodeGroveFileList(paths: readonly string[]): string {
  return JSON.stringify(uniquePaths(paths));
}

/** The paths of a list payload; empty for anything malformed. */
export function decodeGroveFileList(raw: string): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return uniquePaths(value.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

type DragData = Pick<DataTransfer, "getData">;
type DragWriter = Pick<DataTransfer, "setData">;

/** The files an internal drop carries, in order: the list if present, else the single path. */
export function groveDropPaths(data: DragData): string[] {
  const list = decodeGroveFileList(data.getData(GROVE_FILE_LIST_DRAG_TYPE));
  if (list.length > 0) return list;
  return uniquePaths([data.getData(GROVE_FILE_DRAG_TYPE)]);
}

/** Write a file drag of one or more (non-directory) paths. */
export function setGroveFileDrag(data: DragWriter, paths: readonly string[]): string[] {
  const unique = uniquePaths(paths);
  if (unique.length === 0) return unique;
  if (unique.length > 1) data.setData(GROVE_FILE_LIST_DRAG_TYPE, encodeGroveFileList(unique));
  data.setData(GROVE_FILE_DRAG_TYPE, unique[0]);
  data.setData(GROVE_FILE_IS_DIR_TYPE, "false");
  data.setData("text/plain", unique.join("\n"));
  return unique;
}

export function dragCarriesGroveFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === GROVE_FILE_DRAG_TYPE || types[i] === GROVE_FILE_LIST_DRAG_TYPE) return true;
  }
  return false;
}

// Browsers hide drag data until the drop; the count for "Drop 3 files" comes
// from the drag this window started.
let activeDragCount: number | null = null;

export function beginGroveFileDrag(count: number): void {
  activeDragCount = count;
}

export function endGroveFileDrag(): void {
  activeDragCount = null;
}

/** Files in the drag over a drop target: 1 when unknown (e.g. from another window). */
export function groveDragCount(types: ArrayLike<string> | null | undefined): number {
  if (!dragCarriesGroveFiles(types)) return 1;
  return activeDragCount ?? 1;
}
