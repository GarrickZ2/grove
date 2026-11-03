import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Link2, RotateCw, Sparkles, X } from "lucide-react";
import type { Task } from "../../../data/types";
import { useProject, useTheme } from "../../../context";
import { getProjectStyle } from "../../../utils/projectStyle";
import { LinkedProjectPicker } from "../../../components/Tasks/TaskDetail/tabs/LinkedProjectPicker";
import { openLinkedProject, useTaskLinkedProjects, useTaskStats, USAGE_DAYS } from "../../../components/Tasks/TaskDetail/tabs/useTaskStats";
import { AgentAvatar } from "../../../components/Review/AgentAvatar";
import { resolveAgentIcon } from "../../../utils/agentIcon";
import { formatCost, formatDuration, formatTokens } from "../../../components/Stats/formatters";
import type { PeriodData, TimeseriesBucket } from "../../../api/statistics";
import { EmptyState } from "../../ui/Surface";
import { PanelLoading } from "../../ui/PanelShell";
import { usePanelMenuItems, type PanelMenuItem } from "../../ui/panelSlots";
import { formatDateTime, relativeText } from "../../ui/format";
import { plural, usageDays } from "./panelModel";
import { HeaderActions, PanelBody, PanelSection, ShowMore } from "./PanelStates";

const SESSIONS_SHOWN = 5;

const agentLabel = (agent: string) => resolveAgentIcon(agent).label || agent;

/** Info panel body: the task at a glance, its linked projects, then its agent usage, sessions and models. */
export function OrbitInfoPanel({ projectId, task }: { projectId: string; task: Task }) {
  const { diffData, commitsData, usage, recentUsage, isLoading, reload } = useTaskStats(projectId, task.id);
  const links = useTaskLinkedProjects(projectId, task.id);

  const menu = useMemo<PanelMenuItem[]>(() => [{ id: "info-refresh", label: "Refresh", icon: RotateCw, onSelect: reload }], [reload]);
  usePanelMenuItems(menu);

  if (isLoading && !diffData && !commitsData) {
    return (
      <PanelBody label="Task info">
        <PanelLoading label="Loading task info" boxes={3} />
      </PanelBody>
    );
  }

  const commitTotal = commitsData ? commitsData.total : null;

  const tiles: { key: string; label: string; value: ReactNode; title?: string }[] = [];
  if (diffData) {
    tiles.push({
      key: "changes",
      label: "Changes",
      value: <><span className="owp-add">+{diffData.total_additions}</span> <span className="owp-del">−{diffData.total_deletions}</span></>,
      title: `${diffData.total_additions} additions, ${diffData.total_deletions} deletions against ${task.target || "the target"}`,
    });
    tiles.push({ key: "files", label: "Files", value: `${diffData.files.length} changed` });
  }
  if (commitTotal !== null) tiles.push({ key: "commits", label: "Commits", value: commitTotal });
  const kpi = usage && usage.kpi.turns > 0 ? usage.kpi : null;
  if (kpi) {
    tiles.push({
      key: "tokens",
      label: "Tokens",
      value: formatTokens(kpi.tokens_total),
      title: `${kpi.tokens_total.toLocaleString()} tokens: ${formatTokens(kpi.tokens_in)} in, ${formatTokens(kpi.tokens_cached)} cached, ${formatTokens(kpi.tokens_out)} out`,
    });
    if (kpi.cost_total > 0) tiles.push({ key: "cost", label: "Cost", value: formatCost(kpi.cost_total), title: "As reported by the agents" });
  }
  tiles.push({ key: "created", label: "Created", value: relativeText(task.createdAt), title: formatDateTime(task.createdAt) });
  tiles.push({ key: "updated", label: "Updated", value: relativeText(task.updatedAt), title: formatDateTime(task.updatedAt) });

  return (
    <PanelBody label="Task info">
      <div className="owp-scroll">
        <section className="owp-sec">
          <div className="owp-box owp-kv">
            {tiles.map((tile) => (
              <div key={tile.key} title={tile.title}>
                <span>{tile.label}</span>
                <b className="owp-tnum">{tile.value}</b>
              </div>
            ))}
          </div>
        </section>

        <LinkedProjectsSection links={links} />
        <UsageSection usage={kpi ? usage : null} recent={recentUsage} />
        {kpi && usage ? <SessionsSection projectId={projectId} taskId={task.id} usage={usage} /> : null}
        {kpi && usage && usage.models.length > 1 ? <ModelsSection usage={usage} /> : null}
      </div>
    </PanelBody>
  );
}

