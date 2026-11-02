import { Combobox } from "../../../../components/ui";
import { textCapableProviders, useProviderProfiles, useVoiceControlSettings } from "../../../../components/AI/useAISettingsData";
import { VOICE_CONTROL_LIMITS, useVoiceControlEditor } from "../../../../components/AI/useVoiceControlEditor";
import type { ProviderProfile, VoiceControlSettings } from "../../../../components/AI/types";
import { Block, Button, Group, Row, SearchField, Toggle } from "../../../ui";
import { LanguageChips, LoadingGroup, NumberInput, ProviderSelect, TriggerRecorder } from "./VoiceControls";
import "./voice.css";

export function VoiceControlPage() {
  const { providers, loading: providersLoading } = useProviderProfiles();
  const voiceControl = useVoiceControlSettings();
  if (providersLoading || voiceControl.loading) return <LoadingGroup label="Loading voice control settings" />;
  return <VoiceControlSettingsView settings={voiceControl.settings} providers={textCapableProviders(providers)} onSave={voiceControl.save} />;
}

const LIMIT_ROWS = [
  { key: "minDuration", title: "Ignore commands shorter than", description: "Skips accidental taps.", label: "Minimum command length in seconds", unit: "sec" },
  { key: "maxDuration", title: "Stop listening after", description: "Ends runaway capture.", label: "Maximum command length in seconds", unit: "sec" },
  { key: "pttActivationDelayMs", title: "Push-to-talk threshold", description: "How long the key must be held before listening starts.", label: "Push-to-talk threshold in milliseconds", unit: "ms" },
] as const;

function VoiceControlSettingsView({ settings, providers, onSave }: {
  settings: VoiceControlSettings;
  providers: ProviderProfile[];
  onSave: (next: VoiceControlSettings) => void;
}) {
  const editor = useVoiceControlEditor(settings, onSave);
  const { settings: current, patchSettings, recordingTarget, toggleRecordingTarget, clearShortcut } = editor;
  const off = !current.enabled;
  const enabledCount = editor.allCommands.filter((command) => editor.isActionEnabled(command.id)).length;
  const categoryOptions = [
    { id: "all", value: "all", label: "All categories" },
    ...editor.categories.map((category) => ({ id: category, value: category, label: category })),
  ];

  return (
    <>
      <Group title="Pipeline" hint="Speech becomes text, then a command." anchorId="pipeline">
        <Row title="Voice control" description="Speak a command, let Grove understand it, then run only the actions you allow.">
          <Toggle checked={current.enabled} onChange={(enabled) => patchSettings("enabled", enabled)} label="Voice control" />
        </Row>
        <Row
          leading={<span className="ost-v-step" aria-hidden="true">1</span>}
          title="Recognize speech"
          description="Speech-to-text provider."
          dim={off}
        >
          <ProviderSelect
            providers={providers}
            value={current.sttProviderId}
            onChange={(value) => patchSettings("sttProviderId", value)}
            disabled={off}
          />
        </Row>
        <Row
          leading={<span className="ost-v-step" aria-hidden="true">2</span>}
          title="Interpret command"
          description="Language model that turns the words into an action."
          dim={off}
        >
          <ProviderSelect
            providers={providers}
            value={current.llmProviderId}
            onChange={(value) => patchSettings("llmProviderId", value)}
            disabled={off}
          />
        </Row>
        <LanguageChips
          value={current.preferredLanguages || []}
          onToggle={editor.togglePreferredLanguage}
          onAdd={editor.addCustomLanguage}
          dim={off}
        />
      </Group>

      <Group title="Shortcuts" anchorId="shortcuts">
        <Row title="Push to talk" description="Hold a key while speaking, then release." dim={off}>
          <TriggerRecorder
            target="ptt"
            label="voice control push-to-talk key"
            value={current.pushToTalkKey}
            recording={recordingTarget === "ptt"}
            onToggleRecording={() => toggleRecordingTarget("ptt")}
            onClear={() => clearShortcut("ptt")}
          />
        </Row>
        <Row title="Toggle listening" description="Press once to start and again to stop." dim={off}>
          <TriggerRecorder
            target="toggle"
            label="toggle listening shortcut"
            value={current.toggleShortcut}
            recording={recordingTarget === "toggle"}
            onToggleRecording={() => toggleRecordingTarget("toggle")}
            onClear={() => clearShortcut("toggle")}
          />
        </Row>
      </Group>

      <Group title="Listening limits" hint="Ignore accidental taps and stop runaway capture." anchorId="limits">
        {LIMIT_ROWS.map((row) => (
          <Row key={row.key} title={row.title} description={row.description} dim={off}>
            <NumberInput
              label={row.label}
              unit={row.unit}
              {...VOICE_CONTROL_LIMITS[row.key]}
              value={editor.drafts[row.key]}
              onChange={(value) => editor.setDraft(row.key, value)}
              onCommit={() => editor.commitDuration(row.key)}
              onReset={() => editor.resetDraft(row.key)}
            />
          </Row>
        ))}
      </Group>

      <Group
        title="Actions"
        hint={`${enabledCount} of ${editor.allCommands.length} allowed`}
        anchorId="actions"
        actions={(
          <>
            <Button variant="ghost" disabled={off} onClick={editor.applyRecommendedActions}>Recommended</Button>
            <Button variant="ghost" disabled={off} onClick={editor.enableAllActions}>Enable all</Button>
            <Button variant="ghost" disabled={off} onClick={editor.disableAllActions}>Disable all</Button>
          </>
        )}
      >
        <Block dim={off}>
          <div className="ost-v-toolbar">
            <SearchField
              className="ost-search"
              label="Search actions"
              placeholder="Search by name, description, or id"
              value={editor.searchQuery}
              onChange={editor.setSearchQuery}
            />
            <div className="ost-picker">
              <Combobox
                options={categoryOptions}
                value={editor.categoryFilter}
                onChange={editor.setCategoryFilter}
                allowCustom={false}
                size="compact"
              />
            </div>
          </div>
        </Block>
        <div className="ost-v-scroll">
          {editor.filteredCommands.length === 0 ? (
            <Row dim={off} title="No matching actions" description="Try another search or category." />
          ) : editor.filteredCommands.map((command) => {
            const allowed = editor.isActionEnabled(command.id);
            return (
              <Row
                key={command.id}
                dim={off}
                title={(
                  <>
                    {command.name}
                    {command.category ? <span className="ost-v-badge">{command.category}</span> : null}
                  </>
                )}
                description={(
                  <>
                    {command.description ? <>{command.description} </> : null}
                    <span className="ost-v-id">{command.id}</span>
                  </>
                )}
              >
                <Toggle checked={allowed} onChange={() => editor.toggleActionEnabled(command.id)} label={`Allow ${command.name}`} />
              </Row>
            );
          })}
        </div>
      </Group>
    </>
  );
}
