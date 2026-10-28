import type { ChatMessage, ServerEvent } from "./TaskChat";
import type { AgentContentBlock } from "./agentContentBlocks";
import { reduceMessageChunk, reduceUserMessage } from "./messageChunks";
import { scanThought, thoughtStatusContent } from "./v2ThoughtStatus";

type RawBlock = Record<string, unknown>;

export function contentBlock(value: unknown): AgentContentBlock | undefined {
  if (!value || typeof value !== "object") return undefined;
  const block = value as RawBlock;
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { type: "text", text: block.text } : undefined;
    case "image":
    case "audio":
      return typeof block.mimeType === "string"
        ? { type: block.type, data: typeof block.data === "string" ? block.data : undefined, mime_type: block.mimeType, ...(block.type === "image" && typeof block.uri === "string" ? { uri: block.uri } : {}), ...(typeof (block._meta as RawBlock | undefined)?.name === "string" ? { label: (block._meta as RawBlock).name as string } : {}) }
        : undefined;
    case "resource_link":
      return typeof block.uri === "string" && typeof block.name === "string"
        ? { type: "resource_link", uri: block.uri, name: block.name,
            mime_type: typeof block.mimeType === "string" ? block.mimeType : undefined,
            title: typeof block.title === "string" ? block.title : undefined,
            description: typeof block.description === "string" ? block.description : undefined,
            size: typeof block.size === "number" ? block.size : undefined }
        : undefined;
    case "resource": {
      const resource = block.resource as RawBlock | undefined;
      return resource && typeof resource.uri === "string"
        ? { type: "resource", uri: resource.uri,
            mime_type: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
            text: typeof resource.text === "string" ? resource.text : undefined,
            blob: typeof resource.blob === "string" ? resource.blob : undefined }
        : undefined;
    }
    default:
      // Unknown blocks stay in the stored protocol event for future clients.
      return undefined;
  }
}

/** Apply v2 message updates identically to live events and saved history. */
export function reduceV2Message(messages: ChatMessage[], event: ServerEvent): ChatMessage[] {
  if (event.type === "v2_message_bind") {
    if (typeof event.client_message_id !== "string" || typeof event.message_id !== "string") return messages;
    return messages.map((message) => message.type === "user" && message.clientMessageId === event.client_message_id
      ? { ...message, messageId: event.message_id, v2EchoPending: true, v2OriginalAttachments: message.attachments ?? [], v2EchoAttachments: [] } : message);
  }
  const update = event.update as RawBlock | undefined;
  if (!update || typeof update.messageId !== "string" || typeof update.sessionUpdate !== "string") return messages;
  const id = update.messageId;
  const kind = update.sessionUpdate;
  const thought = kind === "agent_thought" || kind === "agent_thought_chunk";
  const assistant = kind === "agent_message" || kind === "agent_message_chunk";
  const user = kind === "user_message" || kind === "user_message_chunk";
  if (!thought && !assistant && !user) return messages;
  const isChunk = kind.endsWith("_chunk");
  if (isChunk) {
    const block = contentBlock(update.content);
    if (!block) return messages;
    if (user) {
      const existing = messages.find((message) => message.type === "user" && message.messageId === id);
      if (existing?.type === "user" && existing.v2OriginalAttachments) {
        const echo = [...(existing.v2EchoAttachments ?? []), ...userAttachments([block])];
        return messages.map((message) => message === existing ? {
          ...existing, content: (existing.v2EchoPending ? "" : existing.content) + (block.type === "text" ? block.text : ""),
          attachments: mergeAttachments(existing.v2OriginalAttachments!, echo), v2EchoAttachments: echo, v2EchoPending: false,
        } : message);
      }
      return reduceUserMessage(messages, { type: "user_message", message_id: id, text: block.type === "text" ? block.text : "" }, userAttachments([block]));
    }
    if (thought) {
      if (block.type !== "text") return messages;
      const prepared = reduceMessageChunk(messages, { type: "thought_chunk", message_id: id, text: "" });
      return prepared.map((message) => {
        if (message.type !== "thinking" || message.messageId !== id) return message;
        const thoughtScan = scanThought(message.thoughtScan, block.text);
        return { ...message, thoughtScan, content: thoughtStatusContent(thoughtScan) };
      });
    }
    return reduceMessageChunk(messages, block.type === "text"
      ? { type: thought ? "thought_chunk" : "message_chunk", message_id: id, text: block.text }
      : { type: "message_content_chunk", message_id: id, content: block });
  }
  // Omitted content is not a replacement. An explicit null clears it.
  if (!("content" in update)) return messages;
  const blocks = Array.isArray(update.content)
    ? update.content.map(contentBlock).filter((block): block is AgentContentBlock => block !== undefined)
    : [];
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  const type = user ? "user" : thought ? "thinking" : "assistant";
  const index = messages.findIndex((message) => message.type === type && message.messageId === id);
  if (index >= 0) return messages.map((message, i) => {
    if (i !== index) return message;
    if (message.type === "thinking") { const thoughtScan = scanThought(undefined, text); return { ...message, thoughtScan, content: thoughtStatusContent(thoughtScan) }; }
    if (message.type === "assistant") return { ...message, content: text, blocks };
    if (message.type === "user") {
      const echo = userAttachments(blocks);
      return { ...message, content: text, attachments: update.content === null || !message.v2OriginalAttachments ? echo : mergeAttachments(message.v2OriginalAttachments, echo), v2OriginalAttachments: update.content === null ? [] : message.v2OriginalAttachments, v2EchoAttachments: echo, v2EchoPending: false };
    }
    return message;
  });
  if (user) return [...messages, { type: "user", messageId: id, content: text, attachments: userAttachments(blocks) }];
  const prepared = reduceMessageChunk(messages, { type: thought ? "thought_chunk" : "message_chunk", message_id: id, text: "" });
  return prepared.map((message) => {
    if (thought && message.type === "thinking" && message.messageId === id) { const thoughtScan = scanThought(undefined, text); return { ...message, thoughtScan, content: thoughtStatusContent(thoughtScan) }; }
    if (!thought && message.type === "assistant" && message.messageId === id) return { ...message, content: text, blocks };
    return message;
  });
}

