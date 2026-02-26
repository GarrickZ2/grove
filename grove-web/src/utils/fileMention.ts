// Shared utilities for @ file mention feature (used by Chat and Notes)

export interface MentionItem {
  path: string;
  isDir: boolean;
}

export interface FilteredMentionItem extends MentionItem {
  score: number;
  indices: number[];
}

/** Fuzzy match a query against a target string */
export function fuzzyMatch(
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
export function extractDirectories(files: string[]): string[] {
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
      const { match, score, indices } = fuzzyMatch(query, item.path);
      return { ...item, score, indices, match };
    })
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
