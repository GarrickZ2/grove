import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Headphones, Loader2, Pause, Play, Plus, Save, Search, Trash2, Volume2 } from "lucide-react";
import { useDropdown } from "../../hooks/useDropdown";
import { formatProviderError } from "../../utils/providerErrors";
import { Button } from "../ui/Button";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { Switch } from "../ui/Switch";
import { VoiceIdentityIcon } from "./components/VoiceIdentityIcon";
import type {
  ProviderProfile,
  SpeakingProfile,
  SpeakingProfileConfig,
  SpeakingProviderField,
  SpeakingProviderSchema,
  SpeakingVoice,
  SpeakingVoicePage,
  SpeakingVoiceQuery,
} from "./types";

type ProfileDraft = Omit<SpeakingProfile, "id"> & { id?: string };

const inputClass = "h-12 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-highlight)] focus:ring-2 focus:ring-[var(--color-highlight)]/10";
const comboboxClass = "h-12 rounded-xl px-3.5 py-0";
const toolbarComboboxClass = "h-10 rounded-xl bg-[var(--color-bg)] px-3 py-0 shadow-sm";
const voiceTypeFilters = [
  { value: "all", label: "All voices" },
  { value: "personal", label: "Personal" },
  { value: "saved", label: "Saved" },
  { value: "default", label: "Default" },
  { value: "workspace", label: "Workspace" },
] as const;
type VoiceTypeFilter = (typeof voiceTypeFilters)[number]["value"];

