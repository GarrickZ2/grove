import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import cronstrue from "cronstrue";
import {
  Activity,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Database,
  FileText,
  FolderOpen,
  GitCompare,
  Link2,
  Loader2,
  Orbit,
  PencilLine,
  Play,
  RefreshCw,
  Search,
  Tag,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useBanner, useProject } from "../../context";
import { Button } from "../ui/Button";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { DialogShell } from "../ui/DialogShell";
import { Input } from "../ui/Input";
import { Switch } from "../ui/Switch";
import { AgentPicker } from "../ui/AgentPicker";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { MemoryAgentConfig } from "./MemoryAgentConfig";
import { MemoryGraph } from "./MemoryGraph";
import { memoryCategoryColor } from "./MemoryGraphPalette";
import { ConfirmDialog } from "../Dialogs";
import { agentOptions, type AgentOption } from "../../data/agents";
import {
  type AgentConfigSelection,
  type AutomationRun,
  cancelAutomationRun,
  finishAutomationRun,
  listAutomationRuns,
  triggerAutomation,
} from "../../api/automations";
import {
  type MemoryConfig,
  type MemoryConfigInput,
  type MemoryEntity,
  type MemoryEntityDocument,
  type MemoryLog,
  type MemoryOverview,
  type MemoryRelation,
  deleteMemoryEntity,
  deleteMemoryLogs,
  deleteMemoryRun,
  getMemoryConfig,
  getMemoryEntity,
  getMemoryOverview,
  getMemoryRunHistory,
  listMemoryEntities,
  listMemoryLogs,
  listMemoryRelations,
  updateMemoryConfig,
} from "../../api/memory";
import {
  type InstalledAgentConfig,
  listInstalledAgentConfigs,
} from "../../api/marketplace";
import { configForAgent, reconcileAgentConfig } from "../../utils/agentConfig";
import { appendHmacToUrl, getApiHost } from "../../api/client";
import {
  applyToolCallCreated,
  applyToolCallUpdated,
  canApplyToolCallUpdate,
  hasReadableToolInput,
  hasReadableToolOutput,
  type ToolCallMessage,
} from "../Tasks/TaskView/toolCallReducer";
import { TaskChat } from "../Tasks/TaskView/TaskChat";
import { useIsMobile } from "../../hooks/useIsMobile";
import "./memory-page.css";

type Tab = "overview" | "memories" | "logs" | "runs";

type MemoryRunStreamUpdate = {
  automation_id: string;
  run_id: string;
  run?: AutomationRun;
  event?: Record<string, unknown>;
  sequence: number;
};

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "memories", label: "Memories" },
  { id: "logs", label: "Memory Logs" },
  { id: "runs", label: "Runs" },
];

const EMPTY_OVERVIEW: MemoryOverview = {
  entity_count: 0,
  relation_count: 0,
  log_count: 0,
  run_count: 0,
  successful_run_count: 0,
  failed_run_count: 0,
  in_progress_run_count: 0,
  waiting_run_count: 0,
  active_run_count: 0,
  usage: {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_by_currency: {},
  },
};

const DEFAULT_DRAFT: MemoryConfigInput = {
  enabled: false,
  deep_organization: false,
  pending_log_threshold: null,
  organization_enabled: true,
  agent_config: { source: "default" },
  schedule_cron: "0 2 * * *",
  event_triggers: ["task.finished"],
};

export function MemoryPage() {
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id ?? null;
  const [tab, setTab] = useState<Tab>("overview");
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [overview, setOverview] = useState<MemoryOverview>(EMPTY_OVERVIEW);
  const [agents, setAgents] = useState<InstalledAgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [runStarting, setRunStarting] = useState(false);
  const [liveRunUpdates, setLiveRunUpdates] = useState<MemoryRunStreamUpdate[]>([]);
  const liveRunSequence = useRef(0);
  const activeTabRef = useRef(tab);
  const { showBanner } = useBanner();

  useEffect(() => {
    activeTabRef.current = tab;
  }, [tab]);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [configResult, overviewResult] = await Promise.allSettled([
        getMemoryConfig(projectId),
        getMemoryOverview(projectId),
      ]);
      if (configResult.status === "fulfilled") setConfig(configResult.value);
      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      const failure = [configResult, overviewResult].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") setError(errorMessage(failure.reason));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      setAgents(await listInstalledAgentConfigs());
    } catch (reason) {
      setAgentsError(errorMessage(reason));
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh, refreshTick]);

  useEffect(() => {
    void Promise.resolve().then(loadAgents);
  }, [loadAgents, tab]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      setLiveRunUpdates([]);
      liveRunSequence.current = 0;
    });
  }, [projectId]);

  const handleRunUpdate = useCallback((update: Omit<MemoryRunStreamUpdate, "sequence">) => {
    if (update.event && activeTabRef.current !== "runs") return;
    const sequence = ++liveRunSequence.current;
    setLiveRunUpdates((current) => [...current, { ...update, sequence }].slice(-500));
    if (!update.event || update.event.type === "complete" || (update.run && isTerminal(update.run.status))) {
      setRefreshTick((value) => value + 1);
    }
  }, []);
  useMemoryRunUpdates(projectId, config?.organization.id, handleRunUpdate);

  const runOrganization = useCallback(async () => {
    if (!projectId || !config) {
      showBanner("Save Memory settings before starting a run.", "error", 5000);
      return;
    }
    setRunStarting(true);
    try {
      const result = await triggerAutomation(projectId, config.organization.id);
      if (result.error) throw new Error(result.error);
      showBanner("Memory organization started.", "success");
      setRefreshTick((value) => value + 1);
    } catch (reason) {
      showBanner(errorMessage(reason), "error", 5000);
    } finally {
      setRunStarting(false);
    }
  }, [config, projectId, showBanner]);

  if (!projectId) {
    return <EmptyPage title="Select a project" description="Memory is stored and organized per project." />;
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="flex-shrink-0 border-b border-[var(--color-border)]">
        <div className="relative flex flex-col gap-2 pb-4 pr-12 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:pb-5 sm:pr-0">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)] flex items-center justify-center">
              <Brain className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold text-[var(--color-text)]">Memory</h1>
                <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]">Beta</span>
              </div>
              <p className="mt-1 max-w-xl truncate text-sm leading-5 text-[var(--color-text-muted)]">
                <span className="sm:hidden">Project knowledge organized by Grove.</span>
                <span className="hidden sm:inline">What Grove has learned while working in this project.</span>
              </p>
            </div>
          </div>
          <Button className="absolute right-0 top-0 h-10 w-10 self-start !p-0 sm:static sm:h-auto sm:w-auto sm:self-auto sm:!px-3" variant="ghost" size="sm" onClick={() => { setRefreshTick((value) => value + 1); void loadAgents(); }} disabled={loading} title="Refresh Memory" aria-label="Refresh Memory">
            <RefreshCw className={`h-4 w-4 sm:mr-1.5 sm:h-3.5 sm:w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`relative px-3 py-2.5 text-sm whitespace-nowrap transition-colors ${tab === item.id ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
            >
              {item.label}
              {tab === item.id && <motion.span layoutId="memory-tab" className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-[var(--color-highlight)]" />}
            </button>
          ))}
        </nav>
      </header>

      {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:overflow-hidden sm:pt-5">
        {loading && !config && overview === EMPTY_OVERVIEW ? (
          <CenteredLoading />
        ) : tab === "overview" ? (
          <OverviewTab
            projectId={projectId}
            config={config}
            overview={overview}
            agents={agents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            runStarting={runStarting}
            onRunOrganization={runOrganization}
            onSaved={(next) => { setConfig(next); setRefreshTick((value) => value + 1); }}
          />
        ) : tab === "memories" ? (
          <MemoriesTab projectId={projectId} refreshTick={refreshTick} onChanged={() => setRefreshTick((value) => value + 1)} />
        ) : tab === "logs" ? (
          <LogsTab
            projectId={projectId}
            config={config}
            overview={overview}
            refreshTick={refreshTick}
            runStarting={runStarting}
            onRunOrganization={runOrganization}
            onChanged={() => setRefreshTick((value) => value + 1)}
          />
        ) : (
          <RunsTab
            key={`${projectId}:${config?.project_id === projectId ? config.organization.id : "loading"}`}
            projectId={projectId}
            config={config}
            refreshTick={refreshTick}
            liveUpdates={liveRunUpdates}
            onChanged={() => setRefreshTick((value) => value + 1)}
          />
        )}
      </main>
    </div>
  );
}

