import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../../api/client";
import type { NeedsYouItem } from "./dashboardModel";

/** A pending native elicitation simple enough to answer from the Dashboard. */
export interface InlineForm {
  request_id: string;
  agent_name: string;
  message: string;
  field: {
    name: string;
    label: string;
    description: string | null;
    required: boolean;
    kind: "boolean" | "choice" | "text";
    options: string[];
  };
}

/** More choices than this open the session instead of crowding the row. */
export const MAX_INLINE_CHOICES = 3;

const formPath = (item: NeedsYouItem) =>
  `/api/v1/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.taskId)}/chats/${encodeURIComponent(item.chatId ?? "")}/pending-form`;

/** Only well-formed, inline-sized forms; anything else (an older server that
 *  answers with index.html, unknown kinds, long choice lists) opens the session. */
export function usableForm(response: unknown): InlineForm | null {
  const form = (response as { form?: InlineForm | null } | null)?.form;
  if (!form || typeof form.request_id !== "string" || !form.field || typeof form.field.name !== "string") return null;
  const { kind, options } = form.field;
  if (kind === "choice") return Array.isArray(options) && options.length > 0 && options.length <= MAX_INLINE_CHOICES ? form : null;
  return kind === "boolean" || kind === "text" ? form : null;
}

/**
 * For each "input" row, the pending request if it can be answered in place.
 * Fetched once per request (row id + start time); failures fall back to the
 * row's "Answer" (open the session).
 */
export function usePendingForms(items: NeedsYouItem[]) {
  const [forms, setForms] = useState<Map<string, InlineForm>>(() => new Map());
  const inputs = items.filter((item) => item.kind === "input" && item.chatId);
  const key = inputs.map((item) => `${item.id}@${item.at}`).join("\u0000");

  const store = useCallback((item: NeedsYouItem, form: InlineForm | null) => {
    setForms((previous) => {
      const next = new Map(previous);
      if (form) next.set(item.id, form);
      else next.delete(item.id);
      return next;
    });
  }, []);

  const load = useCallback((item: NeedsYouItem) => apiClient.get<unknown>(formPath(item))
    .then((response) => store(item, usableForm(response)))
    .catch(() => store(item, null)), [store]);

  useEffect(() => {
    // Only the key matters: it changes when a request starts or ends.
    for (const item of inputs) {
      apiClient.get<unknown>(formPath(item))
        .then((response) => store(item, usableForm(response)))
        .catch(() => store(item, null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, store]);

  const formFor = useCallback((item: NeedsYouItem) => forms.get(item.id) ?? null, [forms]);
  return { formFor, reload: load };
}

/** Answer the pending request. Throws with the server's message on failure. */
export async function answerPendingForm(item: NeedsYouItem, form: InlineForm, value: string) {
  await apiClient.post<{ request_id: string; action: "accept"; value: string }, { status?: string }>(
    formPath(item),
    { request_id: form.request_id, action: "accept", value },
  );
}
