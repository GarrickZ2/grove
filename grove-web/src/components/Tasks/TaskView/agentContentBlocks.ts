export type AgentContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      data?: string;
      mime_type: string;
      uri?: string;
      label?: string;
    }
  | { type: "audio"; data?: string; mime_type: string; label?: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mime_type?: string;
      size?: number;
      title?: string;
      description?: string;
      label?: string;
    }
  | {
      type: "resource";
      uri: string;
      mime_type?: string;
      text?: string;
      blob?: string;
    };

function existingBlocks(
  blocks: AgentContentBlock[] | undefined,
  existingText: string,
): AgentContentBlock[] {
  if (blocks) return [...blocks];
  return existingText ? [{ type: "text", text: existingText }] : [];
}

export function appendTextContentBlock(
  blocks: AgentContentBlock[] | undefined,
  existingText: string,
  text: string,
): AgentContentBlock[] {
  const next = existingBlocks(blocks, existingText);
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "text", text });
  }
  return next;
}

export function appendStructuredContentBlock(
  blocks: AgentContentBlock[] | undefined,
  existingText: string,
  content: Exclude<AgentContentBlock, { type: "text" }>,
): AgentContentBlock[] {
  return [...existingBlocks(blocks, existingText), content];
}
