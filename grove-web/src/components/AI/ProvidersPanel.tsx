import { useState } from "react";
import { BadgePlus, Edit3, KeyRound, Pencil, RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Combobox } from "../ui/Combobox";
import { providerPresets } from "./mock";
import { SectionCard } from "./components/Shared";
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

interface ProvidersPanelProps {
  providers: ProviderProfile[];
  onCreate: (data: Omit<ProviderProfile, "id" | "status">) => Promise<ProviderProfile>;
  onUpdate: (id: string, data: Partial<ProviderProfile>) => Promise<ProviderProfile>;
  onDelete: (id: string) => Promise<void>;
  onVerify: (id: string) => Promise<{ status: string; message: string }>;
}

export function ProvidersPanel({ providers, onCreate, onUpdate, onDelete, onVerify }: ProvidersPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<ProviderProfile | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const providerOptions = providerPresets.map((item) => ({
    id: item.id,
    label: item.label,
    value: item.label,
  }));

  const createDraftProfile = (): ProviderProfile => ({
    id: `draft-${Date.now()}`,
    name: "",
    type: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "",
    status: "draft",
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
  };

  const handleFieldChange = (field: keyof ProviderProfile, value: string) => {
    setEditingDraft((current) => {
      if (!current) return current;
      if (field === "type") {
        const nextPreset = providerPresets.find((item) => item.label === value);
        return {
          ...current,
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
      setOperationError(error instanceof Error ? error.message : "Failed to verify provider");
    } else if (result && draftIsTarget) {
      const status = result.status as ProviderStatus;
      setEditingDraft((current) =>
        current ? { ...current, status } : current,
      );
    }
    setVerifyingId(null);
  };

  return (
    <div className="space-y-5">
      <SectionCard
        title="Provider Profiles"
        description="Global provider profiles define where Grove sends requests for Writing and Audio flows."
        icon={KeyRound}
        actions={(
          <Button variant="primary" size="sm" className="gap-2" onClick={handleCreateProfile}>
            <BadgePlus className="h-4 w-4" />
            Create Profile
          </Button>
        )}
      >
        {operationError && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs font-medium text-red-400">
            {operationError}
          </div>
        )}
        {!isCreating && providers.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] py-16">
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
        <div className="grid gap-4 xl:grid-cols-2">
          {(isCreating && editingDraft ? [editingDraft, ...providers] : providers).map((provider) => {
            const isEditing = editingId === provider.id;
            const currentProvider = isEditing && editingDraft ? editingDraft : provider;
            return (
              <div
                key={provider.id}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <Pencil className="h-4 w-4 text-[var(--color-text-muted)]" />
                          <input
                            type="text"
                            value={currentProvider.name}
                            placeholder="Untitled Provider"
                            onChange={(e) => handleFieldChange("name", e.target.value)}
                            className="min-w-[220px] border-none bg-transparent p-0 text-sm font-semibold text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                          />
                        </div>
                      ) : (
                        <h4 className="text-sm font-semibold text-[var(--color-text)]">
                          {provider.name || "Untitled Provider"}
                        </h4>
                      )}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClassName(currentProvider.status)}`}>
                        {statusLabel(currentProvider.status)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>Cancel</Button>
                        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                          {saving ? "Saving..." : "Save"}
                        </Button>
                      </>
                    ) : (
                      <>
                        {currentProvider.status !== "verified" && (
                          <Button
                            variant="secondary" size="sm"
                            onClick={() => handleVerify(provider.id)}
                            disabled={verifyingId === provider.id}
                            className="gap-1.5"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${verifyingId === provider.id ? "animate-spin" : ""}`} />
                            {verifyingId === provider.id ? "Testing..." : "Test"}
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => handleStartEdit(provider)} className="gap-2" disabled={Boolean(editingId)}>
                          <Edit3 className="h-4 w-4" />
                          Edit
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  <Combobox
                    label="Base URL"
                    options={providerOptions}
                    value={currentProvider.type}
                    onChange={(value) => handleFieldChange("type", value)}
                    allowCustom={false}
                    disabled={!isEditing}
                  />
                  <Input
                    label="API Key"
                    value={currentProvider.apiKey}
                    placeholder={isEditing ? "Enter new API key (leave empty to keep current)" : ""}
                    readOnly={!isEditing}
                    onChange={(e) => handleFieldChange("apiKey", e.target.value)}
                  />
                  <Input
                    label="Model"
                    value={currentProvider.model}
                    readOnly={!isEditing}
                    onChange={(e) => handleFieldChange("model", e.target.value)}
                  />
                  {currentProvider.type === "Custom Base URL" && (
                    <Input
                      label="Custom Base URL"
                      value={currentProvider.baseUrl}
                      readOnly={!isEditing}
                      onChange={(e) => handleFieldChange("baseUrl", e.target.value)}
                    />
                  )}
                </div>
                <div className="mt-4 flex items-center justify-end border-t border-[var(--color-border)] pt-4">
                  {isEditing && (
                    <Button variant="danger" size="sm" onClick={() => handleDelete(provider.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </SectionCard>
    </div>
  );
}
