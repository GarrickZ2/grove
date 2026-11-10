import { useEffect, useState } from "react";
import { Headphones, Loader2, Pause, Play, Plus, Trash2 } from "lucide-react";
import { getSpeakingProviderSchema, listSpeakingVoices, previewSpeakingProfile } from "../../../../api";
import { Combobox, type ComboboxOption } from "../../../../components/ui";
import { VoiceIdentityIcon } from "../../../../components/AI/components/VoiceIdentityIcon";
import { MetaPill, RichModelPicker, RichVoicePicker } from "../../../../components/AI/components/SpeakingPickers";
import { useProviderProfiles, useSpeakingProfiles, type SpeakingProfilesState } from "../../../../components/AI/useAISettingsData";
import { SPOKEN_LIMITS, useSpeakingProfileEditor, voiceMeta } from "../../../../components/AI/useSpeakingProfileEditor";
import type { ProviderProfile, SpeakingProfileConfig, SpeakingProviderField, SpeakingVoice } from "../../../../components/AI/types";
import { Block, Button, DrawnCheck, Group, Row, Toggle } from "../../../ui";
import { LoadingGroup, Notice } from "./VoiceControls";
import "./voice.css";

const PREVIEW_HINT = "Open the voice picker to search and preview voices available to this provider account.";

export function AgentVoicePage() {
  const { providers, loading: providersLoading } = useProviderProfiles();
  const speaking = useSpeakingProfiles();
  if (providersLoading || speaking.loading) return <LoadingGroup label="Loading agent voice settings" />;
  if (speaking.loadError) {
    return (
      <div className="ost-empty">
        <b>Agent voice is unavailable</b>
        <span>{speaking.loadError}</span>
        <Button variant="primary" onClick={() => void speaking.retry()}>Retry</Button>
      </div>
    );
  }
  return <SpeakingProfileSettings speaking={speaking} providers={providers} />;
}

function SpeakingProfileSettings({ speaking, providers }: { speaking: SpeakingProfilesState; providers: ProviderProfile[] }) {
  const editor = useSpeakingProfileEditor({
    profiles: speaking.profiles,
    providers,
    loadError: speaking.loadError,
    onCreate: speaking.create,
    onUpdate: speaking.update,
    onDelete: speaking.remove,
    onListVoices: listSpeakingVoices,
    onGetProviderSchema: getSpeakingProviderSchema,
    onPreview: previewSpeakingProfile,
  });
  const { draft, catalog, providerConnected, activeVoice, playingVoiceId } = editor;
  const profileOptions: ComboboxOption[] = speaking.profiles.map((profile) => ({
    id: profile.id,
    value: profile.id,
    label: profile.name,
    icon: <VoiceIdentityIcon kind="profile" id={profile.id} size="xs" />,
  }));
  const providerOptions: ComboboxOption[] = editor.speakingProviders.map((item) => ({
    id: item.id,
    value: item.id,
    label: item.name,
    description: item.status === "verified" ? "Connected" : "Connection required",
  }));
  const messages = [editor.error, ...editor.providerIssueMessages].filter((message): message is string => Boolean(message));

  return (
    <>
      {messages.map((message) => <Notice key={message} standalone>{message}</Notice>)}

      <Group title="Speaking profiles" anchorId="profiles">
        <Row title="Profile" description={draft.id ? "Editing a saved profile." : "New profile, not saved yet."}>
          <div className="ost-picker">
            <Combobox
              options={profileOptions}
              value={editor.selectedId ?? ""}
              onChange={editor.selectProfile}
              placeholder={speaking.profiles.length === 0 ? "No saved profiles" : "Select profile"}
              allowCustom={false}
              disabled={speaking.profiles.length === 0}
              size="compact"
            />
          </div>
          {draft.id ? (
            <Button variant="ghost" iconOnly className="ost-danger" aria-label="Delete profile" title="Delete profile" onClick={() => void editor.deleteProfile()}>
              <Trash2 />
            </Button>
          ) : null}
          <Button onClick={editor.startCreate}><Plus />New</Button>
        </Row>
        <Row title="Profile name">
          <input
            className="oui-field ost-v-input"
            aria-label="Speaking Profile name"
            value={draft.name}
            onChange={(event) => editor.setName(event.target.value)}
          />
        </Row>
        <Row title="Speaking provider" description="The provider account that supplies voices.">
          <div className="ost-picker">
            <Combobox
              options={providerOptions}
              value={draft.providerId}
              onChange={editor.selectProvider}
              placeholder="Select provider"
              allowCustom={false}
              size="compact"
            />
          </div>
        </Row>
        {editor.provider && !providerConnected ? (
          <Notice tone="warn">This provider must pass its connection test before voices can be loaded.</Notice>
        ) : null}
        {!draft.providerId ? (
          <Notice tone="warn">Create or select a speaking provider in AI providers before choosing a voice.</Notice>
        ) : null}
      </Group>

      <Group title="Voice and model" anchorId="voice">
        <Block>
          <VoicePreview
            voice={activeVoice}
            playing={Boolean(activeVoice && playingVoiceId === activeVoice.voiceId)}
            previewing={editor.previewing}
            onPreview={() => void editor.playAudio(activeVoice)}
          />
        </Block>
        <Row title={editor.voiceField?.label ?? "Voice"} dim={!providerConnected}>
          <div className="ost-v-picker-wide">
            <RichVoicePicker
              voices={catalog.voices}
              value={editor.selectedVoiceId}
              disabled={!providerConnected}
              disabledLabel="Connect a provider first"
              loading={catalog.loading}
              search={catalog.search}
              onOpen={catalog.open}
              onSearchChange={catalog.setSearch}
              voiceType={catalog.voiceType}
              onVoiceTypeChange={catalog.setVoiceType}
              hasMore={catalog.hasMore}
              totalCount={catalog.totalCount}
              playingVoiceId={playingVoiceId}
              onPreview={editor.playAudio}
              onLoadMore={catalog.loadMore}
              onChange={editor.selectVoice}
            />
          </div>
        </Row>
        <Row title={editor.modelField?.label ?? "Model"} dim={!providerConnected || !editor.modelField}>
          <div className="ost-v-picker-wide">
            <RichModelPicker
              options={editor.modelField?.options ?? []}
              value={editor.currentModel}
              disabled={!providerConnected || !editor.modelField}
              onChange={editor.selectModel}
            />
          </div>
        </Row>
      </Group>

      {editor.visibleTuningFields.length > 0 ? (
        <Group title="Voice character" anchorId="character">
          {editor.visibleTuningFields.map((field) => (
            <FieldRow key={field.key} field={field} value={draft.config[field.key]} onChange={(value) => editor.patchConfig(field.key, value)} />
          ))}
        </Group>
      ) : null}

      <Group title="Spoken limits" hint="Longer replies are cut short; the full reply stays in chat." anchorId="limits">
        <Row title="Characters" description="Most characters spoken per update.">
          <LimitInput label="Characters" limit="maxCharacters" value={draft.maxCharacters} onChange={(value) => editor.setLimit("maxCharacters", value)} />
        </Row>
        <Row title="Duration" description="Longest an update may speak.">
          <LimitInput label="Duration in seconds" limit="maxDurationSeconds" unit="sec" value={draft.maxDurationSeconds} onChange={(value) => editor.setLimit("maxDurationSeconds", value)} />
        </Row>
        {editor.additionalFields.map((field) => (
          <FieldRow key={field.key} field={field} value={draft.config[field.key]} onChange={(value) => editor.patchConfig(field.key, value)} />
        ))}
      </Group>

      <SaveBar editor={editor} />
    </>
  );
}

