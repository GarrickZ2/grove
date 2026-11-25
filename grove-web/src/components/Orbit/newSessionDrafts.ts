import { useSyncExternalStore } from "react";

/**
 * Tasks whose workspace shows the New composer in place of a Session (Orbit
 * desktop). The Session is created on the first send, so until then the Task's
 * panels are reachable with no Session at all.
 */
export type NewSessionEnd = "sent" | "left";

const open = new Set<string>();
const ends = new Map<string, NewSessionEnd>();
const listeners = new Set<() => void>();
let shown: string | null = null;

const keyOf = (projectId: string, taskId: string) => `${projectId}:${taskId}`;
const notify = () => listeners.forEach((listener) => listener());
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function beginNewSession(projectId: string, taskId: string): void {
  const key = keyOf(projectId, taskId);
  if (open.has(key)) return;
  open.add(key);
  ends.delete(key);
  notify();
}

/** `sent`: the first message created the Session. `left`: another Session was opened instead. */
export function endNewSession(projectId: string, taskId: string, reason: NewSessionEnd): void {
  const key = keyOf(projectId, taskId);
  if (!open.delete(key)) return;
  ends.set(key, reason);
  notify();
}

export function hasNewSession(projectId: string, taskId: string): boolean {
  return open.has(keyOf(projectId, taskId));
}

export function newSessionEnd(projectId: string, taskId: string): NewSessionEnd | undefined {
  return ends.get(keyOf(projectId, taskId));
}

export function useNewSession(projectId: string, taskId: string): boolean {
  return useSyncExternalStore(subscribe, () => open.has(keyOf(projectId, taskId)), () => false);
}

/** The one on screen. No Session is, so nothing can be sent to the one behind it. */
export function showNewSession(projectId: string, taskId: string): () => void {
  const key = keyOf(projectId, taskId);
  const set = (next: string | null) => {
    shown = next;
    notify();
    window.dispatchEvent(new CustomEvent("grove-active-chat-changed"));
  };
  set(key);
  return () => { if (shown === key) set(null); };
}

export function newSessionShown(): boolean {
  return shown !== null;
}

export function useShownNewSession(): string | null {
  return useSyncExternalStore(subscribe, () => shown, () => null);
}
