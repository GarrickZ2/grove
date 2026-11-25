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

/**
 * Where a fork that ends with the reply at `index` starts from: `null` for the
 * whole session, a session cursor for an earlier reply, `undefined` when the
 * Agent offers no fork there.
 */
export function forkTarget(messages: ChatMessage[], index: number): string | null | undefined {
  if (messages[index]?.type !== "assistant") return undefined;
  const next = messages.slice(index + 1).find((message) => message.type === "user");
  return next?.type === "user" ? next.forkCursor : null;
}

/** Apply a `fork_point` event: the Agent can fork right before the latest user message. */
export function reduceForkPoint(messages: ChatMessage[], event: { type: string; cursor_id?: unknown; available?: unknown }): ChatMessage[] {
  const cursor = typeof event.cursor_id === "string" ? event.cursor_id : undefined;
  if (!cursor) return messages;
  if (!event.available) {
    return messages.map((message) => message.type === "user" && message.forkCursor === cursor ? { ...message, forkCursor: undefined } : message);
  }
  const index = messages.map((message) => message.type).lastIndexOf("user");
  return messages.map((message, i) => i === index && message.type === "user" ? { ...message, forkCursor: cursor } : message);
}
