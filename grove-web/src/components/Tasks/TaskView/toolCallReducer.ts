import type { AgentContentBlock } from "./agentContentBlocks";

export type ToolCallContentData =
  | { type: "content"; content: AgentContentBlock }
  | {
      type: "diff";
      path: string;
      old_text?: string;
      new_text: string;
      display_text: string;
    }
  | {
      type: "terminal";
      terminal_id: string;
      /** Absent in legacy history that only persisted the Terminal ID. */
      output?: string;
      truncated?: boolean;
      exit_status?: { exit_code?: number; signal?: string };
    };

export type ToolCallInputData = { label: string; value: string };

export type ToolCallChipTone = "neutral" | "running" | "warning" | "cancelled";

export function toolCallChipTone(status: string): ToolCallChipTone {
  if (status === "running" || status === "in_progress") return "running";
  if (status === "failed" || status === "error") return "warning";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "neutral";
}

export function hasReadableToolInput(input: ToolCallInputData[] | undefined): boolean {
  return input?.some((field) => field.value.trim().length > 0) ?? false;
}

/** Restore readable JSON for structured inputs, including legacy Grove
 * history that stored object arrays without their outer brackets. */
export function formatToolInputValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return value;
    try {
      parsed = JSON.parse(`[${trimmed}]`);
    } catch {
      return value;
    }
  }
  return parsed && typeof parsed === "object"
    ? JSON.stringify(parsed, null, 2)
    : value;
}

function hasReadableContentBlock(block: AgentContentBlock): boolean {
  if (block.type === "text") return block.text.trim().length > 0;
  if (block.type === "image" || block.type === "audio") return true;
  if (block.type === "resource_link") return block.uri.length > 0 || block.name.length > 0;
  return Boolean(block.uri || block.text?.trim() || block.blob);
}

export function hasReadableToolOutput(
  output: ToolCallContentData[] | undefined,
  legacyContent: string,
): boolean {
  const hasStructuredOutput = output?.some((item) => {
    if (item.type === "content") return hasReadableContentBlock(item.content);
    if (item.type === "diff") {
      return Boolean(item.display_text.trim() || item.new_text.trim() || item.path.trim());
    }
    return item.terminal_id.trim().length > 0;
  });
  return Boolean(hasStructuredOutput) || legacyContent.trim().length > 0;
}

export function toolCallHoverText(
  title: string,
  input: ToolCallInputData[] | undefined,
): string {
  const command = input?.find((field) => field.label.toLowerCase() === "command")?.value.trim();
  return command || title;
}

export type ToolCallMessage = {
  type: "tool";
  id: string;
  title: string;
  status: string;
  content?: string;
  kind?: string;
  input?: ToolCallInputData[];
  output?: ToolCallContentData[];
  collapsed: boolean;
  locations?: { path: string; line?: number }[];
  /** Exact ACP locations; display locations additionally include Diff paths. */
  protocolLocations?: { path: string; line?: number }[];
};

type ToolEvent = { type: string; [key: string]: unknown };
type Location = { path: string; line?: number };

export function canApplyToolCallUpdate(
  previous: ToolCallMessage | undefined,
  event: ToolEvent,
): boolean {
  return previous !== undefined || event.protocol_v1 !== true || typeof event.title === "string";
}

function eventLocations(value: unknown): Location[] | undefined {
  return Array.isArray(value) ? (value as Location[]) : undefined;
}

function eventContent(value: unknown): ToolCallContentData[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return (value as ToolCallContentData[]).flatMap(expandEmbeddedMcpResult);
}

function expandEmbeddedMcpResult(item: ToolCallContentData): ToolCallContentData[] {
  if (item.type !== "content" || item.content.type !== "text") return [item];
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.content.text);
  } catch {
    return [item];
  }
  if (!parsed || typeof parsed !== "object") return [item];
  const root = parsed as Record<string, unknown>;
  const result = root.result && typeof root.result === "object"
    ? root.result as Record<string, unknown>
    : root;
  if (!Array.isArray(result.content)) return [item];

  const blocks = result.content.filter(
    (block): block is Record<string, unknown> => Boolean(block && typeof block === "object"),
  );
  if (!blocks.some((block) => block.type === "image" || block.type === "audio")) {
    return [item];
  }

  const expanded = blocks.flatMap((block): ToolCallContentData[] => {
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "content", content: { type: "text", text: block.text } }];
    }
    const mimeType = typeof block.mimeType === "string"
      ? block.mimeType
      : typeof block.mime_type === "string"
        ? block.mime_type
        : undefined;
    if (block.type === "image" && typeof block.data === "string") {
      return [{
        type: "content",
        content: {
          type: "image",
          data: block.data,
          mime_type: mimeType || "image/png",
        },
      }];
    }
    if (block.type === "audio" && typeof block.data === "string") {
      return [{
        type: "content",
        content: {
          type: "audio",
          data: block.data,
          mime_type: mimeType || "audio/mpeg",
        },
      }];
    }
    return [];
  });
  return expanded.length > 0 ? expanded : [item];
}

