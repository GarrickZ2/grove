import type { ReactNode } from "react";
import { Check, Headphones, Loader2, Pause, Play, Plus, Save, Trash2, Volume2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { Switch } from "../ui/Switch";
import { VoiceIdentityIcon } from "./components/VoiceIdentityIcon";
import { MetaPill, RichModelPicker, RichVoicePicker, VoiceAvatar } from "./components/SpeakingPickers";
import { useSpeakingProfileEditor, voiceMeta } from "./useSpeakingProfileEditor";
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

const inputClass = "h-12 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-highlight)] focus:ring-2 focus:ring-[var(--color-highlight)]/10";
const comboboxClass = "h-12 rounded-xl px-3.5 py-0";
const toolbarComboboxClass = "h-10 rounded-xl bg-[var(--color-bg)] px-3 py-0 shadow-sm";

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
  const {
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
    catalog,
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
  } = useSpeakingProfileEditor({ profiles, providers, loadError, onCreate, onUpdate, onDelete, onListVoices, onGetProviderSchema, onPreview });
  const profileOptions: ComboboxOption[] = profiles.map((profile) => ({
    id: profile.id,
    value: profile.id,
    label: profile.name,
    icon: <VoiceIdentityIcon kind="profile" id={profile.id} size="xs" />,
  }));
  const providerOptions: ComboboxOption[] = speakingProviders.map((item) => ({ id: item.id, value: item.id, label: item.name, description: item.status === "verified" ? "Connected" : "Connection required" }));

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
                <FieldShell label="Profile name"><input aria-label="Speaking Profile name" className={inputClass} value={draft.name} onChange={(event) => setName(event.target.value)} /></FieldShell>
                <FieldShell label="Speaking Provider"><Combobox options={providerOptions} value={draft.providerId} onChange={selectProvider} placeholder="Select provider" allowCustom={false} triggerClassName={comboboxClass} /></FieldShell>
              </div>
            </section>

            <section className="mt-5 border-t border-[var(--color-border)] pt-5 [@media(max-height:760px)]:mt-3 [@media(max-height:760px)]:pt-3">
              <SectionHeading title="Voice and model" description="Search the Provider account, listen first, then choose the synthesis model." />
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <FieldShell label={voiceField?.label ?? "Voice"}><RichVoicePicker voices={catalog.voices} value={selectedVoiceId} disabled={!providerConnected} loading={catalog.loading} search={catalog.search} onOpen={catalog.open} onSearchChange={catalog.setSearch} voiceType={catalog.voiceType} onVoiceTypeChange={catalog.setVoiceType} hasMore={catalog.hasMore} totalCount={catalog.totalCount} playingVoiceId={playingVoiceId} onPreview={playAudio} onLoadMore={catalog.loadMore} onChange={selectVoice} /></FieldShell>
                <FieldShell label={modelField?.label ?? "Model"}><RichModelPicker options={modelField?.options ?? []} value={currentModel} disabled={!providerConnected || !modelField} onChange={selectModel} /></FieldShell>
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
                  <div className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-2.5 md:grid-cols-1 md:grid-rows-2 [@media(max-height:760px)]:mt-2 [@media(max-height:760px)]:grid-cols-2 [@media(max-height:760px)]:grid-rows-1"><NumberField label="Characters" value={draft.maxCharacters} min={40} max={2000} step={10} onChange={(value) => setLimit("maxCharacters", value)} /><NumberField label="Duration" value={draft.maxDurationSeconds} min={5} max={300} suffix="sec" onChange={(value) => setLimit("maxDurationSeconds", value)} /></div>
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
