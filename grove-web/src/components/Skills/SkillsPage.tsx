import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Bot, Boxes, FolderGit2, PackagePlus, Plus, Server } from "lucide-react";
import { ExtensionsExplore, AddMcpDialog } from "./ExtensionsExplore";
import { SourcesTab } from "./SourcesTab";
import { AgentsTab } from "./AgentsTab";
import { AddSourceDialog } from "./AddSourceDialog";
import { AddPluginDialog } from "../Config/AddPluginDialog";
import { DropdownMenu } from "../ui";
import type { AgentDef, SkillSource, InstalledSkill } from "../../api";
import { getAgentDefs, listSources, listInstalled } from "../../api";
import { useProject } from "../../context";
import { useCommand } from "../../keyboard";

type TabId = "catalog" | "sources" | "agents";

const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "catalog", label: "Catalog", icon: Boxes },
  { id: "sources", label: "Sources", icon: FolderGit2 },
  { id: "agents", label: "Agents", icon: Bot },
];

export function SkillsPage() {
  const { selectedProject } = useProject();
  const projectPath = selectedProject?.path ?? null;
  const [activeTab, setActiveTab] = useState<TabId>("catalog");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [sourceDialog, setSourceDialog] = useState<"git" | "local" | null>(null);
  const [showAddPlugin, setShowAddPlugin] = useState(false);
  const [showAddMcp, setShowAddMcp] = useState(false);

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
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  const refreshAgents = useCallback(async () => {
    const data = await getAgentDefs();
    setAgents(data);
  }, []);

  const refreshSources = useCallback(async () => {
    const data = await listSources();
    setSources(data);
  }, []);

  // After an install/update, both the installed set AND per-source update
  // state change (server recomputes `has_remote_updates`/`skill_count`).
  // Refresh both so "Update Available" badges clear promptly.
  const refreshAfterInstall = useCallback(async () => {
    await Promise.all([
      listInstalled().then(setInstalled),
      listSources().then(setSources),
    ]);
  }, []);

  // Catalog-declared tab switchers — Command Palette / Settings shortcut
  // both call setActiveTab so the page jumps to that tab regardless of
  // current selection.
  useCommand("skills.tab.explore", () => setActiveTab("catalog"), []);
  useCommand("skills.tab.sources", () => setActiveTab("sources"), []);
  useCommand("skills.tab.agents", () => setActiveTab("agents"), []);
  useCommand("skills.source.add", () => setSourceDialog("git"), []);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col animate-pulse">
        <div className="mb-5 flex items-center justify-between border-b border-[var(--color-border)] pb-5"><div className="flex items-center gap-3"><div className="h-12 w-12 rounded-2xl bg-[var(--color-bg-secondary)]" /><div className="space-y-2"><div className="h-5 w-32 rounded bg-[var(--color-bg-secondary)]" /><div className="h-3 w-80 rounded bg-[var(--color-bg-secondary)]" /></div></div><div className="h-9 w-40 rounded-lg bg-[var(--color-bg-secondary)]" /></div>
        <div className="h-12 rounded-xl bg-[var(--color-bg-secondary)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden md:overflow-hidden">
      <header className="shrink-0 border-b border-[var(--color-border)]">
      <div className="flex items-start justify-between gap-3 pb-4 sm:gap-4 sm:pb-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] sm:h-12 sm:w-12 sm:rounded-2xl"><Boxes className="h-5 w-5" /></div>
          <div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight text-[var(--color-text)] sm:text-2xl">Extensions</h1><p className="mt-1 truncate text-sm text-[var(--color-text-muted)]"><span className="sm:hidden">Manage Grove capabilities.</span><span className="hidden sm:inline">Discover capabilities, manage installations, and keep their sources connected.</span></p></div>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu align="right" items={[
            { id: "source", label: "Source…", description: "Scan a Git repository or local folder", icon: FolderGit2, onClick: () => setSourceDialog("git") },
            { id: "plugin", label: "Plugin…", description: "Install or register a development plugin", icon: PackagePlus, onClick: () => setShowAddPlugin(true) },
            { id: "mcp", label: "MCP Server…", description: "Create a managed server definition", icon: Server, onClick: () => setShowAddMcp(true) },
          ]} trigger={<span className="flex items-center gap-1.5"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Add</span></span>} triggerClassName="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-highlight)] text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 sm:h-9 sm:w-auto sm:px-3.5" />
        </div>
      </div>
      {/* Tab Bar */}
      <nav className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors
                ${isActive
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--color-text-muted)]">{tab.id === "catalog" ? sources.reduce((sum, source) => sum + source.skill_count + source.plugin_count + source.mcp_count, 0) : tab.id === "sources" ? sources.length : agents.length}</span>
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
      </nav>
      </header>

      {/* Tab Content */}
      <div className="min-h-0 flex-none overflow-visible pt-4 md:flex-1 md:overflow-hidden md:pt-5">
        {activeTab === "catalog" && (
          <ExtensionsExplore
            sources={sources}
            agents={enabledAgents}
            installed={installed}
            projectPath={projectPath}
            onInstalled={refreshAfterInstall}
            refreshToken={refreshToken}
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
            installed={installed}
            onRefresh={refreshAgents}
          />
        )}
      </div>
      <AddSourceDialog isOpen={sourceDialog !== null} editingSource={null} initialSourceType={sourceDialog ?? "git"} onClose={() => setSourceDialog(null)} onSaved={async () => { setSourceDialog(null); await refreshSources(); setRefreshToken((value) => value + 1); }} />
      {showAddPlugin && <AddPluginDialog onClose={() => { setShowAddPlugin(false); setRefreshToken((value) => value + 1); }} />}
      {showAddMcp && <AddMcpDialog onClose={() => setShowAddMcp(false)} onCreated={async () => { setShowAddMcp(false); await refreshSources(); setRefreshToken((value) => value + 1); }} />}
    </div>
  );
}
