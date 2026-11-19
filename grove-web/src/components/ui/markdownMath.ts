/**
 * Math in Markdown, with the rules Typora and Obsidian use (Pandoc's):
 *
 * - `$$…$$` is display math.
 * - `$…$` is inline math only when the opening `$` is not followed by a space,
 *   the closing `$` is not preceded by one, and no digit follows it. So
 *   "$5 and $10" and "$20,000" stay text.
 * - `\(…\)` and `\[…\]`, which chat models write, are read as `$…$` and
 *   `$$…$$`. `\[ \]` only as a block on its own lines, since `\[` is also how
 *   Markdown escapes a bracket.
 *
 * Code (fenced blocks and inline spans) is never touched.
 */
import type { Root, RootContent, Text } from "mdast";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Rewrite `\(…\)` and `\[…\]` as dollar math, outside code. */
export function convertLatexDelimiters(content: string): string {
  if (!content.includes("\\(") && !content.includes("\\[")) return content;
  const lines = content.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "\\[" || trimmed === "\\]") {
      lines[i] = line.replace(trimmed, () => "$$");
      continue;
    }
    const block = /^(\s*)\\\[(.+)\\\]\s*$/.exec(line);
    if (block) {
      lines[i] = `${block[1]}$$${block[2].trim()}$$`;
      continue;
    }
    // Inline `\(…\)`, skipping inline code spans.
    lines[i] = line
      .split(/(`+[^`]*`+)/g)
      .map((part, index) => (index % 2 === 1 ? part : part.replace(/\\\((.+?)\\\)/g, (_, inner: string) => `$${inner.trim()}$`)))
      .join("");
  }
  return lines.join("\n");
}

/**
 * remark plugin, after remark-math: inline math that breaks the dollar rules
 * goes back to the text it was written as.
 */
export function remarkMathRules() {
  return (tree: Root, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      node.children = (node.children as RootContent[]).map((child) => {
        if (child.type !== "inlineMath") {
          visit(child);
          return child;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) return child;
        const raw = source.slice(start, end);
        if (raw.startsWith("$$")) return child;
        const inner = raw.slice(1, -1);
        const breaks = /^\s/.test(inner) || /\s$/.test(inner) || /^\d/.test(source.charAt(end));
        return breaks ? ({ type: "text", value: raw, position: child.position } satisfies Text) : child;
      }) as typeof node.children;
    };
    visit(tree);
  };
}
