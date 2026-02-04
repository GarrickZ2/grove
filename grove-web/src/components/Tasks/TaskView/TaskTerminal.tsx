import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Terminal as TerminalIcon, Play, ChevronRight } from "lucide-react";
import { Button } from "../../ui";
import type { Task } from "../../../data/types";
import { mockTerminalOutput } from "../../../data/mockData";

interface TaskTerminalProps {
  task: Task;
  collapsed?: boolean;
  onExpand?: () => void;
  onStartSession: () => void;
}

// Parse ANSI codes and convert to styled spans
function parseAnsiToHtml(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let currentIndex = 0;
  let key = 0;

  // Simple ANSI color mappings
  const colorMap: Record<string, string> = {
    "30": "#1a1a1a",
    "31": "var(--color-error)",
    "32": "var(--color-success)",
    "33": "var(--color-warning)",
    "34": "var(--color-info)",
    "35": "#a855f7",
    "36": "#22d3ee",
    "37": "var(--color-text)",
    "90": "var(--color-text-muted)",
  };

  const regex = /\x1b\[([0-9;]*)m/g;
  let match;
  let currentStyle: React.CSSProperties = {};

  while ((match = regex.exec(text)) !== null) {
    // Add text before this match
    if (match.index > currentIndex) {
      const textBefore = text.slice(currentIndex, match.index);
      result.push(
        <span key={key++} style={currentStyle}>
          {textBefore}
        </span>
      );
    }

    // Parse the ANSI code
    const codes = match[1].split(";");
    for (const code of codes) {
      if (code === "0" || code === "") {
        // Reset
        currentStyle = {};
      } else if (code === "1") {
        // Bold
        currentStyle = { ...currentStyle, fontWeight: "bold" };
      } else if (colorMap[code]) {
        // Color
        currentStyle = { ...currentStyle, color: colorMap[code] };
      }
    }

    currentIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (currentIndex < text.length) {
    result.push(
      <span key={key++} style={currentStyle}>
        {text.slice(currentIndex)}
      </span>
    );
  }

  return result;
}

export function TaskTerminal({ task, collapsed = false, onExpand, onStartSession }: TaskTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayedContent, setDisplayedContent] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);

  const isLive = task.status === "live";

  // Simulate terminal output for live tasks
  useEffect(() => {
    if (!isLive) {
      setDisplayedContent("");
      return;
    }

    // Gradually "type" the output
    let charIndex = 0;
    const content = mockTerminalOutput;

    const typeInterval = setInterval(() => {
      if (charIndex < content.length) {
        setDisplayedContent(content.slice(0, charIndex + 1));
        charIndex++;
      } else {
        clearInterval(typeInterval);
      }
    }, 15);

    return () => clearInterval(typeInterval);
  }, [isLive, task.id]);

  // Cursor blink effect
  useEffect(() => {
    const blinkInterval = setInterval(() => {
      setCursorVisible((prev) => !prev);
    }, 530);

    return () => clearInterval(blinkInterval);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayedContent]);

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
          {isLive && (
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

  // Not live: show start session prompt
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

  // Full terminal view
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
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-success)] animate-pulse" />
          <span className="text-xs text-[var(--color-text-muted)]">Live</span>
        </div>
      </div>

      {/* Terminal Content */}
      <div
        ref={containerRef}
        className="flex-1 p-3 overflow-y-auto font-mono text-sm leading-relaxed"
        style={{ backgroundColor: "#0d0d0d" }}
      >
        <pre className="whitespace-pre-wrap text-[var(--color-text)]">
          {parseAnsiToHtml(displayedContent)}
          {displayedContent.endsWith("█") ? null : (
            <span
              className="inline-block w-2 h-4 bg-[var(--color-text)]"
              style={{ opacity: cursorVisible ? 1 : 0 }}
            />
          )}
        </pre>
      </div>
    </motion.div>
  );
}