function voiceSnapshot(config: SpeakingProfileConfig, voiceId: string, fallbackName: string): SpeakingVoice | null {
  if (!voiceId) return null;
  const value = (key: string) => typeof config[key] === "string" && config[key] ? String(config[key]) : undefined;
  return {
    voiceId,
    name: value("voiceName") ?? (fallbackName === "New Speaking Profile" ? "Selected voice" : fallbackName),
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

function configWithVoiceSnapshot(config: SpeakingProfileConfig, fieldKey: string, voice: SpeakingVoice): SpeakingProfileConfig {
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
  return { name: "New Speaking Profile", providerId, config: {}, maxCharacters: 280, maxDurationSeconds: 30 };
}

function isMissingRequiredValue(value: SpeakingProfileConfig[string] | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function profileSignature(profile: ProfileDraft | SpeakingProfile, schema: SpeakingProviderSchema | null): string {
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

export function AgentVoicePanel({ profiles, providers, loadError, onRetryLoad, onCreate, onUpdate, onDelete, onListVoices, onGetProviderSchema, onPreview }: {
  profiles: SpeakingProfile[];
  providers: ProviderProfile[];
  loadError?: string | null;
  onRetryLoad?: () => void;
  onCreate: (profile: Omit<SpeakingProfile, "id">) => Promise<SpeakingProfile>;
  onUpdate: (id: string, profile: Omit<SpeakingProfile, "id">) => Promise<SpeakingProfile>;
  onDelete: (id: string) => Promise<void>;
  onListVoices: (providerId: string, query?: SpeakingVoiceQuery) => Promise<SpeakingVoicePage>;
  onGetProviderSchema: (providerId: string) => Promise<SpeakingProviderSchema>;
  onPreview: (id: string, text: string) => Promise<{ mimeType: string; audioBase64: string }>;
}) {
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
  const patchConfig = (key: string, value: string | number | boolean) => setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));

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
  const voiceField = schema?.fields.find((field) => field.type === "voice");
  const modelField = schema?.fields.find((field) => field.type === "select");
  const tuningFields = schema?.fields.filter((field) => field.type === "range" || field.type === "boolean") ?? [];
  const additionalFields = schema?.fields.filter((field) => field !== voiceField && field !== modelField && !tuningFields.includes(field)) ?? [];
  const profileOptions: ComboboxOption[] = profiles.map((profile) => ({
    id: profile.id,
    value: profile.id,
    label: profile.name,
    icon: <VoiceIdentityIcon kind="profile" id={profile.id} size="xs" />,
  }));
  const providerOptions: ComboboxOption[] = speakingProviders.map((item) => ({ id: item.id, value: item.id, label: item.name, description: item.status === "verified" ? "Connected" : "Connection required" }));
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm">
      <header className="relative shrink-0 overflow-hidden border-b border-[var(--color-border)] px-5 py-4 [@media(max-height:760px)]:py-3">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_10%,color-mix(in_srgb,var(--color-highlight)_14%,transparent),transparent_34%)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] sm:h-11 sm:w-11"><Volume2 className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-[var(--color-text)] sm:text-lg">Give every Session a distinct voice</h2>
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-muted)]">Choose, tune, and preview the voice used for spoken Agent updates.</p>
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
            <div className="w-56 max-[900px]:hidden"><Combobox options={profileOptions} value={selectedId ?? ""} onChange={selectProfile} placeholder={profiles.length === 0 ? "No saved profiles" : "Select profile"} allowCustom={false} disabled={profiles.length === 0} triggerClassName={toolbarComboboxClass} /></div>
            <div className="flex h-10 items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm">
              <button type="button" onClick={startCreate} className="flex h-full items-center px-3 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-secondary)]"><Plus className="mr-1.5 h-3.5 w-3.5" />New</button>
              <span className="h-5 w-px bg-[var(--color-border)]" />
              <button type="button" onClick={deleteProfile} disabled={!draft.id} title="Delete Speaking Profile" className="flex h-full w-10 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <Button className="h-10 flex-1 rounded-xl px-4 py-0 sm:min-w-[7.5rem] sm:flex-none" variant="primary" size="sm" onClick={saveProfile} disabled={saveDisabled}>{showSaved ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}{saving ? "Saving..." : showSaved ? "Saved" : "Save profile"}</Button>
          </div>
        </div>
      </header>

      {loadError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-error)]/8 text-[var(--color-error)]"><Volume2 className="h-5 w-5" /></div>
            <h3 className="mt-4 text-sm font-semibold text-[var(--color-text)]">Agent Voice is unavailable</h3>
            <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">{loadError}</p>
            {onRetryLoad && <Button className="mt-4" variant="secondary" size="sm" onClick={onRetryLoad}>Retry</Button>}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)] max-[1180px]:grid-cols-1">
          <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 min-[1181px]:overflow-hidden [@media(max-height:760px)]:py-3">
            {error && <InlineMessage>{error}</InlineMessage>}
            {providerIssueMessages.map((issue) => <InlineMessage key={issue}>{issue}</InlineMessage>)}
            <section>
              <SectionHeading title="Profile details" description="Name this setup and choose the Provider account that supplies it." />
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <FieldShell label="Profile name"><input aria-label="Speaking Profile name" className={inputClass} value={draft.name} onChange={(event) => { profileNameTouchedRef.current = true; setDraft((current) => ({ ...current, name: event.target.value })); }} /></FieldShell>
                <FieldShell label="Speaking Provider"><Combobox options={providerOptions} value={draft.providerId} onChange={(value) => { setVoiceSearch(""); setVoiceType("all"); setVoicePickerOpened(false); setSelectedVoice(null); setDraft((current) => ({ ...current, providerId: value, config: {} })); }} placeholder="Select provider" allowCustom={false} triggerClassName={comboboxClass} /></FieldShell>
              </div>
            </section>

            <section className="mt-5 border-t border-[var(--color-border)] pt-5 [@media(max-height:760px)]:mt-3 [@media(max-height:760px)]:pt-3">
              <SectionHeading title="Voice and model" description="Search the Provider account, listen first, then choose the synthesis model." />
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <FieldShell label={voiceField?.label ?? "Voice"}><RichVoicePicker voices={availableVoices} value={selectedVoiceId} disabled={!providerConnected} loading={loadingVoices} search={voiceSearch} onOpen={() => setVoicePickerOpened(true)} onSearchChange={setVoiceSearch} voiceType={voiceType} onVoiceTypeChange={setVoiceType} hasMore={hasMoreVoices} totalCount={totalVoices} playingVoiceId={playingVoiceId} onPreview={playAudio} onLoadMore={loadMoreVoices} onChange={(voice) => { setSelectedVoice(voice); setDraft((current) => ({ ...current, name: profileNameTouchedRef.current ? current.name : voice.name, config: configWithVoiceSnapshot(current.config, voiceField?.key ?? "voiceId", voice) })); }} /></FieldShell>
                <FieldShell label={modelField?.label ?? "Model"}><RichModelPicker options={modelField?.options ?? []} value={currentModel} disabled={!providerConnected || !modelField} onChange={(value) => patchConfig(modelField?.key ?? "modelId", value)} /></FieldShell>
              </div>
              {provider && !providerConnected && <InlineMessage>This Provider must pass its connection test before voices can be loaded.</InlineMessage>}
              {!draft.providerId && <p className="mt-3 text-xs text-[var(--color-text-muted)]">Create or select a Speaking Provider before choosing a voice.</p>}
            </section>

            {visibleTuningFields.length > 0 && <section className="mt-5 flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)] pt-5 [@media(max-height:760px)]:mt-3 [@media(max-height:760px)]:pt-3">
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_12rem] gap-4 max-[760px]:grid-cols-1">
                <div className="flex min-h-0 flex-col">
                  <SectionHeading title="Voice character" description="Tune how the selected voice is delivered." />
                  <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 md:grid-rows-2 [@media(max-height:760px)]:mt-2 [@media(max-height:760px)]:gap-2">{visibleTuningFields.map((field) => <div key={field.key} className={`min-h-0 ${field.type === "boolean" ? "sm:col-span-2" : ""}`}><ProviderControl field={field} value={draft.config[field.key]} onChange={(value) => patchConfig(field.key, value)} /></div>)}</div>
                </div>
                <div className="flex min-h-0 flex-col border-l border-[var(--color-border)] pl-4 max-[760px]:border-l-0 max-[760px]:border-t max-[760px]:pl-0 max-[760px]:pt-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--color-text)]">Spoken limits</h3>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)] [@media(max-height:760px)]:hidden">Full reply in Chat.</p>
                  </div>
                  <div className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-2.5 md:grid-cols-1 md:grid-rows-2 [@media(max-height:760px)]:mt-2 [@media(max-height:760px)]:grid-cols-2 [@media(max-height:760px)]:grid-rows-1"><NumberField label="Characters" value={draft.maxCharacters} min={40} max={2000} step={10} onChange={(value) => setDraft((current) => ({ ...current, maxCharacters: value }))} /><NumberField label="Duration" value={draft.maxDurationSeconds} min={5} max={300} suffix="sec" onChange={(value) => setDraft((current) => ({ ...current, maxDurationSeconds: value }))} /></div>
                </div>
              </div>
            </section>}
            {additionalFields.length > 0 && <section className="mt-5 border-t border-[var(--color-border)] pt-5"><div className="grid gap-4 md:grid-cols-2">{additionalFields.map((field) => <ProviderControl key={field.key} field={field} value={draft.config[field.key]} onChange={(value) => patchConfig(field.key, value)} />)}</div></section>}
          </div>

          <aside className="flex min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-secondary)]/45 p-5 max-[1180px]:hidden [@media(max-height:760px)]:p-4">
            <VoicePreview voice={activeVoice} playing={Boolean(activeVoice && playingVoiceId === activeVoice.voiceId)} previewing={previewing} onPreview={() => void playAudio(activeVoice)} />
          </aside>
        </div>
      )}
    </div>
  );
}

