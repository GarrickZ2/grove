import { isIosClient } from '../utils/platform';
/** Reuse TaskChat's authoritative runtime messages, not rendered transcript text. */
export function publishIosChatEvent(project: string, task: string, chat: string, event: unknown, title?: string) {
  if (!isIosClient) return;
  window.dispatchEvent(new CustomEvent('grove:ios-chat-runtime', {detail: {
    type:'chat_runtime', project_id:project, task_id:task, chat_id:chat, chat_title:title, event,
  }}));
}