function OverviewTab({
  projectId,
  config,
  overview,
  agents,
  agentsLoading,
  agentsError,
  runStarting,
  onRunOrganization,
  onSaved,
}: {
  projectId: string;
  config: MemoryConfig | null;
  overview: MemoryOverview;
  agents: InstalledAgentConfig[];
  agentsLoading: boolean;
  agentsError: string | null;
  runStarting: boolean;
  onRunOrganization: () => Promise<void>;
  onSaved: (config: MemoryConfig) => void;
}) {
  const [draft, setDraft] = useState<MemoryConfigInput>(() => configToDraft(config));
  const [saving, setSaving] = useState(false);
  const [snapshotEntities, setSnapshotEntities] = useState<MemoryEntity[]>([]);
  const { showBanner } = useBanner();

  useEffect(() => {
    const next = configToDraft(config);
    void Promise.resolve().then(() => setDraft(next));
  }, [config]);

  useEffect(() => {
    if (agents.length === 0) return;
    void Promise.resolve().then(() => setDraft((current) => {
      const agentId = current.agent_config.agent_id;
      const agent = agents.find((candidate) => candidate.id === agentId) ?? (
        !agentId && !config ? agents[0] : undefined
      );
      if (!agent) return current;
      return {
        ...current,
        agent_config: agentId
          ? reconcileAgentConfig(current.agent_config, agent)
          : configForAgent(agent),
      };
    }));
  }, [agents, config]);

  useEffect(() => {
    if (agentsError) {
      showBanner(`Could not load installed Agents: ${agentsError}`, "error", 5000);
    }
  }, [agentsError, showBanner]);

  useEffect(() => {
    if (!agentsLoading && !agentsError && agents.length === 0) {
      showBanner(
        "No installed Agent is available. Install and run an Agent once so Grove can learn its configuration capabilities.",
        "error",
        5000,
      );
    }
  }, [agents, agentsError, agentsLoading, showBanner]);

  // The overview itself is available from the inexpensive aggregate query.
  // Entity previews enrich the page independently and never block its first
  // render, so returning to Memory stays immediate even on large projects.
  useEffect(() => {
    let disposed = false;
    void listMemoryEntities(projectId, undefined, undefined, 100)
      .then((page) => {
        if (!disposed) setSnapshotEntities(page.items);
      })
      .catch(() => {
        if (!disposed) setSnapshotEntities([]);
      });
    return () => { disposed = true; };
  }, [projectId, overview.entity_count, overview.last_organized_at]);

  const savedDraft = useMemo(() => {
    const saved = configToDraft(config);
    const agent = agents.find((candidate) => candidate.id === saved.agent_config.agent_id);
    if (agent) saved.agent_config = reconcileAgentConfig(saved.agent_config, agent);
    return saved;
  }, [agents, config]);
  const isDirty = useMemo(() => !sameMemoryConfig(draft, savedDraft), [draft, savedDraft]);

  const selectedAgentId = draft.agent_config.agent_id ?? "";
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const options = selectedAgent?.capability_snapshot?.config_options ?? [];
  const modes = selectedAgent?.capability_snapshot?.modes?.available ?? [];
  const installedAgentOptions = useMemo<AgentOption[]>(() => agents.map((agent) => {
    const metadata = agentOptions.find((option) => option.id === agent.id || option.value === agent.id);
    return {
      ...metadata,
      id: agent.id,
      value: agent.id,
      label: agent.name,
    };
  }), [agents]);

  const save = async () => {
    if (draft.enabled && !draft.agent_config.agent_id) {
      showBanner("Choose an installed Agent first.", "error", 5000);
      return;
    }
    setSaving(true);
    try {
      const next = await updateMemoryConfig(projectId, draft);
      onSaved(next);
      showBanner("Memory settings saved.", "success");
    } catch (reason) {
      showBanner(errorMessage(reason), "error", 5000);
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!config) {
      showBanner("Save Memory settings before starting a run.", "error", 5000);
      return;
    }
    if (isDirty) {
      showBanner("Save your changes before starting Memory organization.", "error", 5000);
      return;
    }
    await onRunOrganization();
  };

  const state = overview.in_progress_run_count > 0
    ? {
        label: "Organizing",
        tone: "active" as const,
        title: "Grove is organizing recent project knowledge.",
        description: "Follow the active run to see what is being consolidated.",
      }
    : overview.waiting_run_count > 0
      ? {
          label: "Waiting",
          tone: "pending" as const,
          title: "Memory organization is waiting for you.",
          description: "Open the Run to provide input, guidance, or permission.",
        }
      : !draft.enabled
        ? {
            label: "Disabled",
            tone: "muted" as const,
            title: "Memory is disabled for this project.",
            description: "Enable Memory to collect short-term observations and organize them over time.",
          }
        : overview.log_count > 0
          ? {
              label: `${formatNumber(overview.log_count)} pending`,
              tone: "pending" as const,
              title: `${formatNumber(overview.log_count)} ${plural(overview.log_count, "Memory Log is", "Memory Logs are")} waiting to be organized.`,
              description: overview.failed_run_count > 0
                ? `A previous attempt failed, but these Logs are ready for a new organization run. · ${lastOrganizedText(overview.last_organized_at)}`
                : `${lastOrganizedText(overview.last_organized_at)} · ${config?.organization.enabled ? "Automatic organization is enabled." : "Automatic organization is paused."}`,
            }
          : overview.failed_run_count > 0
            ? {
                label: "Failed",
                tone: "error" as const,
                title: "A Memory organization attempt failed.",
                description: "Open the Run to review the error, or start a new organization attempt.",
              }
            : {
                label: "Up to date",
                tone: "success" as const,
                title: "No Memory Logs are waiting to be organized.",
                description: `${lastOrganizedText(overview.last_organized_at)} · ${config?.organization.enabled ? "Automatic organization is enabled." : "Run an organization when you are ready."}`,
              };

  const categoryCounts = [...snapshotEntities.reduce((counts, entity) => {
    for (const key of new Set(entity.tags.map((tag) => tag.key))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, new Map<string, number>()).entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5);
  const strongestMemories = snapshotEntities.slice(0, 4);

  return (
    <OverviewFitFrame>
    <div className="memory-overview min-h-0 min-w-0 overflow-x-hidden pr-1">
      <section className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 shadow-sm">
        <div className="pointer-events-none absolute -right-8 -top-20 h-52 w-52 rounded-full bg-[var(--color-highlight)]/10 blur-3xl" />
        <div className="relative flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--color-highlight)]/15 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]">
              <Activity className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Current state</p>
                <MemoryStateBadge label={state.label} tone={state.tone} />
              </div>
              <h2 className="mt-1 text-xl font-semibold tracking-tight text-[var(--color-text)]">{state.title}</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{state.description}</p>
            </div>
          </div>
          <OrganizeMemoryButton
            config={config}
            overview={overview}
            runStarting={runStarting}
            blockedByUnsavedChanges={isDirty}
            onClick={() => void runNow()}
          />
        </div>
      </section>

      <div className="mt-3 grid items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-h-0 flex-col gap-4">
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Statistics</p>
                <h3 className="mt-1 text-base font-semibold text-[var(--color-text)]">Memory at a glance</h3>
              </div>
              <span className="text-[10px] text-[var(--color-text-muted)]">Snapshot · now</span>
            </div>
            <div className="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 lg:grid-cols-4">
              <OverviewStat value={formatNumber(overview.entity_count)} label="Durable memories" icon={<Brain className="h-3.5 w-3.5" />} />
              <OverviewStat value={formatNumber(overview.relation_count)} label="Relations" icon={<Orbit className="h-3.5 w-3.5" />} />
              <OverviewStat value={formatNumber(overview.log_count)} label="Pending logs" icon={<Activity className="h-3.5 w-3.5" />} tone={overview.log_count > 0 ? "warning" : "default"} />
              <OverviewStat value={overview.last_organized_at ? relativeTime(overview.last_organized_at) : "—"} label="Last organized" icon={<Check className="h-3.5 w-3.5" />} />
            </div>
          </section>

          <div className="grid min-h-[310px] flex-1 items-stretch gap-4 lg:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.15fr)]">
            <section className="flex min-h-0 flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"><Tag className="h-3.5 w-3.5" /></span>
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">Top tag categories</h3>
                </div>
                <span className="text-[10px] text-[var(--color-text-muted)]">May overlap</span>
              </div>
              <TagCategoryOverview items={categoryCounts} />
            </section>

            <section className="flex min-h-0 flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"><FileText className="h-3.5 w-3.5" /></span>
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">Strongest memories</h3>
                </div>
                <span className="text-[10px] text-[var(--color-text-muted)]">By score</span>
              </div>
              <div className="mt-3 grid min-w-0 flex-1 gap-2" style={{ gridTemplateRows: `repeat(${Math.max(strongestMemories.length, 1)}, minmax(0, 1fr))` }}>
                {strongestMemories.length > 0 ? strongestMemories.map((entity, index) => (
                  <div key={entity.entity_id} className="flex min-h-0 min-w-0 flex-col justify-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[10px] font-semibold text-[var(--color-text-muted)]">{index + 1}</span>
                      <p className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">{entity.title}</p>
                      <span className="rounded-full bg-[var(--color-highlight)]/10 px-2 py-0.5 text-[10px] font-medium tabular-nums text-[var(--color-highlight)]">{entity.score}</span>
                    </div>
                    <p className="ml-8 mt-1 line-clamp-1 text-[11px] leading-4 text-[var(--color-text-muted)]">{entity.description}</p>
                  </div>
                )) : (
                  <p className="rounded-xl bg-[var(--color-bg-secondary)] px-3 py-5 text-xs leading-5 text-[var(--color-text-muted)]">Organize recent logs and chats to form the first durable Memory.</p>
                )}
              </div>
            </section>
          </div>

          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"><CircleCheck className="h-3.5 w-3.5" /></span>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">Organization activity</h3>
                  <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">Runs and reported Agent usage</p>
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3 lg:grid-cols-6">
              <OverviewActivityMetric value={formatNumber(overview.successful_run_count)} label="Completed" />
              <OverviewActivityMetric value={formatNumber(overview.failed_run_count)} label="Errors" tone={overview.failed_run_count > 0 ? "danger" : "default"} />
              <OverviewActivityMetric value={formatMetricCost(overview.usage.cost_by_currency)} label="Cost" />
              <OverviewActivityMetric value={compactNumber(overview.usage.input_tokens)} label="Input tokens" />
              <OverviewActivityMetric value={compactNumber(overview.usage.cached_input_tokens)} label="Cached input" />
              <OverviewActivityMetric value={compactNumber(overview.usage.output_tokens)} label="Output tokens" />
            </div>
          </section>
        </div>

        <aside className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3.5 shadow-sm xl:sticky xl:top-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Organization</p>
              <h3 className="mt-1 text-base font-semibold text-[var(--color-text)]">Keep Memory current</h3>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">Configure how Grove forms durable project knowledge.</p>
            </div>
            {isDirty ? (
              <Button size="sm" onClick={save} disabled={saving || (draft.enabled && agents.length === 0)}>
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                Save
              </Button>
            ) : (
              <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]"><Check className="h-3.5 w-3.5" />Saved</span>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/[0.07] px-3 py-2 shadow-sm">
            <OrganizationSwitchRow
              title="Enable Memory"
              description="Collect and organize Memory for this project"
              value={draft.enabled}
              onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>

          <div
            className={`mt-2 space-y-2 transition-opacity ${!draft.enabled ? "pointer-events-none select-none opacity-40 grayscale" : ""}`}
            aria-disabled={!draft.enabled}
          >
            <OrganizationGroup label="Collection" description="What Memory can use" icon={<Brain className="h-3.5 w-3.5" />}>
              <OrganizationSwitchRow title="Deep organization" description="Include more project history" value={draft.deep_organization} onChange={(deep_organization) => setDraft((current) => ({ ...current, deep_organization }))} />
            </OrganizationGroup>

            <OrganizationGroup label="Automation" description="When organization runs" icon={<Activity className="h-3.5 w-3.5" />}>
              <OrganizationSwitchRow title="Automatic organization" description="Keep Memory current in the background" value={draft.organization_enabled} onChange={(organization_enabled) => setDraft((current) => ({ ...current, organization_enabled }))} />
              <div className={`mt-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 ${!draft.organization_enabled ? "opacity-55" : ""}`}>
                <OrganizationSwitchRow
                  title="When a task is archived"
                  description="Runs after Active moves to Archived"
                  value={draft.event_triggers.includes("task.finished")}
                  onChange={(checked) => setDraft((current) => ({ ...current, event_triggers: checked ? [...current.event_triggers.filter((item) => item !== "task.finished"), "task.finished"] : current.event_triggers.filter((item) => item !== "task.finished") }))}
                  disabled={!draft.organization_enabled}
                />
                <OrganizationNumberRow
                  title="Pending Logs threshold"
                  description={draft.pending_log_threshold ? `Runs at ${formatNumber(draft.pending_log_threshold)} Logs` : "Off"}
                  value={draft.pending_log_threshold}
                  placeholder="50"
                  onChange={(pending_log_threshold) => setDraft((current) => ({ ...current, pending_log_threshold }))}
                  disabled={!draft.organization_enabled}
                />
                <OrganizationControlRow title="Schedule" description={describeSchedule(draft.schedule_cron)} disabled={!draft.organization_enabled}>
                  <ScheduleField value={draft.schedule_cron} onChange={(schedule_cron) => setDraft((current) => ({ ...current, schedule_cron }))} />
                </OrganizationControlRow>
              </div>
            </OrganizationGroup>

            <OrganizationGroup label="Organizer" description="Agent and runtime configuration" icon={<Orbit className="h-3.5 w-3.5" />}>
              <OrganizationControlRow title="Agent" description="Installed Agent used for organization">
                <AgentPicker
                  value={selectedAgentId}
                  onChange={(agentId) => {
                    const agent = agents.find((item) => item.id === agentId);
                    setDraft((current) => ({ ...current, agent_config: agent ? configForAgent(agent) : { source: "default" } }));
                  }}
                  options={installedAgentOptions}
                  allowCustom={false}
                  triggerSize="compact"
                  placeholder={agentsLoading ? "Loading installed Agents…" : "Choose an installed Agent"}
                />
              </OrganizationControlRow>
              {draft.agent_config.source === "config_options" && options.length > 0 && (
                <div className="border-t border-[var(--color-border)] pt-2">
                  <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Agent configuration</p>
                  <MemoryAgentConfig options={options} config={draft.agent_config} onChange={(agent_config) => setDraft((current) => ({ ...current, agent_config }))} />
                </div>
              )}
              {draft.agent_config.source === "modes" && modes.length > 0 && (
                <OrganizationControlRow title="Mode" description="Supported by the selected Agent">
                  <Combobox
                    options={modes.map(([id, name]) => ({ id, value: id, label: name }))}
                    value={draft.agent_config.mode_id}
                    onChange={(modeId) => setDraft((current) => ({ ...current, agent_config: { ...current.agent_config, source: "modes", mode_id: modeId } }))}
                    allowCustom={false}
                  />
                </OrganizationControlRow>
              )}
            </OrganizationGroup>
          </div>
        </aside>
      </div>
    </div>
    </OverviewFitFrame>
  );
}

function OverviewFitFrame({ children }: { children: ReactNode }) {
  const { isMobile } = useIsMobile();
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (isMobile) return;
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return;

    let animationFrame = 0;
    const measure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const availableHeight = frame.clientHeight;
        const contentHeight = content.scrollHeight;
        if (availableHeight <= 0 || contentHeight <= 0) return;
        const next = Math.min(1, availableHeight / contentHeight);
        const rounded = Math.floor(next * 1000) / 1000;
        setScale((current) => Math.abs(current - rounded) > 0.002 ? rounded : current);
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [isMobile]);

  return (
    <div ref={frameRef} className="min-h-0 sm:h-full sm:overflow-hidden" data-overview-fit-scale={scale.toFixed(3)}>
      <div
        ref={contentRef}
        className="memory-overview-fit-content origin-top-left"
        style={{
          width: !isMobile && scale < 0.999 ? `${100 / scale}%` : "100%",
          transform: !isMobile && scale < 0.999 ? `scale(${scale})` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MemoryStateBadge({ label, tone }: { label: string; tone: "success" | "pending" | "active" | "error" | "muted" }) {
  const color = tone === "success"
    ? "text-[var(--color-success)]"
    : tone === "pending"
      ? "text-[var(--color-warning)]"
      : tone === "active"
        ? "text-[var(--color-highlight)]"
        : tone === "error"
          ? "text-[var(--color-error)]"
        : "text-[var(--color-text-muted)]";
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium ${color}`}>
      <span className={`h-2 w-2 rounded-full bg-current ${tone === "active" ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}

function OverviewStat({ value, label, icon, tone = "default" }: { value: string; label: string; icon: ReactNode; tone?: "default" | "warning" }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/45 p-3">
      <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${tone === "warning" ? "bg-[var(--color-warning)]/10 text-[var(--color-warning)]" : "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"}`}>{icon}</div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--color-text)]">{value}</p>
      <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{label}</p>
    </div>
  );
}

function OverviewActivityMetric({ value, label, tone = "default" }: { value: string; label: string; tone?: "default" | "active" | "danger" }) {
  const valueColor = tone === "active"
    ? "text-[var(--color-highlight)]"
    : tone === "danger"
      ? "text-[var(--color-error)]"
      : "text-[var(--color-text)]";
  return (
    <div className="bg-[var(--color-bg-secondary)]/60 px-3 py-2.5">
      <p className={`text-base font-semibold tabular-nums ${valueColor}`}>{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{label}</p>
    </div>
  );
}

function TagCategoryOverview({ items }: { items: [string, number][] }) {
  if (items.length === 0) {
    return <p className="py-6 text-xs text-[var(--color-text-muted)]">Tag categories will appear after Grove forms durable memories.</p>;
  }
  const max = Math.max(...items.map(([, count]) => count), 1);
  return (
    <div className="mt-3 grid min-h-[190px] flex-1 grid-cols-5 items-stretch gap-2 rounded-xl bg-[var(--color-bg-secondary)]/45 px-3 pb-2.5 pt-3">
      {items.map(([name, count]) => (
        <div key={name} className="flex min-w-0 flex-col items-center">
          <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-end">
            <span className="mb-1.5 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]">{count}</span>
            <span
              className="block w-full max-w-10 rounded-t-md bg-[var(--color-highlight)]/75"
              style={{ height: `${Math.max(14, (count / max) * 100)}%` }}
            />
          </div>
          <span className="mt-2 w-full truncate text-center text-[10px] font-medium text-[var(--color-text-muted)]">{humanize(name)}</span>
        </div>
      ))}
    </div>
  );
}

function OrganizationGroup({ label, description, icon, children }: { label: string; description: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/45 p-2.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg)] text-[var(--color-highlight)]">{icon}</span>
        <div>
          <p className="text-xs font-semibold text-[var(--color-text)]">{label}</p>
          <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{description}</p>
        </div>
      </div>
      <div className="divide-y divide-[var(--color-border)]">{children}</div>
    </section>
  );
}

function OrganizationSwitchRow({
  title,
  description,
  value,
  onChange,
  disabled = false,
}: {
  title: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-1.5 ${disabled ? "opacity-55" : ""}`}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-[var(--color-text)]">{title}</p>
        <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{description}</p>
      </div>
      <Switch checked={value} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

function OrganizationControlRow({ title, description, children, disabled = false }: { title: string; description: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`py-1.5 ${disabled ? "pointer-events-none opacity-55" : ""}`}>
      <div className="mb-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-[var(--color-text)]">{title}</p>
          <p className="truncate text-right text-[10px] text-[var(--color-text-muted)]">{description}</p>
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function OrganizationNumberRow({
  title,
  description,
  value,
  placeholder,
  onChange,
  disabled = false,
}: {
  title: string;
  description: string;
  value: number | null;
  placeholder?: string;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 ${disabled ? "opacity-55" : ""}`}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-[var(--color-text)]">{title}</p>
        <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{description}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder={placeholder}
          value={value ?? ""}
          disabled={disabled}
          aria-label={title}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const parsed = Number.parseInt(raw, 10);
            onChange(raw !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : null);
          }}
          className="h-7 w-16 px-2 py-1 text-right text-xs tabular-nums"
        />
        <span className="text-[10px] text-[var(--color-text-muted)]">logs</span>
      </div>
    </div>
  );
}

function MemoriesTab({ projectId, refreshTick, onChanged }: { projectId: string; refreshTick: number; onChanged: () => void }) {
  const { isMobile } = useIsMobile();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<MemoryEntity[]>([]);
  const [allRelations, setAllRelations] = useState<MemoryRelation[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [view, setView] = useState<"graph" | "list">(() => isMobile ? "list" : "graph");
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryEntityDocument | null>(null);
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [relatedNames, setRelatedNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntityDocument | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [entityPage, relationPage] = await Promise.all([
        listMemoryEntities(projectId, submitted, undefined, 100),
        listMemoryRelations(projectId, undefined, 100),
      ]);
      setItems(entityPage.items);
      setAllRelations(relationPage.items);
      setHasMore(Boolean(entityPage.next_cursor || relationPage.next_cursor));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }, [projectId, submitted]);

  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshTick]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSubmitted(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (!selectedId) {
        setDetail(null);
        setRelations([]);
        setRelatedNames({});
        return;
      }
      setDetail(null);
      try {
        const [document, relationPage] = await Promise.all([
          getMemoryEntity(projectId, selectedId),
          listMemoryRelations(projectId, selectedId),
        ]);
        if (!active) return;
        setDetail(document);
        setRelations(relationPage.items);
        const known = new Map(items.map((entity) => [entity.entity_id, entity.title]));
        const relatedIds = [...new Set(relationPage.items.map((relation) => relation.source_entity_id === selectedId ? relation.target_entity_id : relation.source_entity_id))].slice(0, 6);
        const missing = relatedIds.filter((id) => !known.has(id));
        const loaded = await Promise.all(missing.map((id) => getMemoryEntity(projectId, id).catch(() => null)));
        if (!active) return;
        loaded.forEach((entity) => { if (entity) known.set(entity.entity_id, entity.title); });
        setRelatedNames(Object.fromEntries(known));
      } catch (reason) {
        if (active) setError(errorMessage(reason));
      }
    });
    return () => { active = false; };
  }, [items, projectId, selectedId]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of items) {
      for (const key of new Set(entity.tags.map((tag) => tag.key))) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [items]);
  const categoryColors = useMemo(() => {
    const names = categories.map(([name]) => name);
    return new Map(names.map((name) => [name, memoryCategoryColor(name, names)]));
  }, [categories]);
  const visibleItems = category
    ? items.filter((entity) => entity.tags.some((tag) => tag.key === category))
    : items;
  const resultSummary = submitted
    ? `${formatNumber(items.length)}${hasMore ? "+" : ""} matching ${plural(items.length, "memory", "memories")}`
    : hasMore
      ? `Showing the ${formatNumber(items.length)} strongest memories`
      : `${formatNumber(items.length)} ${plural(items.length, "memory", "memories")}`;

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deleteMemoryEntity(projectId, deleteTarget.entity_id);
      setItems((current) => current.filter((entity) => entity.entity_id !== deleteTarget.entity_id));
      setAllRelations((current) => current.filter((relation) => relation.source_entity_id !== deleteTarget.entity_id && relation.target_entity_id !== deleteTarget.entity_id));
      setSelectedId(null);
      setDeleteTarget(null);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col sm:h-full">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 pb-3 sm:grid-cols-[minmax(320px,680px)_auto_1fr] sm:gap-3 sm:pb-4">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <SearchBar value={query} onChange={setQuery} onSubmit={() => setSubmitted(query.trim())} placeholder="Search memories, descriptions, or tags" />
        </div>
        <div className="inline-flex justify-self-start items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1">
          <button
            type="button"
            title="Relation graph"
            onClick={() => setView("graph")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${view === "graph" ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          >
            Graph
          </button>
          <button
            type="button"
            title="Memory list"
            onClick={() => setView("list")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${view === "list" ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          >
            List
          </button>
        </div>
        <p className="min-w-0 truncate justify-self-end text-xs text-[var(--color-text-muted)]">{resultSummary}</p>
      </div>

      {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
      {!loading && items.length === 0 ? (
        <EmptyPage title="No memories yet" description={submitted ? "No memories match this search." : "Run Memory organization to turn short-term logs into durable Markdown memories."} />
      ) : (
        <div className="flex min-h-[440px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] sm:flex-1 sm:flex-row">
          <aside className="flex w-full flex-shrink-0 gap-2 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 p-3 [scrollbar-width:none] sm:block sm:w-60 sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-4 [&::-webkit-scrollbar]:hidden">
            <p className="hidden px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)] sm:block">Tag category</p>
            <button
              type="button"
              onClick={() => setCategory(null)}
              className={`flex flex-shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition-colors sm:w-full ${category === null ? "bg-[var(--color-bg-secondary)] text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/70 hover:text-[var(--color-text)]"}`}
            >
              <span>All memories</span>
              <span className="text-[10px] tabular-nums">{items.length}</span>
            </button>
            <div className="flex gap-2 sm:mt-1 sm:block sm:space-y-0.5">
              {categories.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setCategory(name)}
                  className={`flex flex-shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors sm:w-full ${category === name ? "bg-[var(--color-bg-secondary)] text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/70 hover:text-[var(--color-text)]"}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: categoryColors.get(name) }} />
                  <span className="truncate flex-1 text-left">{humanize(name)}</span>
                  <span className="text-[10px] tabular-nums">{count}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
              {view === "graph" ? (
                <MemoryGraph
                  entities={visibleItems}
                  relations={allRelations}
                  onOpen={setSelectedId}
                  categoryColors={categoryColors}
                  activeCategory={category}
                  summary={`${items.length === 1 ? "Showing 1 memory" : `Showing ${formatNumber(visibleItems.length)} of the ${formatNumber(items.length)} strongest memories`}${submitted ? " · search covers the full snapshot" : ""}`}
                />
              ) : (
                <MemoryEntityList entities={visibleItems} onOpen={setSelectedId} />
              )}
            </div>
          </section>
        </div>
      )}
      {loading && <div className="absolute inset-0 pointer-events-none"><CenteredLoading compact /></div>}
      <MemoryDocumentDialog
        isOpen={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        detail={detail}
        relations={relations}
        relatedNames={relatedNames}
        onOpen={setSelectedId}
        onDelete={setDeleteTarget}
      />
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title="Delete Memory"
        message={<>Delete <strong className="text-[var(--color-text)]">{deleteTarget?.title}</strong>? Its Markdown document, snapshot, and related connections will be removed.</>}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        actionsDisabled={deleting}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
      />
    </div>
  );
}

function MemoryEntityList({ entities, onOpen }: { entities: MemoryEntity[]; onOpen: (entityId: string) => void }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_minmax(180px,0.42fr)_80px_120px] gap-4 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] md:grid">
        <span>Memory</span>
        <span>Tags</span>
        <span>Score</span>
        <span>Updated</span>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {entities.map((entity) => (
          <button
            key={entity.entity_id}
            type="button"
            onClick={() => onOpen(entity.entity_id)}
            className="block w-full px-4 py-3.5 text-left transition-colors hover:bg-[var(--color-bg-secondary)]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-highlight)] md:grid md:grid-cols-[minmax(0,1fr)_minmax(180px,0.42fr)_80px_120px] md:items-center md:gap-4 md:px-5"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[var(--color-text)]">{entity.title}</span>
              <span className="mt-1 block truncate text-xs text-[var(--color-text-muted)]">{entity.description}</span>
            </span>
            <span className="mt-2 flex min-w-0 flex-wrap gap-1.5 md:mt-0">
              {entity.tags.slice(0, 3).map((tag) => (
                <span key={`${tag.key}:${tag.value}`} className="max-w-full truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                  {tag.icon ? `${tag.icon} ` : ""}{humanize(tag.key)} · {tag.value}
                </span>
              ))}
            </span>
            <span className="mt-2 inline-flex text-xs font-medium tabular-nums text-[var(--color-text)] md:mt-0">Score {entity.score}</span>
            <span className="ml-3 mt-2 inline-flex text-xs text-[var(--color-text-muted)] md:ml-0 md:mt-0">{relativeDate(entity.updated_at)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MemoryDocumentDialog({ isOpen, onClose, detail, relations, relatedNames, onOpen, onDelete }: { isOpen: boolean; onClose: () => void; detail: MemoryEntityDocument | null; relations: MemoryRelation[]; relatedNames: Record<string, string>; onOpen: (id: string) => void; onDelete: (detail: MemoryEntityDocument) => void }) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-[min(1080px,calc(100vw-48px))]">
      <div className="glass-overlay flex max-h-[min(88vh,920px)] min-h-[360px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_28px_80px_rgba(0,0,0,0.28)]">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"><FileText className="h-4 w-4" /></span>
            <div>
              <p className="text-xs font-semibold text-[var(--color-text)]">Memory document</p>
              <p className="text-[10px] text-[var(--color-text-muted)]">Durable project knowledge</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => { if (detail) onDelete(detail); }} disabled={!detail} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Delete Memory"><Trash2 className="h-4 w-4" /></button>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" aria-label="Close Memory document"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!detail ? <div className="flex min-h-[360px] items-center justify-center"><CenteredLoading compact /></div> : <MemoryDetail detail={detail} relations={relations} relatedNames={relatedNames} onOpen={onOpen} />}
        </div>
      </div>
    </DialogShell>
  );
}

function MemoryDetail({ detail, relations, relatedNames, onOpen }: { detail: MemoryEntityDocument; relations: MemoryRelation[]; relatedNames: Record<string, string>; onOpen: (id: string) => void }) {
  return (
    <article className="bg-[var(--color-bg-secondary)]/20">
      <div className="p-6 md:p-9 border-b border-[var(--color-border)]">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-3xl font-semibold tracking-tight text-[var(--color-text)]">{detail.title}</h2><p className="text-xs text-[var(--color-text-muted)] mt-2">Updated {formatDate(detail.updated_at)}</p></div>
          <Score value={detail.score} />
        </div>
        {relations.length > 0 && (
          <div className="mt-7">
            <p className="text-xs text-[var(--color-text-muted)] mb-2">Related memories</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {relations.slice(0, 6).map((relation) => {
                const id = relation.source_entity_id === detail.entity_id ? relation.target_entity_id : relation.source_entity_id;
                return <button key={relation.id} onClick={() => onOpen(id)} className="text-left rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 hover:border-[var(--color-highlight)]/60 transition-colors"><span className="block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{relation.relation_type}</span><span className="block text-sm font-medium text-[var(--color-text)] mt-0.5 truncate">{relatedNames[id] ?? id}</span></button>;
              })}
            </div>
          </div>
        )}
        <p className="mt-7 text-base leading-relaxed text-[var(--color-text)]">{detail.description}</p>
        <TagList tags={detail.tags} />
      </div>
      <div className="p-6 md:p-9"><MarkdownRenderer content={detail.body || "_This memory has no body yet._"} renderMode="document" /></div>
    </article>
  );
}

function LogsTab({
  projectId,
  config,
  overview,
  refreshTick,
  runStarting,
  onRunOrganization,
  onChanged,
}: {
  projectId: string;
  config: MemoryConfig | null;
  overview: MemoryOverview;
  refreshTick: number;
  runStarting: boolean;
  onRunOrganization: () => Promise<void>;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<MemoryLog[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const page = await listMemoryLogs(projectId, submitted, append ? cursor : undefined);
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }, [projectId, submitted, cursor]);
  useEffect(() => { void Promise.resolve().then(() => load(false)); }, [projectId, submitted, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const visibleIds = new Set(items.map((item) => item.id));
    void Promise.resolve().then(() => {
      setSelectedIds((current) => new Set([...current].filter((id) => visibleIds.has(id))));
    });
  }, [items]);

  const confirmDelete = async () => {
    if (deleteTargetIds.length === 0 || deleting) return;
    setDeleting(true);
    try {
      for (let offset = 0; offset < deleteTargetIds.length; offset += 200) {
        await deleteMemoryLogs(projectId, deleteTargetIds.slice(offset, offset + 200));
      }
      const deleted = new Set(deleteTargetIds);
      setItems((current) => current.filter((item) => !deleted.has(item.id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !deleted.has(id))));
      setDeleteTargetIds([]);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  const allLoadedSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  return <div className="h-full min-h-0 overflow-y-auto pr-1 pb-2">
    <div className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)] pb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <SearchBar value={query} onChange={setQuery} onSubmit={() => setSubmitted(query.trim())} placeholder="Search Memory Logs" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {items.length > 0 && <Button variant="ghost" size="sm" onClick={() => setSelectedIds(allLoadedSelected ? new Set() : new Set(items.map((item) => item.id)))}>{allLoadedSelected ? "Clear selection" : "Select loaded"}</Button>}
          {selectedIds.size > 0 && <Button variant="danger" size="sm" onClick={() => setDeleteTargetIds([...selectedIds])}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete {selectedIds.size}</Button>}
          <OrganizeMemoryButton
            config={config}
            overview={overview}
            runStarting={runStarting}
            onClick={() => void onRunOrganization()}
          />
        </div>
      </div>
    </div>
    <div className="space-y-4 pt-4">
      {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
      {!loading && items.length === 0 ? <EmptyPage title="No Memory Logs" description={submitted ? "No logs match this search." : "Working Agents will append short-term memories here."} /> : <div className="space-y-2">{items.map((log) => <LogRow key={log.id} log={log} selected={selectedIds.has(log.id)} onSelectedChange={(selected) => setSelectedIds((current) => { const next = new Set(current); if (selected) next.add(log.id); else next.delete(log.id); return next; })} onDelete={() => setDeleteTargetIds([log.id])} />)}</div>}
      {loading && <CenteredLoading compact />}
      {cursor && !loading && (
        <div className="flex items-center justify-center gap-3 py-2">
          <span className="text-xs text-[var(--color-text-muted)]">{formatNumber(items.length)} logs loaded</span>
          <Button variant="secondary" size="sm" onClick={() => void load(true)}>Load more logs</Button>
        </div>
      )}
    </div>
    <ConfirmDialog
      isOpen={deleteTargetIds.length > 0}
      title={deleteTargetIds.length === 1 ? "Delete Memory Log" : "Delete Memory Logs"}
      message={`Delete ${deleteTargetIds.length} selected ${plural(deleteTargetIds.length, "log", "logs")}? Deleted short-term observations will not be available to future organization runs.`}
      confirmLabel={deleting ? "Deleting…" : "Delete"}
      actionsDisabled={deleting}
      variant="danger"
      onConfirm={() => void confirmDelete()}
      onCancel={() => { if (!deleting) setDeleteTargetIds([]); }}
    />
  </div>;
}

function OrganizeMemoryButton({
  config,
  overview,
  runStarting,
  blockedByUnsavedChanges = false,
  onClick,
}: {
  config: MemoryConfig | null;
  overview: MemoryOverview;
  runStarting: boolean;
  blockedByUnsavedChanges?: boolean;
  onClick: () => void;
}) {
  const runOpen = overview.active_run_count > 0;
  const agentRunning = overview.in_progress_run_count > 0;
  return (
    <Button
      onClick={onClick}
      disabled={runStarting || !config?.enabled || runOpen || blockedByUnsavedChanges}
      title={blockedByUnsavedChanges ? "Save configuration changes before organizing Memory" : undefined}
      className="w-full flex-shrink-0 justify-center self-start sm:w-auto sm:self-auto"
    >
      {runStarting || agentRunning
        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        : runOpen
          ? <CircleAlert className="mr-2 h-4 w-4" />
          : <Play className="mr-2 h-4 w-4" />}
      {agentRunning
        ? "Organization running"
        : runOpen
          ? (overview.waiting_run_count > 0 ? "Organization waiting" : "Organization stopping")
          : blockedByUnsavedChanges
            ? "Save changes first"
            : overview.log_count > 0
              ? `Organize ${formatNumber(overview.log_count)} ${plural(overview.log_count, "log", "logs")}`
              : "Organize now"}
    </Button>
  );
}

function RunsTab({
  projectId,
  config,
  refreshTick,
  liveUpdates,
  onChanged,
}: {
  projectId: string;
  config: MemoryConfig | null;
  refreshTick: number;
  liveUpdates: MemoryRunStreamUpdate[];
  onChanged: () => void;
}) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [historyUsage, setHistoryUsage] = useState<MemoryOverview["usage"] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [finishingRunId, setFinishingRunId] = useState<string | null>(null);
  const historySequenceRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    if (!config || config.project_id !== projectId) {
      setRuns([]);
      setError(null);
      setLoading(Boolean(config && config.project_id !== projectId));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextRuns = await listAutomationRuns(projectId, config.organization.id);
      if (generation === loadGenerationRef.current) setRuns(nextRuns);
    } catch (reason) {
      if (generation === loadGenerationRef.current) setError(errorMessage(reason));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [projectId, config]);
  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshTick]);

  const latestUpdate = liveUpdates[liveUpdates.length - 1];
  useEffect(() => {
    if (!latestUpdate || latestUpdate.automation_id !== config?.organization.id) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (latestUpdate.run) {
        if (!isAgentRunning(latestUpdate.run.status)) {
          setFinishingRunId((current) =>
            current === latestUpdate.run_id ? null : current,
          );
        }
        setRuns((current) => {
          const index = current.findIndex((run) => run.id === latestUpdate.run_id);
          if (index < 0) return [latestUpdate.run!, ...current];
          const next = [...current];
          next[index] = latestUpdate.run!;
          return next;
        });
      }
      if (
        expanded === latestUpdate.run_id
        && latestUpdate.event
        && latestUpdate.sequence > historySequenceRef.current
      ) {
        historySequenceRef.current = latestUpdate.sequence;
        setHistory((current) => [...current, latestUpdate.event!]);
        if (latestUpdate.event.type === "complete") {
          void getMemoryRunHistory(projectId, latestUpdate.run_id)
            .then((response) => {
              if (!active) return;
              setHistory(response.events);
              setHistoryUsage(response.usage);
            })
            .catch((reason) => { if (active) setError(errorMessage(reason)); });
        }
      }
    });
    return () => { active = false; };
  }, [config?.organization.id, expanded, latestUpdate, projectId]);

  const toggle = (runId: string) => {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    historySequenceRef.current = liveUpdates[liveUpdates.length - 1]?.sequence ?? 0;
    setHistoryLoading(true);
    setHistory([]);
    setHistoryUsage(null);
  };
  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    const loadHistory = async () => {
      try {
        const response = await getMemoryRunHistory(projectId, expanded);
        if (disposed) return;
        setHistory(response.events);
        setHistoryUsage(response.usage);
        historySequenceRef.current = liveUpdates[liveUpdates.length - 1]?.sequence ?? 0;
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        if (!disposed) setHistoryLoading(false);
      }
    };
    void loadHistory();
    return () => { disposed = true; };
    // WebSocket events keep an active run current after this initial snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, projectId]);

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deleteMemoryRun(projectId, deleteTarget.id);
      setRuns((current) => current.filter((run) => run.id !== deleteTarget.id));
      if (expanded === deleteTarget.id) {
        setExpanded(null);
        setHistory([]);
        setHistoryUsage(null);
      }
      setDeleteTarget(null);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  const finishRun = async (run: AutomationRun) => {
    if (!config || finishingRunId) return;
    setFinishingRunId(run.id);
    try {
      await finishAutomationRun(projectId, config.organization.id, run.id);
    } catch (reason) {
      setFinishingRunId(null);
      setError(errorMessage(reason));
    }
  };

  const selectedRun = expanded
    ? runs.find((run) => run.id === expanded) ?? null
    : null;

  useEffect(() => {
    if (!selectedRun) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedRun]);

  if (!config) return <EmptyPage title="Memory is not configured" description="Open Overview, choose an Agent, and save the project settings first." />;
  return <div className="h-full min-h-0">
    <div className="h-full min-h-0 space-y-3 overflow-y-auto pr-1 pb-2">
      {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
      {!loading && runs.length === 0 ? <EmptyPage title="No organization runs" description="Use Run now from Overview or wait for the configured schedule." /> : runs.map((run) => (
      <div key={run.id} className={`rounded-2xl border overflow-hidden transition-colors ${expanded === run.id ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/[0.025]" : "border-[var(--color-border)]"}`}>
        <div className="px-4 py-4 flex items-center gap-3 hover:bg-[var(--color-bg-secondary)]/55 transition-colors">
          <button onClick={() => toggle(run.id)} className="min-w-0 flex-1 flex items-center gap-3 text-left">
            <RunStatus status={run.status} />
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate font-medium text-sm text-[var(--color-text)]">{runTitle(run)}</span><span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">{humanize(run.trigger_kind)}</span></div><p className="text-xs text-[var(--color-text-muted)] mt-1">{formatDate(run.triggered_at * 1000)} · {durationLabel(run)}{run.agent_snapshot ? ` · ${run.agent_snapshot}` : ""}</p></div>
            <RunCounts result={run.result} />
          </button>
          {["running", "waiting", "failed"].includes(run.status) && <Button variant="ghost" size="sm" disabled={finishingRunId === run.id} onClick={() => void finishRun(run)}>{finishingRunId === run.id ? "Finishing…" : "Finish"}</Button>}
          {!isTerminal(run.status) && <Button variant="ghost" size="sm" onClick={() => void cancelAutomationRun(projectId, config.organization.id, run.id)}>Cancel</Button>}
          {isTerminal(run.status) && <button type="button" onClick={() => setDeleteTarget(run)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)]" aria-label="Delete organization run" title="Delete run"><Trash2 className="h-4 w-4" /></button>}
          <button onClick={() => toggle(run.id)} className="p-1 text-[var(--color-text-muted)]" aria-label={expanded === run.id ? "Close run" : "Open run"}><ChevronRight className={`w-4 h-4 transition-transform ${expanded === run.id ? "rotate-180" : ""}`} /></button>
        </div>
      </div>
      ))}
      {loading && <CenteredLoading compact />}
    </div>

    {typeof document !== "undefined" && createPortal(
      <AnimatePresence>
        {selectedRun && (
          <>
            <motion.button
              key="memory-run-backdrop"
              type="button"
              aria-label="Close run"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setExpanded(null)}
              className="fixed inset-0 z-[80] cursor-default bg-black/25 backdrop-blur-[1px]"
            />
            <motion.section
              key={selectedRun.id}
              initial={{ x: "calc(100% + 2rem)", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "calc(100% + 2rem)", opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed bottom-4 right-4 top-4 z-[81] flex w-[min(72vw,1120px)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_24px_80px_rgba(0,0,0,0.28)] ring-1 ring-black/5"
              role="dialog"
              aria-modal="true"
              aria-label={runTitle(selectedRun)}
            >
              <header className="flex flex-shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-4 py-3 backdrop-blur-xl">
                <RunStatus status={selectedRun.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-medium text-[var(--color-text)]">{runTitle(selectedRun)}</h2>
                    <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{humanize(selectedRun.trigger_kind)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{formatDate(selectedRun.triggered_at * 1000)} · {durationLabel(selectedRun)}{selectedRun.agent_snapshot ? ` · ${selectedRun.agent_snapshot}` : ""}</p>
                </div>
                {["running", "waiting", "failed"].includes(selectedRun.status) && <Button variant="ghost" size="sm" disabled={finishingRunId === selectedRun.id} onClick={() => void finishRun(selectedRun)}>{finishingRunId === selectedRun.id ? "Finishing…" : "Finish"}</Button>}
                {!isTerminal(selectedRun.status) && <Button variant="ghost" size="sm" onClick={() => void cancelAutomationRun(projectId, config.organization.id, selectedRun.id)}>Cancel</Button>}
                <button type="button" onClick={() => setExpanded(null)} className="rounded-lg p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]" aria-label="Close run"><X className="h-4 w-4" /></button>
              </header>

              <div className="flex min-h-0 flex-1 bg-[var(--color-bg)]">
                {selectedRun.resolved_task_id === "_memory" && selectedRun.resolved_chat_id ? (
                  <TaskChat
                    key={selectedRun.id}
                    projectId={projectId}
                    taskId={selectedRun.resolved_task_id}
                    fixedChatId={selectedRun.resolved_chat_id}
                    sessionManagement={false}
                    finished={isTerminal(selectedRun.status)}
                    fullscreen
                    hideHeader
                  />
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <RunTranscript
                      events={history}
                      usage={historyUsage}
                      loading={historyLoading}
                      active={isAgentRunning(selectedRun.status)}
                      error={selectedRun.error}
                      summary={typeof selectedRun.result?.summary === "string" ? selectedRun.result.summary : undefined}
                    />
                  </div>
                )}
              </div>
            </motion.section>
          </>
        )}
      </AnimatePresence>,
      document.body,
    )}

    <ConfirmDialog
      isOpen={Boolean(deleteTarget)}
      title="Delete Run"
      message="Delete this completed organization run, its process history, and its recorded token usage? Memory documents produced by the run will not be changed."
      confirmLabel={deleting ? "Deleting…" : "Delete"}
      actionsDisabled={deleting}
      variant="danger"
      onConfirm={() => void confirmDelete()}
      onCancel={() => { if (!deleting) setDeleteTarget(null); }}
    />
  </div>;
}

type ScheduleKind = "hourly" | "daily" | "weekly" | "custom";

const SCHEDULE_KIND_OPTIONS: ComboboxOption[] = [
  { id: "memory-hourly", label: "Hourly", value: "hourly" },
  { id: "memory-daily", label: "Daily", value: "daily" },
  { id: "memory-weekly", label: "Weekly", value: "weekly" },
  { id: "memory-custom", label: "Custom", value: "custom" },
];
const SCHEDULE_HOUR_OPTIONS: ComboboxOption[] = Array.from({ length: 24 }, (_, hour) => ({ id: `hour-${hour}`, label: String(hour).padStart(2, "0"), value: String(hour) }));
const SCHEDULE_MINUTE_OPTIONS: ComboboxOption[] = Array.from({ length: 60 }, (_, minute) => ({ id: `minute-${minute}`, label: String(minute).padStart(2, "0"), value: String(minute) }));
const SCHEDULE_INTERVAL_OPTIONS: ComboboxOption[] = [1, 2, 3, 4, 6, 8, 12].map((hours) => ({ id: `interval-${hours}`, label: `${hours} hr${hours === 1 ? "" : "s"}`, value: String(hours) }));
const SCHEDULE_DAY_OPTIONS: ComboboxOption[] = [
  { id: "weekdays", label: "Weekdays", value: "1,2,3,4,5" },
  { id: "weekends", label: "Weekends", value: "0,6" },
  { id: "monday", label: "Monday", value: "1" },
  { id: "tuesday", label: "Tuesday", value: "2" },
  { id: "wednesday", label: "Wednesday", value: "3" },
  { id: "thursday", label: "Thursday", value: "4" },
  { id: "friday", label: "Friday", value: "5" },
  { id: "saturday", label: "Saturday", value: "6" },
  { id: "sunday", label: "Sunday", value: "0" },
];

function ScheduleField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const detectedKind = detectScheduleKind(value);
  const [kind, setKind] = useState<ScheduleKind>(detectedKind);
  const parts = value.trim().split(/\s+/);
  const minute = parseSchedulePart(parts[0], 0);
  const hour = parseSchedulePart(parts[1], 2);
  const interval = parts[1]?.startsWith("*/") ? parseSchedulePart(parts[1].slice(2), 1) : 1;
  const day = parts[4] && parts[4] !== "*" ? parts[4] : "1";

  useEffect(() => {
    if (kind !== "custom" && detectedKind !== kind) {
      void Promise.resolve().then(() => setKind(detectedKind));
    }
  }, [detectedKind, kind]);

  const changeKind = (next: string) => {
    const scheduleKind = next as ScheduleKind;
    setKind(scheduleKind);
    if (scheduleKind === "hourly") onChange("0 */1 * * *");
    if (scheduleKind === "daily") onChange(`${minute} ${hour} * * *`);
    if (scheduleKind === "weekly") onChange(`${minute} ${hour} * * 1`);
  };

  return (
    <div className="flex w-full flex-nowrap items-center gap-1.5">
      <div className="w-[88px] flex-shrink-0"><Combobox options={SCHEDULE_KIND_OPTIONS} value={kind} onChange={changeKind} allowCustom={false} size="compact" /></div>
      {kind === "hourly" && <><span className="flex-shrink-0 text-xs text-[var(--color-text-muted)]">Every</span><div className="w-[68px] flex-shrink-0"><Combobox options={SCHEDULE_INTERVAL_OPTIONS} value={String(interval)} onChange={(next) => onChange(`${minute} */${next} * * *`)} allowCustom={false} size="compact" /></div><span className="flex-shrink-0 text-xs text-[var(--color-text-muted)]">at minute</span><div className="w-16 flex-shrink-0"><Combobox options={SCHEDULE_MINUTE_OPTIONS} value={String(minute)} onChange={(next) => onChange(`${next} */${interval} * * *`)} allowCustom={false} size="compact" /></div></>}
      {kind === "daily" && <><span className="flex-shrink-0 text-xs text-[var(--color-text-muted)]">At</span><ScheduleTime hour={hour} minute={minute} onChange={(nextHour, nextMinute) => onChange(`${nextMinute} ${nextHour} * * *`)} /></>}
      {kind === "weekly" && <><div className="w-[102px] flex-shrink-0"><Combobox options={SCHEDULE_DAY_OPTIONS} value={day} onChange={(next) => onChange(`${minute} ${hour} * * ${next}`)} allowCustom={false} size="compact" /></div><span className="flex-shrink-0 text-xs text-[var(--color-text-muted)]">at</span><ScheduleTime hour={hour} minute={minute} onChange={(nextHour, nextMinute) => onChange(`${nextMinute} ${nextHour} * * ${day}`)} /></>}
      {kind === "custom" && <div className="min-w-0 flex-1"><Input value={value} onChange={(event) => onChange(event.target.value)} placeholder="0 2 * * *" className="h-8 min-w-0 font-mono text-xs" /></div>}
    </div>
  );
}

function describeSchedule(value: string) {
  try {
    return cronstrue.toString(value, { use24HourTimeFormat: true });
  } catch {
    return "Enter a valid cron expression.";
  }
}

function ScheduleTime({ hour, minute, onChange }: { hour: number; minute: number; onChange: (hour: number, minute: number) => void }) {
  return <div className="flex min-w-0 items-center gap-1"><div className="w-16 flex-shrink-0"><Combobox options={SCHEDULE_HOUR_OPTIONS} value={String(hour)} onChange={(next) => onChange(parseSchedulePart(next, 0), minute)} allowCustom={false} size="compact" /></div><span className="font-mono text-xs text-[var(--color-text-muted)]">:</span><div className="w-16 flex-shrink-0"><Combobox options={SCHEDULE_MINUTE_OPTIONS} value={String(minute)} onChange={(next) => onChange(hour, parseSchedulePart(next, 0))} allowCustom={false} size="compact" /></div></div>;
}

function detectScheduleKind(cron: string): ScheduleKind {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "custom";
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && hour.startsWith("*/") && /^\d+$/.test(minute)) return "hourly";
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && /^\d+$/.test(hour) && /^\d+$/.test(minute)) return "daily";
  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*" && /^\d+$/.test(hour) && /^\d+$/.test(minute)) return "weekly";
  return "custom";
}

function parseSchedulePart(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function LogRow({ log, selected, onSelectedChange, onDelete }: { log: MemoryLog; selected: boolean; onSelectedChange: (selected: boolean) => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const sourceLabel = log.task_id === "_studio_memory_migration"
    ? "Legacy Studio import"
    : `Task ${shortId(log.task_id)}`;
  return (
    <div className={`group flex w-full items-start gap-2 rounded-xl border px-3 py-3 transition-colors hover:bg-[var(--color-bg-secondary)]/35 ${selected ? "border-[var(--color-highlight)]/55 bg-[var(--color-highlight)]/4" : "border-[var(--color-border)]"}`}>
      <label className="mt-1 flex h-7 w-6 flex-shrink-0 cursor-pointer items-center justify-center" aria-label={`Select ${log.title}`}>
        <input type="checkbox" checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-highlight)]" />
      </label>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="flex min-w-0 flex-1 gap-3 text-left">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)]">
          <Activity className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">{log.title}</h3>
            <span className="flex-shrink-0 text-[10px] text-[var(--color-text-muted)]">{formatDate(log.created_at)}</span>
          </div>
          <p className={`mt-1 text-sm leading-relaxed text-[var(--color-text-muted)] ${expanded ? "whitespace-pre-wrap" : "line-clamp-1"}`}>{log.description}</p>
          <div className={`mt-2 flex items-center gap-1.5 ${expanded ? "flex-wrap" : "overflow-hidden"}`}>
            {log.tags.map((tag) => <span key={tag} className="flex-shrink-0 rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">#{tag}</span>)}
            <span className="flex-shrink-0 text-[10px] text-[var(--color-text-muted)]">{sourceLabel}{log.agent ? ` · ${log.agent}` : ""}</span>
          </div>
        </div>
        <span className="mt-1 flex-shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      <button type="button" onClick={onDelete} className="mt-0.5 rounded-lg p-2 text-[var(--color-text-muted)] opacity-0 transition-all hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete ${log.title}`}><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}

type MemoryRunActivity =
  | { kind: "message"; id: string; text: string }
  | { kind: "tool"; id: string; tools: ToolCallMessage[] }
  | { kind: "error"; id: string; text: string };

type MemoryRunActivitySource =
  | { kind: "message"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolCallMessage }
  | { kind: "error"; id: string; text: string };

function RunTranscript({
  events,
  usage,
  loading,
  active,
  error,
  summary,
}: {
  events: Record<string, unknown>[];
  usage: MemoryOverview["usage"] | null;
  loading: boolean;
  active: boolean;
  error?: string;
  summary?: string;
}) {
  const rows = normalizeRunActivities(events);
  if (loading) return <CenteredLoading compact />;
  if (rows.length === 0 && !error) return <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)] py-5">{active && <Loader2 className="w-4 h-4 animate-spin" />}{active ? "Waiting for live Agent activity…" : "No process events were recorded."}</div>;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
        {active && <span className="inline-flex items-center gap-1.5 font-medium text-[var(--color-highlight)]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />Live</span>}
        <span>{compactNumber(usage?.total_tokens ?? 0)} tokens</span>
        <span>{compactNumber(usage?.input_tokens ?? 0)} input</span>
        <span>{compactNumber(usage?.output_tokens ?? 0)} output</span>
        <span>{formatCosts(usage?.cost_by_currency ?? {})}</span>
      </div>
      <div>
        {error && <InlineNotice tone="error" message={error} />}
        <div className="relative ml-2 space-y-3 border-l border-[var(--color-border)] pb-1 pl-5">
          {rows.map((row) => <RunActivityRow key={row.id} row={row} />)}
          {!active && summary && (
            <div className="relative rounded-xl border border-[var(--color-success)]/20 bg-[var(--color-success)]/6 px-3 py-2.5">
              <span className="absolute -left-[27px] top-3 flex h-3 w-3 items-center justify-center rounded-full bg-[var(--color-bg)] ring-4 ring-[var(--color-bg-secondary)]">
                <CircleCheck className="h-3.5 w-3.5 text-[var(--color-success)]" />
              </span>
              <p className="text-sm font-medium text-[var(--color-text)]">Organization completed</p>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">{summary}</p>
            </div>
          )}
          {active && (
            <div className="relative flex items-center gap-2 py-1 text-xs text-[var(--color-text-muted)]">
              <span className="absolute -left-[25px] h-2 w-2 animate-pulse rounded-full bg-[var(--color-highlight)] ring-4 ring-[var(--color-bg-secondary)]" />
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the next update
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunActivityRow({ row }: { row: MemoryRunActivity }) {
  if (row.kind === "message") {
    return (
      <div className="relative rounded-xl bg-[var(--color-bg)] px-3 py-2.5">
        <span className="absolute -left-[27px] top-3 h-3 w-3 rounded-full border-2 border-[var(--color-highlight)] bg-[var(--color-bg)] ring-4 ring-[var(--color-bg-secondary)]" />
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Agent update</p>
        <div className="text-sm leading-relaxed"><MarkdownRenderer content={row.text} /></div>
      </div>
    );
  }
  if (row.kind === "error") {
    return (
      <div className="relative rounded-xl bg-[var(--color-error)]/8 px-3 py-2.5 text-sm text-[var(--color-error)]">
        <CircleAlert className="absolute -left-[28px] top-3 h-4 w-4 bg-[var(--color-bg-secondary)] ring-4 ring-[var(--color-bg-secondary)]" />
        <p className="font-medium">Agent error</p>
        <p className="mt-0.5 text-xs leading-relaxed">{row.text}</p>
      </div>
    );
  }
  return <RunToolActivity tools={row.tools} />;
}

function RunToolActivity({ tools }: { tools: ToolCallMessage[] }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const presentation = memoryToolGroupPresentation(tools);
  const failed = tools.some((item) => ["failed", "error", "cancelled", "canceled"].includes(item.status));
  const running = tools.some((item) => ["running", "in_progress", "pending"].includes(item.status));
  const StatusIcon = running ? Loader2 : failed ? CircleAlert : Check;
  const hasDetails = tools.some((item) => hasReadableToolInput(item.input) || hasReadableToolOutput(item.output, item.content ?? ""));
  const status = memoryToolGroupStatus(tools);
  return (
    <div className="relative border-b border-[var(--color-border)]/65 py-2.5 last:border-0">
      <span className={`absolute -left-[28px] top-3.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-bg)] ring-4 ring-[var(--color-bg-secondary)] ${failed ? "text-[var(--color-error)]" : "text-[var(--color-highlight)]"}`}>
        <StatusIcon className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
      </span>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/8 text-[var(--color-highlight)]">
          <presentation.Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium text-[var(--color-text)]">{presentation.title}</p>
            {tools.length > 1 && <span className="flex-shrink-0 rounded-md bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]">×{tools.length}</span>}
            <span className={`flex-shrink-0 text-[10px] ${failed ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]"}`}>{status}</span>
          </div>
          {presentation.description && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-[var(--color-text-muted)]">{presentation.description}</p>}
          {hasDetails && (
            <button type="button" onClick={() => setDetailsOpen((value) => !value)} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]">
              {detailsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Technical details{tools.length > 1 ? ` · ${tools.length} operations` : ""}
            </button>
          )}
        </div>
      </div>
      {detailsOpen && <RunToolDetails tools={tools} />}
    </div>
  );
}

