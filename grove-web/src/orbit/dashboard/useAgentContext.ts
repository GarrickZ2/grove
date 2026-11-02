import { useEffect, useState } from "react";
import { getInstructions } from "../../api";
import { getMemoryConfig, getMemoryOverview } from "../../api/memory";
import { listInstalled } from "../../api/skills";
import { getAgentContext, type AgentContextResponse, type AgentContextSourceId } from "../../api/agentContext";
import type { Project } from "../../data/types";
import { formatTokens } from "../../components/Stats/formatters";

export type ContextSourceId = AgentContextSourceId;

export interface ContextSource {
  id: ContextSourceId;
  name: string;
  detail: string;
  /** False when the source is switched off (e.g. Memory disabled). */
  on: boolean;
  /** Estimated tokens at session start; null without the agent-context endpoint. */
  tokens: number | null;
  /** Some parts have no estimate (shown as "~N+"). */
  partial: boolean;
  /** Fallback right-side label (a count) when there are no token estimates. */
  label: string | null;
  /** Page that manages this source, or null when nothing in Grove does. */
  page: string | null;
}

export interface AgentContextView {
  loaded: boolean;
  sources: ContextSource[];
  /** Estimated total at session start; null in counts-only fallback. */
  total: number | null;
  partial: boolean;
}

const SOURCE_PAGE: Record<ContextSourceId, (studio: boolean) => string | null> = {
  // Repo instruction files live in the repository; Studio ones are edited in Studio.
  instructions: (studio) => (studio ? "resource" : null),
  memory: () => "memory",
  mcp: () => "skills",
  skills: () => "skills",
};

/** The agent-context endpoint's sources, in the card's shape. */
export function fromAgentContext(response: AgentContextResponse, project: Pick<Project, "projectType">): Omit<AgentContextView, "loaded"> {
  const studio = project.projectType === "studio";
  return {
    total: response.total_tokens,
    partial: response.partial,
    sources: response.sources.map((source) => ({
      id: source.id,
      name: source.name,
      detail: source.detail,
      on: source.enabled,
      tokens: source.tokens,
      partial: source.partial,
      label: null,
      page: SOURCE_PAGE[source.id]?.(studio) ?? null,
    })),
  };
}

interface Facts {
  instructionLines: number | null;
  memoryEnabled: boolean | null;
  memoryEntities: number | null;
  memoryOrganizedAt: number | null;
  skillCount: number | null;
}

const EMPTY: Facts = { instructionLines: null, memoryEnabled: null, memoryEntities: null, memoryOrganizedAt: null, skillCount: null };

function ago(seconds: number) {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 60));
  if (minutes < 60) return minutes < 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** "~2.4k", or "~1.2k+" when part of it can't be estimated. */
export function tokenLabel(tokens: number, partial: boolean) {
  return `~${formatTokens(tokens)}${partial ? "+" : ""}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Facts → rows. Sources whose facts failed to load are left out rather than guessed. */
export function buildContextSources(project: Pick<Project, "projectType">, facts: Facts): ContextSource[] {
  const sources: ContextSource[] = [];
  // Instructions only exist for Studio projects (`instructions.md` in the studio dir).
  if (project.projectType === "studio" && facts.instructionLines !== null) {
    const lines = facts.instructionLines;
    sources.push({
      id: "instructions", name: "Instructions", page: "resource", on: lines > 0, tokens: null, partial: false,
      detail: lines > 0 ? "Workspace instructions for every agent" : "Not written yet",
      label: lines > 0 ? plural(lines, "line") : null,
    });
  }
  if (facts.memoryEnabled !== null) {
    const entities = facts.memoryEntities;
    sources.push({
      id: "memory", name: "Memory", page: "memory", on: facts.memoryEnabled, tokens: null, partial: false,
      detail: !facts.memoryEnabled
        ? "Turn on to keep what agents learn here"
        : entities === null ? "Keeps what agents learn here"
          : facts.memoryOrganizedAt ? `Organized ${ago(facts.memoryOrganizedAt)}` : "Not organized yet",
      label: !facts.memoryEnabled || entities === null ? null : entities === 1 ? "1 entry" : `${entities} entries`,
    });
  }
  if (facts.skillCount !== null) {
    sources.push({
      id: "skills", name: "Skills", page: "skills", on: facts.skillCount > 0, tokens: null, partial: false,
      detail: facts.skillCount > 0 ? "Installed for your agents" : "None installed",
      label: facts.skillCount > 0 ? plural(facts.skillCount, "skill") : null,
    });
  }
  return sources;
}

type Loaded = { kind: "estimates"; view: Omit<AgentContextView, "loaded"> } | { kind: "facts"; facts: Facts };

async function loadFacts(projectId: string, isStudio: boolean): Promise<Facts> {
  const facts: Facts = { ...EMPTY };
  await Promise.allSettled([
    isStudio
      ? getInstructions(projectId).then((res) => {
        facts.instructionLines = res.content.trim() ? res.content.trim().split("\n").length : 0;
      })
      : Promise.resolve(),
    getMemoryConfig(projectId).then(async (config) => {
      facts.memoryEnabled = !!config?.enabled;
      if (!config?.enabled) return;
      const overview = await getMemoryOverview(projectId);
      facts.memoryEntities = overview.entity_count;
      facts.memoryOrganizedAt = overview.last_organized_at ?? null;
    }),
    listInstalled().then((skills) => { facts.skillCount = skills.length; }),
  ]);
  return facts;
}

/**
 * Loads what every new session in this project starts with: per-source token
 * estimates from the agent-context endpoint, or, on a server without it,
 * the counts-only facts from the Memory and Skills APIs.
 */
export function useAgentContext(project: Project | null): AgentContextView {
  const [state, setState] = useState<{ key: string; loaded: Loaded | null }>({ key: "", loaded: null });
  const projectId = project?.id ?? "";
  const isStudio = project?.projectType === "studio";

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const studio = { projectType: isStudio ? "studio" as const : "repo" as const };
    void getAgentContext(projectId)
      .then((response): Promise<Loaded> => Promise.resolve({ kind: "estimates", view: fromAgentContext(response, studio) }))
      .catch(async (): Promise<Loaded> => ({ kind: "facts", facts: await loadFacts(projectId, isStudio) }))
      .then((loaded) => {
        if (!cancelled) setState({ key: projectId, loaded });
      });
    return () => { cancelled = true; };
  }, [projectId, isStudio]);

  const loaded = state.key === projectId ? state.loaded : null;
  if (!project || !loaded) return { loaded: false, sources: [], total: null, partial: false };
  if (loaded.kind === "estimates") return { loaded: true, ...loaded.view };
  return { loaded: true, sources: buildContextSources(project, loaded.facts), total: null, partial: false };
}
