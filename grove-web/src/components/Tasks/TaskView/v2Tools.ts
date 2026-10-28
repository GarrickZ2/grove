import type { ChatMessage, ServerEvent } from "./TaskChat";
import type { ToolCallContentData, ToolCallInputData, ToolCallMessage } from "./toolCallReducer";
import { contentBlock } from "./v2Messages";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function toolOutput(raw: unknown): ToolCallContentData[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): ToolCallContentData[] => {
    const item = object(value);
    if (!item) return [];
    if (item.type === "content") {
      const content = contentBlock(item.content);
      return content ? [{ type: "content", content }] : [];
    }
    if (item.type === "terminal" && typeof item.terminalId === "string") {
      return [{ type: "terminal", terminal_id: item.terminalId }];
    }
    if (item.type === "diff" && Array.isArray(item.changes)) {
      const patch = object(item.patch);
      return item.changes.flatMap((value, index): ToolCallContentData[] => {
        const change = object(value);
        if (!change || typeof change.path !== "string") return [];
        const summary = [change.operation, change.oldPath, change.path].filter((part) => typeof part === "string").join(" ");
        return [{ type: "diff", path: change.path, new_text: "", display_text: index === 0 && typeof patch?.text === "string" ? patch.text : summary }];
      });
    }
    return [];
  });
}

function inputFields(value: unknown): ToolCallInputData[] {
  const data = object(value);
  if (!data) return value == null ? [] : [{ label: "Input", value: typeof value === "string" ? value : JSON.stringify(value) }];
  return Object.entries(data).map(([label, entry]) => ({ label, value: typeof entry === "string" ? entry : JSON.stringify(entry) ?? "null" }));
}

export function reduceV2Tool(messages: ChatMessage[], event: ServerEvent): ChatMessage[] {
  const update = object(event.update);
  if (!update || typeof update.toolCallId !== "string") return messages;
  const id = update.toolCallId;
  const index = messages.findIndex((message) => message.type === "tool" && message.id === id);
  const previous = index >= 0 ? messages[index] as ToolCallMessage : undefined;
  const state = { ...(previous?.v2State ?? {}) };
  if (update.sessionUpdate === "tool_call_update") {
    for (const [key, value] of Object.entries(update)) {
      if (key === "sessionUpdate" || key === "toolCallId") continue;
      if (key === "_meta" && value !== null) {
        const metadata = { ...object(state._meta) };
        for (const [metaKey, metaValue] of Object.entries(object(value) ?? {})) {
          if (metaValue === null) delete metadata[metaKey]; else metadata[metaKey] = metaValue;
        }
        state._meta = metadata;
      } else {
        state[key] = value;
      }
    }
  } else if (update.sessionUpdate === "tool_call_content_chunk") {
    state.content = [...(Array.isArray(state.content) ? state.content : []), update.content];
  } else return messages;
  const output = toolOutput(state.content).map((item) => {
    if (item.type !== "terminal") return item;
    const previousTerminal = previous?.output?.find((old) => old.type === "terminal" && old.terminal_id === item.terminal_id);
    return previousTerminal?.type === "terminal" ? { ...item, ...previousTerminal } : item;
  });
  if (output.length === 0 && state.rawOutput != null) {
    const text = typeof state.rawOutput === "string" ? state.rawOutput : JSON.stringify(state.rawOutput, null, 2);
    if (text) output.push({ type: "content", content: { type: "text", text } });
  }
  const locations = Array.isArray(state.locations) ? state.locations.flatMap((entry) => {
    const location = object(entry);
    return location && typeof location.path === "string" ? [{ path: location.path, line: typeof location.line === "number" ? location.line : undefined }] : [];
  }) : [];
  for (const item of output) if (item.type === "diff" && !locations.some((location) => location.path === item.path)) locations.push({ path: item.path, line: undefined });
  const tool: ToolCallMessage = {
    type: "tool", id, title: typeof state.title === "string" ? state.title : id,
    name: typeof state.name === "string" ? state.name : undefined,
    kind: typeof state.kind === "string" ? state.kind : undefined,
    status: typeof state.status === "string" ? state.status : "pending",
    input: inputFields(state.rawInput), output, locations, protocolLocations: locations,
    collapsed: previous?.collapsed ?? false, v2State: state,
  };
  return index < 0 ? [...messages.map((message) => {
    if (message.type === "thinking" && !message.complete) return { ...message, complete: true, collapsed: true };
    if (message.type === "assistant" && !message.complete) return { ...message, complete: true };
    return message;
  }), tool] : messages.map((message, i) => i === index ? tool : message);
}