function RunToolDetails({ tools }: { tools: ToolCallMessage[] }) {
  return (
    <div className="mt-2.5 space-y-1 rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/45 px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
      {tools.map((tool, index) => <RunToolDetail key={tool.id} tool={tool} index={tools.length > 1 ? index : undefined} />)}
    </div>
  );
}

function RunToolDetail({ tool, index }: { tool: ToolCallMessage; index?: number }) {
  const input = (tool.input ?? []).filter((field) => !["server", "tool"].includes(field.label.trim().toLowerCase()));
  const failure = readableToolFailure(tool);
  const presentation = memoryToolPresentation(tool);
  return (
    <details className="group border-b border-[var(--color-border)]/70 py-1.5 last:border-0" open={index === undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-[var(--color-text)] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 flex-shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1 truncate">{index === undefined ? presentation.title : `${index + 1}. ${presentation.description || presentation.title}`}</span>
        <span className={`flex-shrink-0 text-[10px] ${failure ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]"}`}>{failure ? "Failed" : humanize(tool.status)}</span>
      </summary>
      <div className="ml-5 mt-2 space-y-2">
        {input.map((field) => <RunToolField key={field.label} field={field} />)}
        {failure && (
          <div className="rounded-md bg-[var(--color-error)]/8 px-2.5 py-2">
            <p className="font-medium text-[var(--color-error)]">Failure reason</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-[var(--color-text)]">{failure}</p>
          </div>
        )}
        {!input.length && !failure && <span>No additional details.</span>}
      </div>
    </details>
  );
}

function RunToolField({ field }: { field: { label: string; value: string } }) {
  const label = field.label.replace(/^Parameters\s*·\s*/i, "");
  const large = field.value.length > 700 || field.value.split("\n").length > 8;
  const value = readableToolFieldValue(field.value);
  if (large) {
    return (
      <details className="rounded-md border border-[var(--color-border)]/70 bg-[var(--color-bg)]/70 px-2.5 py-2">
        <summary className="cursor-pointer text-[var(--color-text)]">{label} <span className="text-[var(--color-text-muted)]">· {formatNumber(field.value.length)} characters</span></summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[var(--color-text)]">{truncateText(value, 6000)}</pre>
      </details>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(88px,auto)_1fr] gap-3">
      <span>{label}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-[var(--color-text)]">{value}</span>
    </div>
  );
}

function SearchBar({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }} className="relative max-w-xl"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" /></form>;
}

