import { useState } from "react";
import { motion } from "framer-motion";
import { Terminal as TerminalIcon, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "../../ui";
import type { Task } from "../../../data/types";
import { XTerminal } from "./XTerminal";
import { useTerminalTheme } from "../../../context";

interface TaskTerminalProps {
  /** Project ID for the task */
  projectId: string;
  /** Task to connect to */
  task: Task;
}

export function TaskTerminal({ projectId, task }: TaskTerminalProps) {
  const { terminalTheme } = useTerminalTheme();
  const [isConnected, setIsConnected] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`mx-4 my-3 rounded-lg border border-[var(--color-border)] overflow-hidden transition-all duration-200
        ${isExpanded ? "h-[400px]" : "h-[220px]"}`}
      style={{ backgroundColor: terminalTheme.colors.background }}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <TerminalIcon className="w-4 h-4" />
          <span>Terminal</span>
          <span className="text-xs text-[var(--color-text-muted)] opacity-60">
            {task.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-[var(--color-success)] animate-pulse" : "bg-[var(--color-warning)]"}`}
            />
            <span className="text-xs text-[var(--color-text-muted)]">
              {isConnected ? "Connected" : "Connecting..."}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1"
          >
            {isExpanded ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Terminal Content - Real xterm.js with tmux session */}
      <div className={`${isExpanded ? "h-[calc(100%-40px)]" : "h-[180px]"}`}>
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
