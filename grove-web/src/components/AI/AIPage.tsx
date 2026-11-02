import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { SlidersHorizontal } from "lucide-react";
import { useProject } from "../../context";
import { listSpeakingVoices, getSpeakingProviderSchema, previewSpeakingProfile } from "../../api";
import { AgentVoicePanel } from "./AgentVoicePanel";
import { AudioPanel } from "./AudioPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { VoiceControlPanel } from "./VoiceControlPanel";
import { tabs } from "./mock";
import {
  textCapableProviders,
  useAudioSettings,
  useProviderProfiles,
  useSpeakingProfiles,
  useVoiceControlSettings,
} from "./useAISettingsData";
import type { TabId } from "./types";

export function AIPage() {
  const { selectedProject } = useProject();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const requestedTab = window.sessionStorage.getItem("grove:ai-settings-tab");
    return tabs.some((tab) => tab.id === requestedTab) ? requestedTab as TabId : "audio";
  });
  const projectId = selectedProject?.id ?? null;
  const providerProfiles = useProviderProfiles();
  const audio = useAudioSettings(projectId);
  const voiceControl = useVoiceControlSettings();
  const speaking = useSpeakingProfiles();
  const loading = providerProfiles.loading || audio.loading || voiceControl.loading || speaking.loading;
  const { remove: removeProvider } = providerProfiles;
  const { forgetProvider } = speaking;

  useEffect(() => {
    window.sessionStorage.removeItem("grove:ai-settings-tab");
  }, []);

  const handleDeleteProvider = useCallback(async (id: string) => {
    await removeProvider(id);
    forgetProvider(id);
  }, [forgetProvider, removeProvider]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden md:overflow-hidden">
      <header className="shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-start justify-between gap-3 pb-4 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] sm:h-11 sm:w-11">
              <SlidersHorizontal className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--color-text)] sm:text-2xl">AI Settings</h1>
              <p className="mt-1 truncate text-sm text-[var(--color-text-muted)]"><span className="sm:hidden">Configure AI and voice.</span><span className="hidden sm:inline">Configure AI input, control, providers, and Agent Voice{selectedProject ? ` for ${selectedProject.name}` : ""}.</span></p>
            </div>
          </div>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {isActive && (
                <motion.div
                  layoutId="aiTabIndicator"
                  className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--color-highlight)]"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
            </button>
          );
        })}
        </nav>
      </header>

      <div className="min-h-0 flex-none overflow-visible pt-4 md:flex-1 md:overflow-hidden md:pt-5">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
            Loading AI settings...
          </div>
        ) : (
          <>
            {activeTab === "providers" && (
              <ProvidersPanel
                providers={providerProfiles.providers}
                loadError={providerProfiles.loadError}
                onRetryLoad={providerProfiles.retry}
                onCreate={providerProfiles.create}
                onUpdate={providerProfiles.update}
                onDelete={handleDeleteProvider}
                onVerify={providerProfiles.verify}
              />
            )}
            {activeTab === "audio" && (
              <AudioPanel
                settings={audio.settings}
                providers={textCapableProviders(providerProfiles.providers)}
                onSettingsSaved={audio.save}
              />
            )}
            {activeTab === "voice_control" && (
              <VoiceControlPanel
                settings={voiceControl.settings}
                providers={textCapableProviders(providerProfiles.providers)}
                onSettingsSaved={voiceControl.save}
              />
            )}
            {activeTab === "agent_voice" && (
              <AgentVoicePanel
                profiles={speaking.profiles}
                providers={providerProfiles.providers}
                loadError={speaking.loadError}
                onRetryLoad={speaking.retry}
                onCreate={speaking.create}
                onUpdate={speaking.update}
                onDelete={speaking.remove}
                onListVoices={listSpeakingVoices}
                onGetProviderSchema={getSpeakingProviderSchema}
                onPreview={previewSpeakingProfile}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