function Score({ value }: { value: number }) { return <span title="Current score" className="text-[10px] tabular-nums px-2 py-1 rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]">Score {value}</span>; }
function TagList({ tags, compact = false }: { tags: { key: string; value: string; icon?: string }[]; compact?: boolean }) { if (!tags.length) return null; return <div className={`flex flex-wrap gap-1.5 ${compact ? "mt-3" : "mt-5"}`}>{tags.map((tag) => <span key={`${tag.key}:${tag.value}`} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">{tag.icon || <Tag className="w-2.5 h-2.5" />}<span>{tag.key}</span><span className="text-[var(--color-text)]">{tag.value}</span></span>)}</div>; }

function InlineNotice({ tone, message, onClose }: { tone: "success" | "error"; message: string; onClose?: () => void }) { const Icon = tone === "success" ? CircleCheck : CircleAlert; return <div className={`my-3 rounded-xl px-3 py-2.5 flex items-start gap-2 text-sm ${tone === "success" ? "bg-[var(--color-success)]/10 text-[var(--color-success)]" : "bg-[var(--color-error)]/10 text-[var(--color-error)]"}`}><Icon className="w-4 h-4 mt-0.5 flex-shrink-0" /><span className="flex-1">{message}</span>{onClose && <button onClick={onClose}><X className="w-3.5 h-3.5" /></button>}</div>; }
function CenteredLoading({ compact = false }: { compact?: boolean }) { return <div className={`flex items-center justify-center text-[var(--color-text-muted)] ${compact ? "py-5" : "py-16"}`}><Loader2 className="w-5 h-5 animate-spin" /></div>; }
function EmptyPage({ title, description }: { title: string; description: string }) { return <div className="min-h-[360px] flex items-center justify-center"><div className="text-center max-w-sm"><div className="mx-auto w-11 h-11 rounded-xl bg-[var(--color-bg-secondary)] flex items-center justify-center"><Brain className="w-5 h-5 text-[var(--color-text-muted)]" /></div><h2 className="mt-4 font-semibold text-[var(--color-text)]">{title}</h2><p className="mt-2 text-sm text-[var(--color-text-muted)] leading-relaxed">{description}</p></div></div>; }

function RunStatus({ status }: { status: string }) {
  if (status === "success") return <div title="Completed" className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--color-success)]/10 text-[var(--color-success)]"><CircleCheck className="w-4 h-4" /></div>;
  if (status === "cancelled") return <div title="Cancelled" className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></div>;
  if (status === "waiting") return <div title="Waiting" className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--color-warning)]/10 text-[var(--color-warning)]"><CircleAlert className="w-4 h-4" /></div>;
  if (status === "failed") return <div title="Failed" className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--color-error)]/10 text-[var(--color-error)]"><CircleX className="w-4 h-4" /></div>;
  return <div title="In Progress" className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"><Loader2 className="w-4 h-4 animate-spin" /></div>;
}
function RunCounts({ result }: { result?: Record<string, unknown> }) { if (!result) return null; const changed = ["entities_created", "entities_updated", "entities_deleted"].reduce((sum, key) => sum + Number(result[key] ?? 0), 0); return <div className="hidden sm:flex items-center gap-3 text-xs text-[var(--color-text-muted)]"><span>{changed} memories changed</span><span>{Number(result.relations_changed ?? 0)} relations</span></div>; }

