import { useState } from "react";
import { BadgePlus, Edit3, KeyRound, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Combobox } from "../ui/Combobox";
import { providerPresets } from "./mock";
import { formatProviderError } from "../../utils/providerErrors";
import type { ProviderProfile, ProviderStatus } from "./types";

function statusLabel(status: ProviderStatus) {
  if (status === "verified") return "Connected";
  if (status === "failed") return "Connect Failed";
  return "Draft";
}

function statusClassName(status: ProviderStatus) {
  if (status === "verified") return "bg-emerald-500/12 text-emerald-500";
  if (status === "failed") return "bg-rose-500/12 text-rose-500";
  return "bg-amber-500/12 text-amber-500";
}

function modelBelongsToFeatureProfile(providerType: string) {
  return providerType.toLowerCase() === "elevenlabs";
}

interface ProvidersPanelProps {
  providers: ProviderProfile[];
  loadError?: string | null;
  onRetryLoad?: () => void;
  onCreate: (data: Omit<ProviderProfile, "id" | "status">) => Promise<ProviderProfile>;
  onUpdate: (id: string, data: Partial<ProviderProfile>) => Promise<ProviderProfile>;
  onDelete: (id: string) => Promise<void>;
  onVerify: (id: string) => Promise<{ status: string; message: string }>;
}

