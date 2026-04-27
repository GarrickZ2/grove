// Shared utilities for @ file mention feature (used by Chat and Notes)

/**
 * Discriminator for the mention dropdown item kind. Files (default) coexist
 * with three agent-graph kinds (spawn / send / reply) inside the same `@`
 * popover so the user picks one entry-point per `@`.
 */
export type MentionKind = "file" | "agent_spawn" | "agent_send" | "agent_reply";

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
  /** Mention kind. Defaults to "file" when omitted. */
  kind?: MentionKind;
  /** Agent-graph: session id (kinds: agent_send / agent_reply). */
  sessionId?: string;
  /** Agent-graph: pending-message id (kind: agent_reply). */
  msgId?: string;
  /** Agent-graph: target session duty hint (kind: agent_send). */
  duty?: string;
  /** Agent-graph: short body excerpt for pending replies. */
  bodyPreview?: string;
  /** Agent-graph: agent id used by the spawn template (kind: agent_spawn). */
  agentName?: string;
  /** Agent-graph: agent icon id when known (kind: agent_spawn). */
  agentIconId?: string;
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

/**
 * Build agent-graph mention items from a `mention-candidates` response.
 * Order matters: pending replies first (most urgent — someone is waiting on
 * caller), then outgoing (existing reachable sessions), then spawn agents.
 *
 * Name collision rule: when an agent shares a name with an existing session,
 * the session is sorted before the agent so it gets default highlight.
 */
/**
 * Build agent-graph @-mention items.
 *
 * Spawn candidates are passed in by the caller from `acpAgentOptions` (the
 * same source the "New chat" picker uses) so icons and labels are
 * automatically aligned with the rest of the UI — no second list to keep in
 * sync with skills builtins.
 */
export function buildAgentMentionItems(input: {
  spawnAgents: { value: string; label: string }[];
  outgoing: { session_id: string; name: string; agent: string; duty?: string }[];
  pending_replies: {
    session_id: string;
    name: string;
    agent: string;
    msg_id: string;
    body_preview: string;
  }[];
}): MentionItem[] {
  const items: MentionItem[] = [];

  for (const p of input.pending_replies) {
    items.push({
      kind: "agent_reply",
      path: `@${p.name}`, // synthetic key for de-dup
      isDir: false,
      displayName: p.name,
      category: "Pending reply",
      sessionId: p.session_id,
      msgId: p.msg_id,
      bodyPreview: p.body_preview,
      agentName: p.agent,
    });
  }

  for (const o of input.outgoing) {
    items.push({
      kind: "agent_send",
      path: `@@${o.name}-${o.session_id}`,
      isDir: false,
      displayName: o.name,
      category: "Send to session",
      sessionId: o.session_id,
      duty: o.duty,
      agentName: o.agent,
    });
  }

  for (const a of input.spawnAgents) {
    items.push({
      kind: "agent_spawn",
      path: `@spawn-${a.value}`,
      isDir: false,
      displayName: a.label,
      category: "Spawn agent",
      agentName: a.value,
    });
  }

  return items;
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
const LINK_SUFFIX = ".link.json";

/** Strip the `.link.json` sidecar suffix so mention chips show a clean name. */
function stripLinkSuffix(name: string): string {
  return name.toLowerCase().endsWith(LINK_SUFFIX)
    ? name.slice(0, name.length - LINK_SUFFIX.length)
    : name;
}

function isLink(path: string): boolean {
  return path.toLowerCase().endsWith(LINK_SUFFIX);
}

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
      if (name.endsWith("/")) {
        // Directory symlink (working directory) — show as directory entry, don't expand.
        const dirName = name.slice(0, -1);
        if (dirName) {
          push({ path: file.slice(0, -1), isDir: true, displayName: dirName, category: "Input · Folder" });
        }
      } else if (name) {
        const linky = isLink(name);
        push({
          path: file,
          isDir: false,
          displayName: linky ? stripLinkSuffix(name) : name,
          category: linky ? "Input · Link" : "Input",
        });
      }
      continue;
    }
    if (file.startsWith("output/")) {
      const name = stripPrefix(file, "output/");
      if (name) {
        const linky = isLink(name);
        push({
          path: file,
          isDir: false,
          displayName: linky ? stripLinkSuffix(name) : name,
          category: linky ? "Output · Link" : "Output",
        });
      }
      continue;
    }
    if (file.startsWith("resource/")) {
      const name = stripPrefix(file, "resource/");
      if (name.endsWith("/")) {
        const dirName = name.slice(0, -1);
        if (dirName) {
          push({ path: file.slice(0, -1), isDir: true, displayName: dirName, category: "Shared Resource · Folder" });
        }
      } else if (name) {
        const linky = isLink(name);
        push({
          path: file,
          isDir: false,
          displayName: linky ? stripLinkSuffix(name) : name,
          category: linky ? "Shared Resource · Link" : "Shared Resource",
        });
      }
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
