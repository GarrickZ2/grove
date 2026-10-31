import type { ChatMessage, ServerEvent } from "../../Tasks/TaskView/TaskChat";
import { reduceMessageChunk } from "../../Tasks/TaskView/messageChunks";
import { reduceV2Message } from "../../Tasks/TaskView/v2Messages";
import type { AskFormDefinition, AcpElicitationSnapshot } from "../../Tasks/TaskView/formPillTypes";

export type BuddyEvent = { type: string; [key: string]: unknown };
export interface Approval { kind: "approval"; id: string; title: string; detail: string; options: { option_id: string; name: string; kind: string }[]; resolved?: string }
export interface Question { kind: "question"; id: string; definition?: AskFormDefinition; snapshot?: AcpElicitationSnapshot; resolved?: string; error?: string; answer?: string }
export interface Activity { kind: "activity"; id: string; started: number; ended?: number; steps: { id: string; title: string }[] }
export type BuddyRow = { kind: "message"; id: string; index: number } | Approval | Question | Activity | { kind: "event"; id: string; text: string };
export interface BuddyTimelineState { messages: ChatMessage[]; rows: BuddyRow[]; busy: boolean; activity: string | null; started: number; hidden: string[]; pending: Record<string, { text: string; attachments: unknown[] }>; dispatched: string[] }
export const emptyBuddyTimeline = (): BuddyTimelineState => ({ messages: [], rows: [], busy: false, activity: null, started: 0, hidden: [], pending: {}, dispatched: [] });
const string = (value: unknown) => typeof value === "string" ? value : "";
function withMessages(state: BuddyTimelineState, messages: ChatMessage[]): BuddyTimelineState {
  return { ...state, messages, rows: [...state.rows, ...messages.slice(state.messages.length).map((_, offset): BuddyRow => ({ kind: "message", id: `message-${state.messages.length + offset}`, index: state.messages.length + offset }))] };
}
function user(state: BuddyTimelineState, event: BuddyEvent): BuddyTimelineState {
  const sender = string(event.sender), id = string(event.message_id), clientId = string(event.client_message_id);
  if (sender && sender !== "connect") {
    if (id && state.hidden.includes(id)) return state;
    return { ...withMessages(state, [...state.messages, { type: "user", content: "", sender, messageId: id || undefined }]), hidden: id ? [...state.hidden, id] : state.hidden };
  }
  if (id && state.hidden.includes(id)) return state;
  if (clientId && state.messages.some(m => m.type === "user" && m.clientMessageId === clientId)) return state;
  if (id && state.messages.some(m => m.type === "user" && m.messageId === id)) return state;
  const attachments = Array.isArray(event.attachments) ? event.attachments.map(value => {
    const file = value as Record<string, unknown>;
    return { type: file.type === "image" ? "image" as const : file.type === "audio" ? "audio" as const : "resource" as const, name: string(file.name), label: string(file.name), data: string(file.data), mimeType: string(file.mime_type), uri: string(file.uri) || undefined };
  }) : [];
  return withMessages(state, [...state.messages, { type: "user", content: string(event.text), messageId: id || undefined, clientMessageId: clientId || undefined, sender: sender || undefined, attachments }]);
}
function activity(state: BuddyTimelineState, id: string, title: string, now: number): BuddyTimelineState {
  const key = state.activity ?? `activity-${state.rows.length}`;
  let rows = state.rows;
  if (!state.activity) rows = [...rows, { kind: "activity", id: key, started: state.started || now, steps: [] }];
  rows = rows.map(row => row.kind === "activity" && row.id === key ? { ...row, steps: row.steps.some(step => step.id === id) ? row.steps.map(step => step.id === id ? { id, title: title || step.title } : step) : [...row.steps, { id, title }] } : row);
  return { ...state, rows, activity: key };
}
export function reduceBuddyEvent(state: BuddyTimelineState, event: BuddyEvent, now = Date.now()): BuddyTimelineState {
  const id = string(event.id);
  switch (event.type) {
    case "buddy_input": return { ...state, pending: { ...state.pending, [string(event.client_message_id)]: { text: string(event.text), attachments: Array.isArray(event.attachments) ? event.attachments : [] } } };
    case "input_accepted": {
      const key = string(event.client_message_id), pending = state.pending[key];
      return pending ? user(state, { type: "user_message", ...pending, client_message_id: key }) : state;
    }
    case "queue_update": {
      let next = state;
      if (Array.isArray(event.messages)) for (const item of event.messages) if (item && typeof item === "object") {
        const input = item as Record<string, unknown>;
        next = user(next, { type: "user_message", ...input, client_message_id: input.id });
      }
      return next;
    }
    case "prompt_started": return activity({ ...state, busy: true, started: Number(event.start_ts) || now, dispatched: Array.isArray(event.message_ids) ? event.message_ids as string[] : [] }, "working", "Working…", now);
    case "user_message": {
      // A compact turn echoes a combined prompt. Keep its already accepted bubbles in this view.
      const represented = state.dispatched.length > 0 && state.dispatched.every(key => state.messages.some(m => m.type === "user" && m.clientMessageId === key));
      const next = represented && !event.client_message_id ? state : user(state, event);
      return { ...next, dispatched: [], busy: true, started: state.started || now };
    }
    case "message_chunk": case "message_content_chunk":
      return withMessages(state, reduceMessageChunk(state.messages, event as ServerEvent));
    case "v2_message_bind": return withMessages(state, reduceV2Message(state.messages, event as ServerEvent));
    case "v2_message_update": {
      const update = event.update as Record<string, unknown> | undefined;
      if (!update || state.hidden.includes(string(update.messageId))) return state;
      if (string(update.sessionUpdate).includes("thought")) return activity(state, "thinking", "Thinking…", now);
      return withMessages(state, reduceV2Message(state.messages, event as ServerEvent));
    }
    case "thought_chunk": return activity(state, "thinking", "Thinking…", now);
    case "plan": case "plan_update": case "plan_document_update": return activity(state, "plan", "Planning next steps", now);
    case "tool_call": case "tool_call_update": case "v2_tool_update": {
      const update = event.type === "v2_tool_update" ? event.update as Record<string, unknown> : event;
      if (!update) return state;
      const toolId = string(update.toolCallId) || id;
      const title = string(update.title);
      if (!toolId || !title && !state.activity) return state;
      const current = state.rows.find(row => row.kind === "activity" && row.id === state.activity);
      const previousTitle = current?.kind === "activity" ? current.steps.find(step => step.id === toolId)?.title : undefined;
      let next = activity(state, toolId, title || previousTitle || "Working…", now);
      const name = string(update.tool_name) || string(update.name) || title;
      if (/buddy_routine_(create|update|delete)/.test(name) && (update.status === "completed" || update.status === "complete")) {
        const eventId = `routine-${toolId}`;
        if (!next.rows.some(row => row.id === eventId)) next = { ...next, rows: [...next.rows, { kind: "event", id: eventId, text: `${name.includes("delete") ? "Deleted" : name.includes("update") ? "Updated" : "Created"} routine · ${title}` }] };
      }
      return next;
    }
    case "permission_request": {
      if (!id) return state;
      const row: Approval = { kind: "approval", id, title: string(event.title) || string(event.description), detail: string(event.detail), options: Array.isArray(event.options) ? event.options as Approval["options"] : [] };
      return { ...state, rows: state.rows.some(r => r.kind === "approval" && r.id === id) ? state.rows.map(r => r.kind === "approval" && r.id === id ? row : r) : [...state.rows, row] };
    }
    case "permission_response": return { ...state, rows: state.rows.map(row => row.kind === "approval" && row.id === id ? { ...row, resolved: string(event.option_id) } : row) };
    case "ask_form": case "elicitation_request": {
      const key = string(event.form_id) || string(event.request_id);
      if (!key) return state;
      const row: Question = { kind: "question", id: key, definition: event.type === "ask_form" ? event.definition as AskFormDefinition : undefined, snapshot: event.type === "elicitation_request" ? event as unknown as AcpElicitationSnapshot : undefined };
      return { ...state, rows: state.rows.some(r => r.kind === "question" && r.id === key) ? state.rows.map(r => r.kind === "question" && r.id === key ? row : r) : [...state.rows, row] };
    }
    case "buddy_answer": return { ...state, rows: state.rows.map(row => row.kind === "question" && row.id === id ? { ...row, answer: string(event.text) } : row) };
    case "ask_form_resolved": case "elicitation_resolved": case "elicitation_complete": case "elicitation_validation_error": {
      const answered = state.rows.find(row => row.kind === "question" && row.id === (id || event.request_id));
      const next = event.type === "elicitation_resolved" && event.action === "accept" && answered?.kind === "question" && answered.answer ? user(state, { type: "user_message", text: answered.answer, client_message_id: `answer-${answered.id}` }) : state;
      return { ...next, rows: next.rows.map(row => {
        if (row.kind !== "question" || row.id !== (id || event.request_id) && !(event.elicitation_id && row.snapshot?.request.elicitationId === event.elicitation_id)) return row;
        if (event.type === "elicitation_validation_error") return { ...row, resolved: undefined, error: string(event.message), answer: undefined };
        if (row.snapshot?.request.mode === "url" && event.action === "accept") return { ...row, snapshot: { ...row.snapshot, opened: true } };
        return { ...row, resolved: string(event.action) || "complete", error: undefined };
      }) };
    }
    case "buddy_reconcile": return { ...state, rows: state.rows.map(row => row.kind === "approval" || row.kind === "question" ? { ...row, resolved: row.resolved || "No longer pending" } : row) };
    case "busy": if (event.value !== false) return { ...state, busy: true }; return { ...state, busy: false };
    case "complete": case "turn_interrupted": case "session_ended":
      return { ...state, busy: false, activity: null, started: 0, messages: state.messages.map(m => m.type === "assistant" ? { ...m, complete: true } : m), rows: state.rows.map(row => row.kind === "activity" && !row.ended ? { ...row, ended: now } : row) };
    case "error": case "session_notice": return { ...state, rows: [...state.rows, { kind: "event", id: `event-${state.rows.length}`, text: string(event.message) || string(event.text) }] };
    default: return state;
  }
}