function RichVoicePicker({ voices, value, disabled, loading, search, onOpen, onSearchChange, voiceType, onVoiceTypeChange, hasMore, totalCount, playingVoiceId, onPreview, onLoadMore, onChange }: {
  voices: SpeakingVoice[]; value: string; disabled: boolean; loading: boolean; search: string; onOpen: () => void; onSearchChange: (value: string) => void; voiceType: VoiceTypeFilter; onVoiceTypeChange: (value: VoiceTypeFilter) => void; hasMore: boolean; totalCount?: number; playingVoiceId: string | null; onPreview: (voice: SpeakingVoice) => void; onLoadMore: () => void; onChange: (voice: SpeakingVoice) => void;
}) {
  const { containerRef, dropdownRef, isOpen, position, setIsOpen, triggerRef } = useDropdown();
  const selected = voices.find((voice) => voice.voiceId === value);
  const groupedVoices = useMemo(() => {
    const order = ["Personal", "Saved", "Professional", "Default", "Workspace", "Other"];
    const groups = new Map<string, SpeakingVoice[]>();
    for (const voice of voices) {
      const raw = voice.source || (voice.category === "professional" ? "Professional" : "Other");
      const group = raw === "Workspace" && voice.category === "professional" ? "Professional" : raw;
      groups.set(group, [...(groups.get(group) ?? []), voice]);
    }
    return [...groups.entries()].sort(([a], [b]) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
  }, [voices]);
  const dropdownWidth = typeof window === "undefined" || !position ? 640 : Math.min(Math.max(position.width, 640), window.innerWidth - 32);
  const dropdownLeft = typeof window === "undefined" || !position ? 16 : Math.max(16, Math.min(position.left, window.innerWidth - dropdownWidth - 16));
  const triggerTop = position ? position.top - 62 : 0;
  const spaceBelow = typeof window === "undefined" || !position ? 520 : window.innerHeight - position.top - 12;
  const spaceAbove = position ? triggerTop - 12 : 0;
  const placeAbove = Boolean(position && spaceBelow < 360 && spaceAbove > spaceBelow);
  const dropdownHeight = typeof window === "undefined" ? 520 : Math.min(520, Math.max(280, placeAbove ? spaceAbove : spaceBelow));
  const dropdownTop = position ? (placeAbove ? Math.max(12, triggerTop - dropdownHeight - 6) : position.top) : 12;

  return <div ref={containerRef}>
    <button ref={triggerRef} type="button" disabled={disabled} onClick={() => { if (!isOpen) onOpen(); setIsOpen((open) => !open); }} className={`flex h-14 w-full items-center gap-3 rounded-xl border px-3 text-left transition-colors ${disabled ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-60" : isOpen ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5 ring-2 ring-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-text-muted)]"}`}>
      {selected ? <VoiceAvatar voice={selected} size="md" /> : <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"><Volume2 className="h-4 w-4" /></div>}
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--color-text)]">{selected?.name ?? (disabled ? "Connect Provider to browse voices" : "Choose a voice")}</div>{selected && <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{voiceMeta(selected).join(" · ") || "Voice details unavailable"}</div>}</div>
      <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
    </button>
    {isOpen && position && createPortal(<div ref={dropdownRef} role="dialog" aria-label="Choose a voice" style={{ position: "fixed", top: dropdownTop, left: dropdownLeft, width: dropdownWidth, height: dropdownHeight, zIndex: 9999 }} className="isolate flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
      <div className="relative z-20 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        <div className="flex h-11 items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 focus-within:border-[var(--color-highlight)]"><Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><input autoFocus value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search name, language, accent, or use case..." className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]" />{loading && <Loader2 className="h-4 w-4 animate-spin text-[var(--color-highlight)]" />}</div>
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">{voiceTypeFilters.map((filter) => <button key={filter.value} type="button" onClick={() => onVoiceTypeChange(filter.value)} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${voiceType === filter.value ? "bg-[var(--color-text)] text-[var(--color-bg)]" : "bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{filter.label}</button>)}</div>
      </div>
      <div className="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
        {!loading && voices.length === 0 && <div className="px-5 py-10 text-center"><Headphones className="mx-auto h-6 w-6 text-[var(--color-text-muted)]" /><div className="mt-2 text-sm font-medium text-[var(--color-text)]">No voices found</div><div className="mt-1 text-xs text-[var(--color-text-muted)]">Try another search or voice group.</div></div>}
        {groupedVoices.map(([group, items]) => <div key={group}><div className="sticky top-0 z-10 border-b border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[var(--color-bg)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{group}</div>{items.map((voice) => {
          const isSelected = voice.voiceId === value;
          const isPlaying = voice.voiceId === playingVoiceId;
          const meta = voiceMeta(voice);
          return <button key={voice.voiceId} type="button" onClick={() => { onChange(voice); setIsOpen(false); }} className={`group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${isSelected ? "bg-[var(--color-highlight)]/8" : "hover:bg-[var(--color-bg-secondary)]"}`}>
            <span role="button" aria-label={isPlaying ? `Pause ${voice.name}` : `Preview ${voice.name}`} aria-disabled={!voice.previewUrl && !isSelected} onClick={(event) => { event.stopPropagation(); if (voice.previewUrl || isSelected) onPreview(voice); }} className={`relative shrink-0 rounded-full ${!voice.previewUrl && !isSelected ? "cursor-not-allowed opacity-45" : ""}`}><VoiceAvatar voice={voice} size="sm" /><span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100">{isPlaying ? <Pause className="h-3 w-3 fill-current" /> : <Play className="ml-0.5 h-3 w-3 fill-current" />}</span></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--color-text)]">{voice.name}</span><span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{voice.description || meta.join(" · ") || "No description provided"}</span></span>
            <span className="hidden max-w-[42%] shrink-0 items-center justify-end gap-1.5 sm:flex">{meta.slice(0, 2).map((item) => <MetaPill key={item}>{item}</MetaPill>)}{meta.length > 2 && <MetaPill>+{meta.length - 2} more</MetaPill>}</span>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">{isSelected && <Check className="h-4 w-4 text-[var(--color-highlight)]" />}</span>
          </button>;
        })}</div>)}
      </div>
      <div className="relative z-20 flex shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5"><span className="text-[11px] text-[var(--color-text-muted)]">{totalCount === undefined ? `${voices.length} available` : `${totalCount} available voices`}</span>{hasMore && <Button variant="secondary" size="sm" onClick={onLoadMore} disabled={loading}>{loading ? "Loading" : "Find more voices"}</Button>}</div>
    </div>, document.body)}
  </div>;
}

