import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Compass, FolderGit2, Bot } from "lucide-react";
import { ExploreTab } from "./ExploreTab";
import { SourcesTab } from "./SourcesTab";
import { AgentsTab } from "./AgentsTab";
import type { AgentDef, SkillSource, InstalledSkill } from "../../api";
import { getAgentDefs, listSources, listInstalled } from "../../api";
import { useProject } from "../../context";

type TabId = "explore" | "sources" | "agents";

const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "explore", label: "Explore", icon: Compass },
  { id: "sources", label: "Sources", icon: FolderGit2 },
  { id: "agents", label: "Agents", icon: Bot },
];

export function SkillsPage() {
  const { selectedProject } = useProject();
  const projectPath = selectedProject?.path ?? null;
  const [activeTab, setActiveTab] = useState<TabId>("explore");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Only enabled agents are used for install/display
  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled), [agents]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [agentData, sourceData, installedData] = await Promise.all([
        getAgentDefs(),
        listSources(),
        listInstalled(),
      ]);
      setAgents(agentData);
      setSources(sourceData);
      setInstalled(installedData);
    } catch (err) {
      console.error("Failed to load skills data:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const refreshAgents = useCallback(async () => {
    const data = await getAgentDefs();
    setAgents(data);
  }, []);

  const refreshSources = useCallback(async () => {
    const data = await listSources();
    setSources(data);
  }, []);

  const refreshInstalled = useCallback(async () => {
    const data = await listInstalled();
    setInstalled(data);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab Bar */}
      <div className="flex items-center gap-1 pb-4 border-b border-[var(--color-border)]">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors
                ${isActive
                  ? "text-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
                }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {tab.id === "agents" && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                  {enabledAgents.length}
                </span>
              )}
              {isActive && (
                <motion.div
                  layoutId="skillsTabIndicator"
                  className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--color-highlight)] rounded-full"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto pt-4">
        {activeTab === "explore" && (
          <ExploreTab
            sources={sources}
            agents={enabledAgents}
            installed={installed}
            projectPath={projectPath}
            onInstalled={refreshInstalled}
          />
        )}
        {activeTab === "sources" && (
          <SourcesTab
            sources={sources}
            onRefresh={refreshSources}
          />
        )}
        {activeTab === "agents" && (
          <AgentsTab
            agents={agents}
            onRefresh={refreshAgents}
          />
        )}
      </div>
    </div>
  );
}
