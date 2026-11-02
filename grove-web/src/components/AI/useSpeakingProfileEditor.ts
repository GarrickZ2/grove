import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatProviderError } from "../../utils/providerErrors";
import type {
  ProviderProfile,
  SpeakingProfile,
  SpeakingProfileConfig,
  SpeakingProviderSchema,
  SpeakingVoice,
  SpeakingVoicePage,
  SpeakingVoiceQuery,
} from "./types";

export type ProfileDraft = Omit<SpeakingProfile, "id"> & { id?: string };

export const voiceTypeFilters = [
  { value: "all", label: "All voices" },
  { value: "personal", label: "Personal" },
  { value: "saved", label: "Saved" },
  { value: "default", label: "Default" },
  { value: "workspace", label: "Workspace" },
] as const;
export type VoiceTypeFilter = (typeof voiceTypeFilters)[number]["value"];

export const SPOKEN_LIMITS = {
  maxCharacters: { min: 40, max: 2000, step: 10 },
  maxDurationSeconds: { min: 5, max: 300, step: 1 },
} as const;

const NEW_PROFILE_NAME = "New Speaking Profile";

export function voiceSnapshot(config: SpeakingProfileConfig, voiceId: string, fallbackName: string): SpeakingVoice | null {
  if (!voiceId) return null;
  const value = (key: string) => typeof config[key] === "string" && config[key] ? String(config[key]) : undefined;
  return {
    voiceId,
    name: value("voiceName") ?? (fallbackName === NEW_PROFILE_NAME ? "Selected voice" : fallbackName),
    description: value("voiceDescription"),
    previewUrl: value("voicePreviewUrl"),
    language: value("voiceLanguage"),
    locale: value("voiceLocale"),
    accent: value("voiceAccent"),
    useCase: value("voiceUseCase"),
    category: value("voiceCategory"),
    source: value("voiceSource"),
  };
}

export function configWithVoiceSnapshot(config: SpeakingProfileConfig, fieldKey: string, voice: SpeakingVoice): SpeakingProfileConfig {
  const next: SpeakingProfileConfig = { ...config, [fieldKey]: voice.voiceId, voiceName: voice.name };
  const values: Array<[string, string | undefined]> = [
    ["voiceDescription", voice.description], ["voicePreviewUrl", voice.previewUrl], ["voiceLanguage", voice.language],
    ["voiceLocale", voice.locale], ["voiceAccent", voice.accent], ["voiceUseCase", voice.useCase],
    ["voiceCategory", voice.category], ["voiceSource", voice.source],
  ];
  for (const [key, value] of values) {
    if (value) next[key] = value;
    else delete next[key];
  }
  return next;
}

function newDraft(providerId = ""): ProfileDraft {
  return { name: NEW_PROFILE_NAME, providerId, config: {}, maxCharacters: 280, maxDurationSeconds: 30 };
}

function isMissingRequiredValue(value: SpeakingProfileConfig[string] | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

/** Stable comparison key for a profile, with schema defaults filled in. */
export function profileSignature(profile: ProfileDraft | SpeakingProfile, schema: SpeakingProviderSchema | null): string {
  const config = { ...profile.config };
  for (const field of schema?.fields ?? []) {
    if (config[field.key] === undefined) config[field.key] = field.defaultValue;
  }
  const sortedConfig = Object.fromEntries(
    Object.entries(config).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    name: profile.name.trim(),
    providerId: profile.providerId,
    config: sortedConfig,
    maxCharacters: profile.maxCharacters,
    maxDurationSeconds: profile.maxDurationSeconds,
  });
}

export function voiceMeta(voice: SpeakingVoice): string[] {
  return [voice.language, voice.accent, voice.useCase, voice.category].filter((item): item is string => Boolean(item)).map((item) => item.replaceAll("_", " "));
}

export interface SpeakingProfileEditorOptions {
  profiles: SpeakingProfile[];
  providers: ProviderProfile[];
  loadError?: string | null;
  onCreate: (profile: Omit<SpeakingProfile, "id">) => Promise<SpeakingProfile>;
  onUpdate: (id: string, profile: Omit<SpeakingProfile, "id">) => Promise<SpeakingProfile>;
  onDelete: (id: string) => Promise<void>;
  onListVoices: (providerId: string, query?: SpeakingVoiceQuery) => Promise<SpeakingVoicePage>;
  onGetProviderSchema: (providerId: string) => Promise<SpeakingProviderSchema>;
  onPreview: (id: string, text: string) => Promise<{ mimeType: string; audioBase64: string }>;
}

