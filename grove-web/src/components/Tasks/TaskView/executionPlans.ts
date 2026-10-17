import type { ChatMessage } from "./TaskChat";
import { normalizePlanEntries, type PlanEntry } from "./planEntries";

export type PlanDocument =
  | { type: "items"; plan_id: string; entries: PlanEntry[] }
  | { type: "markdown"; plan_id: string; content: string }
  | { type: "file"; plan_id: string; uri: string };
export type PlanDocumentMessage = { type: "plan_document"; plan: PlanDocument };

function normalizePlan(value: unknown): PlanDocument | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as Record<string, unknown>;
  if (typeof plan.plan_id !== "string") return null;
  if (plan.type === "items" && Array.isArray(plan.entries)) return { type: "items", plan_id: plan.plan_id, entries: normalizePlanEntries(plan.entries) };
  if (plan.type === "markdown" && typeof plan.content === "string") return { type: "markdown", plan_id: plan.plan_id, content: plan.content };
  if (plan.type === "file" && typeof plan.uri === "string") return { type: "file", plan_id: plan.plan_id, uri: plan.uri };
  return null;
}

export function reducePlanDocumentEvent(messages: ChatMessage[], event: { type: string; plan?: unknown; plan_id?: unknown }): ChatMessage[] {
  if (event.type === "plan_document_removed" && typeof event.plan_id === "string") {
    return messages.filter((message) => message.type !== "plan_document" || message.plan.plan_id !== event.plan_id);
  }
  if (event.type !== "plan_document_update") return messages;
  const plan = normalizePlan(event.plan);
  if (!plan) return messages;
  const previous = messages.findIndex((message) => message.type === "plan_document" && message.plan.plan_id === plan.plan_id);
  const next: PlanDocumentMessage = { type: "plan_document", plan };
  return previous < 0 ? [...messages, next] : messages.map((message, index) => index === previous ? next : message);
}

/** Deliberately excludes descendants: IDs are unique only within a session. */
export function sessionPlanDocuments(messages: ChatMessage[]): PlanDocument[] {
  return messages.flatMap((message) => message.type === "plan_document" ? [message.plan] : []);
}

export function planFilePath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
  } catch { return null; }
}

export function planDocumentTitle(plan: PlanDocument, index: number): string {
  if (plan.type === "file") return (planFilePath(plan.uri) ?? plan.uri).split("/").pop() || `Plan ${index + 1}`;
  if (plan.type === "markdown") return plan.content.match(/^#{1,6}\s+(.+)/m)?.[1]?.trim() || `Plan ${index + 1}`;
  return `Plan ${index + 1}`;
}
