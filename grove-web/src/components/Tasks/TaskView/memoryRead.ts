import { isGroveMemoryReadName } from "./toolCallIdentity";
import type { ToolCallMessage } from "./toolCallReducer";

function isMemoryReadTool(message: ToolCallMessage): boolean {
  if (message.name) return isGroveMemoryReadName(message.name);
  const toolName = message.input
    ?.find((field) => field.label.trim().toLowerCase() === "tool")
    ?.value.trim()
    .toLowerCase();
  return (
    toolName === "memory_read" ||
    /(?:^|[./\s:])memory_read$/i.test(message.title.trim())
  );
}

function memoryEntityId(message: ToolCallMessage): string | undefined {
  return message.input
    ?.find((field) => field.label.toLowerCase().replace(/[^a-z0-9]/g, "").endsWith("entityid"))
    ?.value.trim() || undefined;
}

/** Collect Entity IDs from successful memory_read calls across a chat history. */
export function collectReadMemoryIds(
  messages: readonly { type: string }[],
): string[] {
  const read = new Set<string>();
  for (const message of messages) {
    if (message.type !== "tool") continue;
    const tool = message as ToolCallMessage;
    if (!isMemoryReadTool(tool) || tool.status !== "completed") continue;
    const entityId = memoryEntityId(tool);
    if (entityId) read.add(entityId);
  }
  return [...read];
}
