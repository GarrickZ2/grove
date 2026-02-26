import { useState } from "react";
import { motion } from "framer-motion";
import { Terminal as TerminalIcon, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import type { Task } from "../../../data/types";
import { XTerminal } from "../TaskDetail/XTerminal";
import { useTerminalTheme } from "../../../context";

interface TaskTerminalProps {
  /** Project ID for the task */
  projectId: string;
  /** Task to display */
  task: Task;
  collapsed?: boolean;
  onExpand?: () => void;
  /** Called when terminal connects successfully (session is now live) */
  onConnected?: () => void;
  /** Called when terminal disconnects (session ended) */
  onDisconnected?: () => void;
  /** Whether this panel is in fullscreen mode */
  fullscreen?: boolean;
  /** Toggle fullscreen mode */
  onToggleFullscreen?: () => void;
  /** Hide the terminal header (for FlexLayout tabs) */
  hideHeader?: boolean;
}

export function TaskTerminal({
  projectId,
  task,
  collapsed = false,
  onExpand,
  onConnected: onConnectedProp,
  onDisconnected: onDisconnectedProp,
  fullscreen = false,
  onToggleFullscreen,
  hideHeader = false,
}: TaskTerminalProps) {
  const { terminalTheme } = useTerminalTheme();
  const [isConnected, setIsConnected] = useState(false);

  // Handle terminal connected
  const handleConnected = () => {
    setIsConnected(true);
    onConnectedProp?.();
  };

  // Collapsed mode: vertical bar
  if (collapsed) {
    return (
      <motion.div
        layout
        initial={{ width: 48 }}
        animate={{ width: 48 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="h-full flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden cursor-pointer hover:bg-[var(--color-bg)] transition-colors"
        onClick={onExpand}
        title="Expand Terminal (t)"
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

          {/* Expand indicator */}
          <div className="p-3 text-[var(--color-text-muted)]">
            <ChevronRight className="w-5 h-5" />
          </div>
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
      className={`flex-1 flex flex-col overflow-hidden ${fullscreen || hideHeader ? '' : 'rounded-lg border border-[var(--color-border)]'}`}
      style={{ backgroundColor: terminalTheme.colors.background }}
    >
      {/* Terminal Header - 只在非 hideHeader 模式下显示 */}
      {!hideHeader && (
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
            {onToggleFullscreen && (
              <button
                onClick={onToggleFullscreen}
                className="ml-1 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
                title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
              >
                {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Terminal Content - Real xterm.js with tmux session */}
      <div className="flex-1 min-h-0">
        <XTerminal
          projectId={projectId}
          taskId={task.id}
          onConnected={handleConnected}
          onDisconnected={() => { setIsConnected(false); onDisconnectedProp?.(); }}
        />
      </div>
    </motion.div>
  );
}
