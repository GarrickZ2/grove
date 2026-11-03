import { motion } from "framer-motion";
import { ArrowRight, Calendar, Coins, GitCommit, FileCode, Clock, Loader2, GitBranch, Info, Link2, Sparkles, X } from "lucide-react";
import type { Task } from "../../../../data/types";
import { useProject, useTheme } from "../../../../context";
import { getProjectStyle } from "../../../../utils/projectStyle";
import { ProjectTypeBadge } from "../../../ui/ProjectTypeBadge";
import { useOrbitInterface } from "../../../../orbit/ui/interfaceContext";
import { OrbitInfoPanel } from "../../../../orbit/workspace/panels/OrbitInfoPanel";
import { formatCost, formatDuration, formatTokens } from "../../../Stats/formatters";
import { LinkedProjectPicker } from "./LinkedProjectPicker";
import { openLinkedProject, useTaskLinkedProjects, useTaskStats } from "./useTaskStats";

interface StatsTabProps {
  projectId: string;
  task: Task;
  /** Orbit body (also chosen whenever the Orbit interface is on). */
  variant?: "default" | "orbit";
}

function formatDate(date: Date | undefined, timeAgo?: string): string {
  // Prefer pre-formatted timeAgo if available
  if (timeAgo) return timeAgo;
  if (!date) return "";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface StatCardProps {
  icon: typeof Calendar;
  label: string;
  value: string | number;
  subValue?: string;
  delay?: number;
}

function StatCard({ icon: Icon, label, value, subValue, delay = 0 }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
    >
      <div className="flex items-center gap-2 text-[var(--color-text-muted)] mb-2 select-none">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-xl font-semibold text-[var(--color-text)]">{value}</div>
      {subValue && (
        <div className="text-xs text-[var(--color-text-muted)] mt-1">{subValue}</div>
      )}
    </motion.div>
  );
}

export function StatsTab(props: StatsTabProps) {
  const orbit = useOrbitInterface();
  if (props.variant === "orbit" || orbit) return <OrbitInfoPanel projectId={props.projectId} task={props.task} />;
  return <WorkbenchStatsTab {...props} />;
}

