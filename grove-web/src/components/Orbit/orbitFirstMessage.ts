import type { ChatSessionResponse } from "../../api/tasks";
import type { Attachment } from "../Tasks/TaskView/chatAttachments";
import type { QueuedPromptConfig } from "./orbitDraftConfig";

/**
 * First message typed on Orbit's New page, waiting for its freshly created
 * Session to reach session_ready. TaskChat takes it once and sends it as a
 * normal prompt, so a failed start keeps the message for the next
 * successful connection (Reconnect / retry).
 */
export interface OrbitFirstMessage {
  text: string;
  config?: QueuedPromptConfig;
  /** The created chat, so TaskChat can show it (title, Agent) before its chat list refreshes. */
  chat?: ChatSessionResponse;
  /** Picked on the New page; files are uploaded by TaskChat when the prompt is sent. */
  attachments?: Attachment[];
}

const pending = new Map<string, OrbitFirstMessage>();

export function setOrbitFirstMessage(chatId: string, message: OrbitFirstMessage): void {
  pending.set(chatId, message);
}

export function takeOrbitFirstMessage(chatId: string): OrbitFirstMessage | undefined {
  const message = pending.get(chatId);
  pending.delete(chatId);
  return message;
}
