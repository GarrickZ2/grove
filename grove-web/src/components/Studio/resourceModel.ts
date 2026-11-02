// Pure helpers behind the Studio resource library (shared files, linked
// folders, workspace instructions). Used by both the Workbench ResourcePage
// and the Orbit Studio page.
import type { ResourceFile, WorkDirectoryEntry } from "../../api";
import type { DisplayItem } from "../../api/studio-types";

/** dataTransfer type for an internal move drag (a resource path). */
export const DRAG_TYPE = "application/x-grove-resource-path";

export const INSTRUCTION_TEMPLATES = [
  {
    label: "Frontend Style Guide",
    content: `# Frontend style guide

- Keep layouts clean and high-signal
- Prefer consistent spacing and clear section hierarchy
- Preserve the established design language unless a page is explicitly being redesigned
- Avoid placeholder copy in final UI`,
  },
  {
    label: "Agent Behavior Rules",
    content: `# Agent behavior rules

- Be concise and execution-focused
- Prefer practical solutions over broad speculation
- Explain assumptions when they affect correctness
- Reference files in resource/ when they are relevant`,
  },
  {
    label: "Project Context",
    content: `# Project context

- This Studio shares files through resource/
- Instructions are available to every task as instructions.md
- Prefer using shared files before recreating context in each task`,
  },
];

export function countInstructionLines(text: string): number {
  if (!text.trim()) return 0;
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Appends a template after the current text (or replaces an empty one). */
export function appendTemplate(current: string, content: string): string {
  if (!current.trim()) return content;
  return `${current.trim()}\n\n${content}`;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

export function dropContainsDirectory(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items || [])) {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

/** "a/b/c" → "a/b"; top level → "". */
export function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** Breadcrumb trail for a folder path: [{ name, path }] from the top down. */
export function breadcrumbTrail(path: string): { name: string; path: string }[] {
  const segments = path.split("/").filter(Boolean);
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
}

/** Whether `fromPath` may be dropped into folder `toFolder` (not itself or its own subtree, and not where it already is). */
export function canMoveInto(fromPath: string, toFolder: string): boolean {
  if (!fromPath) return false;
  if (fromPath === toFolder || toFolder.startsWith(`${fromPath}/`)) return false;
  return parentPath(fromPath) !== toFolder;
}

function byName(a: string, b: string) {
  return a.localeCompare(b);
}

/** Files at this level matching `query`, folders first, then by name. */
export function filterFiles(files: ResourceFile[], query: string): ResourceFile[] {
  const q = query.toLowerCase();
  return files
    .filter((file) => file.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return byName(a.name, b.name);
    });
}

/** Linked folders and files in one list: folder-like first, then by name. */
export function mergeResourceItems(
  files: ResourceFile[],
  workdirs: WorkDirectoryEntry[],
  query: string,
): DisplayItem<ResourceFile>[] {
  const q = query.toLowerCase();
  const items: DisplayItem<ResourceFile>[] = [
    ...workdirs.filter((w) => w.name.toLowerCase().includes(q)).map<DisplayItem<ResourceFile>>((w) => ({ type: "workdir", data: w })),
    ...filterFiles(files, query).map<DisplayItem<ResourceFile>>((f) => ({ type: "file", data: f })),
  ];
  items.sort((a, b) => {
    const aIsDirLike = a.type === "workdir" || (a.type === "file" && a.data.is_dir);
    const bIsDirLike = b.type === "workdir" || (b.type === "file" && b.data.is_dir);
    if (aIsDirLike !== bIsDirLike) return aIsDirLike ? -1 : 1;
    return byName(a.data.name, b.data.name);
  });
  return items;
}

/** Totals over the plain files at this level. */
export function resourceStats(files: ResourceFile[]): { fileCount: number; totalBytes: number; latestUpdate: string | null } {
  const plain = files.filter((file) => !file.is_dir);
  const totalBytes = plain.reduce((sum, file) => sum + file.size, 0);
  const latestUpdate = plain.reduce<string | null>((latest, file) => {
    if (!latest) return file.modified_at;
    return new Date(file.modified_at) > new Date(latest) ? file.modified_at : latest;
  }, null);
  return { fileCount: plain.length, totalBytes, latestUpdate };
}