function configToDraft(config: MemoryConfig | null): MemoryConfigInput { return config ? { enabled: config.enabled, deep_organization: config.deep_organization, pending_log_threshold: config.pending_log_threshold, organization_enabled: config.organization.enabled, agent_config: config.organization.agent_config, schedule_cron: config.organization.schedule_cron, event_triggers: config.organization.event_triggers } : { ...DEFAULT_DRAFT, event_triggers: [...DEFAULT_DRAFT.event_triggers] }; }
function sameMemoryConfig(left: MemoryConfigInput, right: MemoryConfigInput) {
  const stableAgentConfig = (config: AgentConfigSelection) => config.source === "config_options"
    ? { ...config, values: Object.fromEntries(Object.entries(config.values).sort(([a], [b]) => a.localeCompare(b))) }
    : config;
  return left.enabled === right.enabled
    && left.deep_organization === right.deep_organization
    && left.pending_log_threshold === right.pending_log_threshold
    && left.organization_enabled === right.organization_enabled
    && left.schedule_cron === right.schedule_cron
    && JSON.stringify([...left.event_triggers].sort()) === JSON.stringify([...right.event_triggers].sort())
    && JSON.stringify(stableAgentConfig(left.agent_config)) === JSON.stringify(stableAgentConfig(right.agent_config));
}
function errorMessage(reason: unknown) { if (reason instanceof Error) return reason.message; if (typeof reason === "object" && reason && "message" in reason) return String(reason.message); return "Something went wrong."; }
function formatNumber(value: number) { return new Intl.NumberFormat().format(value); }
function compactNumber(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatDate(value: string | number) { const date = typeof value === "number" ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function relativeDate(value: string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
function formatCosts(costs: Record<string, number>) { const entries = Object.entries(costs); if (!entries.length) return "No reported cost"; return entries.map(([currency, amount]) => `${amount.toFixed(2)} ${currency.toUpperCase()}`).join(" · "); }
function formatMetricCost(costs: Record<string, number>) {
  const entries = Object.entries(costs);
  if (entries.length === 0) return "—";
  return entries.map(([currency, amount]) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency.toUpperCase(),
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
    }
  }).join(" · ");
}
function humanize(value: string) { return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function plural(value: number, singular: string, pluralValue: string) { return value === 1 ? singular : pluralValue; }
function relativeTime(timestampSeconds: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestampSeconds);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
function lastOrganizedText(timestampSeconds?: number) { return timestampSeconds ? `Last organized ${relativeTime(timestampSeconds)} ago` : "Not organized yet"; }
function shortId(value: string) { return value.length > 10 ? `${value.slice(0, 8)}…` : value; }
function isTerminal(status: string) { return status === "success" || status === "cancelled"; }
function isAgentRunning(status: string) { return status === "queued" || status === "running"; }
function durationLabel(run: AutomationRun) { const end = run.completed_at ?? Math.floor(Date.now() / 1000); const start = run.started_at ?? run.triggered_at; const seconds = Math.max(0, end - start); if (seconds < 60) return `${seconds}s`; return `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function runTitle(run: AutomationRun) {
  if (run.trigger_kind === "manual") return "Manual organization";
  if (["cron", "schedule", "scheduled"].includes(run.trigger_kind)) return "Scheduled organization";
  if (["event", "task", "task.finished"].includes(run.trigger_kind)) return "Task-triggered organization";
  return "Memory organization";
}

function normalizeRunActivities(events: Record<string, unknown>[]): MemoryRunActivity[] {
  const rows: MemoryRunActivitySource[] = [];
  const toolIndexes = new Map<string, number>();
  let messageIndex = 0;
  for (const event of events) {
    const type = String(event.type ?? "");
    let chunk = "";
    if (type === "message_chunk") chunk = String(event.text ?? "");
    if (type === "message_content_chunk" && typeof event.content === "object" && event.content && "text" in event.content) {
      chunk = String((event.content as { text?: unknown }).text ?? "");
    }
    if (chunk) {
      const previous = rows[rows.length - 1];
      if (previous?.kind === "message") previous.text += chunk;
      else rows.push({ kind: "message", id: `message-${messageIndex++}`, text: chunk });
      continue;
    }
    if (type === "tool_call" || type === "tool_call_v1") {
      const toolEvent = { ...event, type };
      const id = String(event.id ?? `tool-${rows.length}`);
      const previousIndex = toolIndexes.get(id);
      const previous = previousIndex === undefined ? undefined : rows[previousIndex];
      const tool = applyToolCallCreated(previous?.kind === "tool" ? previous.tool : undefined, toolEvent);
      if (previousIndex === undefined) {
        toolIndexes.set(id, rows.length);
        rows.push({ kind: "tool", id: `tool-${id}`, tool });
      } else {
        rows[previousIndex] = { kind: "tool", id: `tool-${id}`, tool };
      }
      continue;
    }
    if (type === "tool_call_update" || type === "tool_call_update_v1") {
      const toolEvent = { ...event, type };
      const id = String(event.id ?? `tool-${rows.length}`);
      const previousIndex = toolIndexes.get(id);
      const previous = previousIndex === undefined ? undefined : rows[previousIndex];
      const previousTool = previous?.kind === "tool" ? previous.tool : undefined;
      if (!canApplyToolCallUpdate(previousTool, toolEvent)) continue;
      const tool = applyToolCallUpdated(previousTool, toolEvent);
      if (previousIndex === undefined) {
        toolIndexes.set(id, rows.length);
        rows.push({ kind: "tool", id: `tool-${id}`, tool });
      } else {
        rows[previousIndex] = { kind: "tool", id: `tool-${id}`, tool };
      }
      continue;
    }
    if (type === "error") {
      rows.push({ kind: "error", id: `error-${rows.length}`, text: String(event.message ?? "Unknown error") });
    }
  }
  return groupRunActivities(rows.filter((row) => row.kind !== "message" || row.text.trim().length > 0));
}

function groupRunActivities(rows: MemoryRunActivitySource[]): MemoryRunActivity[] {
  const grouped: MemoryRunActivity[] = [];
  const segmentGroups = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "tool") {
      segmentGroups.clear();
      grouped.push(row);
      continue;
    }
    const key = memoryToolGroupKey(row.tool);
    const existingIndex = segmentGroups.get(key);
    const existing = existingIndex === undefined ? undefined : grouped[existingIndex];
    if (existing?.kind === "tool") {
      existing.tools.push(row.tool);
    } else {
      segmentGroups.set(key, grouped.length);
      grouped.push({ kind: "tool", id: row.id, tools: [row.tool] });
    }
  }
  return grouped;
}

function memoryToolGroupKey(tool: ToolCallMessage) {
  const toolName = memoryToolName(tool);
  if (toolName.includes("memory_create_entity")) return "create-memory";
  if (toolName.includes("memory_delete_entity")) return "delete-memory";
  if (toolName.includes("memory_update_relations")) return "update-relations";
  if (toolName.includes("memory_mark_organization_finished")) return "publish-memory";
  if (toolName.includes("apply_patch") || toolName.includes("edit") || toolName.includes("write")) return "edit-documents";
  if (
    toolName.includes("memory_get_")
    || toolName.includes("read")
    || toolName.includes("glob")
    || toolName.includes("grep")
    || toolName === "rg"
    || toolName === "md"
    || /\.md(?:\b|['"*])/i.test(tool.title)
    || toolName.includes("exec")
    || tool.kind === "search"
    || tool.kind === "execute"
  ) return "review-context";
  const presentation = memoryToolPresentation(tool);
  return `tool:${presentation.title}`;
}

function memoryToolGroupPresentation(tools: ToolCallMessage[]): { title: string; description: string; Icon: typeof Database } {
  if (tools.length === 1) return memoryToolPresentation(tools[0]);
  const key = memoryToolGroupKey(tools[0]);
  const failed = tools.filter((tool) => ["failed", "error", "cancelled", "canceled"].includes(tool.status)).length;
  const completed = tools.filter((tool) => !["running", "in_progress", "pending", "failed", "error", "cancelled", "canceled"].includes(tool.status)).length;
  if (key === "review-context") return { title: "Reviewed project context", description: "Checked pending logs, recent chats, existing Memory, relations, and supporting project files.", Icon: Search };
  if (key === "create-memory") return { title: "Created durable memories", description: `${completed} completed${failed ? `, ${failed} failed` : ""} across ${tools.length} attempts.`, Icon: FileText };
  if (key === "delete-memory") return { title: "Removed durable memories", description: `${tools.length} managed memory documents were reviewed for removal.`, Icon: X };
  if (key === "update-relations") return { title: "Updated memory relations", description: `${tools.length} relation update operations were applied.`, Icon: GitCompare };
  if (key === "edit-documents") return { title: "Updated memory documents", description: `${tools.length} Markdown editing operations were applied.`, Icon: PencilLine };
  const first = memoryToolPresentation(tools[0]);
  return { ...first, description: `${tools.length} related operations.` };
}

function memoryToolGroupStatus(tools: ToolCallMessage[]) {
  const running = tools.filter((tool) => ["running", "in_progress", "pending"].includes(tool.status)).length;
  const failed = tools.filter((tool) => ["failed", "error", "cancelled", "canceled"].includes(tool.status)).length;
  const completed = tools.length - running - failed;
  const parts = [];
  if (completed) parts.push(`${completed} completed`);
  if (failed) parts.push(`${failed} failed`);
  if (running) parts.push(`${running} running`);
  return parts.join(" · ");
}

function memoryToolPresentation(tool: ToolCallMessage): { title: string; description: string; Icon: typeof Database } {
  const toolName = memoryToolName(tool);
  const title = toolInputValue(tool, "title");
  const summary = toolInputValue(tool, "summary");
  const path = toolInputValue(tool, "path") || tool.locations?.[0]?.path;
  const operations = toolInputValue(tool, "operations");
  if (toolName.includes("memory_get_pending_logs")) return { title: "Reviewed pending Memory Logs", description: "Loaded short-term observations waiting to be organized.", Icon: Activity };
  if (toolName.includes("memory_get_recent_chats")) return { title: "Reviewed recent project chats", description: "Collected recent conversation context since the previous organization run.", Icon: Search };
  if (toolName.includes("memory_get_directory")) return { title: "Opened the Memory workspace", description: "Located the managed Markdown documents for this project.", Icon: FolderOpen };
  if (toolName.includes("memory_get_relations")) return { title: "Reviewed existing relations", description: "Compared current links before changing the memory graph.", Icon: Link2 };
  if (toolName.includes("memory_get_entities")) return { title: "Reviewed existing memories", description: "Loaded the current durable-memory snapshot for comparison.", Icon: Database };
  if (toolName.includes("memory_create_entity")) return { title: "Created a durable memory", description: title || "Registered a new managed Markdown document.", Icon: FileText };
  if (toolName.includes("memory_delete_entity")) return { title: "Removed a durable memory", description: title || "Removed a managed memory that was no longer useful.", Icon: X };
  if (toolName.includes("memory_update_relations")) return { title: "Updated memory relations", description: operations ? `${shortStructuredValue(operations)}.` : "Applied the selected links and relation strengths.", Icon: GitCompare };
  if (toolName.includes("memory_mark_organization_finished")) return { title: "Published organized Memory", description: summary || "Validated the snapshot and completed the organization run.", Icon: CircleCheck };
  if (toolName.includes("apply_patch") || toolName.includes("edit") || toolName.includes("write")) return { title: "Updated a memory document", description: path ? compactPath(path) : "Edited managed Markdown content.", Icon: PencilLine };
  if (toolName.includes("read") || toolName.includes("glob") || toolName.includes("grep") || toolName === "rg" || toolName === "md" || /\.md(?:\b|['"*])/i.test(tool.title) || tool.kind === "search") return { title: "Inspected project evidence", description: path ? compactPath(path) : "Read relevant project files and memory documents.", Icon: Search };
  if (toolName.includes("exec") || tool.kind === "execute") return { title: "Inspected the project workspace", description: "Ran a supporting workspace operation; technical output is hidden by default.", Icon: Terminal };
  return { title: humanize(toolName || "Tool activity"), description: "Supporting Agent operation.", Icon: Activity };
}

function memoryToolName(tool: ToolCallMessage) {
  const explicitToolName = toolInputValue(tool, "tool");
  if (explicitToolName) return explicitToolName.toLowerCase();

  // Agent-provided titles are often readable sentences and may contain file
  // extensions (for example, "Search for '*.md' in entities"). Only strip a
  // namespace from identifiers that actually look like qualified tool names.
  const qualifiedToolName = tool.title.match(/(?:^|[/.])([a-z][a-z0-9_-]+)$/i)?.[1];
  return (qualifiedToolName || tool.title).toLowerCase();
}

function toolInputValue(tool: ToolCallMessage, field: string) {
  const normalized = field.toLowerCase();
  return tool.input?.find((item) => item.label.toLowerCase().split("·").pop()?.trim() === normalized)?.value.trim() ?? "";
}

function compactPath(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join("/");
}

function shortStructuredValue(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return `${parsed.length} relation ${plural(parsed.length, "change", "changes")}`;
  } catch { /* readable fallback below */ }
  return truncateText(value.replace(/\s+/g, " "), 120);
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n… remaining details hidden` : value;
}

function readableToolFieldValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : String(parsed);
  } catch {
    return value;
  }
}

