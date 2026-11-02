import { useSyncExternalStore } from 'react';
import type { ReviewCommentEntry } from '../../api/tasks';
import { useGlobalActiveChatId } from '../Tasks/TaskView/useActiveChatId';
import {
  ACTIVE_CHAT_AGENT_EVENT,
  SEND_COMMENT_TO_CHAT_EVENT,
  readActiveChatAgent,
} from '../Tasks/TaskView/reviewCommentPrompt';

/* "Send all open comments to the agent": one batch over the existing
   send-to-chat event (TaskChat builds one message; see reviewCommentPrompt). */

/** Open includes outdated, matching Review's own counts. */
export function openCommentsOf(comments: ReviewCommentEntry[]): ReviewCommentEntry[] {
  return comments.filter((c) => c.status === 'open' || c.status === 'outdated');
}

function subscribeAgent(cb: () => void) {
  window.addEventListener(ACTIVE_CHAT_AGENT_EVENT, cb);
  return () => window.removeEventListener(ACTIVE_CHAT_AGENT_EVENT, cb);
}

/** The visible active chat and its agent label (null when no chat is showing). */
export function useActiveChatTarget(): { chatId: string | null; agent: string | null } {
  const chatId = useGlobalActiveChatId();
  const agent = useSyncExternalStore(subscribeAgent, readActiveChatAgent, () => null);
  return { chatId, agent: chatId ? agent : null };
}

export function sendCommentsToChat(comments: ReviewCommentEntry[]): void {
  window.dispatchEvent(new CustomEvent(SEND_COMMENT_TO_CHAT_EVENT, { detail: { comments } }));
}
