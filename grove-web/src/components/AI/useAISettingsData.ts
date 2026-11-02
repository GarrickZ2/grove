import { useCallback, useEffect, useState } from "react";
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
} from "../../api";
import { formatProviderError } from "../../utils/providerErrors";
import type { AudioSettings, ProviderProfile, SpeakingProfile, VoiceControlSettings } from "./types";

export const defaultAudioSettings: AudioSettings = {
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

export const defaultVoiceControlSettings: VoiceControlSettings = {
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

const PROVIDERS_LOAD_FALLBACK = "Provider profiles could not be loaded.";
const SPEAKING_LOAD_FALLBACK = "Speaking Profiles could not be loaded.";

/** Speech-to-text and language-model features can't run on ElevenLabs profiles. */
export function textCapableProviders(providers: ProviderProfile[]): ProviderProfile[] {
  return providers.filter((provider) => provider.type.toLowerCase() !== "elevenlabs");
}

export interface ProviderProfilesState {
  providers: ProviderProfile[];
  loading: boolean;
  loadError: string | null;
  retry: () => Promise<void>;
  create: (data: Omit<ProviderProfile, "id" | "status">) => Promise<ProviderProfile>;
  update: (id: string, data: Partial<ProviderProfile>) => Promise<ProviderProfile>;
  /** Deleting a provider also deletes its Speaking Profiles on the backend. */
  remove: (id: string) => Promise<void>;
  verify: (id: string) => Promise<{ status: string; message: string }>;
}

export function useProviderProfiles(): ProviderProfilesState {
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProviders()
      .then((next) => {
        if (cancelled) return;
        setProviders(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(formatProviderError(error, { fallback: PROVIDERS_LOAD_FALLBACK }));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const retry = useCallback(async () => {
    try {
      setProviders(await listProviders());
      setLoadError(null);
    } catch (error) {
      setLoadError(formatProviderError(error, { fallback: PROVIDERS_LOAD_FALLBACK }));
    }
  }, []);

  const create = useCallback(async (data: Omit<ProviderProfile, "id" | "status">) => {
    const created = await createProvider(data);
    setProviders((prev) => [created, ...prev]);
    window.dispatchEvent(new Event("grove:providers-changed"));
    return created;
  }, []);

  const update = useCallback(async (id: string, data: Partial<ProviderProfile>) => {
    const updated = await apiUpdateProvider(id, data);
    setProviders((prev) => prev.map((p) => (p.id === id ? updated : p)));
    window.dispatchEvent(new Event("grove:providers-changed"));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await apiDeleteProvider(id);
    setProviders((prev) => prev.filter((p) => p.id !== id));
    window.dispatchEvent(new Event("grove:speaking-profiles-changed"));
  }, []);

  const verify = useCallback(async (id: string) => {
    const result = await apiVerifyProvider(id);
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: result.status as ProviderProfile["status"] } : p)),
    );
    return result;
  }, []);

  return { providers, loading, loadError, retry, create, update, remove, verify };
}

export interface AudioSettingsState {
  settings: AudioSettings;
  loading: boolean;
  save: (next: AudioSettings) => Promise<void>;
}

/** Audio (voice input) settings, merged global + project. Reloads when the project changes. */
export function useAudioSettings(projectId: string | null): AudioSettingsState {
  const [settings, setSettings] = useState<AudioSettings>(defaultAudioSettings);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- loading flag for async fetch
    getAudioSettings(projectId ?? undefined)
      .catch(() => defaultAudioSettings)
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const save = useCallback(async (next: AudioSettings) => {
    setSettings(next);
    // Save global and project settings in parallel
    const promises: Promise<void>[] = [saveAudioGlobal(next)];
    if (projectId) promises.push(saveAudioProject(projectId, next));
    await Promise.all(promises).catch(console.error);
    // Notify GlobalAudioRecorder to reload settings
    window.dispatchEvent(new Event("grove:audio-settings-changed"));
  }, [projectId]);

  return { settings, loading, save };
}

export interface VoiceControlSettingsState {
  settings: VoiceControlSettings;
  loading: boolean;
  save: (next: VoiceControlSettings) => Promise<void>;
}

export function useVoiceControlSettings(): VoiceControlSettingsState {
  const [settings, setSettings] = useState<VoiceControlSettings>(defaultVoiceControlSettings);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getVoiceControlSettings()
      .catch(() => defaultVoiceControlSettings)
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async (next: VoiceControlSettings) => {
    setSettings(next);
    await saveVoiceControlSettings(next).catch(console.error);
    // Notify GlobalVoiceControlRecorder to reload settings
    window.dispatchEvent(new Event("grove:voice-control-settings-changed"));
  }, []);

  return { settings, loading, save };
}

export interface SpeakingProfilesState {
  profiles: SpeakingProfile[];
  loading: boolean;
  loadError: string | null;
  retry: () => Promise<void>;
  create: (data: Omit<SpeakingProfile, "id">) => Promise<SpeakingProfile>;
  update: (id: string, data: Omit<SpeakingProfile, "id">) => Promise<SpeakingProfile>;
  remove: (id: string) => Promise<void>;
  /** Drop local profiles of a deleted provider (the backend already removed them). */
  forgetProvider: (providerId: string) => void;
}

export function useSpeakingProfiles(): SpeakingProfilesState {
  const [profiles, setProfiles] = useState<SpeakingProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listSpeakingProfiles()
      .then((next) => {
        if (cancelled) return;
        setProfiles(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(formatProviderError(error, { fallback: SPEAKING_LOAD_FALLBACK }));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const retry = useCallback(async () => {
    try {
      setProfiles(await listSpeakingProfiles());
      setLoadError(null);
    } catch (error) {
      setLoadError(formatProviderError(error, { fallback: SPEAKING_LOAD_FALLBACK }));
    }
  }, []);

  const create = useCallback(async (data: Omit<SpeakingProfile, "id">) => {
    const created = await createSpeakingProfile(data);
    setProfiles((previous) => [...previous, created]);
    window.dispatchEvent(new Event("grove:speaking-profiles-changed"));
    return created;
  }, []);

  const update = useCallback(async (id: string, data: Omit<SpeakingProfile, "id">) => {
    const updated = await updateSpeakingProfile(id, data);
    setProfiles((previous) => previous.map((profile) => profile.id === id ? updated : profile));
    window.dispatchEvent(new Event("grove:speaking-profiles-changed"));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteSpeakingProfile(id);
    setProfiles((previous) => previous.filter((profile) => profile.id !== id));
    window.dispatchEvent(new CustomEvent("grove:speaking-profile-deleted", { detail: { id } }));
  }, []);

  const forgetProvider = useCallback((providerId: string) => {
    setProfiles((previous) => previous.filter((profile) => profile.providerId !== providerId));
  }, []);

  return { profiles, loading, loadError, retry, create, update, remove, forgetProvider };
}