function readableToolFailure(tool: ToolCallMessage) {
  if (!["failed", "error", "cancelled", "canceled"].includes(tool.status)) return "";
  const raw = tool.content?.trim() ?? "";
  const message = findErrorMessage(parseJsonValue(raw)) || raw;
  const mcpReason = message.match(/MCP error:\s*-?\d+:\s*([^\n]+)/i)?.[1];
  if (mcpReason) return mcpReason.trim();
  const withoutStack = message.split(/\n(?:Stack backtrace|Backtrace):/i)[0];
  const causedBy = withoutStack.split(/\n\s*Caused by:\s*\n/i).pop() ?? withoutStack;
  return truncateText(causedBy.replace(/^tool call error:\s*/i, "").trim(), 800);
}

function parseJsonValue(value: string): unknown {
  if (!value) return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

function findErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    if (parsed !== value) return findErrorMessage(parsed);
    return /(?:error|failed|caused by|must be|invalid|denied)/i.test(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = findErrorMessage(item);
      if (message) return message;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if ("error" in record) {
    const message = findErrorMessage(record.error);
    if (message) return message;
  }
  for (const child of Object.values(record)) {
    const message = findErrorMessage(child);
    if (message) return message;
  }
  return "";
}

function useMemoryRunUpdates(projectId: string | null, automationId: string | undefined, onUpdate: (update: Omit<MemoryRunStreamUpdate, "sequence">) => void) {
  useEffect(() => {
    if (!projectId || !automationId) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    const connect = async () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = await appendHmacToUrl(`${protocol}//${getApiHost()}/api/v1/projects/${projectId}/automation-runs/ws`);
      if (disposed) return;
      ws = new WebSocket(url);
      ws.onmessage = (message) => {
        try {
          const update = JSON.parse(message.data) as {
            automation_id?: string;
            run_id?: string;
            run?: AutomationRun;
            event?: Record<string, unknown>;
          };
          const updateAutomationId = update.automation_id ?? update.run?.automation_id;
          const updateRunId = update.run_id ?? update.run?.id;
          if (updateAutomationId === automationId && updateRunId) {
            onUpdate({
              automation_id: updateAutomationId,
              run_id: updateRunId,
              run: update.run,
              event: update.event,
            });
          }
        } catch { /* ignore malformed updates */ }
      };
      ws.onclose = () => {
        if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 1500);
      };
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [projectId, automationId, onUpdate]);
}
