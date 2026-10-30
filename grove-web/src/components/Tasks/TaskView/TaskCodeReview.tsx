import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  X,
  Code,
  Check,
  ChevronDown,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Button } from "../../ui";
import { DiffReviewPage } from "../../Review";
import type { FileNavRequest } from "../../Review";
import { useProject, useTheme } from "../../../context";
import type { LinkedReviewProject } from "../../../hooks/useLinkedReviewProjects";
import { getProjectStyle } from "../../../utils/projectStyle";

/** One Code Review the panel can show: the task's own, or a linked Project's. */
interface ReviewTarget {
  projectId: string;
  taskId: string;
  name: string;
  isGitRepo?: boolean;
  linked: boolean;
}

function readSelection(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSelection(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable — selection just won't survive a reload.
  }
}

function ProjectGlyph({ projectId }: { projectId: string }) {
  const { theme } = useTheme();
  const { color, Icon } = getProjectStyle(projectId, theme.accentPalette);
  return (
    <span className="review-project-glyph" style={{ backgroundColor: color.bg }}>
      <Icon style={{ color: color.fg }} />
    </span>
  );
}

/** Project picker that takes the place of the Review heading, so switching
 *  Projects costs no extra row. Fixed width keeps the header from shifting
 *  as names change; it collapses to icon-only in narrow panels. */
function ReviewProjectSwitcher({
  targets,
  active,
  onSelect,
}: {
  targets: ReviewTarget[];
  active: ReviewTarget;
  onSelect: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const own = targets.filter((t) => !t.linked);
  const linked = targets.filter((t) => t.linked);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const renderOption = (target: ReviewTarget) => {
    const selected = target.projectId === active.projectId;
    return (
      <button
        key={target.projectId}
        type="button"
        role="option"
        aria-selected={selected}
        className="review-project-option"
        onClick={() => {
          onSelect(target.projectId);
          setOpen(false);
        }}
      >
        <ProjectGlyph projectId={target.projectId} />
        <span className="review-project-name">{target.name}</span>
        <Check className={`review-project-check ${selected ? "" : "invisible"}`} />
      </button>
    );
  };

  return (
    <div ref={rootRef} className="review-project-switcher">
      <button
        type="button"
        className="review-project-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Reviewing ${active.name}. Switch project`}
        title={active.name}
        onClick={() => setOpen((v) => !v)}
      >
        <ProjectGlyph projectId={active.projectId} />
        <span className="review-project-name">{active.name}</span>
        <ChevronDown className="review-project-chevron" />
      </button>
      {open && (
        <div role="listbox" aria-label="Project to review" className="review-project-menu">
          {own.map(renderOption)}
          {own.length > 0 && linked.length > 0 && (
            <div className="review-project-section">Linked projects</div>
          )}
          {linked.map(renderOption)}
        </div>
      )}
    </div>
  );
}

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
  const targets = useMemo<ReviewTarget[]>(() => [
    ...(hasOwnReview ? [{ projectId, taskId, name: ownName, isGitRepo, linked: false }] : []),
    ...(linkedProjects ?? []).map((p) => ({ ...p, linked: true })),
  ], [hasOwnReview, projectId, taskId, ownName, isGitRepo, linkedProjects]);

  const selectionKey = `grove:review-target:${projectId}:${taskId}`;
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelection(selectionKey));
  const active = targets.find((t) => t.projectId === selectedId) ?? targets[0];
  const selectTarget = (id: string) => {
    setSelectedId(id);
    writeSelection(selectionKey, id);
  };
  const showSwitcher = (linkedProjects?.length ?? 0) > 0;

  const containerClass = `h-full min-h-0 flex-1 flex flex-col bg-[var(--color-bg-secondary)] overflow-hidden ${fullscreen ? '' : 'rounded-lg border border-[var(--color-border)]'}`;

  return (
    <motion.div
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1, transitionEnd: { transform: "none" } }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className={containerClass}
    >
      {/* Header - 只在非 hideHeader 模式下显示 */}
      {!hideHeader && (
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
              <ReviewProjectSwitcher targets={targets} active={active} onSelect={selectTarget} />
            ) : undefined}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-text-muted)]">
            Link a coding project in Info to review its changes here.
          </div>
        )}
      </div>
    </motion.div>
  );
}
