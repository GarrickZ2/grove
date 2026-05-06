import type { TocEntry } from "./MarkdownToc";
import { createSlugger } from "./headingSlug";

// ATX-style headings only (`# foo` … `###### foo`). Setext underlines
// (`====` / `----`) are not handled — Grove content is agent-emitted and
// uses ATX exclusively.
export function extractToc(content: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const slug = createSlugger();
  // Track open fence char so a `~~~` block isn't closed by a stray ``` and
  // single-line code spans don't toggle the fence permanently.
  const fenceRe = /^( {0,3})(`{3,}|~{3,})/;
  let fenceChar: string | null = null;
  for (const line of content.split("\n")) {
    const fenceMatch = line.match(fenceRe);
    if (fenceMatch) {
      const ch = fenceMatch[2][0];
      if (fenceChar === null) fenceChar = ch;
      else if (fenceChar === ch) fenceChar = null;
      continue;
    }
    if (fenceChar) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const level = match[1].length;
    // Match what `MarkdownRenderer` sees post-react-markdown: link / image
    // syntax becomes its label, so the slug must too.
    const text = match[2]
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, "")
      .trim();
    entries.push({ id: slug(text), text, level });
  }
  return entries;
}