export function ProvidersPanel({ providers, loadError, onRetryLoad, onCreate, onUpdate, onDelete, onVerify }: ProvidersPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<ProviderProfile | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<{ providerId: string; message: string } | null>(null);
  const providerOptions = providerPresets.map((item) => ({
    id: item.id,
    label: item.label,
    value: item.label,
  }));

  const createDraftProfile = (): ProviderProfile => ({
    id: `draft-${Date.now()}`,
    name: "OpenAI",
    type: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "",
    status: "draft",
    supportsSpeaking: false,
  });

  const handleCreateProfile = () => {
    const draft = createDraftProfile();
    setEditingId(draft.id);
    setEditingDraft(draft);
    setIsCreating(true);
  };

  const handleStartEdit = (profile: ProviderProfile) => {
    // When starting edit, clear the apiKey so user enters fresh value
    setEditingId(profile.id);
    setEditingDraft({ ...profile, apiKey: "" });
    setIsCreating(false);
    if (verificationError?.providerId === profile.id) setVerificationError(null);
  };

  const handleFieldChange = (field: keyof ProviderProfile, value: string) => {
    setEditingDraft((current) => {
      if (!current) return current;
      if (field === "type") {
        const nextPreset = providerPresets.find((item) => item.label === value);
        return {
          ...current,
          name: !current.name.trim() || current.name === current.type ? value : current.name,
          type: value,
          baseUrl: nextPreset ? nextPreset.baseUrl : current.baseUrl,
          status: "draft",
        };
      }

      const shouldResetStatus = field === "apiKey" || field === "model" || field === "baseUrl";
      return { ...current, [field]: value, status: shouldResetStatus ? "draft" : current.status };
    });
  };

  const handleSave = async () => {
    if (!editingDraft || saving) return;
    setOperationError(null);
    if (!editingDraft.name.trim() || !editingDraft.baseUrl.trim() || (isCreating && !editingDraft.apiKey.trim())) {
      setOperationError("Provider name, Base URL, and API Key are required.");
      return;
    }
    setSaving(true);
    try {
      if (isCreating) {
        await onCreate({
          name: editingDraft.name,
          type: editingDraft.type,
          baseUrl: editingDraft.baseUrl,
          apiKey: editingDraft.apiKey,
          model: editingDraft.model,
        });
      } else {
        // Only send fields that have values; skip empty apiKey (means no change)
        const patch: Partial<ProviderProfile> = {
          name: editingDraft.name,
          type: editingDraft.type,
          baseUrl: editingDraft.baseUrl,
          model: editingDraft.model,
          status: editingDraft.status,
        };
        if (editingDraft.apiKey) {
          patch.apiKey = editingDraft.apiKey;
        }
        await onUpdate(editingDraft.id, patch);
      }
      setEditingId(null);
      setEditingDraft(null);
      setIsCreating(false);
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : "Failed to save provider");
    }
    setSaving(false);
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditingDraft(null);
    setIsCreating(false);
    setOperationError(null);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this provider profile?")) return;
    setOperationError(null);
    try {
      await onDelete(id);
      if (editingId === id) setEditingId(null);
      setEditingDraft(null);
      setIsCreating(false);
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : "Failed to delete provider");
    }
  };

  const handleVerify = async (providerId: string) => {
    if (verifyingId) return;

    setVerifyingId(providerId);
    setVerificationError(null);
    const draft = editingDraft;
    const draftIsTarget = draft !== null && draft.id === providerId;
    const pendingApiKey = draftIsTarget && draft.apiKey ? draft.apiKey : null;
    let result: { status: string; message: string } | null = null;
    let error: unknown = null;
    try {
      // If editing and there's a new apiKey, save it first
      if (pendingApiKey) {
        await onUpdate(providerId, { apiKey: pendingApiKey });
      }
      result = await onVerify(providerId);
    } catch (e) {
      error = e;
    }
    if (error) {
      setVerificationError({
        providerId,
        message: formatProviderError(error, { fallback: "Failed to verify provider" }),
      });
    } else if (result) {
      if (result.status === "failed") {
        setVerificationError({
          providerId,
          message: formatProviderError({ message: result.message }, { fallback: "Failed to verify provider" }),
        });
      }
      if (draftIsTarget) {
        const status = result.status as ProviderStatus;
        setEditingDraft((current) =>
          current ? { ...current, status } : current,
        );
      }
    }
    setVerifyingId(null);
  };

  const rows = isCreating && editingDraft ? [editingDraft, ...providers] : providers;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0"><h2 className="text-sm font-semibold text-[var(--color-text)]">Provider Profiles</h2><p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">Shared credentials and model defaults used by AI features.</p></div>
        <Button variant="primary" size="sm" className="shrink-0 gap-2" onClick={handleCreateProfile} disabled={Boolean(editingId)}><BadgePlus className="h-4 w-4" /><span className="hidden sm:inline">New Provider</span></Button>
      </div>
      <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm">
        {loadError && (
          <div className="m-3 flex items-center justify-between gap-4 rounded-xl border border-[var(--color-error)]/25 bg-[var(--color-error)]/8 px-4 py-2.5 text-xs text-[var(--color-error)]">
            <span>Existing Provider Profiles could not be loaded. Current data has not been replaced.</span>
            {onRetryLoad && <Button variant="secondary" size="sm" onClick={onRetryLoad}>Retry</Button>}
          </div>
        )}
        {operationError && (
          <div className="m-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs font-medium text-red-400">
            {operationError}
          </div>
        )}
        {!loadError && !isCreating && providers.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-bg-secondary)]">
              <KeyRound className="h-6 w-6 text-[var(--color-text-muted)]" />
            </div>
            <p className="mt-4 text-sm font-medium text-[var(--color-text)]">No provider profiles yet</p>
            <p className="mt-1.5 max-w-xs text-center text-xs leading-5 text-[var(--color-text-muted)]">
              Create a provider profile to connect Grove with OpenAI, Groq, or any OpenAI-compatible API.
            </p>
            <Button variant="primary" size="sm" className="mt-5 gap-2" onClick={handleCreateProfile}>
              <BadgePlus className="h-4 w-4" />
              Create Profile
            </Button>
          </div>
        ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="hidden shrink-0 grid-cols-[minmax(220px,1fr)_160px_minmax(140px,0.7fr)_110px_120px] gap-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] md:grid">
            <span>Provider</span><span>Type</span><span>Model</span><span>Status</span><span />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((provider) => {
            const isEditing = editingId === provider.id;
            const currentProvider = isEditing && editingDraft ? editingDraft : provider;
            return (
              <div key={provider.id} className="border-b border-[var(--color-border)] last:border-b-0">
                <div className="grid min-h-16 grid-cols-2 items-center gap-3 px-4 py-4 md:grid-cols-[minmax(220px,1fr)_160px_minmax(140px,0.7fr)_110px_120px] md:gap-4 md:px-5 md:py-2.5">
                  <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"><KeyRound className="h-4 w-4" /></span>
                    <div className="min-w-0">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <Pencil className="h-4 w-4 text-[var(--color-text-muted)]" />
                          <input
                            type="text"
                            value={currentProvider.name}
                          placeholder={`${currentProvider.type} Provider`}
                            onChange={(e) => handleFieldChange("name", e.target.value)}
                            className="min-w-[220px] border-none bg-transparent p-0 text-sm font-semibold text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                          />
                        </div>
                      ) : (
                        <h4 className="truncate text-sm font-semibold text-[var(--color-text)]">
                          {provider.name || currentProvider.type}
                        </h4>
                      )}
                      <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{currentProvider.baseUrl}</p>
                    </div>
                  </div>
                  <div className="col-span-2 flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-muted)] md:hidden">
                    <span className="shrink-0 text-[var(--color-text)]">{currentProvider.type}</span>
                    {currentProvider.supportsSpeaking && <span className="shrink-0 rounded bg-[var(--color-highlight)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-highlight)]">Speaking</span>}
                    <span className="truncate before:mr-2 before:content-['·']">{modelBelongsToFeatureProfile(currentProvider.type) ? "Per Speaking Profile" : currentProvider.model || "Default"}</span>
                  </div>
                  <div className="hidden items-center gap-2 text-sm text-[var(--color-text)] md:flex">{currentProvider.type}{currentProvider.supportsSpeaking && <span className="rounded bg-[var(--color-highlight)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-highlight)]">Speaking</span>}</div>
                  <span className="hidden truncate text-sm text-[var(--color-text-muted)] md:block">
                    {modelBelongsToFeatureProfile(currentProvider.type)
                      ? "Per Speaking Profile"
                      : currentProvider.model || "Default"}
                  </span>
                  <div className="col-span-2 flex items-center justify-between md:contents">
                  <span className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClassName(currentProvider.status)}`}>{statusLabel(currentProvider.status)}</span>
                  <div className="flex justify-end gap-1 md:col-auto">
                    {!isEditing && currentProvider.status !== "verified" && <button type="button" onClick={() => handleVerify(provider.id)} disabled={verifyingId === provider.id} className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Test connection"><RefreshCw className={`h-3.5 w-3.5 ${verifyingId === provider.id ? "animate-spin" : ""}`} /></button>}
                    {!isEditing && <button type="button" onClick={() => handleStartEdit(provider)} disabled={Boolean(editingId)} className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Edit Provider"><Edit3 className="h-3.5 w-3.5" /></button>}
                  </div>
                  </div>
                </div>
                {verificationError?.providerId === provider.id && (
                  <div className="border-t border-[var(--color-error)]/15 bg-[var(--color-error)]/6 px-5 py-2 text-xs text-[var(--color-error)]">
                    {verificationError.message}
                  </div>
                )}
                {isEditing && <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/25 px-5 py-4">
                  <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                  <Combobox
                    label="Provider type"
                    options={providerOptions}
                    value={currentProvider.type}
                    onChange={(value) => handleFieldChange("type", value)}
                    allowCustom={false}
                    disabled={!isEditing}
                  />
                  <Input
                    label="API Key"
                    type="password"
                    autoComplete="off"
                    value={currentProvider.apiKey}
                    placeholder={isEditing ? "Enter new API key (leave empty to keep current)" : ""}
                    readOnly={!isEditing}
                    onChange={(e) => handleFieldChange("apiKey", e.target.value)}
                  />
                  {!modelBelongsToFeatureProfile(currentProvider.type) && (
                    <Input
                      label="Model"
                      value={currentProvider.model}
                      readOnly={!isEditing}
                      onChange={(e) => handleFieldChange("model", e.target.value)}
                    />
                  )}
                  {currentProvider.type === "Custom Base URL" && (
                    <Input
                      label="Custom Base URL"
                      value={currentProvider.baseUrl}
                      readOnly={!isEditing}
                      onChange={(e) => handleFieldChange("baseUrl", e.target.value)}
                    />
                  )}
                  </div>
                  <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-3">
                    {!isCreating ? <Button variant="danger" size="sm" onClick={() => handleDelete(provider.id)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete</Button> : <span />}
                    <div className="flex gap-2"><Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>Cancel</Button><Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Provider"}</Button></div>
                  </div>
                </div>
                }
              </div>
            );
          })}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
