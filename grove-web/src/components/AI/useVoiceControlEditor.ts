import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commandRegistry, persistOverride, persistRemoveOverride } from "../../keyboard";
import type { VoiceControlSettings } from "./types";
import { clampDraft, type RecordingTarget } from "./useAudioSettingsEditor";
import { formatPTTKey, formatShortcut } from "./utils";

export const VOICE_CONTROL_LIMITS = {
  minDuration: { min: 1, max: 10, step: 1 },
  maxDuration: { min: 5, max: 60, step: 1 },
  pttActivationDelayMs: { min: 0, max: 2000, step: 50 },
} as const;

type DurationKey = keyof typeof VOICE_CONTROL_LIMITS;

export function isRecommendedAction(cmdId: string): boolean {
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
  return exactMatches.includes(cmdId);
}

/** Ids of every command outside the recommended set — the default "disabled" list. */
export function recommendedDisabledActions(commandIds: string[]): string[] {
  return commandIds.filter((id) => !isRecommendedAction(id));
}

/**
 * Editing state for Voice Control: pipeline, triggers, limits and the set of
 * commands voice may run. Every change is handed to `onSettingsSaved` right
 * away. Shared by the Workbench VoiceControlPanel and Orbit's Voice control page.
 */
export function useVoiceControlEditor(settings: VoiceControlSettings, onSettingsSaved: (next: VoiceControlSettings) => void) {
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
      return {
        ...settings,
        disabledActions: recommendedDisabledActions(allCommands.map((c) => c.id)),
        hasInitializedActions: true,
      };
    }
    return settings;
  }, [settings, allCommands]);

  const [localSettings, setLocalSettings] = useState<VoiceControlSettings>(initialSettings);
  const [recordingTarget, setRecordingTarget] = useState<RecordingTarget | null>(null);

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

  const onSettingsSavedRef = useRef(onSettingsSaved);
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

  const commitDuration = useCallback((key: DurationKey) => {
    const { min, max } = VOICE_CONTROL_LIMITS[key];
    const next = clampDraft(drafts[key], min, max, localSettings[key]);
    setDrafts((d) => ({ ...d, [key]: String(next) }));
    if (next !== localSettings[key]) {
      patchSettings(key, next);
    }
  }, [drafts, localSettings, patchSettings]);

  const setDraft = useCallback((key: DurationKey, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  }, []);

  const resetDraft = useCallback((key: DurationKey) => {
    setDrafts((current) => ({ ...current, [key]: String(localSettings[key]) }));
  }, [localSettings]);

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

  const toggleRecordingTarget = useCallback((target: RecordingTarget) => {
    setRecordingTarget((current) => (current === target ? null : target));
  }, []);

  const clearShortcut = useCallback((target: RecordingTarget) => {
    if (target === "toggle") {
      patchSettings("toggleShortcut", "");
      return;
    }
    patchSettings("pushToTalkKey", "");
    void mirrorPTTToKeymap("");
  }, [mirrorPTTToKeymap, patchSettings]);

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
      const nextDisabled = currentDisabled.includes(actionId)
        ? currentDisabled.filter((id) => id !== actionId)
        : [...currentDisabled, actionId];
      patchSettings("disabledActions", nextDisabled);
    },
    [localSettings.disabledActions, patchSettings]
  );

  const applyRecommendedActions = () => {
    patchSettings("disabledActions", recommendedDisabledActions(allCommands.map((c) => c.id)));
  };
  const enableAllActions = () => patchSettings("disabledActions", []);
  const disableAllActions = () => patchSettings("disabledActions", allCommands.map((c) => c.id));

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

  const isActionEnabled = (actionId: string) => !(localSettings.disabledActions || []).includes(actionId);

  return {
    settings: localSettings,
    patchSettings,
    recordingTarget,
    toggleRecordingTarget,
    clearShortcut,
    togglePreferredLanguage,
    addCustomLanguage,
    drafts,
    setDraft,
    resetDraft,
    commitDuration,
    allCommands,
    categories,
    filteredCommands,
    searchQuery,
    setSearchQuery,
    categoryFilter,
    setCategoryFilter,
    isActionEnabled,
    toggleActionEnabled,
    applyRecommendedActions,
    enableAllActions,
    disableAllActions,
  };
}

export type VoiceControlEditor = ReturnType<typeof useVoiceControlEditor>;
