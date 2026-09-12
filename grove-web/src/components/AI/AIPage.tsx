import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { SlidersHorizontal } from "lucide-react";
import { useProject } from "../../context";
import {
  listProviders,
  createProvider,
  updateProvider as apiUpdateProvider,
  deleteProvider as apiDeleteProvider,
  verifyProvider as apiVerifyProvider,
  getAudioSettings,
  saveAudioGlobal,
  saveAudioProject,
  getVoiceControlSettings,
  saveVoiceControlSettings,
  listSpeakingProfiles,
  createSpeakingProfile,
  updateSpeakingProfile,
  deleteSpeakingProfile,
  listSpeakingVoices,
  getSpeakingProviderSchema,
  previewSpeakingProfile,
} from "../../api";
import { AgentVoicePanel } from "./AgentVoicePanel";
import { AudioPanel } from "./AudioPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { VoiceControlPanel } from "./VoiceControlPanel";
import { tabs } from "./mock";
import { formatProviderError } from "../../utils/providerErrors";
import type { AudioSettings, ProviderProfile, SpeakingProfile, TabId, VoiceControlSettings } from "./types";

const defaultAudio: AudioSettings = {
  enabled: false,
  transcribeMode: "batch",
  globalModeEnabled: false,
  transcribeProvider: "",
  preferredLanguages: [],
  toggleShortcut: "",
  pushToTalkKey: "",
  pttActivationDelayMs: 500,
  maxDuration: 60,
  minDuration: 2,
  reviseEnabled: false,
  reviseProvider: "",
  revisePromptGlobal: "",
  revisePromptProject: "",
  preferredTermsGlobal: [],
  preferredTermsProject: [],
  forbiddenTermsGlobal: [],
  forbiddenTermsProject: [],
  replacementsGlobal: [],
  replacementsProject: [],
};

const defaultVoiceControl: VoiceControlSettings = {
  enabled: false,
  sttProviderId: "",
  sttModel: "",
  llmProviderId: "",
  llmModel: "",
  toggleShortcut: "",
  pushToTalkKey: "",
  pttActivationDelayMs: 500,
  maxDuration: 10,
  minDuration: 1,
  preferredLanguages: [],
  disabledActions: [],
  hasInitializedActions: false,
};

