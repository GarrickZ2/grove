import { useCallback, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, BarChart2, Code2, GitBranch,
  GitCommit, Plus, RefreshCw, Sparkles, TerminalSquare,
} from "lucide-react";
import { useDashboardState } from "../../components/Dashboard/useDashboardState";
import { DashboardDialogs } from "../../components/Dashboard/DashboardDialogs";
import { useNotifications, useProject, useTheme } from "../../context";
import { usePersonaRegistry } from "../../utils/agentIcon";
import { getProjectStyle } from "../../utils/projectStyle";
import { shortenPath } from "../../utils/path";
import type { PermissionOption } from "../../utils/permissionOptions";
import type { Task } from "../../data/types";
import { Button, Card, DrawnCheck, OrbitPage, OrbitPageHeader, OrbitPageMessage, useNow, type PageHue } from "../ui";
import { BranchSwitcher } from "./BranchSwitcher";
import { NeedsYouCard } from "./NeedsYouCard";
import { InFlightCard } from "./InFlightCard";
import { buildNeedsYou, sortInFlight, taskActivity, type NeedsYouItem, type TaskActivity } from "./dashboardModel";
import { resolvePermission, useLiveChats } from "./useLiveChats";
import { answerPendingForm, usePendingForms, type InlineForm } from "./usePendingForms";
import { useInFlightDetails } from "./useInFlightDetails";
import { useAgentContext } from "./useAgentContext";
import { AgentContextCard } from "./AgentContextCard";
import { useProjectLinks } from "./useProjectLinks";
import { ProjectLinksCard } from "./ProjectLinksCard";
import { WeeklyUsage } from "./WeeklyUsage";
import { useNewTaskShortcut } from "./useNewTaskShortcut";
import { useRecentSessions } from "./useRecentSessions";
import { RecentSessionsCard } from "./RecentSessionsCard";
import "./orbit-dashboard.css";
import { hasAppDetection } from "../../components/Config/settingsConstants";

interface OrbitDashboardPageProps {
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
}

/** Relative times re-render on this cadence. */
const CLOCK_MS = 30_000;

type GitOp = "fetch" | "pull" | "push";

