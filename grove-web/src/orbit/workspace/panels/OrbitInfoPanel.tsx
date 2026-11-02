import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Link2, RotateCw, X } from "lucide-react";
import type { Task } from "../../../data/types";
import { useProject, useTheme } from "../../../context";
import { getProjectStyle } from "../../../utils/projectStyle";
import { LinkedProjectPicker } from "../../../components/Tasks/TaskDetail/tabs/LinkedProjectPicker";
import { calculateActiveTime } from "../../../components/Tasks/TaskDetail/tabs/taskStatsModel";
import { openLinkedProject, useTaskLinkedProjects, useTaskStats } from "../../../components/Tasks/TaskDetail/tabs/useTaskStats";
import { EmptyState } from "../../ui/Surface";
import { PanelError, PanelLoading } from "../../ui/PanelShell";
import { usePanelMenuItems, type PanelMenuItem } from "../../ui/panelSlots";
import { formatClock, formatDateTime, relativeText } from "../../ui/format";
import { latestActivityDay, plural, splitPath } from "./panelModel";
import { HeaderActions, PanelBody, PanelSection, ShowMore } from "./PanelStates";

const EDITS_SHOWN = 6;

function FilePath({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="owp-path" title={path}>
      {dir ? <span>{dir}</span> : null}
      <b>{name}</b>
    </span>
  );
}

/** Info panel body: the task at a glance, its activity, hot files and linked projects. */
export function OrbitInfoPanel({ projectId, task }: { projectId: string; task: Task }) {
  const { stats, diffData, commitsData, isLoading, error, reload } = useTaskStats(projectId, task.id);
  const links = useTaskLinkedProjects(projectId, task.id);
  const [allEdits, setAllEdits] = useState(false);

  const activity = useMemo(() => (stats ? latestActivityDay(stats.hourly_activity) : null), [stats]);
  const menu = useMemo<PanelMenuItem[]>(() => [{ id: "info-refresh", label: "Refresh", icon: RotateCw, onSelect: reload }], [reload]);
  usePanelMenuItems(menu);

  if (isLoading && !stats) {
    return (
      <PanelBody label="Task info">
        <PanelLoading label="Loading task info" boxes={3} />
      </PanelBody>
    );
  }

  if (error && !stats) {
    return (
      <PanelBody label="Task info">
        <PanelError title="Couldn’t load this task’s activity" onRetry={reload} retrying={isLoading}>
          Grove didn’t return edit stats for this task. It may have been archived or removed in another window.
        </PanelError>
      </PanelBody>
    );
  }

  const activeTime = stats ? calculateActiveTime(stats.hourly_activity) : "—";
  const edits = stats?.file_edits ?? [];
  const maxEdits = edits.length ? Math.max(...edits.map((file) => file.edit_count)) : 1;
  const shownEdits = allEdits ? edits : edits.slice(0, EDITS_SHOWN);
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
  if (activeTime !== "—") tiles.push({ key: "active", label: "Active time", value: activeTime, title: "Minutes with at least one edit" });
  tiles.push({ key: "created", label: "Created", value: relativeText(task.createdAt), title: formatDateTime(task.createdAt) });
  const lastActivity = stats?.last_activity ?? null;
  tiles.push(
    lastActivity
      ? { key: "last", label: "Last edit", value: relativeText(lastActivity), title: formatDateTime(lastActivity) }
      : { key: "updated", label: "Updated", value: relativeText(task.updatedAt), title: formatDateTime(task.updatedAt) },
  );

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

        {activity ? (
          <PanelSection label="Activity" hint={`${activity.label} · ${plural(activity.total, "edit")}`}>
            <div className="owp-box">
              <div className="owp-hours" role="img" aria-label={`Edits per hour, ${activity.label.toLowerCase()}`}>
                {activity.hours.map((count, hour) => (
                  <i
                    key={hour}
                    className={count ? undefined : "is-zero"}
                    style={{ height: count ? `${Math.max(12, (count / activity.peak) * 100)}%` : undefined, animationDelay: `${120 + hour * 16}ms` } as CSSProperties}
                    title={`${formatClock(new Date(2000, 0, 1, hour))} · ${plural(count, "edit")}`}
                  />
                ))}
              </div>
              <div className="owp-hours-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
            </div>
          </PanelSection>
        ) : null}

        {edits.length > 0 ? (
          <PanelSection label="Most edited" hint={stats ? `${plural(stats.total_edits, "edit")} · ${plural(stats.files_touched, "file")}` : undefined}>
            <div className="owp-box">
              {shownEdits.map((file, index) => (
                <div key={file.path} className="owp-frow" title={`${file.path} · ${plural(file.edit_count, "edit")}`}>
                  <FilePath path={file.path} />
                  <span className="owp-bar" aria-hidden="true">
                    <i style={{ width: `${Math.max(4, (file.edit_count / maxEdits) * 100)}%`, animationDelay: `${200 + Math.min(index, 8) * 60}ms` }} />
                  </span>
                  <span className="owp-count">{file.edit_count}</span>
                </div>
              ))}
              <ShowMore shown={EDITS_SHOWN} total={edits.length} expanded={allEdits} onToggle={() => setAllEdits((value) => !value)} />
            </div>
          </PanelSection>
        ) : null}

        <LinkedProjectsSection links={links} />
      </div>
    </PanelBody>
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