/** Tokens per day for the last two weeks, and how the total splits. */
function UsageSection({ usage, recent }: { usage: PeriodData | null; recent: TimeseriesBucket[] }) {
  const days = useMemo(() => usageDays(recent, USAGE_DAYS), [recent]);
  if (!usage) {
    return (
      <PanelSection label="Usage">
        <div className="owp-box">
          <EmptyState icon={Sparkles}>No agent turns yet. Usage shows up here once an agent in this task replies.</EmptyState>
        </div>
      </PanelSection>
    );
  }
  const { kpi } = usage;
  const peak = days ? Math.max(...days.map((day) => day.tokens), 1) : 1;
  return (
    <PanelSection label="Usage" hint={`${plural(kpi.turns, "turn")} · ${formatDuration(kpi.agent_compute_secs)} agent time`}>
      <div className="owp-box">
        {days ? (
          <>
            <div className="owp-days" role="img" aria-label={`Tokens per day, last ${USAGE_DAYS} days`}>
              {days.map((day, index) => (
                <i
                  key={day.label}
                  className={day.tokens ? undefined : "is-zero"}
                  style={{ height: day.tokens ? `${Math.max(10, (day.tokens / peak) * 100)}%` : undefined, animationDelay: `${120 + index * 24}ms` } as CSSProperties}
                  title={`${day.label} · ${formatTokens(day.tokens)} tokens · ${plural(day.turns, "turn")}`}
                />
              ))}
            </div>
            <div className="owp-days-axis" aria-hidden="true"><span>{days[0].label}</span><span>Today</span></div>
          </>
        ) : (
          <div className="owp-quiet">Nothing in the last {USAGE_DAYS} days.</div>
        )}
        <div className="owp-split">
          <span><b>{formatTokens(kpi.tokens_in)}</b> in</span>
          <span><b>{formatTokens(kpi.tokens_cached)}</b> cached</span>
          <span><b>{formatTokens(kpi.tokens_out)}</b> out</span>
        </div>
      </div>
    </PanelSection>
  );
}

/** The task's sessions by tokens; a row opens that session. */
function SessionsSection({ projectId, taskId, usage }: { projectId: string; taskId: string; usage: PeriodData }) {
  const [all, setAll] = useState(false);
  const sessions = usage.top;
  if (sessions.length === 0) return null;
  const peak = Math.max(...sessions.map((session) => session.tokens), 1);
  const shown = all ? sessions : sessions.slice(0, SESSIONS_SHOWN);
  const open = (chatId: string) =>
    window.dispatchEvent(new CustomEvent("grove:navigate", { detail: { route: "tasks", project_id: projectId, task_id: taskId, chat_id: chatId } }));
  return (
    <PanelSection label="Sessions" hint={sessions.length}>
      <div className="owp-box">
        {shown.map((session, index) => {
          const agent = session.agent_split[0]?.agent ?? "";
          const agents = session.agent_split.map((split) => agentLabel(split.agent)).join(", ");
          return (
            <button
              key={session.id}
              type="button"
              className="owp-frow"
              onClick={() => open(session.id)}
              title={`${session.name} · ${agents} · ${session.tokens.toLocaleString()} tokens · ${plural(session.turns, "turn")}${session.cost > 0 ? ` · ${formatCost(session.cost)}` : ""}`}
            >
              <span className="owp-fname">
                {agent ? <AgentAvatar agent={agent} size={18} /> : null}
                <span>{session.name}</span>
              </span>
              <span className="owp-bar" aria-hidden="true">
                <i style={{ width: `${Math.max(4, (session.tokens / peak) * 100)}%`, animationDelay: `${200 + Math.min(index, 8) * 60}ms` }} />
              </span>
              <span className="owp-count">{formatTokens(session.tokens)}</span>
            </button>
          );
        })}
        <ShowMore shown={SESSIONS_SHOWN} total={sessions.length} expanded={all} onToggle={() => setAll((value) => !value)} />
      </div>
    </PanelSection>
  );
}

