import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  X,
  Code,
  Eye,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Button } from "../../ui";
import { DiffReviewPage } from "../../Review";
import type { FileNavRequest } from "../../Review";
import { useProject } from "../../../context";
import type { LinkedReviewProject } from "../../../hooks/useLinkedReviewProjects";
import { useOrbitInterface } from "../../../orbit/ui/interfaceContext";
import { PanelEmpty } from "../../../orbit/ui/PanelShell";
import { useInPanelShell } from "../../../orbit/ui/panelSlots";
import { LinkedProjectPicker } from "../TaskDetail/tabs/LinkedProjectPicker";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { NO_LINKABLE_PROJECTS, useProjectLinker, type ProjectLinker } from "./useProjectLinker";
import { useProjectTarget, type ProjectTarget } from "./useProjectTarget";

interface TaskCodeReviewProps {
  /** Project ID */
  projectId: string;
  /** Task ID */
  taskId: string;
  /** Callback when close button is clicked */
  onClose: () => void;
  /** Whether this panel is in fullscreen mode */
  fullscreen?: boolean;
  /** Toggle fullscreen mode */
  onToggleFullscreen?: () => void;
  /** Hide the review header (for FlexLayout tabs) */
  hideHeader?: boolean;
  /** External navigation request — open a file (optionally at a line) in Review */
  navigateToFile?: FileNavRequest | null;
  /** Whether the project is a git repository (non-git projects don't have Changes mode) */
  isGitRepo?: boolean;
  isChatBusy?: boolean;
  /** Whether the task has a Code Review of its own (false for Studio tasks). */
  hasOwnReview?: boolean;
  /** Linked Projects whose Code Review can be switched to. Each shows exactly
   *  the review of that Project's Local Task, as on that Project's own page. */
  linkedProjects?: LinkedReviewProject[];
}

/** A Studio task with nothing to review yet: the way to get something here. */
function LinkProjectGuide({ linker, orbit }: { linker: ProjectLinker; orbit: boolean }) {
  const picker = (
    <LinkedProjectPicker
      projects={linker.projects}
      disabled={linker.disabled}
      onSelect={linker.link}
      triggerClassName={orbit ? "oui-btn oui-btn-primary" : undefined}
      emptyLabel={NO_LINKABLE_PROJECTS}
    />
  );
  const body = linker.error ?? "Studio tasks have no code of their own. Link a coding project to review its changes here.";
  if (orbit) {
    return (
      <div className="flex h-full flex-col">
        <PanelEmpty icon={Eye} title="Review a coding project" action={picker}>{body}</PanelEmpty>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--color-text-muted)]">
      <p>{body}</p>
      {picker}
    </div>
  );
}

export function TaskCodeReview({
  projectId,
  taskId,
  onClose,
  fullscreen = false,
  onToggleFullscreen,
  hideHeader = false,
  navigateToFile,
  isGitRepo,
  isChatBusy,
  hasOwnReview = true,
  linkedProjects,
}: TaskCodeReviewProps) {
  const { projects } = useProject();
  const ownName = projects.find((p) => p.id === projectId)?.name ?? "This task";
  const targets = useMemo<ProjectTarget[]>(() => [
    ...(hasOwnReview ? [{ projectId, taskId, name: ownName, isGitRepo, linked: false }] : []),
    ...(linkedProjects ?? []).map((p) => ({ ...p, linked: true })),
  ], [hasOwnReview, projectId, taskId, ownName, isGitRepo, linkedProjects]);

  const { active, select } = useProjectTarget(`grove:review-target:${projectId}:${taskId}`, targets);
  const linker = useProjectLinker(projectId, taskId, select);
  const showSwitcher = (linkedProjects?.length ?? 0) > 0;
  // In an Orbit panel shell the shell header is the title (and owns close);
  // Review puts its controls in that header (see Review/OrbitReviewChrome).
  const orbit = useOrbitInterface();
  const inShell = useInPanelShell();
  const shellOwnsHeader = orbit && inShell;

  const containerClass = `h-full min-h-0 flex-1 flex flex-col bg-[var(--color-bg-secondary)] overflow-hidden ${fullscreen || shellOwnsHeader ? '' : 'rounded-lg border border-[var(--color-border)]'}`;

  return (
    <motion.div
      // In Orbit the dock and PanelShell already animate the panel in.
      initial={shellOwnsHeader ? false : { x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1, transitionEnd: { transform: "none" } }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className={containerClass}
    >
      {/* Header - 只在非 hideHeader 模式下显示 */}
      {!hideHeader && !shellOwnsHeader && (
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text)]">
          <Code className="w-4 h-4" />
          <span className="font-medium">Code Review</span>
        </div>
        <div className="flex items-center gap-1">
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4 mr-1" />
            Close
          </Button>
        </div>
      </div>
      )}

      {/* Embedded diff review */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {active ? (
          <DiffReviewPage
            key={`${active.projectId}:${active.taskId}`}
            projectId={active.projectId}
            taskId={active.taskId}
            embedded
            // File-open requests come from this task's chat and address its own tree.
            navigateToFile={active.linked ? null : navigateToFile}
            isGitRepo={active.isGitRepo}
            isChatBusy={isChatBusy}
            title={showSwitcher ? (
              <ProjectSwitcher targets={targets} active={active} onSelect={select} verb="Reviewing" linker={linker} />
            ) : undefined}
          />
        ) : linker.loading || linker.hasReviewable ? null : (
          <LinkProjectGuide linker={linker} orbit={shellOwnsHeader} />
        )}
      </div>
    </motion.div>
  );
}
