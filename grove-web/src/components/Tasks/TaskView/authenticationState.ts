import type { ChatMessage } from "./TaskChat";

/** ACP success is authoritative even if the terminal reported a transport
 * error before the reinitialized Agent confirmed its credentials. */
export function resolveAuthenticationMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => message.type === "auth_required"
    ? { ...message, status: "succeeded", errorMessage: undefined }
    : message);
}