/** Models used, when there was more than one. */
function ModelsSection({ usage }: { usage: PeriodData }) {
  const total = usage.models.reduce((sum, model) => sum + model.tokens, 0) || 1;
  return (
    <PanelSection label="Models" hint={usage.models.length}>
      <div className="owp-box">
        {usage.models.map((model, index) => (
          <div key={`${model.agent}-${model.model}`} className="owp-frow" title={`${model.model || "Unknown model"} · ${agentLabel(model.agent)} · ${model.tokens.toLocaleString()} tokens`}>
            <span className="owp-fname">
              <AgentAvatar agent={model.agent} size={18} />
              <span>{model.model || "Unknown model"}</span>
            </span>
            <span className="owp-bar" aria-hidden="true">
              <i style={{ width: `${Math.max(4, (model.tokens / total) * 100)}%`, animationDelay: `${200 + Math.min(index, 8) * 60}ms` }} />
            </span>
            <span className="owp-count">{Math.round((model.tokens / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </PanelSection>
  );
}

function LinkedProjectsSection({ links }: { links: ReturnType<typeof useTaskLinkedProjects> }) {
  const { theme } = useTheme();
  const { projects } = useProject();
  const { linkedProjects, linkCandidates, linksLoading, linksSaving, linksError, link, unlink } = links;
  const picker = (inHeader: boolean) => (
    <LinkedProjectPicker
      projects={linkCandidates}
      disabled={linksSaving || linksLoading}
      onSelect={(project) => { void link(project.id); }}
      triggerClassName={inHeader ? "oui-btn oui-btn-ghost oui-btn-sm oui-btn-icon" : "owp-link"}
      triggerLabel={inHeader ? "Link project" : "Link"}
      triggerIconOnly={inHeader}
    />
  );

  return (
    <PanelSection
      label="Linked projects"
      hint={linkedProjects.length > 0 ? linkedProjects.length : undefined}
      end={<HeaderActions fallback={picker(false)}>{picker(true)}</HeaderActions>}
    >
      <div className="owp-box">
        {linksLoading ? (
          <div className="owp-quiet" role="status" aria-label="Loading linked projects"><div className="oui-skel" style={{ width: "55%" }} /></div>
        ) : linkedProjects.length === 0 ? (
          <EmptyState icon={Link2}>Link another project so agents in this task can work in it too.</EmptyState>
        ) : (
          linkedProjects.map((project) => {
            const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
            const canOpen = project.exists && projects.some((item) => item.id === project.id && item.exists);
            return (
              <div key={project.id} className={`owp-lrow${project.exists ? "" : " is-missing"}`}>
                <span className="owp-pav" style={{ backgroundColor: color.bg }} aria-hidden="true">
                  <Icon style={{ color: color.fg }} />
                </span>
                <span className="owp-lname">
                  <span title={project.exists ? project.name : "Project is no longer available"}>{project.name}</span>
                  {!project.exists ? <span className="owp-tag is-warn">Unavailable</span> : project.project_type === "studio" ? <span className="owp-tag">Studio</span> : null}
                </span>
                <span className="owp-row-acts">
                  {canOpen ? (
                    <button type="button" className="owp-ib" onClick={() => openLinkedProject(project.id)} aria-label={`Open ${project.name}`} title={`Open ${project.name}`}>
                      <ArrowRight aria-hidden="true" />
                    </button>
                  ) : null}
                  <button type="button" className="owp-ib is-danger" onClick={() => void unlink(project.id)} disabled={linksSaving} aria-label={`Unlink ${project.name}`} title={`Unlink ${project.name}`}>
                    <X aria-hidden="true" />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
      {linksError ? <p className="owp-inline-error" role="alert">{linksError}</p> : null}
    </PanelSection>
  );
}
