import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { persistOverride, persistRemoveOverride } from "../../keyboard";
import type { AudioSettings } from "./types";
import { buildVocabularyRows, formatPTTKey, formatShortcut, type VocabularyRow, type VocabularyTab } from "./utils";

export type SettingsScope = "global" | "project";
export type RecordingTarget = "toggle" | "ptt";

/** Parse a numeric draft and clamp it; falls back to `current` when it isn't a number. */
export function clampDraft(draft: string, min: number, max: number, current: number): number {
  const parsed = Number(draft);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : current;
}

export const AUDIO_LIMITS = {
  minDuration: { min: 1, max: 10, step: 1 },
  maxDuration: { min: 10, max: 300, step: 1 },
  pttActivationDelayMs: { min: 100, max: 2000, step: 50 },
} as const;

type TermListKey = "preferredTermsGlobal" | "preferredTermsProject" | "forbiddenTermsGlobal" | "forbiddenTermsProject";

function termListKey(tab: Exclude<VocabularyTab, "replacement">, scope: SettingsScope): TermListKey {
  if (tab === "preferred") return scope === "global" ? "preferredTermsGlobal" : "preferredTermsProject";
  return scope === "global" ? "forbiddenTermsGlobal" : "forbiddenTermsProject";
}

function replacementKey(scope: SettingsScope) {
  return scope === "global" ? "replacementsGlobal" as const : "replacementsProject" as const;
}

/**
 * Editing state for the voice input (Audio) settings: every change is applied
 * locally and handed to `onSettingsSaved` right away. Shared by the Workbench
 * AudioPanel and Orbit's Voice input page.
 */
