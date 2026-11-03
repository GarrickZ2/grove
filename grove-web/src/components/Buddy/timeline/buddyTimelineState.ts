import type { ChatMessage, ServerEvent } from "../../Tasks/TaskView/TaskChat";
import { reduceMessageChunk } from "../../Tasks/TaskView/messageChunks";
import { reduceV2Message } from "../../Tasks/TaskView/v2Messages";
import type { AskFormDefinition, AcpElicitationSnapshot } from "../../Tasks/TaskView/formPillTypes";

export type BuddyEvent = { type: string; [key: string]: unknown };
export interface Approval { kind: "approval"; id: string; title: string; detail: string; options: { option_id: string; name: string; kind: string }[]; resolved?: string }
export interface Question { kind: "question"; id: string; definition?: AskFormDefinition; snapshot?: AcpElicitationSnapshot; resolved?: string; error?: string; answer?: string }
export interface Activity { kind: "activity"; id: string; started: number; ended?: number; steps: { id: string; title: string }[] }
/** A `send` that starts a new Session (formerly `delegate`). The delegation record (status, result) comes from the delegation list, not the stream. */
export interface DelegationRow { kind: "delegation"; id: string; title: string; delegationId?: string; failed?: boolean }
export type BuddyRow = { kind: "message"; id: string; index: number } | Approval | Question | Activity | DelegationRow | { kind: "event"; id: string; text: string; notice?: { lead: string; name?: string; detail?: string; tone?: "neutral" | "error" } };
export interface BuddyTimelineState { messages: ChatMessage[]; rows: BuddyRow[]; busy: boolean; activity: string | null; started: number; hidden: string[]; pending: Record<string, { text: string; attachments: unknown[] }>; dispatched: string[]; routineCalls?: Record<string, { verb: string; name: string }>;
  /** Work happened since the last assistant text, so the next text starts a new message (the answer may follow). */
  workSinceText?: boolean }
