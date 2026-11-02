import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryConfigInput } from "../../api/memory";
import type { MemoryConfigDraftState } from "../../components/Memory/useMemoryConfigDraft";
import { draftProblem } from "./memoryView";

const AUTOSAVE_MS = 450;

/**
 * Orbit saves Memory settings as you change them. Only edits made through
 * `edit` are saved, so the draft's own reconciliation with installed Agents
 * never writes a config by itself. A failed save isn't retried until the
 * next edit.
 */
export function useMemoryAutosave(editor: MemoryConfigDraftState) {
  const { draft, setDraft, isDirty, saving, save, chooseAgent } = editor;
  const [touched, setTouched] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const failedRef = useRef<string | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const edit = useCallback((update: (current: MemoryConfigInput) => MemoryConfigInput) => {
    failedRef.current = null;
    setTouched(true);
    setDraft(update);
  }, [setDraft]);

  const editAgent = useCallback((agentId: string) => {
    failedRef.current = null;
    setTouched(true);
    chooseAgent(agentId);
  }, [chooseAgent]);

  const problem = touched ? draftProblem(draft) : null;

  useEffect(() => {
    if (!touched || !isDirty || saving || draftProblem(draft)) return;
    const key = JSON.stringify(draft);
    if (failedRef.current === key) return;
    const timer = window.setTimeout(() => {
      void saveRef.current(draft, true).then((ok) => {
        if (ok) {
          setTouched(false);
          setSavedCount((count) => count + 1);
        } else {
          failedRef.current = key;
        }
      });
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, isDirty, saving, touched]);

  return { edit, editAgent, problem, savedCount, pending: touched && isDirty };
}