export function useAudioSettingsEditor(settings: AudioSettings, onSettingsSaved?: (settings: AudioSettings) => void) {
  const [audio, setAudio] = useState(settings);
  const [promptScope, setPromptScope] = useState<SettingsScope>("project");
  const [vocabularyTab, setVocabularyTab] = useState<VocabularyTab>("preferred");
  const [vocabularyQuery, setVocabularyQuery] = useState("");
  const [recordingTarget, setRecordingTarget] = useState<RecordingTarget | null>(null);
  const [vocabularyScope, setVocabularyScope] = useState<SettingsScope>("project");
  const [draftTerm, setDraftTerm] = useState("");
  const [draftReplacementFrom, setDraftReplacementFrom] = useState("");
  const [draftReplacementTo, setDraftReplacementTo] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [draftPromptGlobal, setDraftPromptGlobal] = useState(settings.revisePromptGlobal);
  const [draftPromptProject, setDraftPromptProject] = useState(settings.revisePromptProject);
  const [draftMinDuration, setDraftMinDuration] = useState(String(settings.minDuration));
  const [draftMaxDuration, setDraftMaxDuration] = useState(String(settings.maxDuration));
  const [draftPttActivationDelayMs, setDraftPttActivationDelayMs] = useState(
    String(settings.pttActivationDelayMs),
  );
  const promptEditorRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync local edit drafts whenever the upstream `settings` prop changes
  // (e.g. saved by another panel). Uses the documented "Adjusting state on
  // prop change" pattern instead of an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSyncedSettings, setLastSyncedSettings] = useState(settings);
  if (lastSyncedSettings !== settings) {
    setLastSyncedSettings(settings);
    setAudio(settings);
    setDraftPromptGlobal(settings.revisePromptGlobal);
    setDraftPromptProject(settings.revisePromptProject);
    setDraftMinDuration(String(settings.minDuration));
    setDraftMaxDuration(String(settings.maxDuration));
    setDraftPttActivationDelayMs(String(settings.pttActivationDelayMs));
  }

  const onSettingsSavedRef = useRef(onSettingsSaved);
  useEffect(() => { onSettingsSavedRef.current = onSettingsSaved; }, [onSettingsSaved]);

  const patchAudioState = useCallback((updater: (prev: AudioSettings) => AudioSettings) => {
    setAudio((prev) => {
      const next = updater(prev);
      queueMicrotask(() => onSettingsSavedRef.current?.(next));
      return next;
    });
  }, []);

  const patchAudio = useCallback(<K extends keyof AudioSettings>(key: K, value: AudioSettings[K]) => {
    patchAudioState((prev) => ({ ...prev, [key]: value }));
  }, [patchAudioState]);

  // Mirror PTT key changes into the keymap_overrides table so the binding is
  // visible / editable from Settings → Keyboard Shortcuts. Empty key clears
  // the override. The keymap dispatcher isn't the active path for PTT (the
  // raw keydown/keyup listener in GlobalAudioRecorder still owns that), so
  // a write-failure here doesn't break recording — just log and move on.
  const mirrorPTTToKeymap = useCallback(async (key: string) => {
    try {
      if (key) {
        await persistOverride({
          command_id: "audio.ptt.start",
          key,
          when_ctx: undefined,
          scope: undefined,
        });
      } else {
        await persistRemoveOverride("audio.ptt.start");
      }
    } catch (err) {
      console.error("[AudioPanel] mirror PTT → keymap failed:", err);
    }
  }, []);

  const commitMinDuration = useCallback(() => {
    const { min, max } = AUDIO_LIMITS.minDuration;
    const next = clampDraft(draftMinDuration, min, max, audio.minDuration);
    setDraftMinDuration(String(next));
    if (next !== audio.minDuration) patchAudio("minDuration", next);
  }, [audio.minDuration, draftMinDuration, patchAudio]);

  const commitMaxDuration = useCallback(() => {
    const { min, max } = AUDIO_LIMITS.maxDuration;
    const next = clampDraft(draftMaxDuration, min, max, audio.maxDuration);
    setDraftMaxDuration(String(next));
    if (next !== audio.maxDuration) patchAudio("maxDuration", next);
  }, [audio.maxDuration, draftMaxDuration, patchAudio]);

  const commitPttActivationDelay = useCallback(() => {
    const { min, max } = AUDIO_LIMITS.pttActivationDelayMs;
    const next = clampDraft(draftPttActivationDelayMs, min, max, audio.pttActivationDelayMs);
    setDraftPttActivationDelayMs(String(next));
    if (next !== audio.pttActivationDelayMs) patchAudio("pttActivationDelayMs", next);
  }, [audio.pttActivationDelayMs, draftPttActivationDelayMs, patchAudio]);

  useEffect(() => {
    if (!recordingTarget) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingTarget(null);
        return;
      }

      if (recordingTarget === "toggle") {
        const combo = formatShortcut(event);
        if (combo) {
          patchAudioState((prev) => ({ ...prev, toggleShortcut: combo }));
          setRecordingTarget(null);
        }
      } else {
        const key = formatPTTKey(event);
        if (key) {
          patchAudioState((prev) => ({ ...prev, pushToTalkKey: key }));
          void mirrorPTTToKeymap(key);
          setRecordingTarget(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingTarget, patchAudioState, mirrorPTTToKeymap]);

  const toggleRecordingTarget = useCallback((target: RecordingTarget) => {
    setRecordingTarget((current) => (current === target ? null : target));
  }, []);

  const clearShortcut = useCallback((target: RecordingTarget) => {
    setRecordingTarget(null);
    if (target === "toggle") {
      patchAudio("toggleShortcut", "");
      return;
    }
    patchAudio("pushToTalkKey", "");
    void mirrorPTTToKeymap("");
  }, [mirrorPTTToKeymap, patchAudio]);

  const vocabularyRows = useMemo(() => buildVocabularyRows(audio), [audio]);
  const filteredRows = useMemo(
    () =>
      vocabularyRows.filter((row) => {
        if (row.tab !== vocabularyTab) return false;
        if (row.scopeKey !== vocabularyScope) return false;
        const haystack = `${row.scope} ${row.from} ${row.to}`.toLowerCase();
        return haystack.includes(vocabularyQuery.toLowerCase());
      }),
    [vocabularyQuery, vocabularyRows, vocabularyScope, vocabularyTab],
  );

  const toggleTranscription = () => {
    setRecordingTarget(null);
    patchAudioState((prev) => (
      prev.enabled
        ? { ...prev, enabled: false, reviseEnabled: false }
        : { ...prev, enabled: true }
    ));
  };

  const toggleRevision = () => {
    if (!audio.enabled) return;
    patchAudioState((prev) => ({ ...prev, reviseEnabled: !prev.reviseEnabled }));
  };

  const togglePreferredLanguage = (language: string) => {
    patchAudioState((prev) => ({
      ...prev,
      preferredLanguages: prev.preferredLanguages.includes(language)
        ? prev.preferredLanguages.filter((item) => item !== language)
        : [...prev.preferredLanguages, language],
    }));
  };

  const addCustomLanguage = (language: string) => {
    patchAudioState((prev) => ({
      ...prev,
      preferredLanguages: [...prev.preferredLanguages, language],
    }));
  };

  const canAddVocabulary =
    vocabularyTab === "replacement"
      ? Boolean(draftReplacementFrom.trim() && draftReplacementTo.trim())
      : Boolean(draftTerm.trim());

  const addVocabulary = () => {
    if (vocabularyTab === "replacement") {
      if (!draftReplacementFrom.trim() || !draftReplacementTo.trim()) return;
      const nextRule = { from: draftReplacementFrom.trim(), to: draftReplacementTo.trim() };
      const key = replacementKey(vocabularyScope);
      patchAudioState((prev) => ({ ...prev, [key]: [nextRule, ...prev[key]] }));
      setDraftReplacementFrom("");
      setDraftReplacementTo("");
      setVocabularyQuery("");
      return;
    }

    if (!draftTerm.trim()) return;
    const key = termListKey(vocabularyTab, vocabularyScope);
    patchAudioState((prev) => ({ ...prev, [key]: [draftTerm.trim(), ...prev[key]] }));
    setDraftTerm("");
    setVocabularyQuery("");
  };

  const deleteVocabulary = (row: VocabularyRow) => {
    if (row.tab === "replacement") {
      const key = replacementKey(row.scopeKey);
      patchAudioState((prev) => ({ ...prev, [key]: prev[key].filter((_, index) => index !== row.index) }));
      return;
    }
    const key = termListKey(row.tab, row.scopeKey);
    patchAudioState((prev) => ({ ...prev, [key]: prev[key].filter((_, index) => index !== row.index) }));
  };

  const currentPrompt = promptScope === "global" ? audio.revisePromptGlobal : audio.revisePromptProject;
  const currentDraftPrompt = promptScope === "global" ? draftPromptGlobal : draftPromptProject;
  const setCurrentDraftPrompt = (value: string) => {
    if (promptScope === "global") setDraftPromptGlobal(value);
    else setDraftPromptProject(value);
  };

  const startPromptEdit = () => {
    setDraftPromptGlobal(audio.revisePromptGlobal);
    setDraftPromptProject(audio.revisePromptProject);
    setIsEditingPrompt(true);
    requestAnimationFrame(() => promptEditorRef.current?.focus());
  };

  const cancelPromptEdit = () => {
    setDraftPromptGlobal(audio.revisePromptGlobal);
    setDraftPromptProject(audio.revisePromptProject);
    setIsEditingPrompt(false);
  };

  const savePromptEdit = () => {
    patchAudioState((prev) => ({
      ...prev,
      revisePromptGlobal: draftPromptGlobal,
      revisePromptProject: draftPromptProject,
    }));
    setIsEditingPrompt(false);
  };

  return {
    audio,
    patchAudio,
    promptEditorRef,
    toggleTranscription,
    toggleRevision,
    togglePreferredLanguage,
    addCustomLanguage,
    recordingTarget,
    toggleRecordingTarget,
    clearShortcut,
    durations: {
      minDuration: { draft: draftMinDuration, setDraft: setDraftMinDuration, commit: commitMinDuration },
      maxDuration: { draft: draftMaxDuration, setDraft: setDraftMaxDuration, commit: commitMaxDuration },
      pttActivationDelayMs: { draft: draftPttActivationDelayMs, setDraft: setDraftPttActivationDelayMs, commit: commitPttActivationDelay },
    },
    vocabulary: {
      tab: vocabularyTab,
      setTab: setVocabularyTab,
      scope: vocabularyScope,
      setScope: setVocabularyScope,
      query: vocabularyQuery,
      setQuery: setVocabularyQuery,
      draftTerm,
      setDraftTerm,
      draftReplacementFrom,
      setDraftReplacementFrom,
      draftReplacementTo,
      setDraftReplacementTo,
      rows: filteredRows,
      canAdd: canAddVocabulary,
      add: addVocabulary,
      remove: deleteVocabulary,
    },
    prompt: {
      scope: promptScope,
      setScope: setPromptScope,
      isEditing: isEditingPrompt,
      saved: currentPrompt,
      draft: currentDraftPrompt,
      setDraft: setCurrentDraftPrompt,
      startEdit: startPromptEdit,
      cancelEdit: cancelPromptEdit,
      saveEdit: savePromptEdit,
    },
  };
}

export type AudioSettingsEditor = ReturnType<typeof useAudioSettingsEditor>;
