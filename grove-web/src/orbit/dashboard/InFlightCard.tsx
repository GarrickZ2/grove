import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link2, Plus, X } from "lucide-react";
import { useProject } from "../../context";
import { requestOpenReview } from "../workspace/openReview";
import { Button, Card, EmptyState, StatusDot, formatDateTime, shortAgo } from "../ui";
import type { LinkedProjectItem } from "../../api";
import type { Project, Task } from "../../data/types";
import { resolveAgentIcon } from "../../utils/agentIcon";
import type { TaskActivity } from "./dashboardModel";
import type { TaskDiff } from "./useInFlightDetails";

const ROW_SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;
const MAX_CANDIDATES = 6;

interface InFlightCardProps {
  tasks: Task[];
  activity: Map<string, TaskActivity>;
  diffFor: (taskId: string) => TaskDiff | undefined;
  linksFor: (taskId: string) => LinkedProjectItem[] | undefined;
  /** Other projects that can be linked into a task. */
  linkable: Project[];
  savingTask: string | null;
  linkError: string | null;
  now: number;
  onSaveLinks: (taskId: string, projectIds: string[]) => void;
  onOpen: (task: Task, chatId: string | null) => void;
  onNewTask: () => void;
}

/** Active tasks: what each is doing, its diff, linked projects and a way in. */
export function InFlightCard(props: InFlightCardProps) {
  const { tasks, activity, now, onNewTask } = props;
  const [openTask, setOpenTask] = useState<string | null>(null);
  return (
    <Card className="odb-fill" aria-label="In flight" title="In flight" hint={`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}>
      <div className="odb-flight oui-scroll">
        {tasks.length === 0 ? (
          <EmptyState
            title="No tasks in flight"
            action={<Button variant="secondary" size="sm" onClick={onNewTask}><Plus />New task</Button>}
          >
            Each task gets its own worktree and agent session.
          </EmptyState>
        ) : null}
        {tasks.map((task, index) => (
          <TaskRow
            key={task.id}
            index={index}
            task={task}
            activity={activity.get(task.id)}
            open={openTask === task.id}
            onToggle={() => setOpenTask(openTask === task.id ? null : task.id)}
            now={now}
            props={props}
          />
        ))}
      </div>
    </Card>
  );
}

interface TaskRowProps {
  index: number;
  task: Task;
  activity: TaskActivity | undefined;
  open: boolean;
  onToggle: () => void;
  now: number;
  props: InFlightCardProps;
}

function TaskRow({ index, task, activity, open, onToggle, now, props }: TaskRowProps) {
  const { diffFor, linksFor, linkable, savingTask, linkError, onSaveLinks, onOpen } = props;
  const phase = activity?.phase ?? "idle";
  const diff = diffFor(task.id);
  const links = linksFor(task.id);
  const agent = activity?.agent ? resolveAgentIcon(activity.agent) : null;
  const AgentIcon = agent?.Component;
  const linkedIds = new Set((links ?? []).map((link) => link.id));
  const candidates = linkable.filter((project) => !linkedIds.has(project.id)).slice(0, MAX_CANDIDATES);
  const saving = savingTask === task.id;
  const panelId = `odb-links-${task.id}`;

  return (
    <motion.div
      className={`odb-task is-${phase}`}
      layout="position"
      transition={ROW_SPRING}
      style={{ animationDelay: `${140 + index * 45}ms` }}
    >
      <div className="odb-task-row">
        <StatusDot
          className="odb-st"
          size="lg"
          tone={phase}
          ring={phase !== "idle"}
          pulse={phase === "live"}
          label={phase === "waiting" ? "Waiting on you" : phase === "live" ? "Working" : "Idle"}
        />
        <span className="odb-task-copy">
          <span className="odb-tname" title={task.name}>{task.name}</span>
          <span className="odb-tmeta">
            {task.branch ? <span className="oui-mono odb-tbranch">{task.branch}</span> : null}
            {links ? (
              // With no links the chip stays out of the way until the row is hovered or focused.
              <button
                type="button"
                className={`odb-lchip${open ? " is-open" : ""}${links.length ? "" : " is-hint"}`}
                aria-expanded={open}
                aria-controls={panelId}
                aria-label={links.length ? `${links.length} linked ${links.length === 1 ? "project" : "projects"}` : "Link projects"}
                title="Linked projects in this task"
                onClick={onToggle}
              >
                <Link2 aria-hidden="true" />{links.length || "Link"}
              </button>
            ) : null}
            <span className={`odb-doing is-${phase}`} title={activity?.doing}>
              {activity?.doing ?? "Idle"}
              {phase === "live" ? <span className="odb-typing" aria-hidden="true" /> : null}
            </span>
          </span>
        </span>
        <span className="odb-task-facts">
          {diff && (diff.additions || diff.deletions) ? (
            <span className="odb-diff oui-mono" aria-label={`${diff.additions} added, ${diff.deletions} removed`}>
              <span className="is-add">+{diff.additions}</span><span className="is-del">−{diff.deletions}</span>
            </span>
          ) : null}
          {AgentIcon ? <span className="odb-agent" title={agent?.label}><AgentIcon size={14} /></span> : null}
          <span className="odb-ago" title={formatDateTime(task.updatedAt)}>{shortAgo(task.updatedAt.getTime(), now)}</span>
        </span>
        <span className="odb-row-acts">
          <ReviewAction task={task} onOpen={onOpen} linkedCount={links?.length ?? 0} />
          <Button variant="primary" size="sm" onClick={() => onOpen(task, activity?.chatId ?? null)}>Open</Button>
        </span>
      </div>
      <AnimatePresence initial={false}>
        {open && links ? (
          <motion.div
            id={panelId}
            className="odb-tl"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.36, ease: [0.25, 1, 0.5, 1] }}
          >
            <div className="odb-tl-in">
              <div className="odb-tl-cap">Linked into this task’s agent workspace</div>
              {links.length === 0 ? <div className="odb-tl-none">No linked projects yet.</div> : null}
              {links.map((link) => (
                <div key={link.id} className={`odb-tl-row${link.exists ? "" : " is-missing"}`}>
                  <span className="odb-pav" aria-hidden="true">{link.name.charAt(0)}</span>
                  <span className="oui-truncate">{link.name}</span>
                  {!link.exists ? <span className="odb-src">missing</span> : null}
                  <button
                    type="button"
                    className="odb-x"
                    aria-label={`Unlink ${link.name}`}
                    disabled={saving}
                    onClick={() => onSaveLinks(task.id, links.filter((item) => item.id !== link.id).map((item) => item.id))}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
              {candidates.length ? (
                <div className="odb-tl-add">
                  {candidates.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="odb-addchip"
                      disabled={saving}
                      onClick={() => onSaveLinks(task.id, [...links.map((item) => item.id), project.id])}
                    >
                      <Plus aria-hidden="true" />{project.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {linkError && saving === false ? <div className="odb-tl-error" role="alert">{linkError}</div> : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

/** Opens the task with its Code Review panel showing (see orbit/workspace/openReview.ts). */
function ReviewAction({ task, onOpen, linkedCount }: { task: Task; onOpen: InFlightCardProps["onOpen"]; linkedCount: number }) {
  const { selectedProject } = useProject();
  // Studio tasks review their linked Projects only, so they need at least one.
  if (!selectedProject || (selectedProject.projectType === "studio" && linkedCount === 0)) return null;
  const projectId = selectedProject.id;
  return (
    <Button
      variant="secondary"
      size="sm"
      title="Open this task with Code Review showing"
      onClick={() => {
        requestOpenReview({ projectId, taskId: task.id });
        onOpen(task, null);
      }}
    >
      Review
    </Button>
  );
}
