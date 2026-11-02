import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Combobox } from "../../../../components/ui";
import { useProviderProfiles } from "../../../../components/AI/useAISettingsData";
import {
  CUSTOM_BASE_URL_TYPE,
  modelBelongsToFeatureProfile,
  providerStatusLabel,
  providerTypeOptions,
  useProviderEditor,
  type ProviderEditor,
} from "../../../../components/AI/useProviderEditor";
import type { ProviderProfile } from "../../../../components/AI/types";
import { Block, Button, Group, Lead, Row } from "../../../ui";
import { LoadingGroup, Notice } from "./VoiceControls";
import "./voice.css";

function modelSummary(provider: ProviderProfile) {
  return modelBelongsToFeatureProfile(provider.type) ? "Model per speaking profile" : provider.model || "Default model";
}

export function AIProvidersPage() {
  const profiles = useProviderProfiles();
  const editor = useProviderEditor({
    providers: profiles.providers,
    onCreate: profiles.create,
    onUpdate: profiles.update,
    onDelete: profiles.remove,
    onVerify: profiles.verify,
  });
  if (profiles.loading) return <LoadingGroup label="Loading AI providers" />;
  const empty = !profiles.loadError && !editor.isCreating && profiles.providers.length === 0;

  return (
    <Group
      title="Provider profiles"
      hint="Shared credentials and model defaults used by AI features."
      anchorId="profiles"
      actions={(
        empty ? undefined : (
          <Button onClick={editor.startCreate} disabled={Boolean(editor.editingId)}>
            <Plus />New provider
          </Button>
        )
      )}
    >
      {profiles.loadError ? (
        <Notice action={<Button onClick={() => void profiles.retry()}>Retry</Button>}>
          Existing provider profiles could not be loaded. Current data has not been replaced.
        </Notice>
      ) : null}
      {editor.operationError ? <Notice>{editor.operationError}</Notice> : null}
      {empty ? (
        <Row
          leading={<Lead><KeyRound /></Lead>}
          title="No provider profiles yet"
          description="Connect Grove with OpenAI, Groq, ElevenLabs, or any OpenAI-compatible API."
        >
          <Button variant="primary" onClick={editor.startCreate}>Create profile</Button>
        </Row>
      ) : editor.rows.map((provider) => <ProviderRow key={provider.id} provider={provider} editor={editor} />)}
    </Group>
  );
}

/** Brand marks bundled under /agent-icon/; mono ones follow the theme like agent icons. */
const PROVIDER_LOGOS: Record<string, { file: string; mono: boolean }> = {
  openai: { file: "openai.svg", mono: true },
  openrouter: { file: "openrouter.svg", mono: true },
  groq: { file: "groq.svg", mono: true },
  together: { file: "together-color.svg", mono: false },
  fireworks: { file: "fireworks-color.svg", mono: false },
  elevenlabs: { file: "elevenlabs.svg", mono: true },
};

function ProviderLogo({ type }: { type: string }) {
  // Stored types are display names ("OpenAI", "ElevenLabs").
  const logo = PROVIDER_LOGOS[type.toLowerCase().replace(/[^a-z]/g, "")];
  if (!logo) return <KeyRound />;
  return (
    <img
      className="ost-v-logo"
      src={`/agent-icon/${logo.file}`}
      alt=""
      style={logo.mono ? { filter: "var(--agent-monochrome-icon-filter)" } : undefined}
    />
  );
}

function ProviderRow({ provider, editor }: { provider: ProviderProfile; editor: ProviderEditor }) {
  const editing = editor.editingId === provider.id;
  const current = editing && editor.editingDraft ? editor.editingDraft : provider;
  const verifying = editor.verifyingId === provider.id;
  const verificationError = editor.verificationError?.providerId === provider.id ? editor.verificationError.message : null;

  return (
    <>
      <Row
        leading={<Lead><ProviderLogo type={current.type} /></Lead>}
        title={(
          <>
            <span className="ost-truncate">{provider.name || current.type}</span>
            {current.supportsSpeaking ? <span className="ost-v-badge is-accent">Speaking</span> : null}
          </>
        )}
        description={<>{current.type} · {modelSummary(current)}<br /><span className="ost-v-id">{current.baseUrl}</span></>}
      >
        <span className={`oui-status ost-v-status is-${current.status}`}><i />{providerStatusLabel(current.status)}</span>
        {!editing && current.status !== "verified" ? (
          <Button
            variant="ghost"
            iconOnly
            title="Test connection"
            aria-label={`Test connection for ${provider.name || current.type}`}
            disabled={verifying}
            onClick={() => void editor.verify(provider.id)}
          >
            <RefreshCw className={verifying ? "ost-spin" : undefined} />
          </Button>
        ) : null}
        {!editing ? (
          <Button
            variant="ghost"
            iconOnly
            title="Edit provider"
            aria-label={`Edit ${provider.name || current.type}`}
            disabled={Boolean(editor.editingId)}
            onClick={() => editor.startEdit(provider)}
          >
            <Pencil />
          </Button>
        ) : null}
      </Row>
      {verificationError ? <Notice>{verificationError}</Notice> : null}
      {editing ? <ProviderForm provider={current} editor={editor} /> : null}
    </>
  );
}

function ProviderForm({ provider, editor }: { provider: ProviderProfile; editor: ProviderEditor }) {
  const { changeField, isCreating, saving } = editor;
  return (
    <Block>
      <div className="ost-v-form">
        <label>
          Name
          <input
            className="oui-field"
            value={provider.name}
            placeholder={`${provider.type} Provider`}
            onChange={(event) => changeField("name", event.target.value)}
          />
        </label>
        <div className="ost-v-form-label">
          Provider type
          <Combobox
            options={providerTypeOptions}
            value={provider.type}
            onChange={(value) => changeField("type", value)}
            allowCustom={false}
            size="compact"
          />
        </div>
        <label>
          API key
          <input
            className="oui-field"
            type="password"
            autoComplete="off"
            value={provider.apiKey}
            placeholder={isCreating ? "Paste an API key" : "Leave empty to keep the current key"}
            onChange={(event) => changeField("apiKey", event.target.value)}
          />
        </label>
        {!modelBelongsToFeatureProfile(provider.type) ? (
          <label>
            Model
            <input className="oui-field" value={provider.model} onChange={(event) => changeField("model", event.target.value)} />
          </label>
        ) : null}
        {provider.type === CUSTOM_BASE_URL_TYPE ? (
          <label>
            Base URL
            <input className="oui-field oui-mono" value={provider.baseUrl} onChange={(event) => changeField("baseUrl", event.target.value)} />
          </label>
        ) : null}
      </div>
      <div className="ost-v-form-actions">
        {!isCreating ? (
          <Button variant="ghost" className="ost-danger" onClick={() => void editor.remove(provider.id)}>
            <Trash2 />Delete
          </Button>
        ) : null}
        <span className="ost-v-spacer" />
        <Button onClick={editor.cancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void editor.save()} disabled={saving}>{saving ? "Saving…" : "Save provider"}</Button>
      </div>
    </Block>
  );
}
