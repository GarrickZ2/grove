import type { ChatMessage } from "./TaskChat";

/** Show actions only on the final assistant message of a finished turn. */
export function showMessageActions(messages: ChatMessage[], index: number, isBusy: boolean): boolean {
  if (messages[index]?.type !== "assistant") return true;
  const nextUser = messages.findIndex((message, i) => i > index && message.type === "user");
  if (isBusy && nextUser < 0) return false;
  return !messages.slice(index + 1, nextUser < 0 ? undefined : nextUser).some(
    (message) => message.type === "assistant" && (message.content.trim() || message.blocks?.some((block) => block.type !== "text")),
  );
}