export const emptyBuddyTimeline = (): BuddyTimelineState => ({ messages: [], rows: [], busy: false, activity: null, started: 0, hidden: [], pending: {}, dispatched: [] });
const string = (value: unknown) => typeof value === "string" ? value : "";
/** Tool input arrives as `{label,value}` pairs (v1) or a raw object (v2). */
function toolInput(update: Record<string, unknown>, key: string): string {
  if (Array.isArray(update.input)) for (const item of update.input) if (item && typeof item === "object" && (item as Record<string, unknown>).label === key) return string((item as Record<string, unknown>).value);
  const raw = (update.rawInput ?? update.raw_input) as Record<string, unknown> | undefined;
  return raw && typeof raw === "object" ? string(raw[key]) : "";
}
/** `send` starts a new Session (and so a delegation card) only when it carries `new`. */
function newSessionTitle(update: Record<string, unknown>): string | undefined {
  const raw = (update.rawInput ?? update.raw_input) as Record<string, unknown> | undefined;
  const fresh = raw && typeof raw === "object" ? raw.new : undefined;
  if (fresh && typeof fresh === "object") return string((fresh as Record<string, unknown>).title) || "Delegated work";
  if (Array.isArray(update.input)) for (const item of update.input) if (item && typeof item === "object" && (item as Record<string, unknown>).label === "new") return "Delegated work";
  return undefined;
}
/** `message_buddy` returns `{message_id, to: {id, name}}`, possibly escaped inside text content. */
function messagedBuddyName(update: Record<string, unknown>): string | undefined {
  const output = [update.content, update.output, update.rawOutput, update.raw_output].filter(value => value != null).map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  return /\\*"to\\*"\s*:\s*\{[^}]*?\\*"name\\*"\s*:\s*\\*"([^"\\]+)/.exec(output)?.[1];
}
/** The tool result is the created Delegation JSON, whose first `id` is the delegation id. It may be escaped inside text content. */
function delegationIdFromOutput(update: Record<string, unknown>): string | undefined {
  const output = [update.content, update.output, update.rawOutput, update.raw_output].filter(value => value != null).map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  return /\\*"id\\*"\s*:\s*\\*"([^"\\]+)/.exec(output)?.[1];
}
function withMessages(state: BuddyTimelineState, messages: ChatMessage[]): BuddyTimelineState {
  return { ...state, messages, rows: [...state.rows, ...messages.slice(state.messages.length).map((_, offset): BuddyRow => ({ kind: "message", id: `message-${state.messages.length + offset}`, index: state.messages.length + offset }))] };
}
function user(state: BuddyTimelineState, event: BuddyEvent, now = Date.now()): BuddyTimelineState {
  const sender = string(event.sender), id = string(event.message_id), clientId = string(event.client_message_id);
  if (sender && sender !== "connect") {
    if (id && state.hidden.includes(id)) return state;
    // Kept (not shown as text) so the timeline can mark where Grove prompted the Buddy.
    return { ...withMessages(state, [...state.messages, { type: "user", content: string(event.text), sender, messageId: id || undefined, sentAt: now }]), hidden: id ? [...state.hidden, id] : state.hidden };
  }
  if (id && state.hidden.includes(id)) return state;
  if (clientId && state.messages.some(m => m.type === "user" && m.clientMessageId === clientId)) return state;
  if (id && state.messages.some(m => m.type === "user" && m.messageId === id)) return state;
  const attachments = Array.isArray(event.attachments) ? event.attachments.map(value => {
    const file = value as Record<string, unknown>;
    return { type: file.type === "image" ? "image" as const : file.type === "audio" ? "audio" as const : "resource" as const, name: string(file.name), label: string(file.name), data: string(file.data), mimeType: string(file.mime_type), uri: string(file.uri) || undefined };
  }) : [];
  return withMessages(state, [...state.messages, { type: "user", content: string(event.text), messageId: id || undefined, clientMessageId: clientId || undefined, sender: sender || undefined, attachments, sentAt: now }]);
}
function activity(state: BuddyTimelineState, id: string, title: string, now: number): BuddyTimelineState {
  const key = state.activity ?? `activity-${state.rows.length}`;
  let rows = state.rows;
  if (!state.activity) rows = [...rows, { kind: "activity", id: key, started: state.started || now, steps: [] }];
  rows = rows.map(row => row.kind === "activity" && row.id === key ? { ...row, steps: row.steps.some(step => step.id === id) ? row.steps.map(step => step.id === id ? { id, title: title || step.title } : step) : [...row.steps, { id, title }] } : row);
  return { ...state, rows, activity: key, workSinceText: true };
}
/** Text after tool/thinking work opens a new assistant message, as TaskChat's tool rows do, so a finished turn can keep only its answer. */
function assistantText(state: BuddyTimelineState, event: BuddyEvent): BuddyTimelineState {
  const text = string(event.text);
  if (!state.workSinceText || event.type !== "message_chunk" || !text.trim()) return withMessages(state, reduceMessageChunk(state.messages, event as ServerEvent));
  const id = string(event.message_id) || undefined, body = text.replace(/^\n+/, "");
  // Agents may reuse one message id across tool calls; retire the earlier part's id so later chunks land here.
  const messages = state.messages.map((message, index) => message.type !== "assistant" ? message : { ...message, complete: true, messageId: id && message.messageId === id ? `${id}#${index}` : message.messageId });
  return { ...withMessages(state, [...messages, { type: "assistant", content: body, messageId: id, complete: false, blocks: [{ type: "text", text: body }] }]), workSinceText: false };
}
export function reduceBuddyEvent(state: BuddyTimelineState, event: BuddyEvent, now = Date.now()): BuddyTimelineState {
  const id = string(event.id);
  switch (event.type) {
    case "buddy_input": return { ...state, pending: { ...state.pending, [string(event.client_message_id)]: { text: string(event.text), attachments: Array.isArray(event.attachments) ? event.attachments : [] } } };
    case "input_accepted": {
      const key = string(event.client_message_id), pending = state.pending[key];
      return pending ? user(state, { type: "user_message", ...pending, client_message_id: key }, now) : state;
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
      const next = represented && !event.client_message_id ? state : user(state, event, now);
      return { ...next, dispatched: [], busy: true, started: state.started || now };
    }
    case "message_chunk": case "message_content_chunk":
      return assistantText(state, event);
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
      // Completion updates often carry neither the tool name nor its input; fall back to the first event.
      const name = string(update.tool_name) || string(update.name) || title || previousTitle || "";
      // Later updates often omit the tool name, so an existing row also identifies the call.
      const rowId = `delegation-${toolId}`, existing = next.rows.find((row): row is DelegationRow => row.kind === "delegation" && row.id === rowId);
      const started = /(?:^|__)send$/.test(name) ? newSessionTitle(update) : undefined;
      if (existing || started || /(?:^|__|buddy_)delegate$/.test(name)) {
        const row: DelegationRow = { kind: "delegation", id: rowId, title: toolInput(update, "title") || (started !== "Delegated work" ? started : undefined) || existing?.title || "Delegated work", delegationId: delegationIdFromOutput(update) ?? existing?.delegationId, failed: update.status === "failed" || !!existing?.failed };
        next = { ...next, rows: existing ? next.rows.map(item => item === existing ? row : item) : [...next.rows, row] };
      }
      // A message to another Buddy shows as its own line: who it went to, the text on hover.
      const chatId = `buddy-chat-${toolId}`, chatRow = next.rows.find(row => row.id === chatId);
      if (chatRow || /(?:^|__)message_buddy$/.test(name)) {
        const previous = chatRow?.kind === "event" ? chatRow.notice : undefined;
        const failed = update.status === "failed";
        const reply = !!toolInput(update, "reply_to") || previous?.lead.startsWith("Replied") || previous?.lead === "Couldn't reply to";
        const lead = failed ? (reply ? "Couldn't reply to" : "Couldn't message") : reply ? "Replied to" : "Sent to";
        const to = messagedBuddyName(update) || toolInput(update, "buddy") || previous?.name || "a Buddy";
        const detail = toolInput(update, "text") || previous?.detail;
        const row: BuddyRow = { kind: "event", id: chatId, text: `${lead} ${to}`, notice: { lead, name: to, detail, tone: failed ? "error" : "neutral" } };
        next = { ...next, rows: chatRow ? next.rows.map(item => item === chatRow ? row : item) : [...next.rows, row] };
      }
      // Current names are verb_routine; buddy_routine_verb is kept for older histories.
      const match = /(?:^|__)(create|update|delete)_routine$|buddy_routine_(create|update|delete)$/.exec(name);
      const known = next.routineCalls?.[toolId];
      const routine = match ? { verb: match[1] ?? match[2], name: toolInput(update, "name") || known?.name || "" } : known;
      if (routine && match) next = { ...next, routineCalls: { ...next.routineCalls, [toolId]: routine } };
      if (routine && (update.status === "completed" || update.status === "complete")) {
        const eventId = `routine-${toolId}`;
        if (!next.rows.some(row => row.id === eventId)) {
          const lead = `${routine.verb === "delete" ? "Deleted" : routine.verb === "update" ? "Updated" : "Created"} routine`;
          next = { ...next, rows: [...next.rows, { kind: "event", id: eventId, text: `${lead}${routine.name ? ` · ${routine.name}` : ""}`, notice: { lead, name: routine.name || undefined } }] };
        }
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
    case "complete": case "turn_interrupted": case "session_ended": {
      // The backend stamps a finished turn with start_ts/end_ts (seconds); history replay has no other clock.
      const open = state.rows.find((row): row is Activity => row.kind === "activity" && !row.ended);
      const startedAt = Number(event.start_ts) * 1000 || open?.started || state.started || undefined, endedAt = Number(event.end_ts) * 1000 || now;
      // Like TaskChat, the turn's answer (its last assistant message) carries the turn timing for hover actions.
      let lastUser = -1, answer = -1;
      state.messages.forEach((m, i) => { if (m.type === "user") lastUser = i; else if (m.type === "assistant" && i > lastUser) answer = i; });
      if (answer < lastUser) answer = -1;
      return { ...state, busy: false, activity: null, started: 0, messages: state.messages.map((m, i) => m.type !== "assistant" ? m : { ...m, complete: true, ...(i === answer && event.type !== "session_ended" ? { startTs: startedAt && startedAt / 1000, endTs: endedAt / 1000 } : {}) }), rows: state.rows.map(row => row.kind === "activity" && !row.ended ? { ...row, started: startedAt ?? row.started, ended: endedAt } : row) };
    }
    case "user_message_time": {
      // Authoritative send time for a user message, keyed by its client id when present.
      const sentAt = Number(event.sent_at), key = string(event.client_message_id);
      if (!sentAt) return state;
      let target = key ? state.messages.findIndex(m => m.type === "user" && m.clientMessageId === key) : -1;
      if (target < 0) for (let i = state.messages.length - 1; i >= 0; i--) if (state.messages[i].type === "user") { target = i; break; }
      return target < 0 ? state : { ...state, messages: state.messages.map((m, i) => i === target && m.type === "user" ? { ...m, sentAt } : m) };
    }
    case "error": case "session_notice": return { ...state, rows: [...state.rows, { kind: "event", id: `event-${state.rows.length}`, text: string(event.message) || string(event.text) }] };
    default: return state;
  }
}
