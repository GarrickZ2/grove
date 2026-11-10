import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Mic, Pencil, Trash2 } from "lucide-react";
import { useProject } from "../../../../context";
import { textCapableProviders, useAudioSettings, useProviderProfiles } from "../../../../components/AI/useAISettingsData";
import { AUDIO_LIMITS, useAudioSettingsEditor, type AudioSettingsEditor } from "../../../../components/AI/useAudioSettingsEditor";
import type { AudioSettings, ProviderProfile } from "../../../../components/AI/types";
import { Block, Button, Group, Row, SearchField, Segmented, Toggle } from "../../../ui";
import { LanguageChips, LoadingGroup, NumberInput, ProviderSelect, TriggerRecorder } from "./VoiceControls";
import { useVoiceInputTest, waveformHeights } from "./useVoiceInputTest";
import "./voice.css";

const WAVE_BARS = 32;

export function VoiceInputPage() {
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id ?? null;
  const { providers, loading: providersLoading } = useProviderProfiles();
  const audio = useAudioSettings(projectId);
  if (providersLoading || audio.loading) return <LoadingGroup label="Loading voice input settings" />;
  return (
    <VoiceInputSettings
      settings={audio.settings}
      providers={textCapableProviders(providers)}
      onSave={audio.save}
      projectId={projectId}
      projectName={selectedProject?.name ?? null}
    />
  );
}

function VoiceInputSettings({ settings, providers, onSave, projectId, projectName }: {
  settings: AudioSettings;
  providers: ProviderProfile[];
  onSave: (next: AudioSettings) => void;
  projectId: string | null;
  projectName: string | null;
}) {
  const editor = useAudioSettingsEditor(settings, onSave);
  const { audio, patchAudio, toggleTranscription, toggleRevision, recordingTarget, toggleRecordingTarget, clearShortcut, durations } = editor;
  const off = !audio.enabled;
  const reviseOff = off || !audio.reviseEnabled;

  return (
    <>
      <Group title="Try it" anchorId="try">
        <TryIt audio={audio} projectId={projectId} />
      </Group>

      <Group title="Recognition" anchorId="recognition">
        <Row title="Voice input" description="Transcribe speech into the focused text field.">
          <Toggle checked={audio.enabled} onChange={toggleTranscription} label="Voice input" />
        </Row>
        <Row title="Speech provider" description="Transcription runs through this provider’s account." dim={off}>
          <ProviderSelect
            providers={providers}
            value={audio.transcribeProvider}
            onChange={(value) => patchAudio("transcribeProvider", value)}
            disabled={off}
          />
        </Row>
        <Row
          title="Show text"
          description={audio.transcribeMode === "batch" ? "Transcribe once when recording stops." : "Continuously refresh text during recording."}
          dim={off}
        >
          <Segmented
            ariaLabel="Show text"
            value={audio.transcribeMode}
            options={[
              { value: "batch", label: "After I stop" },
              { value: "streaming", label: "While I talk" },
            ]}
            onChange={(mode) => patchAudio("transcribeMode", mode)}
          />
        </Row>
        <LanguageChips
          value={audio.preferredLanguages}
          onToggle={editor.togglePreferredLanguage}
          onAdd={editor.addCustomLanguage}
          dim={off}
        />
      </Group>

      <Group title="Revision" anchorId="revision">
        <Row title="Revise transcript" description="Clean up filler words and match project vocabulary." dim={off}>
          <Toggle checked={audio.enabled && audio.reviseEnabled} onChange={toggleRevision} disabled={off} label="Revise transcript" />
        </Row>
        <Row title="Language model" description="Cleans and normalizes transcripts." dim={reviseOff}>
          <ProviderSelect
            providers={providers}
            value={audio.reviseProvider}
            onChange={(value) => patchAudio("reviseProvider", value)}
            disabled={reviseOff}
          />
        </Row>
        <RevisionInstruction editor={editor} dim={reviseOff} projectName={projectName} />
      </Group>

      <VocabularyGroup editor={editor} dim={reviseOff} />

      <Group title="Shortcuts" anchorId="shortcuts">
        <Row title="Push to talk" description="Hold a key while speaking, then release." dim={off}>
          <TriggerRecorder
            target="ptt"
            label="push-to-talk key"
            value={audio.pushToTalkKey}
            recording={recordingTarget === "ptt"}
            onToggleRecording={() => toggleRecordingTarget("ptt")}
            onClear={() => clearShortcut("ptt")}
          />
        </Row>
        <Row title="Toggle recording" description="Press once to start and again to stop." dim={off}>
          <TriggerRecorder
            target="toggle"
            label="toggle recording shortcut"
            value={audio.toggleShortcut}
            recording={recordingTarget === "toggle"}
            onToggleRecording={() => toggleRecordingTarget("toggle")}
            onClear={() => clearShortcut("toggle")}
          />
        </Row>
      </Group>

      <Group title="Guardrails" anchorId="guardrails">
        <Row title="Ignore recordings shorter than" description="Avoids accidental taps." dim={off}>
          <NumberInput
            label="Minimum recording length in seconds"
            unit="sec"
            {...AUDIO_LIMITS.minDuration}
            value={durations.minDuration.draft}
            onChange={durations.minDuration.setDraft}
            onCommit={durations.minDuration.commit}
          />
        </Row>
        <Row title="Stop after" description="Ends runaway recordings." dim={off}>
          <NumberInput
            label="Maximum recording length in seconds"
            unit="sec"
            {...AUDIO_LIMITS.maxDuration}
            value={durations.maxDuration.draft}
            onChange={durations.maxDuration.setDraft}
            onCommit={durations.maxDuration.commit}
          />
        </Row>
        <Row title="Push-to-talk delay" description="How long the key must be held before recording starts." dim={off}>
          <NumberInput
            label="Push-to-talk delay in milliseconds"
            unit="ms"
            {...AUDIO_LIMITS.pttActivationDelayMs}
            value={durations.pttActivationDelayMs.draft}
            onChange={durations.pttActivationDelayMs.setDraft}
            onCommit={durations.pttActivationDelayMs.commit}
          />
        </Row>
      </Group>
    </>
  );
}

