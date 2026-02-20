import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Globe, FolderOpen, Link2, Info, AlertTriangle } from "lucide-react";
import { Button } from "../ui";
import { AgentIcon } from "./AgentIcon";
import { installSkill, uninstallSkill } from "../../api";
import type { AgentDef, InstalledSkill, ApiError } from "../../api";

interface InstallDialogProps {
  isOpen: boolean;
  skillName: string;
  sourceName: string;
  repoKey: string;
  repoPath: string;
  relativePath: string;
  agents: AgentDef[];
  installedRecord: InstalledSkill | null;
  projectPath: string | null;
  onClose: () => void;
  onInstalled: () => void;
}

export function InstallDialog({
  isOpen,
  skillName,
  sourceName,
  repoKey,
  repoPath,
  relativePath,
  agents,
  installedRecord,
  projectPath,
  onClose,
  onInstalled,
}: InstallDialogProps) {
  const [scope, setScope] = useState<"global" | "project">("global");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictInfo, setConflictInfo] = useState<{ source: string; skill: string } | null>(null);

  const isManageMode = installedRecord !== null && installedRecord.agents.length > 0;

  // Build path-based shared groups for the current scope
  // Agents sharing the same directory path will be linked
  const pathGroups = useMemo(() => {
    const pathToAgents: Record<string, string[]> = {};
    for (const agent of agents) {
      const path = scope === "global" ? agent.global_skills_dir : agent.project_skills_dir;
      if (!pathToAgents[path]) pathToAgents[path] = [];
      pathToAgents[path].push(agent.id);
    }
    return pathToAgents;
  }, [agents, scope]);

  // Map: agentId → list of other agent IDs sharing the same path
  const agentShareMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const ids of Object.values(pathGroups)) {
      if (ids.length > 1) {
        for (const id of ids) {
          map[id] = ids;
        }
      }
    }
    return map;
  }, [pathGroups]);

  const hasSharedPaths = Object.keys(agentShareMap).length > 0;

  // Helper: get installed agent IDs for a given scope
  const getInstalledForScope = (s: "global" | "project") =>
    new Set(installedRecord?.agents.filter((a) => a.scope === s).map((a) => a.agent_id) ?? []);

  useEffect(() => {
    if (!isOpen) return;
    if (installedRecord && installedRecord.agents.length > 0) {
      const hasProject = installedRecord.agents.some((a) => a.scope === "project");
      const initialScope = hasProject ? "project" : "global";
      setScope(initialScope);
      setSelectedAgents(getInstalledForScope(initialScope));
    } else {
      setSelectedAgents(new Set());
      setScope("global");
    }
    setError(null);
  }, [isOpen, installedRecord]);

  // When scope changes, update selected agents to match that scope's installs
  const handleScopeChange = (newScope: "global" | "project") => {
    setScope(newScope);
    if (isManageMode) {
      setSelectedAgents(getInstalledForScope(newScope));
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      const siblings = agentShareMap[agentId];

      if (next.has(agentId)) {
        next.delete(agentId);
        if (siblings) {
          for (const id of siblings) next.delete(id);
        }
      } else {
        next.add(agentId);
        if (siblings) {
          for (const id of siblings) next.add(id);
        }
      }
      return next;
    });
  };

  const handleInstall = async (force = false) => {
    // In fresh install mode, require at least one agent
    if (selectedAgents.size === 0 && !isManageMode) {
      setError("Select at least one agent");
      return;
    }
    setIsWorking(true);
    setError(null);
    setConflictInfo(null);
    try {
      await installSkill({
        repo_key: repoKey,
        source_name: sourceName,
        skill_name: skillName,
        repo_path: repoPath,
        relative_path: relativePath,
        scope,
        agents: Array.from(selectedAgents).map((id) => ({ agent_id: id })),
        project_path: scope === "project" && projectPath ? projectPath : undefined,
        force,
      });
      onInstalled();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409 && (apiErr.data as Record<string, string>)?.error_type === "skill_conflict") {
        const data = apiErr.data as Record<string, string>;
        setConflictInfo({ source: data.conflict_source_name, skill: data.conflict_skill_name });
      } else {
        setError(apiErr.message || "Install failed");
      }
    } finally {
      setIsWorking(false);
    }
  };

  const handleUninstall = async () => {
    setIsWorking(true);
    setError(null);
    try {
      await uninstallSkill(repoKey, repoPath);
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setIsWorking(false);
    }
  };

  // Group agents for rendering: shared-path groups + independent agents
  const agentLayout = useMemo(() => {
    const independent: AgentDef[] = [];
    const groups: { path: string; members: AgentDef[] }[] = [];
    const seenPaths = new Set<string>();

    for (const agent of agents) {
      const path = scope === "global" ? agent.global_skills_dir : agent.project_skills_dir;
      const groupIds = pathGroups[path];

      if (groupIds.length > 1) {
        if (!seenPaths.has(path)) {
          seenPaths.add(path);
          groups.push({
            path,
            members: agents.filter((a) => groupIds.includes(a.id)),
          });
        }
      } else {
        independent.push(agent);
      }
    }
    return { independent, groups };
  }, [agents, scope, pathGroups]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-50"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">
                    {isManageMode ? "Manage Skill" : "Install Skill"}
                  </h2>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{skillName}</p>
                </div>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="px-5 py-4 space-y-5">
                {/* Scope */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-2">
                    Scope
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleScopeChange("global")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm rounded-lg border transition-colors ${
                        scope === "global"
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                      }`}
                    >
                      <Globe className="w-4 h-4" />
                      Global
                    </button>
                    <button
                      onClick={() => handleScopeChange("project")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm rounded-lg border transition-colors ${
                        scope === "project"
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                      }`}
                    >
                      <FolderOpen className="w-4 h-4" />
                      Project
                    </button>
                  </div>
                </div>

                {/* Agents */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-2">
                    Agents
                  </label>
                  <div className="space-y-1">
                    {/* Independent agents (unique path) */}
                    {agentLayout.independent.map((agent) => (
                      <AgentCheckRow
                        key={agent.id}
                        agent={agent}
                        scope={scope}
                        isChecked={selectedAgents.has(agent.id)}
                        onToggle={() => toggleAgent(agent.id)}
                      />
                    ))}

                    {/* Shared-path groups */}
                    {agentLayout.groups.map((group) => (
                      <div key={group.path} className="relative">
                        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--color-highlight)]/30 rounded-full ml-[7px]" />
                        <div className="pl-4 space-y-1">
                          {group.members.map((agent, idx) => (
                            <AgentCheckRow
                              key={agent.id}
                              agent={agent}
                              scope={scope}
                              isChecked={selectedAgents.has(agent.id)}
                              onToggle={() => toggleAgent(agent.id)}
                              showLinkedHint={idx === 0}
                              sharedPath={group.path}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {hasSharedPaths && (
                    <div className="flex items-start gap-1.5 mt-2 px-1">
                      <Info className="w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0 mt-0.5" />
                      <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                        Agents with the same {scope === "global" ? "global" : "project"} directory share skills automatically.
                        Selecting one auto-selects all that share the path.
                      </p>
                    </div>
                  )}
                </div>

                {conflictInfo && (
                  <div className="p-3 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] flex-shrink-0 mt-0.5" />
                      <div className="text-xs text-[var(--color-text)]">
                        <p className="font-medium mb-1">
                          Skill &apos;{conflictInfo.skill}&apos; is already installed from source &apos;{conflictInfo.source}&apos;.
                        </p>
                        <p className="text-[var(--color-text-muted)] mb-2">
                          Installing will replace the existing skill.
                        </p>
                        <Button variant="primary" size="sm" onClick={() => handleInstall(true)} disabled={isWorking}>
                          {isWorking ? "Replacing..." : "Replace"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {error && (
                  <p className="text-xs text-[var(--color-error)]">{error}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-between gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                {isManageMode ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleUninstall}
                      disabled={isWorking}
                      className="text-[var(--color-error)] hover:text-[var(--color-error)]"
                    >
                      Uninstall All
                    </Button>
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={onClose}>Cancel</Button>
                      <Button variant="primary" onClick={() => handleInstall()} disabled={isWorking}>
                        {isWorking ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div />
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={onClose}>Cancel</Button>
                      <Button variant="primary" onClick={() => handleInstall()} disabled={isWorking || selectedAgents.size === 0}>
                        {isWorking ? "Installing..." : "Install"}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function AgentCheckRow({
  agent,
  scope,
  isChecked,
  onToggle,
  showLinkedHint,
  sharedPath,
}: {
  agent: AgentDef;
  scope: "global" | "project";
  isChecked: boolean;
  onToggle: () => void;
  showLinkedHint?: boolean;
  sharedPath?: string;
}) {
  const pathPreview = scope === "global" ? agent.global_skills_dir : agent.project_skills_dir;

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
    >
      <div
        className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
          isChecked
            ? "bg-[var(--color-highlight)] border-[var(--color-highlight)]"
            : "border-[var(--color-border)]"
        }`}
      >
        {isChecked && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
        <AgentIcon iconId={agent.icon_id} size={18} />
      </div>

      <div className="flex-1 text-left min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-[var(--color-text)]">{agent.display_name}</span>
          {showLinkedHint && sharedPath && (
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--color-highlight)]">
              <Link2 className="w-3 h-3" /> shared path
            </span>
          )}
        </div>
        <p className="text-[10px] text-[var(--color-text-muted)] font-mono truncate mt-0.5">
          {pathPreview}
        </p>
      </div>
    </button>
  );
}
