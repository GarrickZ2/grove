import { useState } from "react";
import { motion } from "framer-motion";
import { Terminal as TerminalIcon, Play, ChevronRight } from "lucide-react";
import { Button } from "../../ui";
import type { Task } from "../../../data/types";
import { XTerminal } from "../TaskDetail/XTerminal";

interface TaskTerminalProps {
  /** Project ID for the task */
  projectId: string;
  /** Task to display */
  task: Task;
  collapsed?: boolean;
  onExpand?: () => void;
  onStartSession: () => void;
}

export function TaskTerminal({
  projectId,
  task,
  collapsed = false,
  onExpand,
  onStartSession,
}: TaskTerminalProps) {
  const [isConnected, setIsConnected] = useState(false);

  const isLive = task.status === "live";

  // Collapsed mode: vertical bar
  if (collapsed) {
    return (
      <motion.div
        layout
        initial={{ width: 48 }}
        animate={{ width: 48 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="h-full flex flex-col rounded-lg border border-[var(--color-border)] bg-[#0d0d0d] overflow-hidden"
      >
        {/* Vertical Bar */}
        <div className="flex-1 flex flex-col items-center py-2">
          {/* Terminal icon */}
          <div className="p-3 text-[var(--color-text-muted)]">
            <TerminalIcon className="w-5 h-5" />
          </div>

          {/* Live indicator */}
          {isConnected && (
            <div className="p-3">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-success)] animate-pulse" />
            </div>
          )}

          <div className="flex-1" />

          {/* Expand button */}
          <button
            onClick={onExpand}
            className="p-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title="Expand Terminal (closes Review)"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </motion.div>
    );
  }

  // Not live: show start session prompt (keep for idle tasks)
  if (!isLive) {
    return (
      <motion.div
        layout
        className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[#0d0d0d] overflow-hidden"
      >
        <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <TerminalIcon className="w-4 h-4" />
            <span>Terminal</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <TerminalIcon className="w-10 h-10 text-[var(--color-text-muted)] mb-3" />
          <p className="text-sm text-[var(--color-text-muted)] mb-3">
            Session not running
          </p>
          <Button variant="secondary" size="sm" onClick={onStartSession}>
            <Play className="w-4 h-4 mr-1.5" />
            Start Session
          </Button>
        </div>
      </motion.div>
    );
  }

  // Full terminal view - Real xterm.js with tmux session
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[#0d0d0d] overflow-hidden"
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <TerminalIcon className="w-4 h-4" />
          <span>Terminal</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-[var(--color-success)] animate-pulse" : "bg-[var(--color-warning)]"}`}
          />
          <span className="text-xs text-[var(--color-text-muted)]">
            {isConnected ? "Connected" : "Connecting..."}
          </span>
        </div>
      </div>

      {/* Terminal Content - Real xterm.js with tmux session */}
      <div className="flex-1 min-h-0">
        <XTerminal
          projectId={projectId}
          taskId={task.id}
          onConnected={() => setIsConnected(true)}
          onDisconnected={() => setIsConnected(false)}
        />
      </div>
    </motion.div>
  );
}
