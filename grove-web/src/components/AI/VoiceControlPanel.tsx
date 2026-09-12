import React, { useCallback, useEffect, useState, useMemo } from "react";
import { ArrowRight, Ban, Check, ChevronDown, Globe2, Keyboard, Mic, Search, Settings, X } from "lucide-react";
import { SettingsModeSwitch, SettingsToggle } from "./components/PipelineLayout";
import type { ProviderProfile, VoiceControlSettings } from "./types";
import { formatShortcut, formatPTTKey, pttKeyLabel } from "./utils";
import { commandRegistry, persistOverride, persistRemoveOverride } from "../../keyboard";

interface VoiceControlPanelProps {
  settings: VoiceControlSettings;
  providers: ProviderProfile[];
  onSettingsSaved: (next: VoiceControlSettings) => void;
}

const languageOptions = [
  { id: "zh", label: "Chinese", value: "Chinese" },
  { id: "en", label: "English", value: "English" },
  { id: "ja", label: "Japanese", value: "Japanese" },
  { id: "ko", label: "Korean", value: "Korean" },
  { id: "de", label: "German", value: "German" },
  { id: "fr", label: "French", value: "French" },
];

function VoiceLanguagePicker({ value, disabled, onToggle, onAddCustom }: {
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
    <details className="group relative w-full sm:w-72">
      <summary className={`flex h-10 list-none items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm [&::-webkit-details-marker]:hidden ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer hover:border-[var(--color-text-muted)]"}`}>
        <span className="flex min-w-0 items-center gap-2">
          <Globe2 className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <span className={value.length ? "truncate text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
            {value.length ? value.join(", ") : "Automatic"}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-full min-w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 shadow-xl">
        <div className="grid grid-cols-2 gap-1">
          {languageOptions.map((language) => (
            <label key={language.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]">
              <input type="checkbox" checked={value.includes(language.value)} onChange={() => onToggle(language.value)} />
              {language.label}
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2 border-t border-[var(--color-border)] pt-2">
          <input
            value={customLanguage}
            onChange={(event) => setCustomLanguage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustom();
              }
            }}
            placeholder="Add language"
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
          />
          <button type="button" onClick={addCustom} disabled={!customLanguage.trim()} className="h-9 rounded-lg px-3 text-xs font-medium text-[var(--color-highlight)] disabled:opacity-40">
            Add
          </button>
        </div>
      </div>
    </details>
  );
}

function isRecommendedAction(cmdId: string): boolean {
  // Navigation, help, palette, panel, radio
  const prefixes = ["nav.", "help.", "palette.", "panel.", "radio."];
  if (prefixes.some((p) => cmdId.startsWith(p))) return true;

  const exactMatches = [
    "task.new",
    "task.open",
    "task.close",
    "task.selectNext",
    "task.selectPrevious",
    "task.search",
    "agent.switch.next",
    "agent.switch.previous",
    "project.open",
    "chat.switchSession",
  ];
  if (exactMatches.includes(cmdId)) return true;

  return false;
}

export function VoiceControlPanel({
  settings,
  providers,
  onSettingsSaved,
}: VoiceControlPanelProps) {
  // Track registry version so dynamically registered commands (e.g.
  // voiceControl.* from GlobalVoiceControlRecorder) appear in the list even
  // when this panel mounts before those components complete their first render.
  const [registryVersion, setRegistryVersion] = useState(0);
  useEffect(() => commandRegistry.subscribe(() => setRegistryVersion((v) => v + 1)), []);
  const allCommands = useMemo(() => {
    return commandRegistry.listCommands().filter((c) => !c.hidden);
  // registryVersion is intentionally the only dep: it increments on every
  // registry mutation, causing the list to be recomputed from the live registry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion]);

  // Compute recommended settings once on load if settings.hasInitializedActions is false
  const initialSettings = useMemo(() => {
    if (!settings.hasInitializedActions) {
      const recommendedSet = new Set(allCommands.filter((c) => isRecommendedAction(c.id)).map((c) => c.id));
      const defaultDisabled = allCommands.filter((c) => !recommendedSet.has(c.id)).map((c) => c.id);
      return {
        ...settings,
        disabledActions: defaultDisabled,
        hasInitializedActions: true,
      };
    }
    return settings;
  }, [settings, allCommands]);

  const [localSettings, setLocalSettings] = useState<VoiceControlSettings>(initialSettings);
  const [recordingTarget, setRecordingTarget] = useState<"toggle" | "ptt" | null>(null);

  const [drafts, setDrafts] = useState({
    minDuration: String(initialSettings.minDuration),
    maxDuration: String(initialSettings.maxDuration),
    pttActivationDelayMs: String(initialSettings.pttActivationDelayMs),
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [activeSection, setActiveSection] = useState<"settings" | "actions">("settings");

  // Sync local state when parent passes a new settings object (React adjusted-state pattern).
  // Three setState calls are batched by React 18 into a single re-render.
  const [lastSyncedSettings, setLastSyncedSettings] = useState(settings);
  if (lastSyncedSettings !== settings) {
    setLastSyncedSettings(settings);
    setLocalSettings(initialSettings);
    setDrafts({
      minDuration: String(initialSettings.minDuration),
      maxDuration: String(initialSettings.maxDuration),
      pttActivationDelayMs: String(initialSettings.pttActivationDelayMs),
    });
  }

  const onSettingsSavedRef = React.useRef(onSettingsSaved);
  useEffect(() => {
    onSettingsSavedRef.current = onSettingsSaved;
  }, [onSettingsSaved]);

  const patchSettingsState = useCallback(
    (updater: (prev: VoiceControlSettings) => VoiceControlSettings) => {
      setLocalSettings((prev) => {
        const next = updater(prev);
        queueMicrotask(() => onSettingsSavedRef.current?.(next));
        return next;
      });
    },
    []
  );

  const patchSettings = useCallback(
    <K extends keyof VoiceControlSettings>(key: K, value: VoiceControlSettings[K]) => {
      patchSettingsState((prev) => ({ ...prev, [key]: value }));
    },
    [patchSettingsState]
  );

  // Auto-initialize disabledActions on mount with recommended values if not set
  useEffect(() => {
    if (!settings.hasInitializedActions) {
      onSettingsSavedRef.current?.(initialSettings);
    }
  }, [settings.hasInitializedActions, initialSettings]);

  const mirrorPTTToKeymap = useCallback(async (key: string) => {
    try {
      if (key) {
        await persistOverride({
          command_id: "voiceControl.ptt.start",
          key,
          when_ctx: undefined,
          scope: undefined,
        });
      } else {
        await persistRemoveOverride("voiceControl.ptt.start");
      }
    } catch (err) {
      console.error("[VoiceControlPanel] mirror PTT → keymap failed:", err);
    }
  }, []);

  const commitMinDuration = useCallback(() => {
    const parsed = Number(drafts.minDuration);
    const next = Number.isFinite(parsed)
      ? Math.max(1, Math.min(10, Math.floor(parsed)))
      : localSettings.minDuration;
    setDrafts((d) => ({ ...d, minDuration: String(next) }));
    if (next !== localSettings.minDuration) {
      patchSettings("minDuration", next);
    }
  }, [localSettings.minDuration, drafts.minDuration, patchSettings]);

  const commitMaxDuration = useCallback(() => {
    const parsed = Number(drafts.maxDuration);
    const next = Number.isFinite(parsed)
      ? Math.max(5, Math.min(60, Math.floor(parsed)))
      : localSettings.maxDuration;
    setDrafts((d) => ({ ...d, maxDuration: String(next) }));
    if (next !== localSettings.maxDuration) {
      patchSettings("maxDuration", next);
    }
  }, [localSettings.maxDuration, drafts.maxDuration, patchSettings]);

  const commitPttActivationDelay = useCallback(() => {
    const parsed = Number(drafts.pttActivationDelayMs);
    const next = Number.isFinite(parsed)
      ? Math.max(0, Math.min(2000, Math.floor(parsed)))
      : localSettings.pttActivationDelayMs;
    setDrafts((d) => ({ ...d, pttActivationDelayMs: String(next) }));
    if (next !== localSettings.pttActivationDelayMs) {
      patchSettings("pttActivationDelayMs", next);
    }
  }, [localSettings.pttActivationDelayMs, drafts.pttActivationDelayMs, patchSettings]);

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
          patchSettingsState((prev) => ({ ...prev, toggleShortcut: combo }));
          setRecordingTarget(null);
        }
      } else {
        const key = formatPTTKey(event);
        if (key) {
          patchSettingsState((prev) => ({ ...prev, pushToTalkKey: key }));
          void mirrorPTTToKeymap(key);
          setRecordingTarget(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingTarget, patchSettingsState, mirrorPTTToKeymap]);

  const togglePreferredLanguage = (language: string) => {
    patchSettingsState((prev) => ({
      ...prev,
      preferredLanguages: (prev.preferredLanguages || []).includes(language)
        ? (prev.preferredLanguages || []).filter((item) => item !== language)
        : [...(prev.preferredLanguages || []), language],
    }));
  };

  const addCustomLanguage = (language: string) => {
    patchSettingsState((prev) => ({
      ...prev,
      preferredLanguages: [...(prev.preferredLanguages || []), language],
    }));
  };

  const toggleActionEnabled = useCallback(
    (actionId: string) => {
      const currentDisabled = localSettings.disabledActions || [];
      let nextDisabled: string[];
      if (currentDisabled.includes(actionId)) {
        nextDisabled = currentDisabled.filter((id) => id !== actionId);
      } else {
        nextDisabled = [...currentDisabled, actionId];
      }
      patchSettings("disabledActions", nextDisabled);
    },
    [localSettings.disabledActions, patchSettings]
  );

  // Compute categories from command registry
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const cmd of allCommands) {
      if (cmd.category) {
        set.add(cmd.category);
      }
    }
    return Array.from(set).sort();
  }, [allCommands]);

  // Filter commands by search query and category
  const filteredCommands = useMemo(() => {
    return allCommands.filter((cmd) => {
      const matchSearch =
        cmd.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        cmd.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (cmd.description || "").toLowerCase().includes(searchQuery.toLowerCase());

      const matchCategory = categoryFilter === "all" || cmd.category === categoryFilter;

      return matchSearch && matchCategory;
    });
  }, [allCommands, searchQuery, categoryFilter]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm">
      {activeSection === "settings" ? (
      <header className="relative shrink-0 overflow-hidden border-b border-[var(--color-border)] px-5 py-4 [@media(max-height:760px)]:py-3">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,color-mix(in_srgb,var(--color-highlight)_14%,transparent),transparent_34%)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] sm:h-11 sm:w-11"><Mic className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-[var(--color-text)] sm:text-lg">Control Grove without leaving your work</h2>
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-muted)]">Speak a command, let Grove understand it, then run only the actions you allow.</p>
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center gap-3 sm:w-auto">
          <SettingsModeSwitch
            activeId={activeSection}
            onChange={(id) => setActiveSection(id as "settings" | "actions")}
            items={[
              { id: "settings", label: "Settings", icon: Mic },
              { id: "actions", label: "Actions", icon: Settings, count: allCommands.length },
            ]}
          />
          <SettingsToggle
            enabled={localSettings.enabled}
            onToggle={() => patchSettings("enabled", !localSettings.enabled)}
            label="Toggle Voice Control"
          />
          </div>
        </div>
      </header>
      ) : (
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] px-5 py-3">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-[var(--color-text)]">Voice Control</span>
          <SettingsModeSwitch
            activeId={activeSection}
            onChange={(id) => setActiveSection(id as "settings" | "actions")}
            items={[
              { id: "settings", label: "Settings", icon: Mic },
              { id: "actions", label: "Actions", icon: Settings, count: allCommands.length },
            ]}
          />
        </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const recommendedSet = new Set(allCommands.filter((c) => isRecommendedAction(c.id)).map((c) => c.id));
                const defaultDisabled = allCommands.filter((c) => !recommendedSet.has(c.id)).map((c) => c.id);
                patchSettings("disabledActions", defaultDisabled);
              }}
              disabled={!localSettings.enabled}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-secondary)]"
            >
              <Settings className="h-3.5 w-3.5 text-[var(--color-highlight)]" />
              Recommended
            </button>
            <button
              type="button"
              onClick={() => patchSettings("disabledActions", [])}
              disabled={!localSettings.enabled}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-secondary)]"
            >
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              Enable All
            </button>
            <button
              type="button"
              onClick={() => patchSettings("disabledActions", allCommands.map((c) => c.id))}
              disabled={!localSettings.enabled}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-secondary)]"
            >
              <Ban className="h-3.5 w-3.5 text-rose-500" />
              Disable All
            </button>
          </div>
      </div>
      )}
      <div className="min-h-0 flex-1 overflow-visible md:overflow-hidden">
      <section className={activeSection === "settings" ? "h-full min-h-0" : "hidden"}>
        <div className="h-full min-h-0 overflow-y-auto">
          <div className={`flex min-h-full flex-col px-4 sm:px-6 ${localSettings.enabled ? "" : "pointer-events-none opacity-55"}`}>
            <section className="grid min-h-44 flex-[1.35] content-center gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Command pipeline</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Turn speech into text, then interpret it as an action.</p>
              </div>
              <div className="min-w-0">
                <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)]">
                  <label>
                    <span className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-text-muted)]">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-highlight)]/10 text-[10px] font-semibold text-[var(--color-highlight)]">1</span>
                      Recognize speech
                    </span>
                    <select
                      value={localSettings.sttProviderId}
                      onChange={(event) => patchSettings("sttProviderId", event.target.value)}
                      disabled={!localSettings.enabled}
                      className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                    >
                      <option value="">Select speech-to-text provider</option>
                      {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.model ? ` · ${provider.model}` : ""}</option>)}
                    </select>
                  </label>
                  <ArrowRight className="mb-3 hidden h-4 w-4 justify-self-center text-[var(--color-text-muted)] sm:block" />
                  <label>
                    <span className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-text-muted)]">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-highlight)]/10 text-[10px] font-semibold text-[var(--color-highlight)]">2</span>
                      Interpret command
                    </span>
                    <select
                      value={localSettings.llmProviderId}
                      onChange={(event) => patchSettings("llmProviderId", event.target.value)}
                      disabled={!localSettings.enabled}
                      className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                    >
                      <option value="">Select language model provider</option>
                      {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.model ? ` · ${provider.model}` : ""}</option>)}
                    </select>
                  </label>
                </div>
                <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/25 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-medium text-[var(--color-text)]">Expected languages</p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Helps recognition without restricting what the user can say.</p>
                  </div>
                  <VoiceLanguagePicker
                    value={localSettings.preferredLanguages || []}
                    disabled={!localSettings.enabled}
                    onToggle={togglePreferredLanguage}
                    onAddCustom={addCustomLanguage}
                  />
                </div>
              </div>
            </section>

            <section className="grid min-h-40 flex-[1.2] content-center gap-5 border-b border-[var(--color-border)] py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Activation</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Keep either trigger available, or configure both.</p>
              </div>
              <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)]">
                <div className="grid min-h-16 items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_72px_28px]">
                  <div className="flex min-w-0 items-center gap-3">
                    <Keyboard className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
                    <div>
                      <p className="text-sm font-medium text-[var(--color-text)]">Toggle listening</p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Press once to start and again to stop.</p>
                    </div>
                  </div>
                  <div className="truncate rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)]">
                    {recordingTarget === "toggle" ? <span className="text-[var(--color-highlight)]">Press shortcut</span> : localSettings.toggleShortcut || <span className="text-[var(--color-text-muted)]">Not set</span>}
                  </div>
                  <button type="button" onClick={() => setRecordingTarget(recordingTarget === "toggle" ? null : "toggle")} disabled={!localSettings.enabled} className="h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]">
                    {recordingTarget === "toggle" ? "Cancel" : "Change"}
                  </button>
                  <button type="button" onClick={() => patchSettings("toggleShortcut", "")} disabled={!localSettings.toggleShortcut} aria-label="Clear toggle shortcut" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-error)] disabled:invisible">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid min-h-16 items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_72px_28px]">
                  <div className="flex min-w-0 items-center gap-3">
                    <Mic className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
                    <div>
                      <p className="text-sm font-medium text-[var(--color-text)]">Push to talk</p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Hold a key while speaking, then release.</p>
                    </div>
                  </div>
                  <div className="truncate rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)]">
                    {recordingTarget === "ptt" ? <span className="text-[var(--color-highlight)]">Press a key</span> : localSettings.pushToTalkKey ? pttKeyLabel(localSettings.pushToTalkKey) : <span className="text-[var(--color-text-muted)]">Not set</span>}
                  </div>
                  <button type="button" onClick={() => setRecordingTarget(recordingTarget === "ptt" ? null : "ptt")} disabled={!localSettings.enabled} className="h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]">
                    {recordingTarget === "ptt" ? "Cancel" : "Change"}
                  </button>
                  <button type="button" onClick={() => { patchSettings("pushToTalkKey", ""); void mirrorPTTToKeymap(""); }} disabled={!localSettings.pushToTalkKey} aria-label="Clear push-to-talk key" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-error)] disabled:invisible">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </section>

            <section className="grid min-h-28 flex-1 content-center gap-5 py-4 md:grid-cols-[170px_minmax(0,1fr)] [@media(max-height:760px)]:min-h-0 [@media(max-height:760px)]:py-2.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Listening limits</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Ignore accidental taps and stop runaway capture.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {([
                  { label: "Ignore shorter than", value: drafts.minDuration, set: "minDuration", commit: commitMinDuration, min: 1, max: 10, step: 1, unit: "sec" },
                  { label: "Stop listening after", value: drafts.maxDuration, set: "maxDuration", commit: commitMaxDuration, min: 5, max: 60, step: 1, unit: "sec" },
                  { label: "Push-to-talk threshold", value: drafts.pttActivationDelayMs, set: "pttActivationDelayMs", commit: commitPttActivationDelay, min: 0, max: 2000, step: 50, unit: "ms" },
                ] as const).map((field) => (
                  <label key={field.label}>
                    <span className="mb-2 block text-xs font-medium text-[var(--color-text-muted)]">{field.label}</span>
                    <span className="flex h-11 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3">
                      <input
                        type="number"
                        value={field.value}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        disabled={!localSettings.enabled}
                        onChange={(event) => setDrafts((current) => ({ ...current, [field.set]: event.target.value }))}
                        onBlur={field.commit}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            setDrafts((current) => ({ ...current, [field.set]: String(localSettings[field.set]) }));
                            event.currentTarget.blur();
                          }
                        }}
                        className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-[var(--color-text)] outline-none"
                      />
                      <span className="text-xs text-[var(--color-text-muted)]">{field.unit}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          </div>
        </div>
      </section>

      {/* Actions Manager Section */}
      <section className={activeSection === "actions" ? "flex h-full min-h-0 flex-col" : "hidden"}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-5 sm:px-6">
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Search filter */}
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-3 h-4 w-4 text-[var(--color-text-muted)]" />
              <input
                type="text"
                placeholder="Search commands by name, description, or id..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                disabled={!localSettings.enabled}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] pl-10 pr-4 py-2.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
              />
            </div>
            {/* Category filter */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              disabled={!localSettings.enabled}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)] w-48"
            >
              <option value="all">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Action List Grid */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {filteredCommands.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-sm text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]/30">
                <Ban className="h-8 w-8 mb-2 opacity-50" />
                No matching actions found
              </div>
            ) : (
              filteredCommands.map((cmd) => {
                const isEnabled = !(localSettings.disabledActions || []).includes(cmd.id);
                return (
                  <div
                    key={cmd.id}
                    className={`flex items-start justify-between gap-4 p-4 transition-colors ${
                      isEnabled ? "bg-[var(--color-bg)]/30" : "bg-[var(--color-bg-secondary)]/20 opacity-70"
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--color-text)]">{cmd.name}</span>
                        {cmd.category && (
                          <span className="rounded-full bg-[var(--color-highlight)]/10 px-2.5 py-0.5 text-[10px] font-semibold text-[var(--color-highlight)]">
                            {cmd.category}
                          </span>
                        )}
                        <code className="text-[10px] text-[var(--color-text-muted)] font-mono">{cmd.id}</code>
                      </div>
                      {cmd.description && (
                        <p className="text-xs leading-5 text-[var(--color-text-muted)] max-w-2xl">{cmd.description}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => toggleActionEnabled(cmd.id)}
                      disabled={!localSettings.enabled}
                      className={`relative inline-flex h-6 min-w-10 items-center rounded-full border px-0.5 transition-colors ${
                        isEnabled
                          ? "justify-end border-emerald-500/50 bg-emerald-500/15"
                          : "justify-start border-[var(--color-border)] bg-[var(--color-bg)]"
                      }`}
                    >
                      <div
                        className={`h-4 w-4 rounded-full transition-transform ${
                          isEnabled ? "bg-emerald-500" : "bg-[var(--color-text-muted)]/50"
                        }`}
                      />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>
      </div>
    </div>
  );
}
