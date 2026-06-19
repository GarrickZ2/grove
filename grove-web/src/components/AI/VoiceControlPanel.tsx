import React, { useCallback, useEffect, useState, useMemo } from "react";
import { ArrowDown, Keyboard, Mic, MicOff, Search, Timer, Settings, Check, Ban, X } from "lucide-react";
import { LanguageMultiSelect } from "./components/LanguageMultiSelect";
import { ProfilePicker } from "./components/ProfilePicker";
import { FieldGroup, PipelineSection } from "./components/PipelineLayout";
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
  // voice_control.* from GlobalVoiceControlRecorder) appear in the list even
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
          command_id: "voice_control.ptt.start",
          key,
          when_ctx: undefined,
          scope: undefined,
        });
      } else {
        await persistRemoveOverride("voice_control.ptt.start");
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
    <div className="mx-auto max-w-[980px] space-y-4">
      <div className="rounded-[28px] border border-[var(--color-border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--color-highlight)_8%,transparent),transparent_70%)] px-5 py-5 sm:px-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-highlight)]">Voice Control Pipeline</div>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
          Speak your actions directly to the AI, which analyzes your intent and maps it to sequential system commands.
        </p>
      </div>

      <PipelineSection
        step="STAGE 1"
        title="Voice Control Settings"
        icon={Mic}
        enabled={localSettings.enabled}
        onToggle={() => patchSettings("enabled", !localSettings.enabled)}
      >
        <div className={localSettings.enabled ? "space-y-6" : "pointer-events-none space-y-6 opacity-50"}>
          <div className="grid gap-6 md:grid-cols-2">
            {/* STT Provider Selection */}
            <FieldGroup
              title="Voice-to-Text (STT) Profile"
              hint="Select a provider profile for transcribing speech to text."
              inlineHint
            >
              <div className="max-w-[360px]">
                <ProfilePicker
                  label="STT Profile"
                  profiles={providers}
                  value={localSettings.sttProviderId}
                  onChange={(value) => patchSettings("sttProviderId", value)}
                  disabled={!localSettings.enabled}
                />
              </div>
            </FieldGroup>

            {/* LLM Provider Selection */}
            <FieldGroup
              title="Text Model (LLM) Profile"
              hint="Select a text model profile to analyze text and emit actions."
              inlineHint
            >
              <div className="max-w-[360px]">
                <ProfilePicker
                  label="LLM Profile"
                  profiles={providers}
                  value={localSettings.llmProviderId}
                  onChange={(value) => patchSettings("llmProviderId", value)}
                  disabled={!localSettings.enabled}
                />
              </div>
            </FieldGroup>
          </div>

          {/* Language preference */}
          <FieldGroup
            title="Language preference"
            hint="Select the preferred languages for speech input."
            inlineHint
          >
            <div className="max-w-[360px]">
              <LanguageMultiSelect
                label="Preferred Languages"
                options={languageOptions}
                value={localSettings.preferredLanguages || []}
                onToggle={togglePreferredLanguage}
                onAddCustom={addCustomLanguage}
                disabled={!localSettings.enabled}
              />
            </div>
          </FieldGroup>

          {/* Recording shortcuts */}
          <FieldGroup title="Recording shortcuts" hint="Configure combo shortcut keys or push-to-talk keys.">
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Toggle Mode */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Keyboard className="h-4 w-4 text-[var(--color-text-muted)]" />
                    <span className="text-sm font-medium text-[var(--color-text)]">Toggle Mode</span>
                  </div>
                  {localSettings.toggleShortcut && (
                    <button
                      type="button"
                      onClick={() => patchSettings("toggleShortcut", "")}
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
                    {recordingTarget === "toggle" ? (
                      <span className="text-[var(--color-highlight)]">Press combo keys...</span>
                    ) : (
                      localSettings.toggleShortcut || <span className="text-[var(--color-text-muted)]">Not set</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRecordingTarget(recordingTarget === "toggle" ? null : "toggle")}
                    disabled={!localSettings.enabled}
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
                  {localSettings.pushToTalkKey && (
                    <button
                      type="button"
                      onClick={() => {
                        patchSettings("pushToTalkKey", "");
                        void mirrorPTTToKeymap("");
                      }}
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
                    {recordingTarget === "ptt" ? (
                      <span className="text-[var(--color-highlight)]">Press any key...</span>
                    ) : localSettings.pushToTalkKey ? (
                      pttKeyLabel(localSettings.pushToTalkKey)
                    ) : (
                      <span className="text-[var(--color-text-muted)]">Not set</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRecordingTarget(recordingTarget === "ptt" ? null : "ptt")}
                    disabled={!localSettings.enabled}
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

          {/* Duration Limits */}
          <FieldGroup title="Duration limits" hint="Minimum duration filters accidental taps. Maximum prevents runaway recordings. PTT hold delay controls the start latency.">
            <div className="grid gap-4 sm:grid-cols-3 max-w-[720px]">
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
                    value={drafts.minDuration}
                    onChange={(e) => setDrafts((d) => ({ ...d, minDuration: e.target.value }))}
                    onBlur={commitMinDuration}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setDrafts((d) => ({ ...d, minDuration: String(localSettings.minDuration) }));
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={!localSettings.enabled}
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
                    min={5}
                    max={60}
                    value={drafts.maxDuration}
                    onChange={(e) => setDrafts((d) => ({ ...d, maxDuration: e.target.value }))}
                    onBlur={commitMaxDuration}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setDrafts((d) => ({ ...d, maxDuration: String(localSettings.maxDuration) }));
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={!localSettings.enabled}
                    className="h-10 w-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">seconds</span>
                </div>
              </div>
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-muted)]">
                  <Mic className="h-3.5 w-3.5" />
                  PTT hold delay
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={2000}
                    step={50}
                    value={drafts.pttActivationDelayMs}
                    onChange={(e) => setDrafts((d) => ({ ...d, pttActivationDelayMs: e.target.value }))}
                    onBlur={commitPttActivationDelay}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setDrafts((d) => ({ ...d, pttActivationDelayMs: String(localSettings.pttActivationDelayMs) }));
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={!localSettings.enabled}
                    className="h-10 w-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">ms</span>
                </div>
              </div>
            </div>
          </FieldGroup>
        </div>
      </PipelineSection>

      <div className="flex justify-center py-1 text-[var(--color-text-muted)]">
        <ArrowDown className="h-5 w-5" />
      </div>

      {/* Actions Manager Section */}
      <section className={localSettings.enabled ? "rounded-[28px] border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_18px_50px_rgba(15,23,42,0.05)]" : "pointer-events-none rounded-[28px] border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_18px_50px_rgba(15,23,42,0.05)] opacity-50"}>
        <div className="border-b border-[var(--color-border)] px-5 py-4 sm:px-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]">
                <Settings className="h-5 w-5" />
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-highlight)]">STAGE 2</div>
                <h2 className="mt-1 text-base font-semibold text-[var(--color-text)]">Actions Manager</h2>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const recommendedSet = new Set(allCommands.filter((c) => isRecommendedAction(c.id)).map((c) => c.id));
                  const defaultDisabled = allCommands.filter((c) => !recommendedSet.has(c.id)).map((c) => c.id);
                  patchSettings("disabledActions", defaultDisabled);
                }}
                disabled={!localSettings.enabled}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors bg-[var(--color-bg)]"
              >
                <Settings className="h-3.5 w-3.5 text-[var(--color-highlight)]" />
                Recommended
              </button>
              <button
                type="button"
                onClick={() => patchSettings("disabledActions", [])}
                disabled={!localSettings.enabled}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors bg-[var(--color-bg)]"
              >
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                Enable All
              </button>
              <button
                type="button"
                onClick={() => patchSettings("disabledActions", allCommands.map((c) => c.id))}
                disabled={!localSettings.enabled}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors bg-[var(--color-bg)]"
              >
                <Ban className="h-3.5 w-3.5 text-rose-500" />
                Disable All
              </button>
            </div>
          </div>
        </div>

        <div className="px-5 py-5 sm:px-6 space-y-4">
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
          <div className="border border-[var(--color-border)] rounded-2xl overflow-x-hidden divide-y divide-[var(--color-border)] max-h-96 overflow-y-auto">
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
  );
}