/** Slides in only while there is something to save, then says "Saved" and leaves. */
function SaveBar({ editor }: { editor: ReturnType<typeof useSpeakingProfileEditor> }) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), 1400);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const saved = flash && editor.showSaved;
  const visible = !editor.saveDisabled || editor.saving || saved;
  const save = async () => {
    await editor.saveProfile();
    setFlash(true);
  };
  return (
    <div className={`ost-v-savebar${visible ? " is-on" : ""}`} aria-hidden={!visible}>
      <div className="ost-v-savebar-in">
        <span className="ost-v-savebar-text">{saved ? "Profile saved" : editor.draft.id ? "Unsaved changes" : "New profile"}</span>
        <Button variant="primary" disabled={!visible || editor.saveDisabled} tabIndex={visible ? 0 : -1} onClick={() => void save()}>
          {saved ? <DrawnCheck /> : null}
          {editor.saving ? "Saving…" : saved ? "Saved" : "Save profile"}
        </Button>
      </div>
    </div>
  );
}

function VoicePreview({ voice, playing, previewing, onPreview }: { voice: SpeakingVoice | null; playing: boolean; previewing: boolean; onPreview: () => void }) {
  const meta = voice ? voiceMeta(voice) : [];
  return (
    <div className="ost-v-voice">
      <span className="ost-v-voice-art">
        {voice ? (
          <VoiceIdentityIcon kind="voice" id={voice.voiceId} size="xl" />
        ) : (
          <span className="ost-v-voice-empty"><Headphones /></span>
        )}
        {voice ? (
          <button
            type="button"
            className="ost-v-voice-play"
            onClick={onPreview}
            disabled={previewing && !playing}
            aria-label={playing ? "Pause voice preview" : "Play voice preview"}
          >
            {playing ? <Pause fill="currentColor" /> : previewing ? <Loader2 className="ost-spin" /> : <Play fill="currentColor" />}
          </button>
        ) : null}
      </span>
      <span className="ost-v-voice-copy">
        <b>{voice?.name ?? "Choose a voice"}</b>
        <p>{voice?.description ?? PREVIEW_HINT}</p>
        {meta.length > 0 ? <span className="ost-v-pills">{meta.map((item) => <MetaPill key={item}>{item}</MetaPill>)}</span> : null}
      </span>
    </div>
  );
}

function LimitInput({ label, limit, unit, value, onChange }: {
  label: string;
  limit: keyof typeof SPOKEN_LIMITS;
  unit?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const { min, max, step } = SPOKEN_LIMITS[limit];
  return (
    <span className="ost-v-num">
      <input
        className="oui-field"
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))}
      />
      {unit}
    </span>
  );
}

/** One provider-defined control: range slider, switch, or text / number input. */
function FieldRow({ field, value, onChange }: {
  field: SpeakingProviderField;
  value: SpeakingProfileConfig[string] | undefined;
  onChange: (value: string | number | boolean) => void;
}) {
  const current = value ?? field.defaultValue;
  if (field.type === "boolean") {
    return (
      <Row title={field.label} description={field.description}>
        <Toggle checked={Boolean(current)} onChange={onChange} label={field.label} />
      </Row>
    );
  }
  if (field.type === "range") {
    const number = Number(current);
    const decimals = field.step && field.step < 0.1 ? 2 : 1;
    return (
      <Row title={field.label} description={field.description}>
        <span className="ost-v-range">
          <input
            type="range"
            aria-label={field.label}
            value={number}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <output>{number.toFixed(decimals)}</output>
        </span>
      </Row>
    );
  }
  return (
    <Row title={field.label} description={field.description}>
      <input
        className="oui-field ost-v-input"
        type={field.type === "number" ? "number" : "text"}
        aria-label={field.label}
        value={String(current)}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
    </Row>
  );
}
