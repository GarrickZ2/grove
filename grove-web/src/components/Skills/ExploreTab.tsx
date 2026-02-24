import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Filter, X, SlidersHorizontal, Users, ChevronLeft, ChevronRight } from "lucide-react";
import { SkillCard } from "./SkillCard";
import { SkillDetailPanel } from "./SkillDetailPanel";
import { AgentIcon } from "./AgentIcon";
import { exploreSkills } from "../../api";
import type { SkillSource, SkillSummary, AgentDef, InstalledSkill } from "../../api";

const PAGE_SIZE = 15;

type StatusFilter = "all" | "not_installed" | "installed" | "update_available";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "not_installed", label: "Not Installed" },
  { value: "installed", label: "Installed" },
  { value: "update_available", label: "Update Available" },
];

interface ExploreTabProps {
  sources: SkillSource[];
  agents: AgentDef[];
  installed: InstalledSkill[];
  projectPath: string | null;
  onInstalled: () => Promise<void>;
}

export function ExploreTab({ sources, agents, installed, projectPath, onInstalled }: ExploreTabProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string[]>([]);
  const [showSourceFilter, setShowSourceFilter] = useState(false);
  const [showStatusFilter, setShowStatusFilter] = useState(false);
  const [showAgentFilter, setShowAgentFilter] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<{ source: string; name: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const loadSkills = useCallback(async () => {
    setIsLoading(true);
    try {
      const sourceFilter = selectedSources.length > 0 ? selectedSources.join(",") : undefined;
      const data = await exploreSkills(searchQuery || undefined, sourceFilter);
      setSkills(data);
    } catch (err) {
      console.error("Failed to load skills:", err);
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery, selectedSources]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(loadSkills, 300);
    return () => clearTimeout(timer);
  }, [loadSkills]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedSources, statusFilter, selectedAgentFilter]);

  const toggleSourceFilter = (name: string) => {
    setSelectedSources((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    );
  };

  const toggleAgentFilter = (agentId: string) => {
    setSelectedAgentFilter((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  // Build source update map for "Update Available" status
  const sourceUpdateMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const s of sources) {
      map.set(s.name, s.has_remote_updates);
    }
    return map;
  }, [sources]);

  // Enrich skills: compute install status relative to agent filter + update availability
  const enrichedSkills = useMemo(() => {
    const filteredAgents = selectedAgentFilter.length > 0
      ? agents.filter((a) => selectedAgentFilter.includes(a.id))
      : agents;
    const totalCount = filteredAgents.length;
    const filteredAgentIds = new Set(filteredAgents.map((a) => a.id));

    return skills.map((skill) => {
      const inst = installed.find((i) => i.repo_key === skill.repo_key && i.repo_path === skill.repo_path);
      const hasUpdate = !!(inst && sourceUpdateMap.get(skill.source));

      if (inst) {
        // Union of global + current project agent IDs (deduplicated)
        const relevantAgentIds = new Set(
          inst.agents
            .filter((a) => a.scope === "global" || (a.scope === "project" && a.project_path === projectPath))
            .map((a) => a.agent_id)
        );
        const activeInstalls = [...relevantAgentIds].filter((id) => filteredAgentIds.has(id)).length;
        return {
          ...skill,
          total_agents: totalCount,
          install_status: (activeInstalls >= totalCount
            ? "installed"
            : activeInstalls > 0
              ? "partial"
              : "not_installed") as SkillSummary["install_status"],
          installed_agent_count: activeInstalls,
          has_update: hasUpdate,
        };
      }
      // Not in installed list → override stale server values
      return {
        ...skill,
        total_agents: totalCount,
        install_status: "not_installed" as SkillSummary["install_status"],
        installed_agent_count: 0,
        has_update: false,
      };
    });
  }, [skills, installed, agents, selectedAgentFilter, sourceUpdateMap, projectPath]);

  // Apply agent + status filters
  const filteredSkills = useMemo(() => {
    let result = enrichedSkills;

    // Agent filter: only show skills installed for at least one of the selected agents
    if (selectedAgentFilter.length > 0) {
      const agentIdSet = new Set(selectedAgentFilter);
      result = result.filter((skill) => {
        const inst = installed.find((i) => i.repo_key === skill.repo_key && i.repo_path === skill.repo_path);
        if (!inst) return false;
        return inst.agents.some((a) =>
          agentIdSet.has(a.agent_id)
          && (a.scope === "global" || (a.scope === "project" && a.project_path === projectPath))
        );
      });
    }

    // Status filter
    if (statusFilter !== "all") {
      result = result.filter((skill) => {
        switch (statusFilter) {
          case "not_installed":
            return skill.install_status === "not_installed";
          case "installed":
            return skill.install_status !== "not_installed";
          case "update_available":
            return skill.has_update;
          default:
            return true;
        }
      });
    }

    return result;
  }, [enrichedSkills, statusFilter, selectedAgentFilter, installed, projectPath]);

  // Pagination
  const totalItems = filteredSkills.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedSkills = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredSkills.slice(start, start + PAGE_SIZE);
  }, [filteredSkills, safePage]);

  const activeSourceCount = selectedSources.length;
  const activeAgentCount = selectedAgentFilter.length;
  const activeStatusLabel = STATUS_OPTIONS.find((o) => o.value === statusFilter);

  return (
    <div className="h-full">
      <div className="min-w-0">
        {/* Search + Filters */}
        <div className="flex items-center gap-2 mb-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
            />
          </div>

          {/* Status Filter */}
          <div className="relative">
            <button
              onClick={() => { setShowStatusFilter(!showStatusFilter); setShowSourceFilter(false); setShowAgentFilter(false); }}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${
                statusFilter !== "all"
                  ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)]/30"
              }`}
            >
              <SlidersHorizontal className="w-4 h-4" />
              {activeStatusLabel?.label || "All"}
            </button>

            {showStatusFilter && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowStatusFilter(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl py-1">
                  {STATUS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => { setStatusFilter(option.value); setShowStatusFilter(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                        statusFilter === option.value
                          ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                      }`}
                    >
                      <div
                        className={`w-1.5 h-1.5 rounded-full ${
                          statusFilter === option.value ? "bg-[var(--color-highlight)]" : "bg-transparent"
                        }`}
                      />
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Source Filter */}
          <div className="relative">
            <button
              onClick={() => { setShowSourceFilter(!showSourceFilter); setShowStatusFilter(false); setShowAgentFilter(false); }}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${
                activeSourceCount > 0
                  ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)]/30"
              }`}
            >
              <Filter className="w-4 h-4" />
              Sources
              {activeSourceCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-[var(--color-highlight)] text-white">
                  {activeSourceCount}
                </span>
              )}
            </button>

            {showSourceFilter && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowSourceFilter(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl py-1">
                  {sources.map((source) => (
                    <button
                      key={source.name}
                      onClick={() => toggleSourceFilter(source.name)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          selectedSources.includes(source.name)
                            ? "bg-[var(--color-highlight)] border-[var(--color-highlight)]"
                            : "border-[var(--color-border)]"
                        }`}
                      >
                        {selectedSources.includes(source.name) && (
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <span className="text-[var(--color-text)]">{source.name}</span>
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{source.skill_count}</span>
                    </button>
                  ))}
                  {selectedSources.length > 0 && (
                    <div className="border-t border-[var(--color-border)] mt-1 pt-1">
                      <button
                        onClick={() => { setSelectedSources([]); setShowSourceFilter(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <X className="w-3 h-3" /> Clear filters
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Agent Filter */}
          <div className="relative">
            <button
              onClick={() => { setShowAgentFilter(!showAgentFilter); setShowSourceFilter(false); setShowStatusFilter(false); }}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${
                activeAgentCount > 0
                  ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)]/30"
              }`}
            >
              <Users className="w-4 h-4" />
              Agents
              {activeAgentCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-[var(--color-highlight)] text-white">
                  {activeAgentCount}
                </span>
              )}
            </button>

            {showAgentFilter && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowAgentFilter(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl py-1">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => toggleAgentFilter(agent.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          selectedAgentFilter.includes(agent.id)
                            ? "bg-[var(--color-highlight)] border-[var(--color-highlight)]"
                            : "border-[var(--color-border)]"
                        }`}
                      >
                        {selectedAgentFilter.includes(agent.id) && (
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                        <AgentIcon iconId={agent.icon_id} size={14} />
                      </div>
                      <span className="text-[var(--color-text)] truncate">{agent.display_name}</span>
                    </button>
                  ))}
                  {selectedAgentFilter.length > 0 && (
                    <div className="border-t border-[var(--color-border)] mt-1 pt-1">
                      <button
                        onClick={() => { setSelectedAgentFilter([]); setShowAgentFilter(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <X className="w-3 h-3" /> Clear filters
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Active filter chips */}
        {(statusFilter !== "all" || selectedSources.length > 0 || selectedAgentFilter.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {statusFilter !== "all" && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]">
                {activeStatusLabel?.label}
                <button onClick={() => setStatusFilter("all")} className="hover:text-[var(--color-text)]">
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
            {selectedSources.map((s) => (
              <span key={s} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                {s}
                <button onClick={() => toggleSourceFilter(s)} className="hover:text-[var(--color-text)]">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {selectedAgentFilter.map((id) => {
              const agent = agents.find((a) => a.id === id);
              return (
                <span key={id} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                  {agent?.display_name || id}
                  <button onClick={() => toggleAgentFilter(id)} className="hover:text-[var(--color-text)]">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={() => { setStatusFilter("all"); setSelectedSources([]); setSelectedAgentFilter([]); }}
              className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Skill Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="w-10 h-10 text-[var(--color-text-muted)] mb-3 opacity-40" />
            <p className="text-sm text-[var(--color-text-muted)]">
              {searchQuery || selectedSources.length > 0 || statusFilter !== "all" || selectedAgentFilter.length > 0
                ? "No skills found matching your filters."
                : "No skills available. Add a source first."}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {pagedSkills.map((skill) => (
                <SkillCard
                  key={`${skill.source}/${skill.name}`}
                  skill={skill}
                  hasUpdate={skill.has_update}
                  isSelected={selectedSkill?.source === skill.source && selectedSkill?.name === skill.name}
                  onClick={() =>
                    setSelectedSkill(
                      selectedSkill?.source === skill.source && selectedSkill?.name === skill.name
                        ? null
                        : { source: skill.source, name: skill.name }
                    )
                  }
                />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-[var(--color-border)]">
                <span className="text-xs text-[var(--color-text-muted)]">
                  {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, totalItems)} of {totalItems} skills
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>

                  {generatePageNumbers(safePage, totalPages).map((page, i) =>
                    page === "..." ? (
                      <span key={`ellipsis-${i}`} className="px-2 text-xs text-[var(--color-text-muted)]">...</span>
                    ) : (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page as number)}
                        className={`min-w-[36px] h-8 px-2.5 rounded-md text-xs font-medium transition-colors ${
                          safePage === page
                            ? "bg-[var(--color-highlight)] text-white"
                            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
                        }`}
                      >
                        {page}
                      </button>
                    )
                  )}

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail Panel */}
      <SkillDetailPanel
        selectedSkill={selectedSkill}
        agents={agents}
        installed={installed}
        projectPath={projectPath}
        onClose={() => setSelectedSkill(null)}
        onInstalled={onInstalled}
      />
    </div>
  );
}

/** Generate page numbers with ellipsis for large page counts */
function generatePageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 9) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | "...")[] = [1];

  if (current > 4) {
    pages.push("...");
  }

  const start = Math.max(2, current - 2);
  const end = Math.min(total - 1, current + 2);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 3) {
    pages.push("...");
  }

  pages.push(total);
  return pages;
}
