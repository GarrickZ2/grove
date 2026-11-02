/*
 * Open a task's Code Review panel from anywhere in Orbit.
 *
 *   requestOpenReview({ projectId, taskId, file?, line? })
 *
 * The task workspace (`IDELayoutContainer`) opens its Review panel and, when
 * `file` is given, jumps to that file (and line). Callers outside the
 * workspace, e.g. the Dashboard, call this and then navigate to the task as
 * they normally do: the request is kept briefly, so a workspace that mounts
 * after the navigation still picks it up. A workspace that is already mounted
 * gets it at once through `OPEN_REVIEW_EVENT`.
 *
 * A request is consumed once, by the workspace showing that task, and goes
 * stale after `PENDING_TTL_MS` so a later visit never opens Review by surprise.
 * A workspace that can't tell yet whether it has a Review (a Studio task whose
 * linked Projects are still loading) leaves the request pending until it can.
 */

import { useEffect } from "react";

export const OPEN_REVIEW_EVENT = "grove:open-review";

export interface OpenReviewRequest {
  projectId: string;
  taskId: string;
  /** Task-relative path of the file to show. */
  file?: string;
  /** Line to scroll to (needs `file`). */
  line?: number;
  /** `diff` (Changes) or `full` (All files). Omitted: the workspace decides. */
  mode?: "diff" | "full";
}

const PENDING_TTL_MS = 15_000;

let pending: { request: OpenReviewRequest; at: number } | null = null;

/** Ask the workspace showing `taskId` to open Code Review. */
export function requestOpenReview(request: OpenReviewRequest): void {
  pending = { request, at: Date.now() };
  window.dispatchEvent(new CustomEvent<OpenReviewRequest>(OPEN_REVIEW_EVENT, { detail: request }));
}

/** The pending request for this task, if any; taking it clears it. */
export function takeOpenReviewRequest(projectId: string, taskId: string): OpenReviewRequest | null {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  const { request } = pending;
  if (request.projectId !== projectId || request.taskId !== taskId) return null;
  pending = null;
  return request;
}

/**
 * The workspace side: hands this task's request to `onOpen` once `ready`
 * (taken on mount, when `ready` turns true, and on the event). Until then the
 * request stays pending, up to its TTL.
 */
export function useOpenReviewRequests(
  projectId: string,
  taskId: string,
  ready: boolean,
  onOpen: (request: OpenReviewRequest) => void,
): void {
  useEffect(() => {
    if (!ready) return;
    const take = () => {
      const request = takeOpenReviewRequest(projectId, taskId);
      if (request) onOpen(request);
    };
    take();
    window.addEventListener(OPEN_REVIEW_EVENT, take);
    return () => window.removeEventListener(OPEN_REVIEW_EVENT, take);
  }, [projectId, taskId, ready, onOpen]);
}