function RichModelPicker({ options, value, disabled, onChange }: { options: NonNullable<SpeakingProviderField["options"]>; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { containerRef, dropdownRef, isOpen, position, setIsOpen, triggerRef } = useDropdown();
  const selected = options.find((option) => option.value === value);
  const dropdownWidth = typeof window === "undefined" || !position ? 560 : Math.min(Math.max(position.width, 560), window.innerWidth - 32);
  const dropdownLeft = typeof window === "undefined" || !position ? 16 : Math.max(16, Math.min(position.left, window.innerWidth - dropdownWidth - 16));
  const triggerTop = position ? position.top - 62 : 0;
  const desiredHeight = Math.min(420, options.length * 108 + 16);
  const spaceBelow = typeof window === "undefined" || !position ? desiredHeight : window.innerHeight - position.top - 12;
  const spaceAbove = position ? triggerTop - 12 : 0;
  const placeAbove = Boolean(position && spaceBelow < Math.min(240, desiredHeight) && spaceAbove > spaceBelow);
  const dropdownMaxHeight = typeof window === "undefined" ? desiredHeight : Math.min(desiredHeight, Math.max(180, placeAbove ? spaceAbove : spaceBelow));
  const dropdownTop = position ? (placeAbove ? Math.max(12, triggerTop - dropdownMaxHeight - 6) : position.top) : 12;
  return <div ref={containerRef}>
    <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setIsOpen((open) => !open)} className={`flex h-14 w-full items-center justify-between gap-3 rounded-xl border px-3.5 text-left transition-colors ${disabled ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-60" : isOpen ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5 ring-2 ring-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-text-muted)]"}`}>
      <span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold text-[var(--color-text)]">{selected?.label ?? "Choose a model"}</span>{selected?.badge && <MetaPill>{selected.badge}</MetaPill>}</span>{selected?.description && <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">{selected.description}</span>}</span><ChevronDown className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
    </button>
    {isOpen && position && createPortal(<div ref={dropdownRef} role="dialog" aria-label="Choose a model" style={{ position: "fixed", top: dropdownTop, left: dropdownLeft, width: dropdownWidth, maxHeight: dropdownMaxHeight, zIndex: 9999 }} className="overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 shadow-[0_24px_70px_rgba(15,23,42,0.22)]">{options.map((option) => {
      const isSelected = option.value === value;
      return <button key={option.value} type="button" onClick={() => { onChange(option.value); setIsOpen(false); }} className={`mb-1 flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-3.5 text-left transition-colors last:mb-0 ${isSelected ? "border-[var(--color-highlight)]/35 bg-[var(--color-highlight)]/7" : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"}`}><span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-[var(--color-text)]">{option.label}</span>{option.badge && <MetaPill>{option.badge}</MetaPill>}</span>{option.description && <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">{option.description}</span>}{option.metadata && option.metadata.length > 0 && <span className="mt-2 flex flex-wrap gap-1.5">{option.metadata.slice(0, 3).map((item) => <MetaPill key={item}>{item}</MetaPill>)}{option.metadata.length > 3 && <MetaPill>+{option.metadata.length - 3} more</MetaPill>}</span>}</span><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)]">{isSelected && <Check className="h-3.5 w-3.5 text-[var(--color-highlight)]" />}</span></button>;
    })}</div>, document.body)}
  </div>;
}