/**
 * Editing state for Agent Voice Speaking Profiles: the selected profile draft,
 * the provider's control schema, the paged voice catalog, previews, and
 * save/delete. Shared by the Workbench AgentVoicePanel and Orbit's Agent voice page.
 */
export function useSpeakingProfileEditor({ profiles, providers, loadError, onCreate, onUpdate, onDelete, onListVoices, onGetProviderSchema, onPreview }: SpeakingProfileEditorOptions) {
  const speakingProviders = useMemo(() => providers.filter((provider) => provider.supportsSpeaking), [providers]);
  const defaultProviderId = speakingProviders.find((provider) => provider.status === "verified")?.id ?? "";
  const [selectedId, setSelectedId] = useState<string | null>(profiles[0]?.id ?? null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const [draft, setDraft] = useState<ProfileDraft>(() => selected ? { ...selected, config: { ...selected.config } } : newDraft(defaultProviderId));
  const selectedVoiceId = typeof draft.config.voiceId === "string" ? draft.config.voiceId : "";
  const provider = speakingProviders.find((item) => item.id === draft.providerId);
  const providerConnected = provider?.status === "verified";
  const [schema, setSchema] = useState<SpeakingProviderSchema | null>(null);
  const [voices, setVoices] = useState<SpeakingVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeakingVoice | null>(null);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceType, setVoiceType] = useState<VoiceTypeFilter>("all");
  const [voicePageToken, setVoicePageToken] = useState<string>();
  const [hasMoreVoices, setHasMoreVoices] = useState(false);
  const [totalVoices, setTotalVoices] = useState<number>();
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicePickerOpened, setVoicePickerOpened] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerIssues, setProviderIssues] = useState<Partial<Record<"schema" | "voices", string>>>({});
  const loadingMoreVoicesRef = useRef(false);
  const voiceCatalogKeyRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const savedFeedbackTimerRef = useRef<number | null>(null);
  const profileNameTouchedRef = useRef(Boolean(selected));

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (savedFeedbackTimerRef.current !== null) window.clearTimeout(savedFeedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (loadError || !draft.providerId) {
      queueMicrotask(() => {
        setSchema(null);
        setVoices([]);
        setVoicePageToken(undefined);
        setHasMoreVoices(false);
        setTotalVoices(undefined);
        setProviderIssues({});
      });
      return;
    }
    const providerId = draft.providerId;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) { setSchema(null); setProviderIssues({}); } });
    void onGetProviderSchema(providerId)
      .then((nextSchema) => {
        if (cancelled) return;
        setSchema(nextSchema);
        setDraft((current) => {
          if (current.providerId !== providerId) return current;
          const config = { ...current.config };
          for (const field of nextSchema.fields) if (config[field.key] === undefined) config[field.key] = field.defaultValue;
          return { ...current, config };
        });
      })
      .catch((reason) => {
        if (cancelled) return;
        setSchema(null);
        setProviderIssues({ schema: formatProviderError(reason, { fallback: "Provider controls could not be loaded.", backendRestartMessage: "Restart Grove to load Agent Voice Provider controls." }) });
      })
    return () => { cancelled = true; };
  }, [draft.providerId, loadError, onGetProviderSchema]);

  useEffect(() => {
    const catalogKey = `${draft.providerId}:${voiceType}:${voiceSearch.trim()}`;
    voiceCatalogKeyRef.current = catalogKey;
    if (!voicePickerOpened || loadError || !draft.providerId || !providerConnected) {
      queueMicrotask(() => {
        setVoices([]);
        setVoicePageToken(undefined);
        setHasMoreVoices(false);
        setTotalVoices(undefined);
        setLoadingVoices(false);
      });
      return;
    }
    const providerId = draft.providerId;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) { setVoicePageToken(undefined); setHasMoreVoices(false); } });
    const timer = window.setTimeout(() => {
      setLoadingVoices(true);
      void onListVoices(providerId, { search: voiceSearch.trim() || undefined, voiceType: voiceType === "all" ? undefined : voiceType, pageSize: 50 })
        .then((page) => {
          if (cancelled || voiceCatalogKeyRef.current !== catalogKey) return;
          setVoices(page.voices);
          setVoicePageToken(page.nextPageToken);
          setHasMoreVoices(page.hasMore);
          setTotalVoices(page.totalCount);
          setProviderIssues((current) => ({ ...current, voices: undefined }));
        })
        .catch((reason) => {
          if (cancelled || voiceCatalogKeyRef.current !== catalogKey) return;
          setVoices([]);
          setVoicePageToken(undefined);
          setHasMoreVoices(false);
          setTotalVoices(undefined);
          setProviderIssues((current) => ({ ...current, voices: formatProviderError(reason, { fallback: "Voices could not be loaded." }) }));
        })
        .finally(() => { if (!cancelled && voiceCatalogKeyRef.current === catalogKey) setLoadingVoices(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draft.providerId, loadError, onListVoices, providerConnected, voicePickerOpened, voiceSearch, voiceType]);

  const loadMoreVoices = useCallback(() => {
    if (!draft.providerId || !voicePageToken || loadingVoices || loadingMoreVoicesRef.current) return;
    const catalogKey = voiceCatalogKeyRef.current;
    loadingMoreVoicesRef.current = true;
    setLoadingVoices(true);
    void onListVoices(draft.providerId, { search: voiceSearch.trim() || undefined, voiceType: voiceType === "all" ? undefined : voiceType, nextPageToken: voicePageToken, pageSize: 50 })
      .then((page) => {
        if (voiceCatalogKeyRef.current !== catalogKey) return;
        setVoices((current) => {
          const seen = new Set(current.map((voice) => voice.voiceId));
          return [...current, ...page.voices.filter((voice) => !seen.has(voice.voiceId))];
        });
        setVoicePageToken(page.nextPageToken);
        setHasMoreVoices(page.hasMore);
        setTotalVoices(page.totalCount);
      })
      .catch((reason) => setProviderIssues((current) => ({ ...current, voices: formatProviderError(reason, { fallback: "More voices could not be loaded." }) })))
      .finally(() => {
        loadingMoreVoicesRef.current = false;
        if (voiceCatalogKeyRef.current === catalogKey) setLoadingVoices(false);
      });
  }, [draft.providerId, loadingVoices, onListVoices, voicePageToken, voiceSearch, voiceType]);

  const selectProfile = (id: string) => {
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    setSelectedId(profile.id);
    setDraft({ ...profile, config: { ...profile.config } });
    setSelectedVoice(null);
    setVoiceSearch("");
    setVoiceType("all");
    setVoicePickerOpened(false);
    setError(null);
    setSavedSignature(null);
    profileNameTouchedRef.current = true;
  };

  const startCreate = () => {
    setSelectedId(null);
    setDraft(newDraft(defaultProviderId));
    setSelectedVoice(null);
    setVoiceSearch("");
    setVoiceType("all");
    setVoicePickerOpened(false);
    setError(null);
    setSavedSignature(null);
    profileNameTouchedRef.current = false;
  };

  const setName = (name: string) => {
    profileNameTouchedRef.current = true;
    setDraft((current) => ({ ...current, name }));
  };

  const selectProvider = (providerId: string) => {
    setVoiceSearch("");
    setVoiceType("all");
    setVoicePickerOpened(false);
    setSelectedVoice(null);
    setDraft((current) => ({ ...current, providerId, config: {} }));
  };

  const patchConfig = (key: string, value: string | number | boolean) => setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));

  const setLimit = (key: keyof typeof SPOKEN_LIMITS, value: number) => setDraft((current) => ({ ...current, [key]: value }));

  const voiceField = schema?.fields.find((field) => field.type === "voice");
  const modelField = schema?.fields.find((field) => field.type === "select");

  const selectVoice = (voice: SpeakingVoice) => {
    setSelectedVoice(voice);
    setDraft((current) => ({
      ...current,
      name: profileNameTouchedRef.current ? current.name : voice.name,
      config: configWithVoiceSnapshot(current.config, voiceField?.key ?? "voiceId", voice),
    }));
  };

  const selectModel = (value: string) => patchConfig(modelField?.key ?? "modelId", value);

  const saveProfile = async () => {
    const missingRequired = schema?.fields.some((field) => field.required && isMissingRequiredValue(draft.config[field.key]));
    if (!draft.name.trim() || !draft.providerId || missingRequired) { setError("Complete the profile name and required Provider settings."); return; }
    setSaving(true);
    setSavedSignature(null);
    setError(null);
    try {
      const body = { name: draft.name.trim(), providerId: draft.providerId, config: draft.config, maxCharacters: draft.maxCharacters, maxDurationSeconds: draft.maxDurationSeconds };
      const saved = draft.id ? await onUpdate(draft.id, body) : await onCreate(body);
      setSelectedId(saved.id);
      setDraft({ ...saved, config: { ...saved.config } });
      const signature = profileSignature(saved, schema);
      setSavedSignature(signature);
      if (savedFeedbackTimerRef.current !== null) window.clearTimeout(savedFeedbackTimerRef.current);
      savedFeedbackTimerRef.current = window.setTimeout(() => {
        setSavedSignature(null);
        savedFeedbackTimerRef.current = null;
      }, 2200);
      profileNameTouchedRef.current = true;
    } catch (reason) {
      setError(formatProviderError(reason, { fallback: "Could not save Speaking Profile" }));
    } finally { setSaving(false); }
  };

  const deleteProfile = async () => {
    if (!draft.id || !window.confirm(`Delete Speaking Profile “${draft.name}”?`)) return;
    try {
      await onDelete(draft.id);
      const next = profiles.find((profile) => profile.id !== draft.id);
      setSelectedId(next?.id ?? null);
      setDraft(next ? { ...next, config: { ...next.config } } : newDraft(defaultProviderId));
      setSelectedVoice(null);
    } catch (reason) { setError(formatProviderError(reason, { fallback: "Could not delete Speaking Profile" })); }
  };

  const playAudio = useCallback(async (voice: SpeakingVoice | null) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (playingVoiceId === voice?.voiceId) { setPlayingVoiceId(null); setPreviewing(false); return; }
    setError(null);
    setPreviewing(true);
    try {
      let source = voice?.previewUrl;
      if (!source && draft.id && voice?.voiceId === selectedVoiceId) {
        const result = await onPreview(draft.id, "This is how Agent Voice will sound.");
        source = `data:${result.mimeType};base64,${result.audioBase64}`;
      }
      if (!source) throw new Error("This voice does not provide a preview sample.");
      const audio = new Audio(source);
      audioRef.current = audio;
      setPlayingVoiceId(voice?.voiceId ?? null);
      audio.onended = () => { setPlayingVoiceId(null); setPreviewing(false); audioRef.current = null; };
      audio.onerror = () => { setPlayingVoiceId(null); setPreviewing(false); setError("The voice preview could not be played."); audioRef.current = null; };
      await audio.play();
    } catch (reason) {
      setPlayingVoiceId(null);
      setPreviewing(false);
      setError(formatProviderError(reason, { fallback: "Preview failed" }));
    }
  }, [draft.id, onPreview, playingVoiceId, selectedVoiceId]);

  const providerIssueMessages = [...new Set(Object.values(providerIssues).filter((issue): issue is string => Boolean(issue)))];
  const tuningFields = schema?.fields.filter((field) => field.type === "range" || field.type === "boolean") ?? [];
  const additionalFields = schema?.fields.filter((field) => field !== voiceField && field !== modelField && !tuningFields.includes(field)) ?? [];
  const localVoice = voiceSnapshot(draft.config, selectedVoiceId, draft.name);
  const resolvedVoice = selectedVoice ?? localVoice;
  const availableVoices = resolvedVoice && !voices.some((voice) => voice.voiceId === resolvedVoice.voiceId) ? [resolvedVoice, ...voices] : voices;
  const activeVoice = availableVoices.find((voice) => voice.voiceId === selectedVoiceId) ?? resolvedVoice;
  const currentModel = modelField ? String(draft.config[modelField.key] ?? modelField.defaultValue) : "";
  const selectedModel = modelField?.options?.find((option) => option.value === currentModel);
  const visibleTuningFields = tuningFields.filter((field) => !selectedModel?.disabledFieldKeys?.includes(field.key));
  const draftSignature = profileSignature(draft, schema);
  const hasChanges = !draft.id || !selected || draftSignature !== profileSignature(selected, schema);
  const showSaved = savedSignature === draftSignature && !hasChanges;
  const saveDisabled = saving || !providerConnected || !selectedVoiceId || !hasChanges;

  return {
    speakingProviders,
    selectedId,
    selectProfile,
    startCreate,
    draft,
    setName,
    selectProvider,
    patchConfig,
    setLimit,
    provider,
    providerConnected,
    voiceField,
    modelField,
    currentModel,
    selectModel,
    visibleTuningFields,
    additionalFields,
    selectedVoiceId,
    activeVoice,
    selectVoice,
    catalog: {
      voices: availableVoices,
      loading: loadingVoices,
      search: voiceSearch,
      setSearch: setVoiceSearch,
      voiceType,
      setVoiceType,
      hasMore: hasMoreVoices,
      totalCount: totalVoices,
      open: () => setVoicePickerOpened(true),
      loadMore: loadMoreVoices,
    },
    playingVoiceId,
    previewing,
    playAudio,
    error,
    providerIssueMessages,
    saving,
    showSaved,
    saveDisabled,
    saveProfile,
    deleteProfile,
  };
}

export type SpeakingProfileEditor = ReturnType<typeof useSpeakingProfileEditor>;
