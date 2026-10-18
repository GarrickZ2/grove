import type { ChatMessage, ServerEvent } from "./TaskChat";
import { appendTextContentBlock, type AgentContentBlock } from "./agentContentBlocks";

export interface SubagentMessage {
  type: "subagent";
  sessionId: string;
  parentSessionId: string;
  title?: string;
  description?: string;
  capabilities?: { cancel?: object | null };
  state?: { state: string };
  messages: ChatMessage[];
}

export interface SessionExchangeMessage {
  type: "session_exchange";
  id: string;
  sender?: string;
  recipient?: string;
  blocks: AgentContentBlock[];
}

export function flattenSubagentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => message.type === "subagent"
    ? [message, ...flattenSubagentMessages(message.messages)] : [message]);
}

export function mapSubagentMessages(messages: ChatMessage[], map: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  return messages.map((message) => map(message.type === "subagent"
    ? { ...message, messages: mapSubagentMessages(message.messages, map) } : message));
}

/** Reconnect starts with unconfirmed activity. Live child snapshots restore it;
 * a restarted Agent must never resurrect historical spinners or controls. */
export function resetSubagentActivity(messages: ChatMessage[]): ChatMessage[] {
  return mapSubagentMessages(messages, (message) => {
    if (message.type !== "subagent") return message;
    const terminal = ["_completed", "_failed", "_cancelled"].includes(message.state?.state ?? "");
    return { ...message, capabilities: undefined, state: terminal ? message.state : { state: "unknown" } };
  });
}

function updateChild(messages: ChatMessage[], id: string, update: (child: SubagentMessage) => SubagentMessage): ChatMessage[] {
  return messages.map((message) => {
    if (message.type !== "subagent") return message;
    if (message.sessionId === id) return update(message);
    const children = updateChild(message.messages, id, update);
    return { ...message, messages: children };
  });
}

export function reduceSubagentEvent(messages: ChatMessage[], event: ServerEvent, reduce: (messages: ChatMessage[], event: ServerEvent) => ChatMessage[]): ChatMessage[] {
  if (event.type === "subagent_event") {
    if (typeof event.session_id !== "string" || !event.event || event.event.type === "subagent_event") return messages;
    return updateChild(messages, event.session_id, (child) => {
      // Only child Todos belong in the activity transcript. Root Todos are
      // restored separately into the composer panel by TaskChat.
      if (event.event.type === "plan_update") {
        const entry: ChatMessage = { type: "child_plan", entries: event.event.entries ?? [] };
        const index = child.messages.findIndex((message) => message.type === "child_plan");
        return { ...child, messages: index < 0 ? [...child.messages, entry] : child.messages.map((message, i) => i === index ? entry : message) };
      }
      return { ...child, messages: reduce(child.messages, event.event) };
    });
  }
  if (event.type === "subagent_update") {
    if (typeof event.session_id !== "string" || typeof event.parent_session_id !== "string" || event.session_id === event.parent_session_id) return messages;
    const patch = (child: SubagentMessage): SubagentMessage => {
      const next = { ...child };
      for (const key of ["title", "description", "capabilities", "state"] as const) {
        if (Object.prototype.hasOwnProperty.call(event, key)) Object.assign(next, { [key]: event[key] ?? undefined });
      }
      if (next.state?.state && next.state.state !== "running" && next.state.state !== "requires_action") {
        next.messages = next.messages.map((message) => message.type === "assistant" || message.type === "thinking" ? { ...message, complete: true } : message);
      }
      return next;
    };
    if (flattenSubagentMessages(messages).some((message) => message.type === "subagent" && message.sessionId === event.session_id)) {
      return updateChild(messages, event.session_id, patch);
    }
    // Split parent text at delegation, preserving chronology during streaming.
    const before = messages.map((message) => (message.type === "assistant" || message.type === "thinking") ? { ...message, complete: true } : message);
    const child = patch({ type: "subagent", sessionId: event.session_id, parentSessionId: event.parent_session_id, messages: [] });
    if (flattenSubagentMessages(before).some((message) => message.type === "subagent" && message.sessionId === event.parent_session_id)) {
      return updateChild(before, event.parent_session_id, (parent) => ({ ...parent, messages: [...parent.messages, child] }));
    }
    return [...before, child];
  }
  if (event.type === "session_message") {
    if (typeof event.id !== "string") return messages;
    const previous = messages.find((message): message is SessionExchangeMessage => message.type === "session_exchange" && message.id === event.id);
    const blocks = Object.prototype.hasOwnProperty.call(event, "content")
      ? (Array.isArray(event.content) ? event.content as AgentContentBlock[] : []) : undefined;
    const next: SessionExchangeMessage = {
      type: "session_exchange", id: event.id,
      sender: event.sender ?? previous?.sender, recipient: event.recipient ?? previous?.recipient,
      blocks: blocks === undefined ? previous?.blocks ?? [] : event.append ? blocks.reduce((content, block) => block.type === "text" ? appendTextContentBlock(content, "", block.text) : [...content, block], previous?.blocks ?? []) : blocks,
    };
    return previous ? messages.map((message) => message === previous ? next : message) : [...messages.map((message) => message.type === "assistant" || message.type === "thinking" ? { ...message, complete: true } : message), next];
  }
  return messages;
}

export function subagentStatus(child: SubagentMessage, connected: boolean): string {
  const pending = flattenSubagentMessages(child.messages).some((message) => (message.type === "permission" || (message.type === "elicitation" && !message.snapshot.opened)) && !message.resolved);
  if (["_completed", "_failed", "_cancelled"].includes(child.state?.state ?? "")) {
    return child.state!.state === "_completed" ? "Completed" : child.state!.state === "_failed" ? "Failed" : "Cancelled";
  }
  if (!connected) return "Status unknown";
  if (pending) return "Needs your input";
  switch (child.state?.state) {
    case "running": return "Running";
    case "idle": return "Idle";
    case "requires_action": return "Needs your input";
    case "_completed": return "Completed";
    case "_failed": return "Failed";
    case "_cancelled": return "Cancelled";
    default: return "Status unknown";
  }
}

/** One short, plain-text activity line; full Markdown belongs in the detail view. */
export function subagentPreview(child: SubagentMessage): string {
  const latest = [...child.messages].reverse().find((message) => (message.type === "assistant" && message.content.trim()) || message.type === "tool");
  const text = latest?.type === "assistant" ? latest.content
    : latest?.type === "tool" ? latest.name || latest.title : child.description?.startsWith("Delegated task for ") ? "Waiting for activity" : child.description || "Waiting for activity";
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*~]/g, "").replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/\s+/g, " ").trim().slice(0, 180);
}
