const STANDALONE_BOLD_HEADING = /^\s*(?:#{1,6}\s+)?\*\*(.+?)\*\*\s*[.:：。-]?\s*$/;

/**
 * Extract the latest Codex-style thought heading without exposing the
 * reasoning body. Codex emits these headings as standalone `**…**` lines.
 */
export function extractThoughtStatus(content: string): string {
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(STANDALONE_BOLD_HEADING);
    const heading = match?.[1]?.replace(/\s+/g, " ").trim();
    if (heading) return heading;
  }
  return "Thinking";
}

type TranscriptStatusMessage = {
  type: string;
  complete?: boolean;
  status?: string;
};

/**
 * The generic transcript status is only a fallback while an Agent is running.
 * A real unfinished thought is already the authoritative visible status.
 */
export function shouldShowGenericThinking(
  isBusy: boolean,
  messages: readonly TranscriptStatusMessage[],
): boolean {
  if (!isBusy) return false;
  // Compaction has its own visible progress indicator. Ignore unfinished
  // records from older turns when deciding the current turn's fallback.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === "user") break;
    if (message.type === "compaction" && message.status === "in_progress") {
      return false;
    }
  }
  if (messages.some((message) => message.type === "thinking" && !message.complete)) {
    return false;
  }
  const lastMessageType = messages[messages.length - 1]?.type;
  return (
    lastMessageType !== "assistant" &&
    lastMessageType !== "thinking" &&
    lastMessageType !== "terminal_output"
  );
}
