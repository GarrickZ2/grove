import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Keyboard, Mic, MicOff, Pencil, Plus, Search, Timer, Trash2, Wand2, X } from "lucide-react";
import { LanguageMultiSelect } from "./components/LanguageMultiSelect";
import { FieldGroup, PipelineSection } from "./components/PipelineLayout";
import { ProfilePicker } from "./components/ProfilePicker";
import type { AudioSettings, ProviderProfile } from "./types";
import { buildVocabularyRows, formatShortcut, formatPTTKey, pttKeyLabel, type VocabularyRow, type VocabularyTab } from "./utils";

type PromptScope = "global" | "project";

const languageOptions = [
  { id: "zh", label: "Chinese", value: "Chinese" },
  { id: "en", label: "English", value: "English" },
  { id: "ja", label: "Japanese", value: "Japanese" },
  { id: "ko", label: "Korean", value: "Korean" },
  { id: "de", label: "German", value: "German" },
  { id: "fr", label: "French", value: "French" },
];

const textAreaClass =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2.5 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]";

export function AudioPanel({
  settings,
  providers,
  onSettingsSaved,
}: {
  settings: AudioSettings;
  providers: ProviderProfile[];
  onSettingsSaved?: (settings: AudioSettings) => void;
}) {
  const [audio, setAudio] = useState(settings);
  const [promptScope, setPromptScope] = useState<PromptScope>("project");
  const [vocabularyTab, setVocabularyTab] = useState<VocabularyTab>("preferred");
  const [vocabularyQuery, setVocabularyQuery] = useState("");
  const [recordingTarget, setRecordingTarget] = useState<"toggle" | "ptt" | null>(null);
  const [vocabularyScope, setVocabularyScope] = useState<"global" | "project">("project");
  const [draftTerm, setDraftTerm] = useState("");
  const [draftReplacementFrom, setDraftReplacementFrom] = useState("");
  const [draftReplacementTo, setDraftReplacementTo] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [draftPromptGlobal, setDraftPromptGlobal] = useState(settings.revisePromptGlobal);
  const [draftPromptProject, setDraftPromptProject] = useState(settings.revisePromptProject);
  const [draftMinDuration, setDraftMinDuration] = useState(String(settings.minDuration));
  const [draftMaxDuration, setDraftMaxDuration] = useState(String(settings.maxDuration));
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

  const commitMinDuration = useCallback(() => {
    const parsed = Number(draftMinDuration);
    const next = Number.isFinite(parsed)
      ? Math.max(1, Math.min(10, Math.floor(parsed)))
      : audio.minDuration;
    setDraftMinDuration(String(next));
    if (next !== audio.minDuration) {
      patchAudio("minDuration", next);
    }
  }, [audio.minDuration, draftMinDuration, patchAudio]);

  const commitMaxDuration = useCallback(() => {
    const parsed = Number(draftMaxDuration);
    const next = Number.isFinite(parsed)
      ? Math.max(10, Math.min(300, Math.floor(parsed)))
      : audio.maxDuration;
    setDraftMaxDuration(String(next));
    if (next !== audio.maxDuration) {
      patchAudio("maxDuration", next);
    }
  }, [audio.maxDuration, draftMaxDuration, patchAudio]);

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
          setRecordingTarget(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingTarget, patchAudioState]);

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

  const handleTranscribeToggle = () => {
    setRecordingTarget(null);
    patchAudioState((prev) => (
      prev.enabled
        ? { ...prev, enabled: false, reviseEnabled: false }
        : { ...prev, enabled: true }
    ));
  };

  const handleReviseToggle = () => {
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

  const handleReviseProfileChange = (value: string) => {
    patchAudioState((prev) => ({
      ...prev,
      reviseProvider: value,
    }));
  };

  const handleAddVocabulary = () => {
    if (vocabularyTab === "replacement") {
      if (!draftReplacementFrom.trim() || !draftReplacementTo.trim()) return;
      const nextRule = { from: draftReplacementFrom.trim(), to: draftReplacementTo.trim() };
      const replKey = vocabularyScope === "global" ? "replacementsGlobal" : "replacementsProject";
      patchAudioState((prev) => ({
        ...prev,
        [replKey]: [nextRule, ...prev[replKey]],
      }));
      setDraftReplacementFrom("");
      setDraftReplacementTo("");
      setVocabularyQuery("");
      return;
    }

    if (!draftTerm.trim()) return;
    const key =
      vocabularyTab === "preferred"
        ? vocabularyScope === "global"
          ? "preferredTermsGlobal"
          : "preferredTermsProject"
        : vocabularyScope === "global"
          ? "forbiddenTermsGlobal"
          : "forbiddenTermsProject";
    patchAudioState((prev) => ({
      ...prev,
      [key]: [draftTerm.trim(), ...prev[key]],
    }));
    setDraftTerm("");
    setVocabularyQuery("");
  };

  const handleDeleteVocabulary = (row: VocabularyRow) => {
    if (row.tab === "replacement") {
      const key = row.scopeKey === "global" ? "replacementsGlobal" : "replacementsProject";
      patchAudioState((prev) => ({
        ...prev,
        [key]: prev[key].filter((_, index) => index !== row.index),
      }));
      return;
    }

    const key =
      row.tab === "preferred"
        ? row.scopeKey === "global"
          ? "preferredTermsGlobal"
          : "preferredTermsProject"
        : row.scopeKey === "global"
          ? "forbiddenTermsGlobal"
          : "forbiddenTermsProject";
    patchAudioState((prev) => ({
      ...prev,
      [key]: prev[key].filter((_, index) => index !== row.index),
    }));
  };

  const currentPrompt = promptScope === "global" ? audio.revisePromptGlobal : audio.revisePromptProject;
  const currentDraftPrompt = promptScope === "global" ? draftPromptGlobal : draftPromptProject;
  const canAddVocabulary =
    vocabularyTab === "replacement"
      ? Boolean(draftReplacementFrom.trim() && draftReplacementTo.trim())
      : Boolean(draftTerm.trim());

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

  return (
    <div className="mx-auto max-w-[980px] space-y-4">
      <div className="rounded-[28px] border border-[var(--color-border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--color-highlight)_8%,transparent),transparent_70%)] px-5 py-5 sm:px-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-highlight)]">Audio Pipeline</div>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
          Record once, transcribe first, optionally revise second, then insert the cleaned result into the active input.
        </p>
      </div>

      <PipelineSection step="Stage 1" title="Transcribe" icon={Mic} enabled={audio.enabled} onToggle={handleTranscribeToggle}>
        <div className={audio.enabled ? "space-y-6" : "pointer-events-none space-y-6 opacity-50"}>
          <FieldGroup
            title="Speech-to-text profile"
            hint="Provider profile already carries provider credentials and model defaults."
            inlineHint
          >
            <div className="max-w-[360px]">
              <ProfilePicker
                label="Provider Profile"
                profiles={providers}
                value={audio.transcribeProvider}
                onChange={(value) => patchAudio("transcribeProvider", value)}
                disabled={!audio.enabled}
              />
            </div>
          </FieldGroup>

          <FieldGroup
            title="Language preference"
            hint="Select the languages the user commonly speaks. Multiple preferences are allowed."
            inlineHint
          >
            <div className="max-w-[360px]">
              <LanguageMultiSelect
                label="Preferred Languages"
                options={languageOptions}
                value={audio.preferredLanguages}
                onToggle={togglePreferredLanguage}
                onAddCustom={addCustomLanguage}
                disabled={!audio.enabled}
              />
            </div>
          </FieldGroup>

          <FieldGroup title="Recording shortcuts" hint="Configure one or both modes. Toggle uses a combo key to start/stop. Push-to-talk holds a single key.">
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Toggle Mode */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Keyboard className="h-4 w-4 text-[var(--color-text-muted)]" />
                    <span className="text-sm font-medium text-[var(--color-text)]">Toggle Mode</span>
                  </div>
                  {audio.toggleShortcut && (
                    <button
                      type="button"
                      onClick={() => patchAudio("toggleShortcut", "")}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-error)]"
                      title="Clear shortcut"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">
                  Press combo key to start, press again to stop.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex h-10 min-w-0 flex-1 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)]">
                    {recordingTarget === "toggle"
                      ? <span className="text-[var(--color-highlight)]">Press combo keys...</span>
                      : audio.toggleShortcut || <span className="text-[var(--color-text-muted)]">Not set</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRecordingTarget(recordingTarget === "toggle" ? null : "toggle")}
                    disabled={!audio.enabled}
                    className={`inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
                      recordingTarget === "toggle"
                        ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-text-muted)]"
                    }`}
                  >
                    {recordingTarget === "toggle" ? "Cancel" : "Record"}
                  </button>
                </div>
              </div>

              {/* Push-to-Talk Mode */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Mic className="h-4 w-4 text-[var(--color-text-muted)]" />
                    <span className="text-sm font-medium text-[var(--color-text)]">Push-to-Talk</span>
                  </div>
                  {audio.pushToTalkKey && (
                    <button
                      type="button"
                      onClick={() => patchAudio("pushToTalkKey", "")}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-error)]"
                      title="Clear shortcut"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">
                  Hold any key to record, release to stop.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex h-10 min-w-0 flex-1 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)]">
                    {recordingTarget === "ptt"
                      ? <span className="text-[var(--color-highlight)]">Press any key...</span>
                      : audio.pushToTalkKey ? pttKeyLabel(audio.pushToTalkKey) : <span className="text-[var(--color-text-muted)]">Not set</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRecordingTarget(recordingTarget === "ptt" ? null : "ptt")}
                    disabled={!audio.enabled}
                    className={`inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
                      recordingTarget === "ptt"
                        ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-text-muted)]"
                    }`}
                  >
                    {recordingTarget === "ptt" ? "Cancel" : "Record"}
                  </button>
                </div>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup title="Duration limits" hint="Minimum duration filters accidental taps. Maximum prevents runaway recordings.">
            <div className="grid gap-4 sm:grid-cols-2 max-w-[480px]">
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-muted)]">
                  <Timer className="h-3.5 w-3.5" />
                  Min duration
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={draftMinDuration}
                    onChange={(e) => setDraftMinDuration(e.target.value)}
                    onBlur={commitMinDuration}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setDraftMinDuration(String(audio.minDuration));
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={!audio.enabled}
                    className="h-10 w-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">seconds</span>
                </div>
              </div>
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-muted)]">
                  <MicOff className="h-3.5 w-3.5" />
                  Max duration
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={10}
                    max={300}
                    value={draftMaxDuration}
                    onChange={(e) => setDraftMaxDuration(e.target.value)}
                    onBlur={commitMaxDuration}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setDraftMaxDuration(String(audio.maxDuration));
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={!audio.enabled}
                    className="h-10 w-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">seconds</span>
                </div>
              </div>
            </div>
          </FieldGroup>
        </div>
      </PipelineSection>

      <div className="flex justify-center py-1 text-[var(--color-text-muted)]">
        <ArrowDown className="h-5 w-5" />
      </div>

      <PipelineSection
        step="Stage 2"
        title="Revise"
        icon={Wand2}
        enabled={audio.enabled && audio.reviseEnabled}
        onToggle={handleReviseToggle}
        toggleDisabled={!audio.enabled}
      >
        <div className={audio.enabled && audio.reviseEnabled ? "space-y-6" : "pointer-events-none space-y-6 opacity-50"}>
          <FieldGroup title="Revision model">
            <div className="max-w-[360px]">
              <ProfilePicker
                label="Provider Profile"
                profiles={providers}
                value={audio.reviseProvider}
                onChange={handleReviseProfileChange}
                disabled={!audio.reviseEnabled}
              />
            </div>
          </FieldGroup>

          <FieldGroup title="Revise prompt" hint="Use one prompt, and switch scope with tabs instead of managing multiple editors at once.">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
                  {(["global", "project"] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => setPromptScope(scope)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        promptScope === scope
                          ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "text-[var(--color-text-muted)]"
                      }`}
                    >
                      {scope === "global" ? "Global" : "Project"}
                    </button>
                  ))}
                </div>
                {isEditingPrompt ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={savePromptEdit}
                      className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-highlight)]/35 bg-[var(--color-highlight)]/10 px-3 py-2 text-xs font-medium text-[var(--color-highlight)] transition-colors hover:bg-[var(--color-highlight)]/14"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelPromptEdit}
                      className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-text-muted)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={startPromptEdit}
                    className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-text-muted)]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit Prompt
                  </button>
                )}
              </div>
              <textarea
                ref={promptEditorRef}
                value={isEditingPrompt ? currentDraftPrompt : currentPrompt}
                onChange={(e) =>
                  promptScope === "global"
                    ? setDraftPromptGlobal(e.target.value)
                    : setDraftPromptProject(e.target.value)
                }
                rows={6}
                readOnly={!isEditingPrompt}
                disabled={!audio.reviseEnabled}
                className={`mt-4 ${textAreaClass} ${!isEditingPrompt ? "cursor-default opacity-85" : ""}`}
              />
            </div>
          </FieldGroup>

          <FieldGroup title="Vocabulary manager" hint="Search large term sets, keep scope visible, and review rules in a dense grid.">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="inline-flex w-fit rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
                  {([
                    ["preferred", "Preferred terms"],
                    ["forbidden", "Forbidden terms"],
                    ["replacement", "Replacement rules"],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setVocabularyTab(key)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        vocabularyTab === key
                          ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "text-[var(--color-text-muted)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="relative min-w-[240px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <input
                    type="search"
                    value={vocabularyQuery}
                    onChange={(e) => setVocabularyQuery(e.target.value)}
                    placeholder="Search terms and replacements"
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] py-2 pl-9 pr-3 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-[var(--color-text-muted)]">Scope</label>
                    <div className="inline-flex rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1">
                      {(["global", "project"] as const).map((scope) => (
                        <button
                          key={scope}
                          type="button"
                          onClick={() => setVocabularyScope(scope)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                            vocabularyScope === scope
                              ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                              : "text-[var(--color-text-muted)]"
                          }`}
                        >
                          {scope === "global" ? "Global" : "Project"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {vocabularyTab === "replacement" ? (
                    <>
                      <div className="min-w-[220px] flex-1">
                        <label className="mb-2 block text-sm font-medium text-[var(--color-text-muted)]">From</label>
                        <input
                          type="text"
                          value={draftReplacementFrom}
                          onChange={(e) => setDraftReplacementFrom(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && canAddVocabulary) handleAddVocabulary();
                          }}
                          placeholder="Incorrect term"
                          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                        />
                      </div>
                      <div className="min-w-[220px] flex-1">
                        <label className="mb-2 block text-sm font-medium text-[var(--color-text-muted)]">To</label>
                        <input
                          type="text"
                          value={draftReplacementTo}
                          onChange={(e) => setDraftReplacementTo(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && canAddVocabulary) handleAddVocabulary();
                          }}
                          placeholder="Preferred term"
                          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="min-w-[260px] flex-1">
                      <label className="mb-2 block text-sm font-medium text-[var(--color-text-muted)]">
                        {vocabularyTab === "preferred" ? "Preferred term" : "Forbidden term"}
                      </label>
                      <input
                        type="text"
                        value={draftTerm}
                        onChange={(e) => setDraftTerm(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && canAddVocabulary) handleAddVocabulary();
                        }}
                        placeholder={vocabularyTab === "preferred" ? "Add term to preserve" : "Add term to block"}
                        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleAddVocabulary}
                    disabled={!canAddVocabulary}
                    className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors ${
                      canAddVocabulary
                        ? "border-[var(--color-highlight)]/35 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/14"
                        : "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] opacity-60"
                    }`}
                  >
                    <Plus className="h-4 w-4" />
                    Add {vocabularyTab === "replacement" ? "Rule" : "Term"}
                  </button>
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <div className="border-b border-[var(--color-border)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                  {vocabularyScope === "global" ? "Global" : "Project"} {vocabularyTab === "replacement" ? "Rules" : "Terms"}
                </div>

                <div className="max-h-[360px] overflow-y-auto p-4">
                  {filteredRows.length === 0 ? (
                    <div className="py-8 text-sm text-[var(--color-text-muted)]">
                      No {vocabularyScope} rows match the current filter.
                    </div>
                  ) : (
                    <div className={`grid gap-3 ${
                      vocabularyTab === "replacement"
                        ? "grid-cols-1 xl:grid-cols-2"
                        : "grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                    }`}>
                      {filteredRows.map((row) => (
                        <div
                          key={row.id}
                          className={`group flex min-w-0 items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-3 py-2.5 transition-colors hover:border-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/55 ${
                            row.tab === "replacement" ? "justify-between" : ""
                          }`}
                        >
                          {row.tab === "replacement" ? (
                            <>
                              <div className="min-w-0 flex-1 overflow-hidden text-sm text-[var(--color-text)]">
                                <span className="truncate font-medium">{row.from}</span>
                                <span className="mx-2 text-[var(--color-text-muted)]">{"->"}</span>
                                <span className="truncate text-[var(--color-highlight)]">{row.to}</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteVocabulary(row)}
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] opacity-65 transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-error)] group-hover:opacity-100"
                                aria-label={`Delete ${row.from}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">{row.from}</span>
                              <button
                                type="button"
                                onClick={() => handleDeleteVocabulary(row)}
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] opacity-65 transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-error)] group-hover:opacity-100"
                                aria-label={`Delete ${row.from}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </FieldGroup>
        </div>
      </PipelineSection>
    </div>
  );
}