function TryIt({ audio, projectId }: { audio: AudioSettings; projectId: string | null }) {
  const test = useVoiceInputTest({
    projectId,
    mode: audio.transcribeMode,
    minDuration: audio.minDuration,
    maxDuration: audio.maxDuration,
  });
  const ready = audio.enabled && Boolean(audio.transcribeProvider);
  const listening = test.phase === "listening";
  const heights = waveformHeights(test.frequencyData, WAVE_BARS);
  const holdKey = (event: ReactKeyboardEvent, down: boolean) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (down && !event.repeat) test.start();
    if (!down) void test.stop();
  };

  let transcript;
  if (!ready) {
    transcript = <p className="ost-v-hint">{audio.enabled ? "Choose a speech provider below to try voice input." : "Turn on voice input below to try it."}</p>;
  } else if (listening) {
    transcript = <p><span className="ost-v-raw">{test.liveText || "Listening…"}</span><span className="ost-v-caret" /></p>;
  } else if (test.phase === "processing") {
    transcript = <p className="ost-v-hint">Transcribing…</p>;
  } else if (test.error) {
    transcript = <p role="alert" className="ost-error">{test.error}</p>;
  } else if (test.result) {
    transcript = test.result.revised ? (
      <p>
        <span className="ost-v-raw"><s>{test.result.raw}</s></span>
        <span className="ost-v-clean">{test.result.revised}</span>
      </p>
    ) : (
      <p><span className="ost-v-clean">{test.result.raw || "Nothing was recognized."}</span></p>
    );
  } else {
    transcript = (
      <p className="ost-v-hint">
        {test.notice ?? `Hold the button and say something.${audio.reviseEnabled ? " With Revise on, you’ll see the raw text and the cleaned-up version." : ""}`}
      </p>
    );
  }

  return (
    <Block>
      <div className="ost-v-try">
        <button
          type="button"
          className={`ost-v-mic${listening ? " is-on" : ""}`}
          aria-label="Hold to talk"
          aria-pressed={listening}
          disabled={!ready || test.phase === "processing"}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            test.start();
          }}
          onPointerUp={() => void test.stop()}
          onPointerCancel={() => void test.stop()}
          onKeyDown={(event) => holdKey(event, true)}
          onKeyUp={(event) => holdKey(event, false)}
        >
          <Mic />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className={`ost-v-wave${listening ? " is-on" : ""}`} aria-hidden="true">
            {heights.map((height, index) => <i key={index} style={{ height }} />)}
          </div>
          <div className="ost-v-transcript" aria-live="polite">{transcript}</div>
        </div>
      </div>
    </Block>
  );
}

