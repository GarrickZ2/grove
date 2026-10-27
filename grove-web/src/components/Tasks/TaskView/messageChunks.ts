import type { ChatMessage, ServerEvent } from "./TaskChat";
import { appendStructuredContentBlock, appendTextContentBlock, type AgentContentBlock } from "./agentContentBlocks";

/** IDs belong to one session and one message type. Call this on the root or
 * child transcript separately; a late chunk updates its original row in place. */
export function reduceMessageChunk(messages: ChatMessage[], event: ServerEvent): ChatMessage[] {
  const type = event.type === "thought_chunk" ? "thinking" : "assistant";
  const messageId = typeof event.message_id === "string" ? event.message_id : undefined;
  const structured = event.type === "message_content_chunk";
  const content = event.content as AgentContentBlock | undefined;
  if (structured && (!content || content.type === "text")) return messages;

  let previous = messages;
  let index = -1;
  if (messageId !== undefined) {
    index = messages.findIndex((message) => message.type === type && message.messageId === messageId);
  } else {
    // Legacy agents identify messages only through transcript boundaries. Keep
    // accepting their trailing text after completion without reopening a row.
    if (type === "assistant") previous = finishThinking(messages);
    for (let i = previous.length - 1; i >= 0; i -= 1) {
      const message = previous[i];
      if (message.type === type) { index = i; break; }
      if (["user", type === "thinking" ? "assistant" : "tool", "session_notice", "compaction", "subagent", "session_exchange"].includes(message.type)) break;
    }
  }
  if (index >= 0) {
    return previous.map((message, i) => {
      if (i !== index) return message;
      if (message.type === "thinking") return { ...message, content: message.content + event.text };
      if (message.type !== "assistant") return message;
      return structured && content && content.type !== "text"
        ? { ...message, blocks: appendStructuredContentBlock(message.blocks, message.content, content) }
        : { ...message, content: message.content + event.text, blocks: appendTextContentBlock(message.blocks, message.content, event.text) };
    });
  }
  if (type === "assistant" && !structured && messageId === undefined && !event.text?.trim()) return previous;
  if (messageId !== undefined) {
    // A changed ID explicitly starts a new message. This is a message boundary,
    // not a turn completion: usage and busy state still come from ACP's response.
    previous = messages.map((message) => {
      if (message.type === "thinking" && (type === "assistant" || message.messageId !== messageId)) {
        return { ...message, complete: true, collapsed: true };
      }
      return message.type === "assistant" && type === "assistant" && !message.complete
        ? { ...message, complete: true } : message;
    });
  }
  if (type === "thinking") {
    return [...previous, { type, content: event.text, messageId, collapsed: false, complete: false }];
  }
  return [...previous, {
    type, content: structured ? "" : event.text, messageId, complete: false,
    blocks: structured ? [content!] : [{ type: "text", text: event.text }],
  }];
}

function finishThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => message.type === "thinking" && !message.complete
    ? { ...message, complete: true, collapsed: true } : message);
}

export function reduceUserMessage(messages: ChatMessage[], event: ServerEvent, attachments: NonNullable<Extract<ChatMessage, { type: "user" }>["attachments"]>): ChatMessage[] {
  const messageId = typeof event.message_id === "string" ? event.message_id : undefined;
  const clientMessageId = typeof event.client_message_id === "string" ? event.client_message_id : undefined;
  const last = messages.at(-1);
  const index = messageId !== undefined
    ? messages.findIndex((message) => message.type === "user" && message.messageId === messageId)
    : last?.type === "user" && !last.terminal && !event.terminal &&
        (clientMessageId === undefined || last.clientMessageId === clientMessageId) ? messages.length - 1 : -1;
  if (index >= 0) {
    return messages.map((message, i) => i === index && message.type === "user" ? {
      ...message, content: `${message.content}${event.text ?? ""}`,
      attachments: [...(message.attachments ?? []), ...attachments],
    } : message);
  }
  return [...messages, {
    type: "user", content: event.text, messageId, clientMessageId,
    terminal: !!event.terminal, sender: event.sender || undefined, attachments,
  }];
}
