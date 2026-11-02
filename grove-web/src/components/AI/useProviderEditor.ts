import { useState } from "react";
import { providerPresets } from "./mock";
import { formatProviderError } from "../../utils/providerErrors";
import type { ProviderProfile, ProviderStatus } from "./types";

export function providerStatusLabel(status: ProviderStatus) {
  if (status === "verified") return "Connected";
  if (status === "failed") return "Connect Failed";
  return "Draft";
}

/** ElevenLabs picks its model per Speaking Profile, not per provider. */
export function modelBelongsToFeatureProfile(providerType: string) {
  return providerType.toLowerCase() === "elevenlabs";
}

export const CUSTOM_BASE_URL_TYPE = "Custom Base URL";

export const providerTypeOptions = providerPresets.map((item) => ({
  id: item.id,
  label: item.label,
  value: item.label,
}));

function createDraftProfile(): ProviderProfile {
  return {
    id: `draft-${Date.now()}`,
    name: "OpenAI",
    type: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "",
    status: "draft",
    supportsSpeaking: false,
  };
}

/** Apply one field edit to a provider draft; connection-relevant edits reset its status to draft. */
export function applyProviderField(current: ProviderProfile, field: keyof ProviderProfile, value: string): ProviderProfile {
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
}

export interface ProviderEditorOptions {
  providers: ProviderProfile[];
  onCreate: (data: Omit<ProviderProfile, "id" | "status">) => Promise<ProviderProfile>;
  onUpdate: (id: string, data: Partial<ProviderProfile>) => Promise<ProviderProfile>;
  onDelete: (id: string) => Promise<void>;
  onVerify: (id: string) => Promise<{ status: string; message: string }>;
}

/**
 * Inline create / edit / verify / delete flow for AI provider profiles. Shared
 * by the Workbench ProvidersPanel and Orbit's AI providers page.
 */
export function useProviderEditor({ providers, onCreate, onUpdate, onDelete, onVerify }: ProviderEditorOptions) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<ProviderProfile | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<{ providerId: string; message: string } | null>(null);

  const startCreate = () => {
    const draft = createDraftProfile();
    setEditingId(draft.id);
    setEditingDraft(draft);
    setIsCreating(true);
  };

  const startEdit = (profile: ProviderProfile) => {
    // When starting edit, clear the apiKey so user enters fresh value
    setEditingId(profile.id);
    setEditingDraft({ ...profile, apiKey: "" });
    setIsCreating(false);
    if (verificationError?.providerId === profile.id) setVerificationError(null);
  };

  const changeField = (field: keyof ProviderProfile, value: string) => {
    setEditingDraft((current) => (current ? applyProviderField(current, field, value) : current));
  };

  const save = async () => {
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

  const cancel = () => {
    setEditingId(null);
    setEditingDraft(null);
    setIsCreating(false);
    setOperationError(null);
  };

  const remove = async (id: string) => {
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

  const verify = async (providerId: string) => {
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

  return {
    rows,
    editingId,
    editingDraft,
    isCreating,
    saving,
    verifyingId,
    operationError,
    verificationError,
    startCreate,
    startEdit,
    changeField,
    save,
    cancel,
    remove,
    verify,
  };
}

export type ProviderEditor = ReturnType<typeof useProviderEditor>;
