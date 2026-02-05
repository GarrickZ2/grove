import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  BarChart3,
  GitBranch,
  FileText,
  MessageSquare,
  Terminal,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  Trash2,
  GitCommit,
  RefreshCw,
  GitMerge,
  Archive,
  Code,
  GitBranchPlus,
  MoreHorizontal,
} from "lucide-react";
import { Button, DropdownMenu } from "../../ui";
import type { Task } from "../../../data/types";
import { StatsTab, GitTab, NotesTab, CommentsTab } from "./tabs";

interface TaskInfoPanelProps {
  projectId: string;
  task: Task;
  onClose: () => void;
  onEnterTerminal?: () => void;
  onRecover?: () => void;
  onClean?: () => void;
  isTerminalMode?: boolean;
  // Action handlers for non-archived tasks
  onCommit?: () => void;
  onReview?: () => void;
  onRebase?: () => void;
  onSync?: () => void;
  onMerge?: () => void;
  onArchive?: () => void;
  onReset?: () => void;
}

type TabType = "stats" | "git" | "notes" | "comments";

interface TabConfig {
  id: TabType;
  label: string;
  icon: typeof BarChart3;
}

const TABS: TabConfig[] = [
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "comments", label: "Comments", icon: MessageSquare },
];

export function TaskInfoPanel({
  projectId,
  task,
  onClose,
  onEnterTerminal,
  onRecover,
  onClean,
  isTerminalMode = false,
  onCommit,
  onReview,
  onRebase,
  onSync,
  onMerge,
  onArchive,
  onReset,
}: TaskInfoPanelProps) {
  const isArchived = task.status === "archived";
  const isBroken = task.status === "broken";
  const canOperate = !isArchived && !isBroken;
  const [activeTab, setActiveTab] = useState<TabType>("stats");
  const [expanded, setExpanded] = useState(false);

  const renderTabContent = () => {
    switch (activeTab) {
      case "stats":
        return <StatsTab projectId={projectId} task={task} />;
      case "git":
        return <GitTab task={task} />;
      case "notes":
        return <NotesTab task={task} />;
      case "comments":
        return <CommentsTab task={task} />;
    }
  };

  // Terminal mode: collapsible vertical bar
  if (isTerminalMode) {
    return (
      <motion.div
        layout
        initial={{ width: 48 }}
        animate={{ width: expanded ? "60%" : 48 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="h-full flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
        style={{ maxWidth: expanded ? "calc(100% - 400px)" : 48, minWidth: expanded ? 400 : 48 }}
      >
        {/* Vertical Tab Bar (always visible) */}
        <div className="w-12 flex-shrink-0 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
          {/* Back button */}
          <button
            onClick={onClose}
            className="p-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="h-px bg-[var(--color-border)]" />

          {/* Tab icons */}
          <div className="flex-1 flex flex-col py-2">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (!expanded) setExpanded(true);
                  }}
                  className={`
                    p-3 transition-colors
                    ${
                      isActive
                        ? "text-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                    }
                  `}
                  title={tab.label}
                >
                  <Icon className="w-5 h-5" />
                </button>
              );
            })}
          </div>

          {/* Expand/Collapse toggle */}
          <div className="h-px bg-[var(--color-border)]" />
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronLeft className="w-5 h-5" />
            ) : (
              <ChevronRight className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* Expandable Content Panel */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="flex-1 flex flex-col min-w-0 overflow-hidden"
            >
              {/* Task Info Header */}
              <div className="px-3 py-2 border-b border-[var(--color-border)]">
                <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
                  {task.name}
                </h2>
                <p className="text-xs text-[var(--color-text-muted)] font-mono truncate">
                  {task.branch} → {task.target}
                </p>
              </div>

              {/* Active Tab Label */}
              <div className="px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
                <span className="text-xs font-medium text-[var(--color-highlight)]">
                  {TABS.find((t) => t.id === activeTab)?.label}
                </span>
              </div>

              {/* Tab Content with fade animation */}
              <div className="flex-1 min-h-0 flex flex-col p-3">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeTab}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 min-h-0 overflow-y-auto"
                  >
                    {renderTabContent()}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  }

  // Info mode: full panel
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className="h-full flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>

        {/* Action buttons based on task status */}
        <div className="flex items-center gap-1">
          {isArchived ? (
            <>
              {onRecover && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRecover}
                  className="text-[var(--color-success)] hover:bg-[var(--color-success)]/10"
                >
                  <RotateCcw className="w-4 h-4 mr-1" />
                  Recover
                </Button>
              )}
              {onClean && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClean}
                  className="text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Clean
                </Button>
              )}
            </>
          ) : (
            <>
              {/* Primary actions */}
              {onCommit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCommit}
                  disabled={isArchived}
                  className="text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10"
                >
                  <GitCommit className="w-4 h-4 mr-1" />
                  Commit
                </Button>
              )}
              {onReview && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onReview}
                  disabled={isArchived}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <Code className="w-4 h-4 mr-1" />
                  Review
                </Button>
              )}
              {onRebase && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRebase}
                  disabled={!canOperate}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <GitBranchPlus className="w-4 h-4 mr-1" />
                  Rebase
                </Button>
              )}
              {onSync && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onSync}
                  disabled={!canOperate}
                  className="text-[var(--color-info)] hover:bg-[var(--color-info)]/10"
                >
                  <RefreshCw className="w-4 h-4 mr-1" />
                  Sync
                </Button>
              )}
              {onMerge && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onMerge}
                  disabled={!canOperate}
                  className="text-[var(--color-success)] hover:bg-[var(--color-success)]/10"
                >
                  <GitMerge className="w-4 h-4 mr-1" />
                  Merge
                </Button>
              )}
              {/* Dangerous actions in dropdown */}
              {(onArchive || onReset || onClean) && (
                <DropdownMenu
                  trigger={<MoreHorizontal className="w-4 h-4" />}
                  items={[
                    ...(onArchive ? [{
                      id: "archive",
                      label: "Archive",
                      icon: Archive,
                      onClick: onArchive,
                      variant: "warning" as const,
                      disabled: isBroken,
                    }] : []),
                    ...(onReset ? [{
                      id: "reset",
                      label: "Reset",
                      icon: RotateCcw,
                      onClick: onReset,
                      variant: "warning" as const,
                      disabled: isArchived,
                    }] : []),
                    ...(onClean ? [{
                      id: "clean",
                      label: "Clean",
                      icon: Trash2,
                      onClick: onClean,
                      variant: "danger" as const,
                    }] : []),
                  ]}
                />
              )}
              {onEnterTerminal && (
                <Button variant="secondary" size="sm" onClick={onEnterTerminal}>
                  <Terminal className="w-4 h-4 mr-1" />
                  Terminal
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Task Name */}
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
          {task.name}
        </h2>
        <p className="text-xs text-[var(--color-text-muted)] font-mono truncate">
          {task.branch} → {task.target}
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="relative flex border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                relative flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium
                transition-colors
                ${
                  isActive
                    ? "text-[var(--color-highlight)]"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }
              `}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{tab.label}</span>
              {/* Sliding indicator */}
              {isActive && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-highlight)]"
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content with fade animation */}
      <div className="flex-1 min-h-0 flex flex-col p-3">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="flex-1 min-h-0 overflow-y-auto"
          >
            {renderTabContent()}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
