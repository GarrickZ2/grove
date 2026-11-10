import type { CSSProperties } from "react";
import { AlertCircle, Archive, ArrowLeftRight, ArrowRight, FolderX, GitBranch, ListTodo, MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { Project } from "../../data/types";
import { useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import { usePersonaRegistry } from "../../utils/agentIcon";
import { MAX_PROJECT_NAME_LEN, useProjectRename } from "../../components/Projects/useProjectRename";
import { ActionMenu, type ActionItem } from "../studio/ActionMenu";
import { useActionMenu } from "../studio/useActionMenu";
import { WeeklyUsage } from "../dashboard/WeeklyUsage";
import { Button, EmptyState, StatusDot, agoText, formatDateTime } from "../ui";
import { addedLabel, isStudioProject, kindLabel, pathLabel, projectHealth, taskRows, taskTally } from "./projectsView";
import { useProjectDetail } from "./useProjectDetail";

interface ProjectDetailProps {
  project: Project;
  isCurrent: boolean;
  /** Archive / restore in flight. */
  busy: boolean;
  now: number;
  onOpen: () => void;
  onSwitch: () => void;
  onOpenTask: (taskId: string) => void;
  onRename: (name: string) => Promise<void>;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

export function ProjectDetail({ project, isCurrent, busy, now, onOpen, onSwitch, onOpenTask, onRename, onArchive, onRestore, onDelete }: ProjectDetailProps) {
  const { theme } = useTheme();
  usePersonaRegistry();
  const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
  const { isEditing, editName, isRenaming, renameError, inputRef, beginEditing, changeName, handleBlur, handleKeyDown } = useProjectRename(project.name, onRename);
  const menu = useActionMenu();
  const { data, loading } = useProjectDetail(project);
  const health = projectHealth(project);
  const archived = project.archived;
  const studio = isStudioProject(project);
  const path = pathLabel(project);
  const branch = data?.full?.current_branch || (isCurrent ? project.currentBranch : "");
  const rows = taskRows(data?.full ?? null);
  const tally = taskTally(rows);
  const archivedTasks = data?.stats?.archived_tasks;
  const canOpen = !archived && health !== "missing";
  const style = { "--opj-c": color.fg } as CSSProperties;

  const items: ActionItem[] = [
    { id: "rename", icon: Pencil, label: "Rename", onSelect: beginEditing },
    ...(busy ? [] : archived
      ? [{ id: "restore", icon: RotateCcw, label: "Restore", onSelect: onRestore }]
      : [{ id: "archive", icon: Archive, label: "Archive", onSelect: onArchive }]),
    { id: "delete", icon: Trash2, label: "Delete from Grove…", onSelect: onDelete, danger: true, separated: true },
  ];

  const strip = [
    { id: "live", label: "Live", value: tally.live, tone: "live" as const },
    { id: "attention", label: "Need attention", value: tally.attention, tone: "warn" as const },
    { id: "idle", label: "Idle", value: tally.idle, tone: "idle" as const },
    ...(studio ? [] : [{ id: "merged", label: "Merged", value: tally.merged, tone: "ok" as const }]),
    ...(archivedTasks !== undefined ? [{ id: "archived", label: "Archived", value: archivedTasks, tone: "off" as const }] : []),
  ];

  return (
    <section className="oui-card opj-detail" style={style} aria-label={`${project.name} details`}>
      <header key={project.id} className="opj-dhead">
        <span className="opj-avatar is-lg" aria-hidden="true"><Icon /></span>
        <div className="opj-dhead-copy">
          {isEditing ? (
            <input
              ref={inputRef}
              className={`opj-rename${renameError ? " is-error" : ""}`}
              type="text"
              aria-label="Project name"
              value={editName}
              maxLength={MAX_PROJECT_NAME_LEN}
              disabled={isRenaming}
              onChange={(event) => changeName(event.target.value)}
              onBlur={handleBlur}
              onKeyDown={(event) => {
                event.stopPropagation();
                handleKeyDown(event);
              }}
            />
          ) : (
            <h2>
              <span className="oui-truncate" title={project.name}>{project.name}</span>
              {isCurrent ? <span className="opj-badge is-current">Current</span> : null}
              {studio ? <span className="opj-badge is-studio">Studio</span> : null}
              {archived ? <span className="opj-badge is-archived">Archived</span> : null}
            </h2>
          )}
          {renameError ? (
            <p className="opj-rename-err" title={renameError}>{renameError}</p>
          ) : (
            <p className="opj-dmeta">
              {studio ? null : <span>{kindLabel(project)}</span>}
              {path ? <span className="oui-mono oui-truncate" title={project.path}>{path}</span> : null}
              {branch ? <span className="opj-branch oui-mono" title={branch}><GitBranch aria-hidden="true" /><span className="oui-truncate">{branch}</span></span> : null}
              <span title={formatDateTime(project.addedAt)}>{addedLabel(project, now)}</span>
            </p>
          )}
        </div>
        <div className="opj-dacts">
          {archived ? (
            <Button variant="primary" disabled={busy} onClick={onRestore}><RotateCcw />{busy ? "Restoring…" : "Restore"}</Button>
          ) : (
            <>
              {!isCurrent ? <Button onClick={onSwitch} title="Make this the active project"><ArrowLeftRight />Switch</Button> : null}
              {canOpen ? <Button variant="primary" onClick={onOpen} title="Switch to it and open its dashboard">Open<ArrowRight /></Button> : null}
            </>
          )}
          <Button
            variant="ghost"
            iconOnly
            aria-label={`Actions for ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            className={menu.open ? "is-on" : undefined}
            onClick={(event) => (menu.open ? menu.close() : menu.fromButton(event.currentTarget))}
          >
            <MoreHorizontal />
          </Button>
        </div>
      </header>

      {health === "missing" ? (
        <div className="opj-note is-missing">
          <FolderX aria-hidden="true" />
          <span>This folder no longer exists on disk. Restore it to keep working, or remove the project from Grove.</span>
          <Button size="sm" danger onClick={onDelete}>Remove</Button>
        </div>
      ) : health === "not-git" ? (
        <div className="opj-note is-warn">
          <AlertCircle aria-hidden="true" />
          <span>Not a Git repository yet.</span>
        </div>
      ) : null}

      <div className="opj-strip" aria-label="Tasks by status">
        {strip.map((cell) => (
          <div key={cell.id} className={`opj-stat${cell.value > 0 ? "" : " is-zero"}`}>
            <span className="opj-stat-label"><StatusDot tone={cell.tone} size="sm" pulse={cell.tone === "live" && cell.value > 0} />{cell.label}</span>
            <b className="oui-tnum">{data ? cell.value : "–"}</b>
          </div>
        ))}
      </div>

      <div className="opj-dbody">
        <div className="opj-dsec">
          <div className="opj-dsec-head">
            <h3>Tasks{data?.full ? <small>{rows.length}</small> : null}</h3>
          </div>
          {rows.length > 0 ? (
            <div className="opj-tasks oui-scroll" role="list">
              {rows.map((row, index) => {
                const label = row.name;
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="listitem"
                    className="opj-task"
                    style={{ animationDelay: `${Math.min(index, 12) * 30 + 140}ms` }}
                    disabled={!canOpen}
                    title={canOpen ? `Open ${label}` : undefined}
                    onClick={() => onOpenTask(row.id)}
                  >
                    <StatusDot tone={row.tone} pulse={row.tone === "live"} ring={row.tone === "live"} />
                    <span className="opj-task-copy">
                      <span className="opj-task-name"><span className="oui-truncate" title={label}>{label}</span>{row.isLocal ? <span className="opj-badge is-local">Local</span> : null}</span>
                      {!studio && row.branch ? <span className="opj-task-branch oui-mono oui-truncate" title={row.branch}>{row.branch}</span> : null}
                    </span>
                    <span className={`opj-task-status is-${row.tone}`}>{row.label}</span>
                    <span className="opj-task-ago" title={row.updatedAt ? formatDateTime(row.updatedAt) : undefined}>{row.updatedAt ? agoText(row.updatedAt, now) : ""}</span>
                  </button>
                );
              })}
            </div>
          ) : loading && !data ? (
            <div className="opj-tasks" aria-hidden="true">
              {[0, 1, 2].map((i) => <div key={i} className="opj-task is-skel"><span className="oui-skel" style={{ width: `${60 - i * 12}%` }} /></div>)}
            </div>
          ) : (
            <EmptyState icon={ListTodo} title="No tasks">
              {data?.full ? null : "Couldn’t load this project’s tasks."}
            </EmptyState>
          )}
        </div>

        <div className="opj-dsec opj-usage">
          <div className="opj-dsec-head">
            <h3>Usage<small>last 7 days</small></h3>
          </div>
          {data || !loading ? <WeeklyUsage key={project.id} stats={data?.usage ?? null} /> : (
            <div className="opj-usage-skel" aria-hidden="true"><span className="oui-skel" style={{ width: "40%" }} /><span className="oui-skel" style={{ width: "70%" }} /></div>
          )}
        </div>
      </div>

      <ActionMenu at={menu.at} items={items} label={`${project.name} actions`} onClose={menu.close} />
    </section>
  );
}
