import { appendTextContentBlock, type AgentContentBlock } from "./agentContentBlocks";
import type { ChatMessage } from "./TaskChat";

export type CompactionMessage = {
  type: "compaction";
  id: string;
  status: string;
  summary: AgentContentBlock[];
  error?: string;
  metadata?: unknown;
};

/** A turn ending only closes its own compaction; child work can outlive it.
 * A confirmed runtime exit also closes descendants. Transport loss alone does neither. */
export function interruptCompactions(messages: ChatMessage[], includeSubagents = false): ChatMessage[] {
  return messages.map((message) => {
    if (includeSubagents && message.type === "subagent") {
      return { ...message, messages: interruptCompactions(message.messages, true) };
    }
    return message.type === "compaction" && message.status === "in_progress"
      ? { ...message, status: "interrupted" } : message;
  });
}

export function reconcileCompactionActivity(messages: ChatMessage[], runtime: { active: boolean; busy: boolean | null }): ChatMessage[] {
  return !runtime.active ? interruptCompactions(messages, true)
    : runtime.busy === false ? interruptCompactions(messages) : messages;
}

/** First sighting fixes placement. Later updates, even after completion, patch
 * that same entity and never interrupt text that was received after it. */
export function applyCompactionEvent<T extends { type: string }>(
  messages: T[],
  event: Record<string, unknown>,
): (T | CompactionMessage)[] {
  if (typeof event.id !== "string" || !event.id) return messages;
  if (event.type === "compaction_update" && typeof event.status !== "string") return messages;
  if (event.type === "compaction_summary_chunk" && !isContentBlock(event.content)) return messages;
  const index = messages.findIndex((message) => message.type === "compaction" && (message as unknown as CompactionMessage).id === event.id);
  const previous = index >= 0 ? messages[index] as unknown as CompactionMessage : undefined;
  const next: CompactionMessage = previous
    ? { ...previous }
    : { type: "compaction", id: event.id, status: "in_progress", summary: [] };
  if (event.type === "compaction_summary_chunk") {
    const block = event.content as AgentContentBlock;
    next.summary = block.type === "text"
      ? appendTextContentBlock(next.summary, "", block.text)
      : [...next.summary, block];
  } else {
    next.status = event.status as string;
    // Omission preserves; null clears; an array replaces all streamed content.
    if (event.summary !== undefined) {
      next.summary = Array.isArray(event.summary) ? event.summary.filter(isContentBlock) : [];
    }
    if (event.error !== undefined) next.error = typeof event.error === "string" ? event.error : undefined;
    if (event.metadata !== undefined) next.metadata = event.metadata === null ? undefined : event.metadata;
  }
  if (index >= 0) return messages.map((message, i) => i === index ? next : message);
  return [
    ...messages.map((message) => message.type === "assistant" || message.type === "thinking" ? { ...message, complete: true } : message),
    next,
  ];
}

function isContentBlock(value: unknown): value is AgentContentBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  return block.type === "text" ? typeof block.text === "string"
    : ["image", "audio", "resource", "resource_link"].includes(String(block.type));
}

export function compactionSearchText(message: CompactionMessage): string {
  return ["Context compaction", message.status, message.error, ...message.summary.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource") return [block.uri, block.text].filter(Boolean).join("\n");
    if (block.type === "resource_link") return [block.title, block.name, block.uri, block.description].filter(Boolean).join("\n");
    return block.label ?? "";
  })].filter(Boolean).join("\n");
}