type UserAttachment = NonNullable<Extract<ChatMessage, { type: "user" }>['attachments']>[number];

// Match echoed blocks to the locally submitted attachments by occurrence, so
// incomplete echoes retain local metadata and repeated identical files remain distinct.
function mergeAttachments(original: UserAttachment[], echo: UserAttachment[]): UserAttachment[] {
  const merged = original.map((attachment) => ({ ...attachment }));
  const matched = new Set<number>();
  for (const item of echo) {
    const index = original.findIndex((candidate, i) => !matched.has(i) && candidate.type === item.type &&
      (candidate.uri && item.uri ? candidate.uri === item.uri : candidate.data && item.data ? candidate.data === item.data : candidate.mimeType === item.mimeType));
    if (index < 0) { merged.push(item); continue; }
    matched.add(index);
    const local = merged[index];
    merged[index] = { ...item, ...local, data: item.data || local.data, mimeType: item.mimeType || local.mimeType,
      uri: item.uri || local.uri, previewUrl: item.previewUrl || local.previewUrl, label: local.label || item.label, name: local.name || item.name };
  }
  return merged;
}

function userAttachments(blocks: AgentContentBlock[]): NonNullable<Extract<ChatMessage, { type: "user" }>["attachments"]> {
  return blocks.flatMap<NonNullable<Extract<ChatMessage, { type: "user" }>["attachments"]>[number]>((block) => {
    if (block.type === "text") return [];
    if (block.type === "image" || block.type === "audio") return [{
      type: block.type, data: block.data ?? "", mimeType: block.mime_type,
      name: block.label ?? "", label: block.label ?? "", uri: block.type === "image" ? block.uri : undefined,
      previewUrl: block.type === "image" && block.data
        ? `data:${block.mime_type};base64,${block.data}` : undefined,
    }];
    return [{ type: "resource" as const, data: block.type === "resource" ? block.text ?? block.blob ?? "" : "",
      mimeType: block.mime_type ?? "", name: block.type === "resource_link" ? block.name : "",
      label: block.type === "resource_link" ? block.title ?? block.name : "", uri: block.uri }];
  });
}
