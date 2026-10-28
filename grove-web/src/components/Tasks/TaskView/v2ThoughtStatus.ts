import { extractThoughtStatus } from "./thoughtStatus";

// Keep only a possible heading line, never the reasoning body.
export type ThoughtScan = { line: string; skipping: boolean; status: string };

export function scanThought(previous: ThoughtScan | undefined, text: string): ThoughtScan {
  const scan = previous ? { ...previous } : { line: "", skipping: false, status: "" };
  for (const char of text) {
    if (char === "\n") {
      const heading = extractThoughtStatus(scan.line);
      if (!scan.skipping && heading !== "Thinking") scan.status = heading;
      scan.line = "";
      scan.skipping = false;
    } else if (!scan.skipping) {
      scan.line += char;
      // A partial Markdown heading is bounded and discarded as soon as it
      // cannot be a standalone bold heading.
      const afterOpening = scan.line.match(/^\s*(?:#{1,6}\s+)?\*\*(.*)$/)?.[1];
      const closing = afterOpening?.indexOf("**") ?? -1;
      const invalidSuffix = afterOpening !== undefined && closing >= 0 && !/^\s*[.:：。-]?\s*$/.test(afterOpening.slice(closing + 2));
      if (scan.line.length > 300 || !/^\s*(?:#{1,6}(?:\s+|$))?(?:\*{1,2}[^\n]*)?$/.test(scan.line) ||
          /^\s*(?:#{1,6}\s+)?\*[^*]/.test(scan.line) || invalidSuffix) {
        scan.line = "";
        scan.skipping = true;
      }
    }
  }
  return scan;
}

export function thoughtStatusContent(scan: ThoughtScan): string {
  const current = scan.skipping ? "Thinking" : extractThoughtStatus(scan.line);
  const status = current === "Thinking" ? scan.status : current;
  return status ? `**${status}**` : "";
}
