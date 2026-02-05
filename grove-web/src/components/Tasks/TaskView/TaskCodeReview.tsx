import { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import {
  X,
  Code,
  Loader2,
  AlertCircle,
  CheckCircle,
  FileQuestion,
} from "lucide-react";
import { Button } from "../../ui";
import { startDifit, getDifitStatus, stopDifit } from "../../../api";
import type { DifitStatusResponse } from "../../../api";

interface TaskCodeReviewProps {
  /** Project ID */
  projectId: string;
  /** Task ID */
  taskId: string;
  /** Callback when close button is clicked */
  onClose: () => void;
}

export function TaskCodeReview({
  projectId,
  taskId,
  onClose,
}: TaskCodeReviewProps) {
  const [status, setStatus] = useState<DifitStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start difit and poll for URL
  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      try {
        // Start difit (or get existing session)
        const initial = await startDifit(projectId, taskId);
        if (cancelled) return;
        setStatus(initial);

        // If starting, poll until URL is ready
        if (initial.status === "starting") {
          pollIntervalRef.current = setInterval(async () => {
            try {
              const current = await getDifitStatus(projectId, taskId);
              if (cancelled) return;
              setStatus(current);
              if (current.status !== "starting") {
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }
              }
            } catch {
              // Ignore poll errors
            }
          }, 1000);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to start difit");
        }
      }
    };

    start();

    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [projectId, taskId]);

  // Handle close: stop difit server first, then call onClose
  const handleClose = async () => {
    // Stop difit server so it outputs comments
    try {
      await stopDifit(projectId, taskId);
    } catch {
      // Ignore errors, proceed with close
    }
    onClose();
  };

  // Header component (reused across states)
  const Header = () => (
    <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text)]">
        <Code className="w-4 h-4" />
        <span className="font-medium">Code Review</span>
      </div>
      <Button variant="ghost" size="sm" onClick={handleClose}>
        <X className="w-4 h-4 mr-1" />
        Close
      </Button>
    </div>
  );

  // Error state
  if (error) {
    return (
      <motion.div
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
      >
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <AlertCircle className="w-12 h-12 text-[var(--color-danger)] mb-4" />
          <p className="text-[var(--color-text)] font-medium mb-2">
            Failed to start code review
          </p>
          <p className="text-[var(--color-text-muted)] text-sm text-center">
            {error}
          </p>
        </div>
      </motion.div>
    );
  }

  // Loading state (starting)
  if (!status || status.status === "starting") {
    return (
      <motion.div
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
      >
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <Loader2 className="w-12 h-12 text-[var(--color-primary)] mb-4 animate-spin" />
          <p className="text-[var(--color-text)] font-medium mb-2">
            Starting code review server...
          </p>
          <p className="text-[var(--color-text-muted)] text-sm">
            This may take a few seconds
          </p>
        </div>
      </motion.div>
    );
  }

  // Not available state
  if (status.status === "not_available") {
    return (
      <motion.div
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
      >
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <AlertCircle className="w-12 h-12 text-[var(--color-warning)] mb-4" />
          <p className="text-[var(--color-text)] font-medium mb-2">
            Difit not available
          </p>
          <p className="text-[var(--color-text-muted)] text-sm text-center mb-4">
            Install difit to enable code review:
          </p>
          <code className="px-3 py-2 bg-[var(--color-bg-tertiary)] rounded text-sm text-[var(--color-text)]">
            npm install -g difit
          </code>
        </div>
      </motion.div>
    );
  }

  // No diff state
  if (status.status === "no_diff") {
    return (
      <motion.div
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
      >
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <CheckCircle className="w-12 h-12 text-[var(--color-success)] mb-4" />
          <p className="text-[var(--color-text)] font-medium mb-2">
            No differences found
          </p>
          <p className="text-[var(--color-text-muted)] text-sm text-center">
            This task has no changes compared to the target branch.
          </p>
        </div>
      </motion.div>
    );
  }

  // Completed state (show placeholder, ReviewTab will show comments)
  if (status.status === "completed") {
    return (
      <motion.div
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
      >
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <FileQuestion className="w-12 h-12 text-[var(--color-text-muted)] mb-4" />
          <p className="text-[var(--color-text)] font-medium mb-2">
            Review session completed
          </p>
          <p className="text-[var(--color-text-muted)] text-sm text-center">
            Check the Review tab for any comments.
          </p>
        </div>
      </motion.div>
    );
  }

  // Running state - show iframe with difit URL
  if (status.status === "running" && status.url) {
    return (
      <motion.div
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
      >
        <Header />
        <div className="flex-1 relative">
          <iframe
            src={status.url}
            className="absolute inset-0 w-full h-full border-0"
            title="Code Review"
          />
        </div>
      </motion.div>
    );
  }

  // Fallback (shouldn't happen)
  return null;
}