export function OrbitDashboardPage({ onNavigate }: OrbitDashboardPageProps) {
  const dashboard = useDashboardState();
  const {
    selectedProject, isRemote, currentStatus, hasLocalChanges, branches, repoCommits, tokenStats,
    isBranchesLoading, isOperating, operationMessage, messageCount, showMessage, serverPlatform,
    isInitializingGit, handleInitGit,
  } = dashboard;
  const { theme } = useTheme();
  const { projects } = useProject();
  const { notifications, dismissNotification } = useNotifications();
  usePersonaRegistry();
  const chats = useLiveChats();
  const now = useNow(CLOCK_MS);
  const [gitOp, setGitOp] = useState<GitOp | null>(null);
  // Requests answered from here, by id → the request's start time. A later
  // request from the same session starts at a new time and shows again.
  const [answering, setAnswering] = useState<Map<string, number>>(() => new Map());

  const projectId = selectedProject?.id;
  const tasks = useMemo(() => selectedProject?.tasks.filter((task) => task.status !== "archived") ?? [], [selectedProject]);
  const taskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const details = useInFlightDetails(projectId, taskIds);
  const sessionTaskIds = useMemo(() => ["_local", ...taskIds], [taskIds]);
  const recent = useRecentSessions(projectId, sessionTaskIds);
  const taskNames = useMemo(() => new Map(tasks.map((task) => [task.id, task.name])), [tasks]);
  const context = useAgentContext(selectedProject);
  const projectLinks = useProjectLinks(projectId);

  const activity = useMemo(() => {
    const map = new Map<string, TaskActivity>();
    if (projectId) for (const task of tasks) map.set(task.id, taskActivity(projectId, task.id, chats));
    return map;
  }, [projectId, tasks, chats]);
  const inFlight = useMemo(() => sortInFlight(tasks, activity), [tasks, activity]);
  const needsYou = useMemo(() => {
    if (!projectId) return [];
    return buildNeedsYou(projectId, chats, notifications, taskNames).filter((item) => answering.get(item.id) !== item.at);
  }, [projectId, taskNames, chats, notifications, answering]);

  const pendingForms = usePendingForms(needsYou);

  const openNewTask = useCallback(() => onNavigate("tasks", { openNewTask: true }), [onNavigate]);
  const newTaskKeys = useNewTaskShortcut(openNewTask, !!selectedProject && (selectedProject.isGitRepo || selectedProject.projectType === "studio"));

  if (!selectedProject) {
    return <OrbitPageMessage className="odb">Select a project to view its dashboard</OrbitPageMessage>;
  }

  const isGitRepo = selectedProject.isGitRepo;
  const isStudio = selectedProject.projectType === "studio";
  const canCreateTask = isGitRepo || isStudio;
  const { color: projectColor, Icon: ProjectIcon } = getProjectStyle(selectedProject.id, theme.accentPalette);
  const hue: PageHue = {
    from: `color-mix(in oklab, ${projectColor.fg} 62%, white)`,
    to: projectColor.fg,
    strong: `color-mix(in oklab, ${projectColor.fg} 70%, transparent)`,
    glow: `color-mix(in oklab, ${projectColor.fg} 13%, transparent)`,
  };
  const showLocalTools = !isRemote && hasAppDetection(serverPlatform);
  const linkable = projects.filter((project) => project.id !== selectedProject.id && project.exists && !project.archived);

  const runGit = async (op: GitOp, action: () => Promise<void>) => {
    if (isOperating) return;
    setGitOp(op);
    try { await action(); } finally { setGitOp(null); }
  };

  const openTask = (taskId: string, chatId: string | null) => {
    onNavigate("tasks", chatId ? { taskId, chatId, viewMode: "terminal" } : { taskId });
  };

  const answer = async (item: NeedsYouItem, option: PermissionOption) => {
    if (!item.chatId) return;
    // Optimistically collapse the row; the session's next status confirms it.
    setAnswering((previous) => new Map(previous).set(item.id, item.at));
    try {
      await resolvePermission(item.projectId, item.taskId, item.chatId, option.option_id);
    } catch (error) {
      showMessage((error as Error)?.message || "Couldn’t send the answer");
      setAnswering((previous) => {
        const next = new Map(previous);
        next.delete(item.id);
        return next;
      });
    }
  };

  const answerForm = async (item: NeedsYouItem, form: InlineForm, value: string | null) => {
    // Same optimistic collapse as permissions; the input status confirms it.
    setAnswering((previous) => new Map(previous).set(item.id, item.at));
    try {
      await answerPendingForm(item, form, value);
    } catch (error) {
      showMessage((error as Error)?.message || "Couldn’t send the answer");
      setAnswering((previous) => {
        const next = new Map(previous);
        next.delete(item.id);
        return next;
      });
      void pendingForms.reload(item);
    }
  };

  const behind = currentStatus.behind;
  const ahead = currentStatus.ahead;
  const changes = currentStatus.unstaged;
  const pushDisabled = !currentStatus.hasRemote || isOperating || (currentStatus.hasOrigin && ahead === 0);


  const toast = operationMessage ? (
    <span key={messageCount} className="odb-toast" role="status"><DrawnCheck />{operationMessage}</span>
  ) : null;

  return (
    <OrbitPage className="odb" hue={hue} overlays={<DashboardDialogs state={dashboard} project={selectedProject} onNavigate={onNavigate} />}>
      <OrbitPageHeader
        raised
        icon={ProjectIcon}
        title={selectedProject.name}
        titleHint={selectedProject.name}
        titleAside={isGitRepo ? (
          <BranchSwitcher
            current={currentStatus.currentBranch}
            branches={branches}
            commits={repoCommits}
            tasks={selectedProject.tasks}
            loading={isBranchesLoading}
            disabled={isOperating}
            onCheckout={(branch) => void dashboard.handleCheckout(branch)}
            onNewBranch={dashboard.handleNewBranch}
            onAllBranches={() => dashboard.setShowBranchDrawer(true)}
          />
        ) : isStudio ? (
          <span className="odb-tag"><Sparkles aria-hidden="true" />Studio</span>
        ) : null}
        // Studio projects have no meaningful path to show.
        subtitle={isStudio ? undefined : shortenPath(selectedProject.path)}
        subtitleHint={selectedProject.path}
        mono
        actions={(
          <>
            {!isGitRepo || isStudio ? toast : null}
            {showLocalTools && !isStudio ? (
              <>
                <Button variant="ghost" iconOnly aria-label="Open in IDE" title="Open in IDE" onClick={() => void dashboard.handleOpenIDE()}><Code2 /></Button>
                <Button variant="ghost" iconOnly aria-label="Open terminal" title="Open terminal" onClick={() => void dashboard.handleOpenTerminal()}><TerminalSquare /></Button>
              </>
            ) : null}
            {isStudio ? <Button variant="secondary" onClick={() => onNavigate("resource")}>Studio</Button> : null}
            {canCreateTask ? (
              <Button variant="primary" className="odb-new" onClick={openNewTask}>
                <Plus />New task{newTaskKeys ? <kbd>{newTaskKeys}</kbd> : null}
              </Button>
            ) : null}
          </>
        )}
      />

      {isGitRepo && !isStudio ? (
        <section className="odb-repo oui-rise" style={{ animationDelay: "50ms" }} aria-label="Main checkout">
          <div className="odb-repo-l">
            <GitBranch aria-hidden="true" />Main checkout <span className="oui-mono oui-truncate">{currentStatus.currentBranch}</span>
          </div>
          <div className="odb-stats">
            <span className="odb-stat" title={currentStatus.hasOrigin ? undefined : "No upstream on origin"}><ArrowUp aria-hidden="true" /><b key={`a${ahead}`} className="odb-bump">{ahead}</b> ahead</span>
            <span className="odb-stat"><ArrowDown aria-hidden="true" /><b key={`b${behind}`} className="odb-bump">{behind}</b> behind</span>
            <span className={`odb-stat${changes > 0 ? " is-hot" : ""}`}><b key={`c${changes}`} className="odb-bump">{changes}</b> uncommitted</span>
            {currentStatus.hasConflicts ? <span className="odb-stat is-danger">Conflicts</span> : null}
          </div>
          {toast}
          <Button
            variant="ghost" iconOnly size="sm" aria-label="Fetch" title="Fetch"
            disabled={!currentStatus.hasOrigin || isOperating}
            onClick={() => void runGit("fetch", dashboard.handleFetch)}
          >
            <RefreshCw className={gitOp === "fetch" ? "oui-spin" : undefined} />
          </Button>
          <Button variant="secondary" size="sm" disabled={!currentStatus.hasOrigin || isOperating} onClick={() => void runGit("pull", dashboard.handlePull)}>
            <ArrowDown className={gitOp === "pull" ? "odb-spin-y" : undefined} />Pull
          </Button>
          <Button variant="secondary" size="sm" disabled={pushDisabled} onClick={() => void runGit("push", dashboard.handlePush)}>
            <ArrowUp className={gitOp === "push" ? "odb-spin-y" : undefined} />Push
          </Button>
          <Button variant={hasLocalChanges ? "primary" : "secondary"} size="sm" disabled={!hasLocalChanges || isOperating} onClick={dashboard.handleCommit}>
            <GitCommit />Commit
          </Button>
        </section>
      ) : !isGitRepo && !isStudio ? (
        <section className="odb-repo oui-rise is-warn" style={{ animationDelay: "50ms" }} aria-label="Repository">
          <div className="odb-repo-l"><GitBranch aria-hidden="true" />Not a Git repository</div>
          <span className="odb-repo-note">Sessions and notes work here. Initialize Git to unlock tasks, review and commits.</span>
          <Button variant="primary" size="sm" disabled={isInitializingGit} onClick={() => void handleInitGit()}>
            {isInitializingGit ? "Initializing…" : "Initialize Git"}
          </Button>
        </section>
      ) : null}

      <div className="odb-grid">
        <div className="odb-col">
          <div className="oui-rise odb-inbox-wrap" style={{ animationDelay: "100ms" }}>
            <NeedsYouCard
              items={needsYou}
              now={now}
              onAnswer={(item, option) => void answer(item, option)}
              onOpen={(item) => openTask(item.taskId, item.chatId)}
              onDismiss={(item) => void dismissNotification(item.projectId, item.taskId)}
              formFor={pendingForms.formFor}
              onAnswerForm={(item, form, value) => void answerForm(item, form, value)}
              onDeclineForm={(item, form) => void answerForm(item, form, null)}
            />
          </div>
          <div className="oui-rise odb-fill-wrap" style={{ animationDelay: "140ms" }}>
            <InFlightCard
              tasks={inFlight}
              activity={activity}
              diffFor={details.diffFor}
              linksFor={details.linksFor}
              linkable={linkable}
              savingTask={details.savingTask}
              linkError={details.linkError}
              now={now}
              onSaveLinks={(taskId, ids) => void details.saveLinks(taskId, ids)}
              onOpen={(task: Task, chatId) => openTask(task.id, chatId)}
              onNewTask={openNewTask}
            />
          </div>
          <div className="oui-rise odb-recent-wrap" style={{ animationDelay: "180ms" }}>
            <RecentSessionsCard
              projectId={selectedProject.id}
              sessions={recent.sessions}
              loaded={recent.loaded}
              chats={chats}
              taskNames={taskNames}
              now={now}
              onOpen={(taskId, chatId) => openTask(taskId, chatId)}
            />
          </div>
        </div>

        <div className="odb-col">
          <AgentContextCard context={context} onNavigate={(page) => onNavigate(page)} />
          <ProjectLinksCard view={projectLinks} linkable={linkable} />

          <Card
            className="odb-usage oui-rise"
            style={{ animationDelay: "200ms" }}
            aria-label="Usage"
            title="Usage"
            hint="last 7 days"
            actions={<Button variant="ghost" iconOnly size="sm" aria-label="Open statistics" title="Statistics" onClick={() => onNavigate("statistics")}><BarChart2 /></Button>}
          >
            <WeeklyUsage stats={tokenStats} />
          </Card>

        </div>
      </div>
    </OrbitPage>
  );
}