function WorkbenchStatsTab({ projectId, task }: StatsTabProps) {
  const { theme } = useTheme();
  const { projects } = useProject();
  const { diffData, commitsData, usage } = useTaskStats(projectId, task.id);
  const kpi = usage?.kpi;
  const { linkedProjects, linkCandidates, linksLoading, linksSaving, linksError, link, unlink } = useTaskLinkedProjects(projectId, task.id);

  const additions = diffData?.total_additions ?? 0;
  const deletions = diffData?.total_deletions ?? 0;
  const filesChanged = diffData?.files.length ?? 0;
  const commits = commitsData?.commits ?? [];

  return (
    <div className="h-full min-h-0 overflow-y-auto space-y-4 pr-1">
      {/* Basic Info */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0 }}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
      >
        <div className="flex items-center gap-2 mb-3 select-none">
          <Info className="w-4 h-4 text-[var(--color-text-muted)]" />
          <h3 className="text-sm font-medium text-[var(--color-text)]">Task Info</h3>
        </div>

        <div className="space-y-3">
          <div className="text-base font-semibold text-[var(--color-text)] break-words">{task.name}</div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                <GitBranch className="w-3.5 h-3.5" />
                Branch
              </div>
              <code className="block text-sm text-[var(--color-accent)] bg-[var(--color-bg-secondary)] rounded-md px-2 py-1 truncate" title={task.branch}>
                {task.branch || "—"}
              </code>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)] mb-1">Target</div>
              <code className="block text-sm text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)] rounded-md px-2 py-1 truncate" title={task.target}>
                {task.target || "—"}
              </code>
            </div>
          </div>

        </div>
      </motion.div>

      {/* Task-level workspace scope, mapped to ACP additionalDirectories. */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
      >
        <div className="flex items-center justify-between gap-3 mb-3 select-none">
          <div className="flex min-w-0 items-center gap-2">
            <Link2 className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
            <h3 className="text-sm font-medium text-[var(--color-text)]">Linked Projects</h3>
          </div>
          <LinkedProjectPicker
            projects={linkCandidates}
            disabled={linksSaving || linksLoading}
            onSelect={(project) => {
              void link(project.id);
            }}
          />
        </div>

        {linksLoading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading linked projects…
          </div>
        ) : linkedProjects.length === 0 ? (
          <p className="text-xs leading-5 text-[var(--color-text-muted)]">
            Link another Grove Project to this Task.
          </p>
        ) : (
          <div className="space-y-1.5">
            {linkedProjects.map((project) => {
              const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
              const canOpen = project.exists && projects.some((item) => item.id === project.id && item.exists);
              return (
                <div
                  key={project.id}
                  className="flex items-center gap-3 rounded-md bg-[var(--color-bg-secondary)] px-2.5 py-2"
                >
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: color.bg }}
                  >
                    <Icon className="h-4 w-4" style={{ color: color.fg }} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--color-text)]">
                        {project.name}
                      </span>
                      {project.project_type && <ProjectTypeBadge type={project.project_type} />}
                    </div>
                    {!project.exists && (
                      <div className="truncate text-xs text-[var(--color-error)]">
                        Project is no longer available
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openLinkedProject(project.id)}
                    disabled={!canOpen}
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-highlight)] disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Open ${project.name}`}
                    title={canOpen ? `Open ${project.name}` : "Project is not available"}
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void unlink(project.id)}
                    disabled={linksSaving}
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-error)] disabled:opacity-50"
                    aria-label={`Unlink ${project.name}`}
                    title={`Unlink ${project.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {linksError && <p className="mt-2 text-xs text-[var(--color-error)]">{linksError}</p>}
      </motion.div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={Calendar}
          label="Created"
          value={formatDate(task.createdAt)}
          delay={0}
        />
        <StatCard
          icon={Clock}
          label="Last Updated"
          value={formatDate(task.updatedAt)}
          delay={0.05}
        />
        <StatCard
          icon={GitCommit}
          label="Commits"
          value={commits.length}
          subValue={commits.length > 0 ? `Latest: ${commits[0]?.message.slice(0, 30)}...` : "No commits"}
          delay={0.1}
        />
        <StatCard
          icon={FileCode}
          label="Files Changed"
          value={filesChanged}
          subValue={`${additions} additions, ${deletions} deletions`}
          delay={0.15}
        />
        <StatCard
          icon={Sparkles}
          label="Tokens"
          value={kpi ? formatTokens(kpi.tokens_total) : "—"}
          subValue={kpi && kpi.turns > 0 ? `${kpi.turns} turns, ${formatDuration(kpi.agent_compute_secs)} agent time` : "No agent turns yet"}
          delay={0.2}
        />
        <StatCard
          icon={Coins}
          label="Cost"
          value={kpi && kpi.cost_total > 0 ? formatCost(kpi.cost_total) : "—"}
          subValue={kpi && kpi.turns > 0 ? `${formatTokens(kpi.tokens_in)} in, ${formatTokens(kpi.tokens_out)} out` : undefined}
          delay={0.25}
        />
      </div>

      {/* Commit Timeline */}
      {commits.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <h3 className="text-sm font-medium text-[var(--color-text)] mb-3">Commit Timeline</h3>
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-[var(--color-border)]" />

            {/* Commits */}
            <div className="space-y-3">
              {commits.map((commit, index) => (
                <div key={commit.hash} className="flex items-start gap-3 relative">
                  <div
                    className="w-4 h-4 rounded-full border-2 border-[var(--color-highlight)] bg-[var(--color-bg)] flex-shrink-0 z-10"
                    style={{
                      borderColor: index === 0 ? "var(--color-highlight)" : "var(--color-border)",
                    }}
                  />
                  <div className="flex-1 min-w-0 pb-2">
                    <p className="text-sm text-[var(--color-text)] truncate">
                      {commit.message}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mt-0.5">
                      <code className="font-mono">{commit.hash.slice(0, 7)}</code>
                      <span>•</span>
                      <span>{commit.time_ago}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
