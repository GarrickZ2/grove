/** Minimal shape of a conversation turn the rail needs. */
export type RailTurn = {
  messageIndex: number;
  user: string;
  assistant: string;
  isStreaming: boolean;
  tools: { label: string; count: number }[];
};

export type RailTickState = "streaming" | "active" | "answered" | "unanswered";

export function railTickState(turn: RailTurn, activeMessageIndex: number | null): RailTickState {
  if (turn.isStreaming) return "streaming";
  if (turn.messageIndex === activeMessageIndex) return "active";
  return turn.assistant ? "answered" : "unanswered";
}

/** Roving focus inside the rail: arrows step, Home/End jump; null = not ours. */
export function nextRailIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return Math.min(count - 1, current + 1);
    case "ArrowUp":
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** "Exploration ×3 · Edit ×2", the tools a turn used, for the hover preview. */
export function railToolSummary(tools: RailTurn["tools"], limit = 3): string {
  const shown = tools.slice(0, limit).map((tool) => (tool.count > 1 ? `${tool.label} ×${tool.count}` : tool.label));
  const rest = tools.length - shown.length;
  return [...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(" · ");
}

/**
 * Vertical position of the hover preview: centered on the tick, kept inside
 * the viewport with a margin.
 */
export function railPreviewTop(tickCenter: number, previewHeight: number, viewportHeight: number, margin = 12): number {
  const top = tickCenter - previewHeight / 2;
  return Math.max(margin, Math.min(top, viewportHeight - previewHeight - margin));
}

/** Preview text without Markdown syntax ("## What changed" → "What changed"). */
export function railPlainText(text: string): string {
  return text
    .replace(/```[a-z0-9_-]*/gi, " ")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/(^|\s)[-*]\s+/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