export function AIPage() {
  const { selectedProject } = useProject();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const requestedTab = window.sessionStorage.getItem("grove:ai-settings-tab");
    return tabs.some((tab) => tab.id === requestedTab) ? requestedTab as TabId : "audio";
  });
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(defaultAudio);
  const [voiceControlSettings, setVoiceControlSettings] = useState<VoiceControlSettings>(defaultVoiceControl);
  const [speakingProfiles, setSpeakingProfiles] = useState<SpeakingProfile[]>([]);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [speakingProfileLoadError, setSpeakingProfileLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const projectId = selectedProject?.id ?? null;

  useEffect(() => {
    window.sessionStorage.removeItem("grove:ai-settings-tab");
  }, []);

  // Load providers + audio on mount and when project changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- loading flag for async fetch

    Promise.all([
      listProviders().then((value) => ({ value, error: null })).catch((error: unknown) => ({ value: null, error: formatProviderError(error, { fallback: "Provider profiles could not be loaded." }) })),
      getAudioSettings(projectId ?? undefined).catch(() => defaultAudio),
      getVoiceControlSettings().catch(() => defaultVoiceControl),
      listSpeakingProfiles().then((value) => ({ value, error: null })).catch((error: unknown) => ({ value: null, error: formatProviderError(error, { fallback: "Speaking Profiles could not be loaded." }) })),
    ]).then(([providerResult, audio, voice, speakingResult]) => {
      if (cancelled) return;
      if (providerResult.value) setProviders(providerResult.value);
      setProviderLoadError(providerResult.error);
      setAudioSettings(audio);
      setVoiceControlSettings(voice);
      if (speakingResult.value) setSpeakingProfiles(speakingResult.value);
      setSpeakingProfileLoadError(speakingResult.error);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [projectId]);

  const retryProviders = useCallback(async () => {
    try {
      const next = await listProviders();
      setProviders(next);
      setProviderLoadError(null);
    } catch (error) {
      setProviderLoadError(formatProviderError(error, { fallback: "Provider profiles could not be loaded." }));
    }
  }, []);

  const retrySpeakingProfiles = useCallback(async () => {
    try {
      const next = await listSpeakingProfiles();
      setSpeakingProfiles(next);
      setSpeakingProfileLoadError(null);
    } catch (error) {
      setSpeakingProfileLoadError(formatProviderError(error, { fallback: "Speaking Profiles could not be loaded." }));
    }
  }, []);

  // ─── Provider operations ───────────────────────────────────────────────

  const handleCreateProvider = useCallback(async (data: Omit<ProviderProfile, "id" | "status">) => {
    const created = await createProvider(data);
    setProviders((prev) => [created, ...prev]);
    return created;
  }, []);

  const handleUpdateProvider = useCallback(async (id: string, data: Partial<ProviderProfile>) => {
    const updated = await apiUpdateProvider(id, data);
    setProviders((prev) => prev.map((p) => (p.id === id ? updated : p)));
    return updated;
  }, []);

  const handleDeleteProvider = useCallback(async (id: string) => {
    await apiDeleteProvider(id);
    setProviders((prev) => prev.filter((p) => p.id !== id));
    setSpeakingProfiles((previous) => previous.filter((profile) => profile.providerId !== id));
    window.dispatchEvent(new Event("grove:speaking-profiles-changed"));
  }, []);

  const handleVerifyProvider = useCallback(async (id: string) => {
    const result = await apiVerifyProvider(id);
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: result.status as ProviderProfile["status"] } : p)),
    );
    return result;
  }, []);

  // ─── Audio operations ─────────────────────────────────────────────────

  const handleAudioSaved = useCallback(
    async (next: AudioSettings) => {
      setAudioSettings(next);
      // Save global and project settings in parallel
      const promises: Promise<void>[] = [saveAudioGlobal(next)];
      if (projectId) {
        promises.push(saveAudioProject(projectId, next));
      }
      await Promise.all(promises).catch(console.error);
      // Notify GlobalAudioRecorder to reload settings
      window.dispatchEvent(new Event("grove:audio-settings-changed"));
    },
    [projectId],
  );

  // ─── Voice Control operations ─────────────────────────────────────────

  const handleVoiceControlSaved = useCallback(
    async (next: VoiceControlSettings) => {
      setVoiceControlSettings(next);
      await saveVoiceControlSettings(next).catch(console.error);
      // Notify GlobalVoiceControlRecorder to reload settings
      window.dispatchEvent(new Event("grove:voice-control-settings-changed"));
    },
    [],
  );

  const handleCreateSpeakingProfile = useCallback(async (data: Omit<SpeakingProfile, "id">) => {
    const created = await createSpeakingProfile(data);
    setSpeakingProfiles((previous) => [...previous, created]);
    window.dispatchEvent(new Event("grove:speaking-profiles-changed"));
    return created;
  }, []);

  const handleUpdateSpeakingProfile = useCallback(async (id: string, data: Omit<SpeakingProfile, "id">) => {
    const updated = await updateSpeakingProfile(id, data);
    setSpeakingProfiles((previous) => previous.map((profile) => profile.id === id ? updated : profile));
    window.dispatchEvent(new Event("grove:speaking-profiles-changed"));
    return updated;
  }, []);

  const handleDeleteSpeakingProfile = useCallback(async (id: string) => {
    await deleteSpeakingProfile(id);
    setSpeakingProfiles((previous) => previous.filter((profile) => profile.id !== id));
    window.dispatchEvent(new CustomEvent("grove:speaking-profile-deleted", { detail: { id } }));
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden md:overflow-hidden">
      <header className="shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-start justify-between gap-3 pb-4 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] sm:h-11 sm:w-11">
              <SlidersHorizontal className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--color-text)] sm:text-2xl">AI Settings</h1>
              <p className="mt-1 truncate text-sm text-[var(--color-text-muted)]"><span className="sm:hidden">Configure AI and voice.</span><span className="hidden sm:inline">Configure AI input, control, providers, and Agent Voice{selectedProject ? ` for ${selectedProject.name}` : ""}.</span></p>
            </div>
          </div>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {isActive && (
                <motion.div
                  layoutId="aiTabIndicator"
                  className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--color-highlight)]"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
            </button>
          );
        })}
        </nav>
      </header>

      <div className="min-h-0 flex-none overflow-visible pt-4 md:flex-1 md:overflow-hidden md:pt-5">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
            Loading AI settings...
          </div>
        ) : (
          <>
            {activeTab === "providers" && (
              <ProvidersPanel
                providers={providers}
                loadError={providerLoadError}
                onRetryLoad={retryProviders}
                onCreate={handleCreateProvider}
                onUpdate={handleUpdateProvider}
                onDelete={handleDeleteProvider}
                onVerify={handleVerifyProvider}
              />
            )}
            {activeTab === "audio" && (
              <AudioPanel
                settings={audioSettings}
                providers={providers.filter((provider) => provider.type.toLowerCase() !== "elevenlabs")}
                onSettingsSaved={handleAudioSaved}
              />
            )}
            {activeTab === "voice_control" && (
              <VoiceControlPanel
                settings={voiceControlSettings}
                providers={providers.filter((provider) => provider.type.toLowerCase() !== "elevenlabs")}
                onSettingsSaved={handleVoiceControlSaved}
              />
            )}
            {activeTab === "agent_voice" && (
              <AgentVoicePanel
                profiles={speakingProfiles}
                providers={providers}
                loadError={speakingProfileLoadError}
                onRetryLoad={retrySpeakingProfiles}
                onCreate={handleCreateSpeakingProfile}
                onUpdate={handleUpdateSpeakingProfile}
                onDelete={handleDeleteSpeakingProfile}
                onListVoices={listSpeakingVoices}
                onGetProviderSchema={getSpeakingProviderSchema}
                onPreview={previewSpeakingProfile}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