function preserveTerminalSnapshots(
  incoming: ToolCallContentData[] | undefined,
  previous: ToolCallContentData[] | undefined,
): ToolCallContentData[] | undefined {
  if (!incoming || !previous) return incoming;
  return incoming.map((item) => {
    if (item.type !== "terminal" || item.output !== undefined) return item;
    const old = previous.find(
      (candidate): candidate is Extract<ToolCallContentData, { type: "terminal" }> =>
        candidate.type === "terminal" && candidate.terminal_id === item.terminal_id,
    );
    return old?.output !== undefined ? { ...old, ...item, output: old.output } : item;
  });
}

function mergeLocations(existing: Location[] | undefined, incoming: Location[] | undefined) {
  if (!incoming || incoming.length === 0) return existing;
  const result = [...(existing ?? [])];
  for (const location of incoming) {
    if (!result.some((item) => item.path === location.path && item.line === location.line)) {
      result.push(location);
    }
  }
  return result;
}

function contentLocations(content: ToolCallContentData[] | undefined): Location[] {
  return (content ?? [])
    .filter((item): item is Extract<ToolCallContentData, { type: "diff" }> => item.type === "diff")
    .map((item) => ({ path: item.path }));
}

function displayText(content: ToolCallContentData[]): string | undefined {
  const parts = content.flatMap((item): string[] => {
    if (item.type === "diff") return item.display_text ? [item.display_text] : [];
    if (item.type === "terminal") return [`Terminal ${item.terminal_id}`];
    const block = item.content;
    if (block.type === "text") return block.text ? [block.text] : [];
    if (block.type === "image") return [block.label || "<image>"];
    if (block.type === "audio") return [block.label || "<audio>"];
    if (block.type === "resource_link") return [block.title || block.name || block.uri];
    return [block.text || block.uri || "<resource>"];
  });
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function normalizedStatus(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  return value === "in_progress" ? "running" : value;
}

function mergeLegacyContent(previous: string | undefined, next: unknown): string | undefined {
  if (typeof next !== "string" || !next) return previous;
  if (!previous) return next;
  if (previous.includes(next)) return previous;
  if (next.startsWith(previous)) return next;
  return previous.endsWith("\n") ? previous + next : `${previous}\n${next}`;
}

export function applyToolCallCreated(
  previous: ToolCallMessage | undefined,
  event: ToolEvent,
): ToolCallMessage {
  const structured = preserveTerminalSnapshots(eventContent(event.output), previous?.output);
  const protocolLocations = structured !== undefined ? (eventLocations(event.locations) ?? []) : previous?.protocolLocations;
  const locations = structured !== undefined
    ? mergeLocations(protocolLocations, contentLocations(structured))
    : mergeLocations(previous?.locations, eventLocations(event.locations));

  return {
    type: "tool",
    id: String(event.id),
    title: typeof event.title === "string" ? event.title : previous?.title ?? String(event.id),
    kind: typeof event.kind === "string" ? event.kind : previous?.kind,
    status: normalizedStatus(event.status, previous?.status ?? "running"),
    content:
      structured !== undefined
        ? (typeof event.content === "string" ? event.content : displayText(structured))
        : previous?.content,
    input: Array.isArray(event.input) ? (event.input as ToolCallInputData[]) : previous?.input,
    output: structured ?? previous?.output,
    collapsed: previous?.collapsed ?? false,
    locations,
    protocolLocations,
  };
}

export function applyToolCallUpdated(
  previous: ToolCallMessage | undefined,
  event: ToolEvent,
): ToolCallMessage {
  const structured = preserveTerminalSnapshots(eventContent(event.output), previous?.output);
  const protocolV1 = event.protocol_v1 === true;
  const protocolLocations = protocolV1
    ? event.locations_replace === true
      ? (eventLocations(event.locations) ?? [])
      : (previous?.protocolLocations ?? [])
    : previous?.protocolLocations;
  const currentStructured = structured !== undefined ? structured : previous?.output;
  const locations = protocolV1
    ? mergeLocations(protocolLocations, contentLocations(currentStructured))
    : mergeLocations(previous?.locations, eventLocations(event.locations));

  return {
    type: "tool",
    id: String(event.id),
    title: typeof event.title === "string" ? event.title : previous?.title ?? String(event.id),
    kind: typeof event.kind === "string" ? event.kind : previous?.kind,
    status: normalizedStatus(event.status, previous?.status ?? "pending"),
    content:
      structured !== undefined
        ? (typeof event.content === "string" ? event.content : displayText(structured))
        : protocolV1
          ? previous?.content
          : mergeLegacyContent(previous?.content, event.content),
    input: Array.isArray(event.input) ? (event.input as ToolCallInputData[]) : previous?.input,
    output: structured !== undefined ? structured : previous?.output,
    collapsed: previous?.collapsed ?? true,
    locations,
    protocolLocations,
  };
}

export function applyTerminalOutputUpdate(
  message: ToolCallMessage,
  event: ToolEvent,
): ToolCallMessage {
  const terminalId = typeof event.terminal_id === "string" ? event.terminal_id : "";
  if (!terminalId || !message.output) return message;

  let changed = false;
  const output = message.output.map((item) => {
    if (item.type !== "terminal" || item.terminal_id !== terminalId) return item;
    changed = true;
    return {
      ...item,
      output: typeof event.output === "string" ? event.output : (item.output ?? ""),
      truncated: event.truncated === true,
      exit_status:
        event.exit_status && typeof event.exit_status === "object"
          ? (event.exit_status as { exit_code?: number; signal?: string })
          : undefined,
    };
  });

  return changed ? { ...message, output } : message;
}
