// View helpers for the Orbit Studio page: thumbnails, card hints, menus.
import type { ResourceFile, WorkDirectoryEntry } from "../../api";
import { hostnameOf, isLinkFile, linkDisplayName } from "../../components/ui/linkFile";
import { INSTRUCTION_TEMPLATES } from "../../components/Studio/resourceModel";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

export type FileKind = "image" | "doc" | "sheet" | "slides" | "pdf" | "sketch" | "code" | "media" | "archive" | "link" | "other";

const KIND_BY_EXT: Record<string, FileKind> = {
  md: "doc", mdx: "doc", txt: "doc", rtf: "doc", doc: "doc", docx: "doc", pages: "doc",
  csv: "sheet", tsv: "sheet", xls: "sheet", xlsx: "sheet", numbers: "sheet",
  ppt: "slides", pptx: "slides", key: "slides",
  pdf: "pdf",
  excalidraw: "sketch", fig: "sketch", sketch: "sketch", psd: "sketch", ai: "sketch",
  json: "code", js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", rs: "code", html: "code", css: "code", yml: "code", yaml: "code", toml: "code", xml: "code", sh: "code",
  mp4: "media", mov: "media", webm: "media", mp3: "media", wav: "media", m4a: "media",
  zip: "archive", gz: "archive", tar: "archive", rar: "archive", "7z": "archive",
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Broad file kind, used to tint a tile's thumbnail. */
export function fileKind(name: string): FileKind {
  if (isLinkFile(name)) return "link";
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  return KIND_BY_EXT[ext] ?? "other";
}

/** Short badge on the thumbnail: "PNG", "MD", "LINK"; none for extensionless files. */
export function extLabel(name: string): string {
  if (isLinkFile(name)) return "LINK";
  return extOf(name).toUpperCase().slice(0, 6);
}

export function tileTitle(file: ResourceFile): string {
  return isLinkFile(file.name) ? linkDisplayName(file.name) : file.name;
}

/** Second line under a link tile: its host. */
export function linkHost(file: ResourceFile): string {
  return file.url ? hostnameOf(file.url) : "External link";
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Card hint: what's at this level, e.g. "8 files · 3 folders · 1 linked". */
export function libraryCounts(files: ResourceFile[], workdirs: WorkDirectoryEntry[], atRoot: boolean): string {
  const fileCount = files.filter((file) => !file.is_dir).length;
  const folderCount = files.length - fileCount;
  const parts = [plural(fileCount, "file", "files")];
  if (folderCount > 0) parts.push(plural(folderCount, "folder", "folders"));
  if (atRoot && workdirs.length > 0) parts.push(`${workdirs.length} linked`);
  return parts.join(" · ");
}

/** Templates not yet in the instructions (matched by their heading line). */
export function availableTemplates(instructions: string) {
  return INSTRUCTION_TEMPLATES.filter((template) => {
    const heading = template.content.split("\n")[0];
    return !instructions.includes(heading);
  });
}

/** Opening / revealing a file runs on the Grove host; remote clients can't see it. */
export function hostFileActionsAvailable(): boolean {
  return typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ !== true;
}

export function revealLabel(): string {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent) ? "Show in Finder" : "Show in File Manager";
}

/** A point to open a menu at; `alignEnd` lines its right edge up with x, `flipY` is where it ends when it opens upward. */
export interface MenuAnchor {
  x: number;
  y: number;
  alignEnd?: boolean;
  flipY?: number;
}

/** Where a menu opened at (x, y) should sit so it stays on screen. */
export function placeMenu(
  at: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const rawLeft = at.alignEnd ? at.x - size.width : at.x;
  const left = Math.max(margin, Math.min(rawLeft, viewport.width - size.width - margin));
  const fitsBelow = at.y + size.height + margin <= viewport.height;
  const top = fitsBelow ? at.y : Math.max(margin, (at.flipY ?? at.y) - size.height);
  return { left, top };
}