function VoicePreview({ voice, playing, previewing, onPreview }: { voice: SpeakingVoice | null; playing: boolean; previewing: boolean; onPreview: () => void }) {
  const meta = voice ? voiceMeta(voice) : [];
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
    <div className="relative">{voice ? <VoiceAvatar voice={voice} size="xl" /> : <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ring-8 ring-[var(--color-bg)]"><Headphones className="h-8 w-8" /></div>}{voice && <button type="button" onClick={onPreview} disabled={previewing && !playing} aria-label={playing ? "Pause voice preview" : "Play voice preview"} className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-text)] text-[var(--color-bg)] shadow-lg transition-transform hover:scale-105 disabled:opacity-60">{playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />}</button>}</div>
    <h3 className="mt-5 max-w-full truncate text-lg font-semibold text-[var(--color-text)] [@media(max-height:760px)]:mt-3 [@media(max-height:760px)]:text-base">{voice?.name ?? "Choose a voice"}</h3>
    <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--color-text-muted)] [@media(max-height:760px)]:line-clamp-2 [@media(max-height:760px)]:leading-4">{voice?.description ?? "Open the Voice picker to search and preview voices available to this Provider account."}</p>
    {meta.length > 0 && <div className="mt-3 flex max-w-full flex-wrap justify-center gap-1.5 [@media(max-height:760px)]:mt-2 [@media(max-height:760px)]:flex-nowrap [@media(max-height:760px)]:overflow-hidden">{meta.map((item) => <MetaPill key={item}>{item}</MetaPill>)}</div>}
  </div>;
}

