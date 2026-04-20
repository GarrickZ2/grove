// Shared utilities for @ file mention feature (used by Chat and Notes)

export interface MentionItem {
  path: string;
  isDir: boolean;
  /**
   * Friendly label shown to the user. Defaults to `path`. For Studio-categorized
   * items this is the human-readable name (filename without prefix, sketch name,
   * "Instruction", etc.) that should also appear inside the chat chip.
   */
  displayName?: string;
  /**
   * Category badge shown in the dropdown (e.g. "Input", "Sketch", "Memory").
   * Absent for generic file mentions.
   */
  category?: string;
}

export interface FilteredMentionItem extends MentionItem {
  score: number;
  indices: number[];
}

/** Fuzzy match a query against a target string */
function fuzzyMatch(
  query: string,
  target: string,
): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  const indices: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === lastMatchIndex + 1 ? 2 : 1;
      if (ti === 0 || t[ti - 1] === "/") score += 3;
      lastMatchIndex = ti;
      indices.push(ti);
      qi++;
    }
  }

  return { match: qi === q.length, score, indices };
}

/** Extract unique directory paths from a flat file list */
function extractDirectories(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return Array.from(dirs).sort();
}

/** Build mention items: directories first, then files */
export function buildMentionItems(files: string[]): MentionItem[] {
  const dirs = extractDirectories(files);
  const dirItems: MentionItem[] = dirs.map((d) => ({ path: d, isDir: true }));
  const fileItems: MentionItem[] = files.map((f) => ({ path: f, isDir: false }));
  return [...dirItems, ...fileItems];
}

/** Filter mention items by fuzzy query, return top results sorted by score */
export function filterMentionItems(
  items: MentionItem[],
  query: string,
  limit = 15,
): FilteredMentionItem[] {
  if (!query) {
    return items.slice(0, limit).map((item) => ({
      ...item,
      score: 0,
      indices: [],
    }));
  }
  return items
    .map((item) => {
      // Match on the displayed text when present — keeps the highlight indices
      // aligned with what the user is actually typing against.
      const target = item.displayName ?? item.path;
      const { match, score, indices } = fuzzyMatch(query, target);
      return { ...item, score, indices, match };
    })
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Metadata needed to resolve sketch dir names in Studio mention items. */
export interface SketchNameMeta {
  id: string;
  name: string;
}

/**
 * Build the Studio-specific mention list. Files are grouped into Instruction /
 * Memory / Input / Output / Shared Resource / Sketch, each surfaced under a
 * friendly display name while `path` still points at the real file the agent
 * will read.
 *
 * Files that are purely agent-internal (AGENTS.md, CLAUDE.md, GEMINI.md,
 * internal/, scripts/) are hidden — they aren't user-authored content.
 */
export function buildStudioMentionItems(
  files: string[],
  sketches: SketchNameMeta[],
): MentionItem[] {
  const items: MentionItem[] = [];
  const seenSketchDirs = new Set<string>();
  const sketchNameById = new Map(sketches.map((s) => [s.id, s.name] as const));

  const stripPrefix = (path: string, prefix: string) =>
    path.startsWith(prefix) ? path.slice(prefix.length) : path;

  const pushed = new Set<string>();
  const push = (item: MentionItem) => {
    const key = `${item.category ?? ""}::${item.path}`;
    if (pushed.has(key)) return;
    pushed.add(key);
    items.push(item);
  };

  for (const file of files) {
    if (file === "instructions.md") {
      push({ path: file, isDir: false, displayName: "Instruction", category: "Instruction" });
      continue;
    }
    if (file === "memory.md") {
      push({ path: file, isDir: false, displayName: "Memory", category: "Memory" });
      continue;
    }
    // Agent-protocol files: not user content, hide from @ mentions.
    if (file === "AGENTS.md" || file === "CLAUDE.md" || file === "GEMINI.md") {
      continue;
    }
    // Private workspace & scratch: hide.
    if (file.startsWith("internal/") || file.startsWith("scripts/")) {
      continue;
    }
    if (file.startsWith("input/")) {
      const name = stripPrefix(file, "input/");
      if (name) push({ path: file, isDir: false, displayName: name, category: "Input" });
      continue;
    }
    if (file.startsWith("output/")) {
      const name = stripPrefix(file, "output/");
      if (name) push({ path: file, isDir: false, displayName: name, category: "Output" });
      continue;
    }
    if (file.startsWith("resource/")) {
      const name = stripPrefix(file, "resource/");
      if (name) push({ path: file, isDir: false, displayName: name, category: "Shared Resource" });
      continue;
    }
    if (file.startsWith("sketch/")) {
      // Surface one entry per sketch *directory*, labelled by the user-assigned
      // sketch name. Skip every nested file so the list stays compact, and
      // skip `sketch/index.json` (the sketches registry — not a sketch itself).
      const rest = file.slice("sketch/".length);
      const dirSegment = rest.split("/")[0];
      if (!dirSegment || !dirSegment.startsWith("sketch-")) continue;
      const dirPath = `sketch/${dirSegment}`;
      if (seenSketchDirs.has(dirPath)) continue;
      seenSketchDirs.add(dirPath);
      // Backend stores SketchMeta.id as the full "sketch-<uuid>" string —
      // use the dir segment directly as the lookup key.
      const friendly = sketchNameById.get(dirSegment) ?? dirSegment;
      push({ path: dirPath, isDir: true, displayName: friendly, category: "Sketch" });
      continue;
    }
    // Anything else (top-level misc) — leave it out; the Studio taxonomy is
    // intentionally curated.
  }

  return items;
}
