/**
 * 3-tier fuzzy match: exact → substring → token overlap.
 * Returns the best match or undefined if nothing matches.
 */
export function fuzzyFindByName<T>(
  items: T[],
  getName: (item: T) => string,
  query: string
): T | undefined {
  const search = query.toLowerCase().trim();
  if (!search) return undefined;

  // 1. Exact match
  const exact = items.find((item) => getName(item).toLowerCase().trim() === search);
  if (exact) return exact;

  // 2. Substring match (name contains query; reverse only when name is long
  //    enough to avoid false positives from single-word project names)
  const substring = items.find((item) => {
    const name = getName(item).toLowerCase();
    return name.includes(search) || (name.length >= 3 && search.includes(name));
  });
  if (substring) return substring;

  // 3. Token overlap match (skip single-char tokens to avoid false positives)
  const searchTokens = search.split(/[\s_-]+/).filter((t) => t.length >= 2);
  let bestItem: T | undefined;
  let maxOverlap = 0;
  for (const item of items) {
    const nameTokens = getName(item).toLowerCase().split(/[\s_-]+/).filter((t) => t.length >= 2);
    const overlap = searchTokens.filter((token) => nameTokens.includes(token)).length;
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestItem = item;
    }
  }
  return maxOverlap > 0 ? bestItem : undefined;
}