function ProviderControl({ field, value, onChange }: { field: SpeakingProviderField; value: SpeakingProfileConfig[string] | undefined; onChange: (value: string | number | boolean) => void }) {
  const current = value ?? field.defaultValue;
  if (field.type === "boolean") return <div className="flex h-full min-w-0 items-center justify-between gap-4 overflow-hidden rounded-xl border border-[var(--color-border)] px-3.5 py-2.5"><span className="min-w-0"><span className="block text-xs font-semibold text-[var(--color-text)]">{field.label}</span>{field.description && <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">{field.description}</span>}</span><Switch checked={Boolean(current)} onChange={onChange} label={`Toggle ${field.label}`} /></div>;
  if (field.type === "range") {
    const number = Number(current);
    const decimals = field.step && field.step < 0.1 ? 2 : 1;
    return <div className="flex h-full flex-col justify-center rounded-xl border border-[var(--color-border)] px-3.5 py-1.5" title={field.description}><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-[var(--color-text)]">{field.label}</span><span className="text-xs tabular-nums text-[var(--color-text-muted)]">{number.toFixed(decimals)}</span></div><input type="range" className="mt-1.5 w-full accent-[var(--color-highlight)] [@media(max-height:760px)]:mt-1" value={number} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(Number(event.target.value))} /></div>;
  }
  return <FieldShell label={field.label} description={field.description}><input type={field.type === "number" ? "number" : "text"} className={inputClass} value={String(current)} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)} /></FieldShell>;
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return <div className="[@media(max-height:760px)]:flex [@media(max-height:760px)]:min-w-0 [@media(max-height:760px)]:items-baseline [@media(max-height:760px)]:gap-2"><h3 className="shrink-0 text-sm font-semibold text-[var(--color-text)]">{title}</h3><p className="mt-0.5 text-xs text-[var(--color-text-muted)] [@media(max-height:760px)]:mt-0 [@media(max-height:760px)]:truncate">{description}</p></div>;
}
function InlineMessage({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex items-center gap-2 rounded-xl border border-[var(--color-error)]/25 bg-[var(--color-error)]/7 px-3.5 py-2.5 text-xs leading-5 text-[var(--color-error)]">{children}</div>;
}
function FieldShell({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="flex min-w-0 items-baseline gap-2"><span className="shrink-0 text-xs font-semibold text-[var(--color-text)]">{label}</span>{description && <span className="truncate text-[10px] text-[var(--color-text-muted)]">{description}</span>}</span><div className="mt-1.5">{children}</div></label>;
}
function NumberField({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5"><span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">{label}</span><span className="mt-1 flex items-center gap-1.5"><input type="number" className="min-w-0 flex-1 bg-transparent text-sm font-semibold tabular-nums text-[var(--color-text)] outline-none" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))} />{suffix && <span className="text-[10px] text-[var(--color-text-muted)]">{suffix}</span>}</span></label>;
}
function MetaPill({ children }: { children: ReactNode }) {
  return <span className="max-w-40 truncate rounded-full bg-[var(--color-bg-secondary)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-muted)]">{children}</span>;
}
function voiceMeta(voice: SpeakingVoice): string[] {
  return [voice.language, voice.accent, voice.useCase, voice.category].filter((item): item is string => Boolean(item)).map((item) => item.replaceAll("_", " "));
}
function VoiceAvatar({ voice, size }: { voice: SpeakingVoice; size: "sm" | "md" | "xl" }) {
  return <VoiceIdentityIcon kind="voice" id={voice.voiceId} size={size} className={size === "xl" ? "ring-8 ring-[var(--color-bg)] [@media(max-height:760px)]:ring-4" : ""} />;
}
