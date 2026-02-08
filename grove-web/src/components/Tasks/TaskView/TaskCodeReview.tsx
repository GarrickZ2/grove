import { motion } from "framer-motion";
import {
  X,
  Code,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Button } from "../../ui";
import { DiffReviewPage } from "../../Review";

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
}

export function TaskCodeReview({
  projectId,
  taskId,
  onClose,
  fullscreen = false,
  onToggleFullscreen,
}: TaskCodeReviewProps) {
  const containerClass = `flex-1 flex flex-col bg-[var(--color-bg-secondary)] overflow-hidden ${fullscreen ? '' : 'rounded-lg border border-[var(--color-border)]'}`;

  return (
    <motion.div
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className={containerClass}
    >
      {/* Header */}
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

      {/* Embedded diff review */}
      <div className="flex-1 overflow-hidden">
        <DiffReviewPage
          projectId={projectId}
          taskId={taskId}
          embedded
        />
      </div>
    </motion.div>
  );
}
