import { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Globe, FolderOpen, Link2, Info, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "../ui";
import { AgentIcon } from "./AgentIcon";
import { installSkill } from "../../api";
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
  const [workingAgentId, setWorkingAgentId] = useState<string | null>(null);
  const [workingAll, setWorkingAll] = useState<"install" | "uninstall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictInfo, setConflictInfo] = useState<{ source: string; skill: string; force?: () => void } | null>(null);

  const isWorking = workingAgentId !== null || workingAll !== null;

  // Build path-based shared groups for the current scope
  const pathGroups = useMemo(() => {
    const pathToAgents: Record<string, string[]> = {};
    for (const agent of agents) {
      const path = scope === "global" ? agent.global_skills_dir : agent.project_skills_dir;
      if (!pathToAgents[path]) pathToAgents[path] = [];
      pathToAgents[path].push(agent.id);
    }
    return pathToAgents;
  }, [agents, scope]);

  // Map: agentId → list of all agent IDs sharing the same path (including self)
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

  // Derive installed agent IDs for current scope from installedRecord
  const installedAgentIds = useMemo(
    () => new Set(installedRecord?.agents.filter((a) => a.scope === scope).map((a) => a.agent_id) ?? []),
    [installedRecord, scope],
  );

  const allInstalled = agents.length > 0 && agents.every((a) => installedAgentIds.has(a.id));
  const noneInstalled = installedAgentIds.size === 0;

  // Initialize scope only when the dialog opens (not on every data refresh)
  useEffect(() => {
    if (!isOpen) return;
    if (installedRecord && installedRecord.agents.length > 0) {
      const hasProject = installedRecord.agents.some((a) => a.scope === "project");
      setScope(hasProject ? "project" : "global");
    } else {
      setScope("global");
    }
    setError(null);
    setConflictInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Common install params
  const commonInstallParams = useCallback(
    (agentIds: string[], force = false) => ({
      repo_key: repoKey,
      source_name: sourceName,
      skill_name: skillName,
      repo_path: repoPath,
      relative_path: relativePath,
      scope,
      agents: agentIds.map((id) => ({ agent_id: id })),
      project_path: scope === "project" && projectPath ? projectPath : undefined,
      force,
    }),
    [repoKey, sourceName, skillName, repoPath, relativePath, scope, projectPath],
  );

  // Per-agent install/uninstall
  const handleAgentAction = useCallback(
    async (agentId: string, action: "install" | "uninstall", force = false) => {
      setWorkingAgentId(agentId);
      setError(null);
      setConflictInfo(null);

      // Expand to include shared-path siblings
      const siblings = agentShareMap[agentId] ?? [agentId];
      const siblingSet = new Set(siblings);

      let targetIds: string[];
      if (action === "install") {
        targetIds = [...installedAgentIds, ...siblings.filter((id) => !installedAgentIds.has(id))];
      } else {
        targetIds = [...installedAgentIds].filter((id) => !siblingSet.has(id));
      }

      try {
        // Always use installSkill with the target agent list for the current scope.
        // This ensures only the current scope is affected (e.g. removing project agents
        // won't touch global agents). uninstallSkill() removes ALL scopes.
        await installSkill(commonInstallParams(targetIds, force));
        onInstalled();
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.status === 409 && (apiErr.data as Record<string, string>)?.error_type === "skill_conflict") {
          const data = apiErr.data as Record<string, string>;
          setConflictInfo({
            source: data.conflict_source_name,
            skill: data.conflict_skill_name,
            force: () => handleAgentAction(agentId, action, true),
          });
        } else {
          setError(apiErr.message || `${action} failed`);
        }
      } finally {
        setWorkingAgentId(null);
      }
    },
    [agentShareMap, installedAgentIds, repoKey, repoPath, commonInstallParams, onInstalled],
  );

  // Install All
  const handleInstallAll = useCallback(
    async (force = false) => {
      setWorkingAll("install");
      setError(null);
      setConflictInfo(null);

      const allAgentIds = agents.map((a) => a.id);
      try {
        await installSkill(commonInstallParams(allAgentIds, force));
        onInstalled();
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.status === 409 && (apiErr.data as Record<string, string>)?.error_type === "skill_conflict") {
          const data = apiErr.data as Record<string, string>;
          setConflictInfo({
            source: data.conflict_source_name,
            skill: data.conflict_skill_name,
            force: () => handleInstallAll(true),
          });
        } else {
          setError(apiErr.message || "Install failed");
        }
      } finally {
        setWorkingAll(null);
      }
    },
    [agents, commonInstallParams, onInstalled],
  );

  // Uninstall All — only for the current scope (send empty agents list)
  const handleUninstallAll = useCallback(async () => {
    setWorkingAll("uninstall");
    setError(null);
    setConflictInfo(null);
    try {
      await installSkill(commonInstallParams([], false));
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setWorkingAll(null);
    }
  }, [commonInstallParams, onInstalled]);

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
                    Manage Skill
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
                      onClick={() => setScope("global")}
                      disabled={isWorking}
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
                      onClick={() => setScope("project")}
                      disabled={isWorking}
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
                      <AgentActionRow
                        key={agent.id}
                        agent={agent}
                        scope={scope}
                        isInstalled={installedAgentIds.has(agent.id)}
                        isLoading={workingAgentId === agent.id}
                        disabled={isWorking}
                        onAction={(action) => handleAgentAction(agent.id, action)}
                      />
                    ))}

                    {/* Shared-path groups */}
                    {agentLayout.groups.map((group) => (
                      <div key={group.path} className="relative">
                        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--color-highlight)]/30 rounded-full ml-[7px]" />
                        <div className="pl-4 space-y-1">
                          {group.members.map((agent, idx) => (
                            <AgentActionRow
                              key={agent.id}
                              agent={agent}
                              scope={scope}
                              isInstalled={installedAgentIds.has(agent.id)}
                              isLoading={workingAgentId === agent.id || (workingAgentId !== null && (agentShareMap[workingAgentId] ?? []).includes(agent.id))}
                              disabled={isWorking}
                              onAction={(action) => handleAgentAction(agent.id, action)}
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
                        <Button variant="primary" size="sm" onClick={conflictInfo.force} disabled={isWorking}>
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
              <div className="flex justify-end items-center gap-2 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                {!noneInstalled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleUninstallAll}
                    disabled={isWorking}
                    className="text-[var(--color-error)] hover:text-[var(--color-error)] mr-auto"
                  >
                    {workingAll === "uninstall" ? "Uninstalling..." : "Uninstall All"}
                  </Button>
                )}
                {!allInstalled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleInstallAll()}
                    disabled={isWorking}
                    className="text-[var(--color-highlight)] hover:text-[var(--color-highlight)]"
                  >
                    {workingAll === "install" ? "Installing..." : "Install All"}
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function AgentActionRow({
  agent,
  scope,
  isInstalled,
  isLoading,
  disabled,
  onAction,
  showLinkedHint,
  sharedPath,
}: {
  agent: AgentDef;
  scope: "global" | "project";
  isInstalled: boolean;
  isLoading: boolean;
  disabled: boolean;
  onAction: (action: "install" | "uninstall") => void;
  showLinkedHint?: boolean;
  sharedPath?: string;
}) {
  const pathPreview = scope === "global" ? agent.global_skills_dir : agent.project_skills_dir;

  return (
    <div className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
      isInstalled
        ? "bg-[var(--color-highlight)]/5 border border-[var(--color-highlight)]/15"
        : "hover:bg-[var(--color-bg-tertiary)]"
    }`}>
      <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
        <AgentIcon iconId={agent.icon_id} size={18} />
      </div>

      <div className="flex-1 min-w-0">
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

      <button
        onClick={() => onAction(isInstalled ? "uninstall" : "install")}
        disabled={disabled}
        className={`flex-shrink-0 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
          isLoading
            ? "text-[var(--color-text-muted)] cursor-wait"
            : isInstalled
              ? "text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
              : "text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10"
        } disabled:opacity-50`}
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : isInstalled ? (
          "Uninstall"
        ) : (
          "Install"
        )}
      </button>
    </div>
  );
}
