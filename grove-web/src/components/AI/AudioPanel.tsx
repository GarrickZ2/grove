import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, ChevronDown, Globe2, Keyboard, Mic, Pencil, Plus, Search, Trash2, Wand2 } from "lucide-react";
import { SettingsModeSwitch, SettingsToggle } from "./components/PipelineLayout";
import type { AudioSettings, ProviderProfile } from "./types";
import { buildVocabularyRows, formatShortcut, formatPTTKey, pttKeyLabel, type VocabularyRow, type VocabularyTab } from "./utils";
import { persistOverride, persistRemoveOverride } from "../../keyboard";

type PromptScope = "global" | "project";

const languageOptions = [
  { id: "zh", label: "Chinese", value: "Chinese" },
  { id: "en", label: "English", value: "English" },
  { id: "ja", label: "Japanese", value: "Japanese" },
  { id: "ko", label: "Korean", value: "Korean" },
  { id: "de", label: "German", value: "German" },
  { id: "fr", label: "French", value: "French" },
];

function TranscribeLanguagePicker({ value, disabled, onToggle, onAddCustom }: {
  value: string[];
  disabled: boolean;
  onToggle: (language: string) => void;
  onAddCustom: (language: string) => void;
}) {
  const [customLanguage, setCustomLanguage] = useState("");
  const addCustom = () => {
    const next = customLanguage.trim();
    if (!next || value.includes(next)) return;
    onAddCustom(next);
    setCustomLanguage("");
  };

  return (
    <details className="group relative">
      <summary className={`flex h-11 list-none items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm [&::-webkit-details-marker]:hidden ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer hover:border-[var(--color-text-muted)]"}`}>
        <span className="flex min-w-0 items-center gap-2">
          <Globe2 className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <span className={value.length ? "truncate text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
            {value.length ? value.join(", ") : "Automatic"}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 right-0 z-20 mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 shadow-xl">
        <div className="grid grid-cols-2 gap-1">
          {languageOptions.map((language) => (
            <label key={language.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]">
              <input type="checkbox" checked={value.includes(language.value)} onChange={() => onToggle(language.value)} />
              {language.label}
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2 border-t border-[var(--color-border)] pt-2">
          <input value={customLanguage} onChange={(event) => setCustomLanguage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustom(); } }} placeholder="Add language" className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" />
          <button type="button" onClick={addCustom} disabled={!customLanguage.trim()} className="h-9 rounded-lg px-3 text-xs font-medium text-[var(--color-highlight)] disabled:opacity-40">Add</button>
        </div>
      </div>
    </details>
  );
}

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
  const [activeSection, setActiveSection] = useState<"transcribe" | "revise">("transcribe");
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

  const commitPttActivationDelay = useCallback(() => {
    const parsed = Number(draftPttActivationDelayMs);
    const next = Number.isFinite(parsed)
      ? Math.max(100, Math.min(2000, Math.floor(parsed)))
      : audio.pttActivationDelayMs;
    setDraftPttActivationDelayMs(String(next));
    if (next !== audio.pttActivationDelayMs) {
      patchAudio("pttActivationDelayMs", next);
    }
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
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-visible rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm md:overflow-hidden">
      <header className="relative shrink-0 overflow-hidden border-b border-[var(--color-border)] px-4 py-4 sm:px-5 [@media(max-height:760px)]:py-3">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,color-mix(in_srgb,var(--color-highlight)_14%,transparent),transparent_34%)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] sm:h-11 sm:w-11">
              {activeSection === "transcribe" ? <AudioLines className="h-5 w-5" /> : <Wand2 className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-[var(--color-text)] sm:text-lg">
                {activeSection === "transcribe" ? "Turn speech into working text" : "Polish transcripts before they land"}
              </h2>
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                {activeSection === "transcribe" ? "Choose how Grove listens, when text appears, and what starts a recording." : "Use a language model and project vocabulary to clean spoken input."}
              </p>
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center gap-3 sm:w-auto">
          <SettingsModeSwitch
            activeId={activeSection}
            onChange={(id) => setActiveSection(id as "transcribe" | "revise")}
            items={[
              { id: "transcribe", label: "Transcribe", icon: Mic },
              { id: "revise", label: "Revise", icon: Wand2 },
            ]}
          />
            <SettingsToggle
              enabled={activeSection === "transcribe" ? audio.enabled : audio.enabled && audio.reviseEnabled}
              disabled={activeSection === "revise" && !audio.enabled}
              onToggle={activeSection === "transcribe" ? handleTranscribeToggle : handleReviseToggle}
              label={activeSection === "transcribe" ? "Toggle transcription" : "Toggle revision"}
            />
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-visible md:overflow-hidden">
      <div className={activeSection === "transcribe" ? "h-full min-h-0" : "hidden"}>
        <div className="h-full min-h-0 overflow-y-auto">
          <div className={`flex min-h-full flex-col px-4 sm:px-6 ${audio.enabled ? "" : "pointer-events-none opacity-55"}`}>
            <section className="grid min-h-28 flex-1 content-center gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Recognition</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Choose the engine and languages it should expect.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  <span className="mb-2 block text-xs font-medium text-[var(--color-text-muted)]">Speech-to-text Provider</span>
                  <select value={audio.transcribeProvider} onChange={(event) => patchAudio("transcribeProvider", event.target.value)} disabled={!audio.enabled} className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]">
                    <option value="">Select Provider</option>
                    {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.model ? ` · ${provider.model}` : ""}</option>)}
                  </select>
                </label>
                <label>
                  <span className="mb-2 block text-xs font-medium text-[var(--color-text-muted)]">Expected languages</span>
                  <TranscribeLanguagePicker value={audio.preferredLanguages} disabled={!audio.enabled} onToggle={togglePreferredLanguage} onAddCustom={addCustomLanguage} />
                </label>
              </div>
            </section>

            <section className="grid min-h-28 flex-1 content-center gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Result timing</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Decide when recognized text enters the editor.</p>
              </div>
              <div className="grid overflow-hidden rounded-xl border border-[var(--color-border)] sm:grid-cols-2">
                {([
                  ["batch", "After recording", "Transcribe once when recording stops."],
                  ["streaming", "While speaking", "Continuously refresh text during recording."],
                ] as const).map(([mode, title, description]) => {
                  const active = audio.transcribeMode === mode;
                  return <button key={mode} type="button" disabled={!audio.enabled} onClick={() => patchAudio("transcribeMode", mode)} className={`relative flex min-h-16 items-center gap-3 px-4 text-left transition-colors first:border-b first:border-[var(--color-border)] sm:first:border-b-0 sm:first:border-r ${active ? "bg-[var(--color-highlight)]/8" : "hover:bg-[var(--color-bg-secondary)]/45"}`}>
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-[var(--color-highlight)]" : "border-[var(--color-text-muted)]/50"}`}>{active && <span className="h-2 w-2 rounded-full bg-[var(--color-highlight)]" />}</span>
                    <span><span className="block text-sm font-medium text-[var(--color-text)]">{title}</span><span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">{description}</span></span>
                  </button>;
                })}
              </div>
            </section>

            <section className="grid min-h-40 flex-[1.35] content-center gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Recording triggers</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Configure either method or keep both available.</p>
              </div>
              <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)]">
                <div className="grid min-h-16 items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_72px]">
                  <div className="flex min-w-0 items-center gap-3"><Keyboard className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><div><p className="text-sm font-medium text-[var(--color-text)]">Toggle recording</p><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Press once to start and again to stop.</p></div></div>
                  <div className="truncate rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)]">{recordingTarget === "toggle" ? <span className="text-[var(--color-highlight)]">Press shortcut</span> : audio.toggleShortcut || <span className="text-[var(--color-text-muted)]">Not set</span>}</div>
                  <button type="button" onClick={() => setRecordingTarget(recordingTarget === "toggle" ? null : "toggle")} disabled={!audio.enabled} className="h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]">{recordingTarget === "toggle" ? "Cancel" : "Change"}</button>
                </div>
                <div className="grid min-h-16 items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_72px]">
                  <div className="flex min-w-0 items-center gap-3"><Mic className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><div><p className="text-sm font-medium text-[var(--color-text)]">Push to talk</p><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Hold a key while speaking, then release.</p></div></div>
                  <div className="truncate rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)]">{recordingTarget === "ptt" ? <span className="text-[var(--color-highlight)]">Press a key</span> : audio.pushToTalkKey ? pttKeyLabel(audio.pushToTalkKey) : <span className="text-[var(--color-text-muted)]">Not set</span>}</div>
                  <button type="button" onClick={() => setRecordingTarget(recordingTarget === "ptt" ? null : "ptt")} disabled={!audio.enabled} className="h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]">{recordingTarget === "ptt" ? "Cancel" : "Change"}</button>
                </div>
              </div>
            </section>

            <section className="grid min-h-28 flex-1 content-center gap-5 py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Guardrails</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Keep accidental or runaway recordings out.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {([
                  { label: "Ignore shorter than", value: draftMinDuration, set: setDraftMinDuration, commit: commitMinDuration, min: 1, max: 10, step: 1, unit: "sec" },
                  { label: "Stop after", value: draftMaxDuration, set: setDraftMaxDuration, commit: commitMaxDuration, min: 10, max: 300, step: 1, unit: "sec" },
                  { label: "Push-to-talk delay", value: draftPttActivationDelayMs, set: setDraftPttActivationDelayMs, commit: commitPttActivationDelay, min: 100, max: 2000, step: 50, unit: "ms" },
                ]).map((field) => <label key={field.label}><span className="mb-2 block text-xs font-medium text-[var(--color-text-muted)]">{field.label}</span><span className="flex h-11 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3"><input type="number" value={field.value} min={field.min} max={field.max} step={field.step} disabled={!audio.enabled} onChange={(event) => field.set(event.target.value)} onBlur={field.commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-[var(--color-text)] outline-none" /><span className="text-xs text-[var(--color-text-muted)]">{field.unit}</span></span></label>)}
              </div>
            </section>
          </div>
        </div>
      </div>
      <div className={activeSection === "revise" ? "h-full min-h-0" : "hidden"}>
        <div className={`flex h-full min-h-0 flex-col overflow-hidden px-6 ${audio.enabled && audio.reviseEnabled ? "" : "pointer-events-none opacity-55"}`}>
            <section className="grid shrink-0 gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] md:items-center [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Revision engine</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Choose the model that cleans and normalizes transcripts.</p>
              </div>
              <label className="max-w-xl">
                <span className="mb-2 block text-xs font-medium text-[var(--color-text-muted)]">Language model Provider</span>
                <select value={audio.reviseProvider} onChange={(event) => handleReviseProfileChange(event.target.value)} disabled={!audio.reviseEnabled} className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]">
                  <option value="">Select Provider</option>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.model ? ` · ${provider.model}` : ""}</option>)}
                </select>
              </label>
            </section>

            <section className="grid shrink-0 gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] md:items-center [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Revision instruction</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Set a shared default or override it for this project.</p>
              </div>
              <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 px-3 py-2">
                  <div className="inline-flex rounded-lg bg-[var(--color-bg-secondary)] p-0.5">
                    {(["global", "project"] as const).map((scope) => <button key={scope} type="button" onClick={() => setPromptScope(scope)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${promptScope === scope ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>{scope === "global" ? "Global default" : "This project"}</button>)}
                  </div>
                  {isEditingPrompt ? <div className="flex items-center gap-2"><button type="button" onClick={cancelPromptEdit} className="px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-muted)]">Cancel</button><button type="button" onClick={savePromptEdit} className="rounded-lg bg-[var(--color-highlight)] px-3 py-1.5 text-xs font-medium text-white">Save</button></div> : <button type="button" onClick={startPromptEdit} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)]"><Pencil className="h-3.5 w-3.5" />Edit</button>}
                </div>
                <textarea ref={promptEditorRef} value={isEditingPrompt ? currentDraftPrompt : currentPrompt} onChange={(event) => promptScope === "global" ? setDraftPromptGlobal(event.target.value) : setDraftPromptProject(event.target.value)} placeholder={`No ${promptScope} instruction configured.`} readOnly={!isEditingPrompt} disabled={!audio.reviseEnabled} className="block h-24 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] [@media(max-height:760px)]:h-16" />
              </div>
            </section>

            <section className="grid min-h-0 flex-1 gap-5 py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Vocabulary</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Preserve names, block unwanted terms, or define replacements.</p>
              </div>
              <div className="flex min-h-0 min-w-0 flex-col">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-lg bg-[var(--color-bg-secondary)] p-0.5">
                    {([
                      ["preferred", "Preferred"],
                      ["forbidden", "Forbidden"],
                      ["replacement", "Replacements"],
                    ] as const).map(([key, label]) => <button key={key} type="button" onClick={() => setVocabularyTab(key)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${vocabularyTab === key ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>{label}</button>)}
                  </div>
                  <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5">
                    {(["global", "project"] as const).map((scope) => <button key={scope} type="button" onClick={() => setVocabularyScope(scope)} className={`rounded-md px-2.5 py-1 text-[10px] font-medium ${vocabularyScope === scope ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"}`}>{scope === "global" ? "Global" : "Project"}</button>)}
                  </div>
                  <div className="relative ml-auto min-w-52 flex-1 sm:max-w-72">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <input type="search" value={vocabularyQuery} onChange={(event) => setVocabularyQuery(event.target.value)} placeholder="Search vocabulary" className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" />
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  {vocabularyTab === "replacement" ? <><input type="text" value={draftReplacementFrom} onChange={(event) => setDraftReplacementFrom(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canAddVocabulary) handleAddVocabulary(); }} placeholder="Replace this" className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" /><span className="text-xs text-[var(--color-text-muted)]">to</span><input type="text" value={draftReplacementTo} onChange={(event) => setDraftReplacementTo(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canAddVocabulary) handleAddVocabulary(); }} placeholder="Use this" className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" /></> : <input type="text" value={draftTerm} onChange={(event) => setDraftTerm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canAddVocabulary) handleAddVocabulary(); }} placeholder={vocabularyTab === "preferred" ? "Add a term to preserve" : "Add a term to block"} className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" />}
                  <button type="button" onClick={handleAddVocabulary} disabled={!canAddVocabulary} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-highlight)] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-35"><Plus className="h-3.5 w-3.5" />Add</button>
                </div>

                <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                  <div className={`grid h-8 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)] ${vocabularyTab === "replacement" ? "grid-cols-[1fr_1fr_32px] gap-3" : "grid-cols-[1fr_32px]"}`}>
                    <span>{vocabularyTab === "replacement" ? "Source" : "Term"}</span>{vocabularyTab === "replacement" && <span>Replacement</span>}<span />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {filteredRows.length === 0 ? <div className="flex h-full items-center justify-center px-4 text-xs text-[var(--color-text-muted)]">No {vocabularyScope} {vocabularyTab === "replacement" ? "replacement rules" : "terms"} yet.</div> : filteredRows.map((row) => <div key={row.id} className={`grid min-h-10 items-center border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-b-0 ${row.tab === "replacement" ? "grid-cols-[1fr_1fr_32px] gap-3" : "grid-cols-[1fr_32px]"}`}><span className="truncate text-[var(--color-text)]">{row.from}</span>{row.tab === "replacement" && <span className="truncate text-[var(--color-text)]">{row.to}</span>}<button type="button" onClick={() => handleDeleteVocabulary(row)} aria-label={`Delete ${row.from}`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-error)]"><Trash2 className="h-3.5 w-3.5" /></button></div>)}
                  </div>
                </div>
              </div>
            </section>
        </div>
      </div>
      </div>
    </div>
  );
}
