import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Mic, Sparkles } from "lucide-react";
import { useProject } from "../../context";
import {
  listProviders,
  createProvider,
  updateProvider as apiUpdateProvider,
  deleteProvider as apiDeleteProvider,
  verifyProvider as apiVerifyProvider,
  getAudioSettings,
  saveAudioGlobal,
  saveAudioProject,
} from "../../api";
import { AudioPanel } from "./AudioPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { tabs } from "./mock";
import type { AudioSettings, ProviderProfile, TabId } from "./types";

const defaultAudio: AudioSettings = {
  enabled: false,
  transcribeProvider: "",
  preferredLanguages: [],
  toggleShortcut: "",
  pushToTalkKey: "",
  maxDuration: 60,
  minDuration: 2,
  reviseEnabled: false,
  reviseProvider: "",
  revisePromptGlobal: "",
  revisePromptProject: "",
  preferredTermsGlobal: [],
  preferredTermsProject: [],
  forbiddenTermsGlobal: [],
  forbiddenTermsProject: [],
  replacementsGlobal: [],
  replacementsProject: [],
};

export function AIPage() {
  const { selectedProject } = useProject();
  const [activeTab, setActiveTab] = useState<TabId>("audio");
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(defaultAudio);
  const [loading, setLoading] = useState(true);

  const projectId = selectedProject?.id ?? null;

  // Load providers + audio on mount and when project changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- loading flag for async fetch

    Promise.all([
      listProviders().catch(() => [] as ProviderProfile[]),
      getAudioSettings(projectId ?? undefined).catch(() => defaultAudio),
    ]).then(([provs, audio]) => {
      if (cancelled) return;
      setProviders(provs);
      setAudioSettings(audio);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [projectId]);

  // ─── Provider operations ───────────────────────────────────────────────

  const handleCreateProvider = useCallback(async (data: Omit<ProviderProfile, "id" | "status">) => {
    const created = await createProvider(data);
    setProviders((prev) => [created, ...prev]);
    return created;
  }, []);

  const handleUpdateProvider = useCallback(async (id: string, data: Partial<ProviderProfile>) => {
    const updated = await apiUpdateProvider(id, data);
    setProviders((prev) => prev.map((p) => (p.id === id ? updated : p)));
    return updated;
  }, []);

  const handleDeleteProvider = useCallback(async (id: string) => {
    await apiDeleteProvider(id);
    setProviders((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleVerifyProvider = useCallback(async (id: string) => {
    const result = await apiVerifyProvider(id);
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: result.status as ProviderProfile["status"] } : p)),
    );
    return result;
  }, []);

  // ─── Audio operations ─────────────────────────────────────────────────

  const handleAudioSaved = useCallback(
    async (next: AudioSettings) => {
      setAudioSettings(next);
      // Save global and project settings in parallel
      const promises: Promise<void>[] = [saveAudioGlobal(next)];
      if (projectId) {
        promises.push(saveAudioProject(projectId, next));
      }
      await Promise.all(promises).catch(console.error);
      // Notify GlobalAudioRecorder to reload settings
      window.dispatchEvent(new Event("grove:audio-settings-changed"));
    },
    [projectId],
  );

  const audioStateLabel = !audioSettings.enabled
    ? "Disabled"
    : audioSettings.reviseEnabled
      ? "Transcribe + Revise"
      : "Transcribe Only";

  return (
    <div className="flex min-h-full lg:h-full flex-col">
      <div className="mb-4 sm:mb-5 rounded-2xl sm:rounded-3xl border border-[var(--color-border)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-highlight)_8%,transparent),transparent_48%,color-mix(in_srgb,var(--color-accent)_10%,transparent))] p-4 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-highlight)]" />
              AI Control Plane
            </div>
            <h1 className="mt-3 sm:mt-4 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--color-text)]">AI Settings</h1>
            <p className="mt-2 sm:mt-3 max-w-xl text-sm leading-6 text-[var(--color-text-muted)]">
              A dedicated space for Grove-native AI features. Providers stay global, while Audio settings can carry project-aware behavior without leaking provider credentials into every feature.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]/80 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Project Context</div>
              <div className="mt-2 text-sm font-medium text-[var(--color-text)]">{selectedProject?.name ?? "No project selected"}</div>
            </div>
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]/80 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Audio State</div>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-emerald-500">
                <Mic className="h-4 w-4" />
                {audioStateLabel}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-[var(--color-border)] pb-3 sm:pb-4 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {isActive && (
                <motion.div
                  layoutId="aiTabIndicator"
                  className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-[var(--color-highlight)]"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="lg:flex-1 lg:overflow-y-auto pt-5">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
            Loading AI settings...
          </div>
        ) : (
          <>
            {activeTab === "providers" && (
              <ProvidersPanel
                providers={providers}
                onCreate={handleCreateProvider}
                onUpdate={handleUpdateProvider}
                onDelete={handleDeleteProvider}
                onVerify={handleVerifyProvider}
              />
            )}
            {activeTab === "audio" && (
              <AudioPanel
                settings={audioSettings}
                providers={providers}
                onSettingsSaved={handleAudioSaved}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
