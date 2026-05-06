// GitHub-style heading slugger: same base text gets `-1`, `-2` ... suffixes
// on second / third / Nth occurrence, so duplicate headings get unique ids.
// `extractToc` and the Markdown heading renderer must use the same slugger
// (constructed once per content / per render) so their ids match.

export function slugifyText(text: string): string {
  return text
    .replace(/[*_~`]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createSlugger() {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = slugifyText(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}
