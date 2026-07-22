/**
 * Repair a common agent-generated strong-emphasis form such as
 * `**Result: **value`. CommonMark rejects whitespace immediately inside the
 * closing delimiter; move that whitespace outside without touching code.
 */
export function normalizeStrongEmphasis(content: string): string {
  if (!content.includes("**")) return content;

  const fencedParts = content.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < fencedParts.length; i += 2) {
    const inlineParts = fencedParts[i].split(/(`[^`]*`)/g);
    for (let j = 0; j < inlineParts.length; j += 2) {
      inlineParts[j] = inlineParts[j]
        .replace(/\*\*\s+([^*\n]*?\S)\*\*/g, "**$1**")
        .replace(/\*\*([^*\n]*?\S)\s+\*\*/g, "**$1** ")
        // micromark does not consistently recognize `**` as a closing
        // delimiter when the content ends in CJK/full-width punctuation and
        // Chinese text follows immediately (e.g. `**标题：**正文`). Convert
        // only that boundary to equivalent HTML; rehype-sanitize still owns
        // the resulting element and content.
        .replace(
          /\*\*([^*\n]*?[\u3000-\u303f\uff00-\uff65])\*\*(?=[^\s*])/gu,
          "<strong>$1</strong>",
        );
    }
    fencedParts[i] = inlineParts.join("");
  }

  return fencedParts.join("");
}