function RevisionInstruction({ editor, dim, projectName }: { editor: AudioSettingsEditor; dim: boolean; projectName: string | null }) {
  const { prompt, promptEditorRef } = editor;
  return (
    <Block dim={dim}>
      <div className="ost-v-blockhead">
        <span className="oui-row-copy">
          <span className="oui-row-title">Instruction</span>
          <span className="oui-row-desc">Set a shared default, or override it for {projectName ?? "this project"}.</span>
        </span>
        <Segmented
          ariaLabel="Instruction scope"
          value={prompt.scope}
          options={[
            { value: "global", label: "Global default" },
            { value: "project", label: "This project" },
          ]}
          onChange={prompt.setScope}
        />
        {prompt.isEditing ? (
          <>
            <Button variant="ghost" onClick={prompt.cancelEdit}>Cancel</Button>
            <Button variant="primary" onClick={prompt.saveEdit}>Save</Button>
          </>
        ) : (
          <Button onClick={prompt.startEdit}><Pencil />Edit</Button>
        )}
      </div>
      <textarea
        ref={promptEditorRef}
        className="oui-field ost-v-textarea"
        aria-label={prompt.scope === "global" ? "Global revision instruction" : "Project revision instruction"}
        value={prompt.isEditing ? prompt.draft : prompt.saved}
        onChange={(event) => prompt.setDraft(event.target.value)}
        placeholder={`No ${prompt.scope} instruction configured.`}
        readOnly={!prompt.isEditing}
      />
    </Block>
  );
}

function VocabularyGroup({ editor, dim }: { editor: AudioSettingsEditor; dim: boolean }) {
  const { vocabulary } = editor;
  const replacing = vocabulary.tab === "replacement";
  const submitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && vocabulary.canAdd) vocabulary.add();
  };
  return (
    <Group title="Vocabulary" anchorId="vocabulary">
      <Block dim={dim}>
        <div className="ost-v-toolbar">
          <Segmented
            ariaLabel="Vocabulary list"
            value={vocabulary.tab}
            options={[
              { value: "preferred", label: "Preferred" },
              { value: "forbidden", label: "Forbidden" },
              { value: "replacement", label: "Replacements" },
            ]}
            onChange={vocabulary.setTab}
          />
          <Segmented
            ariaLabel="Vocabulary scope"
            value={vocabulary.scope}
            options={[
              { value: "global", label: "Global" },
              { value: "project", label: "Project" },
            ]}
            onChange={vocabulary.setScope}
          />
          <SearchField className="ost-search" label="Search vocabulary" value={vocabulary.query} onChange={vocabulary.setQuery} />
        </div>
      </Block>
      <div className={`ost-addrow${dim ? " ost-v-dim" : ""}`}>
        {replacing ? (
          <>
            <input
              className="oui-field"
              type="text"
              aria-label="Replace this"
              placeholder="Replace this"
              value={vocabulary.draftReplacementFrom}
              onChange={(event) => vocabulary.setDraftReplacementFrom(event.target.value)}
              onKeyDown={submitOnEnter}
            />
            <input
              className="oui-field"
              type="text"
              aria-label="With this"
              placeholder="With this"
              value={vocabulary.draftReplacementTo}
              onChange={(event) => vocabulary.setDraftReplacementTo(event.target.value)}
              onKeyDown={submitOnEnter}
            />
          </>
        ) : (
          <input
            className="oui-field"
            type="text"
            aria-label={vocabulary.tab === "preferred" ? "Term to preserve" : "Term to block"}
            placeholder={vocabulary.tab === "preferred" ? "Add a term to preserve" : "Add a term to block"}
            value={vocabulary.draftTerm}
            onChange={(event) => vocabulary.setDraftTerm(event.target.value)}
            onKeyDown={submitOnEnter}
          />
        )}
        <Button onClick={vocabulary.add} disabled={!vocabulary.canAdd}>Add</Button>
      </div>
      <div className="ost-v-scroll">
        {vocabulary.rows.length === 0 ? (
          <Row
            dim={dim}
            title={`No ${vocabulary.scope} ${replacing ? "replacement rules" : "terms"} yet`}
            description={replacing ? "Replacements rewrite what was heard before it lands." : vocabulary.tab === "preferred" ? "Preferred terms keep their exact spelling." : "Forbidden terms get rewritten or removed."}
          />
        ) : vocabulary.rows.map((row) => (
          <Row
            key={row.id}
            dim={dim}
            title={replacing ? <>{row.from}<span className="ost-v-arrow" aria-hidden="true">→</span>{row.to}</> : row.from}
          >
            <Button variant="ghost" iconOnly className="ost-danger" aria-label={`Delete ${row.from}`} onClick={() => vocabulary.remove(row)}>
              <Trash2 />
            </Button>
          </Row>
        ))}
      </div>
    </Group>
  );
}
