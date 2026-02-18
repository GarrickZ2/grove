import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
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
  FileCode,
  GitBranchPlus,
  MoreHorizontal,
} from "lucide-react";
import { Button, DropdownMenu } from "../../ui";
import type { Task } from "../../../data/types";
import { StatsTab, GitTab, NotesTab, CommentsTab } from "./tabs";
import { useConfig } from "../../../context";
import type { PanelType } from "../PanelSystem/types";

interface TaskInfoPanelProps {
  projectId: string;
  task: Task;
  projectName?: string;
  onClose: () => void;
  onRecover?: () => void;
  onClean?: () => void;
  isTerminalMode?: boolean;
  // Controlled tab mode (optional)
  activeTab?: TabType;
  onTabChange?: (tab: TabType) => void;
  // Action handlers for non-archived tasks
  onCommit?: () => void;
  onRebase?: () => void;
  onSync?: () => void;
  onMerge?: () => void;
  onArchive?: () => void;
  onReset?: () => void;
  // 新增：进入 Workspace (双击任务或点击 Workspace 按钮)
  onEnterWorkspace?: () => void;
  // 新增：在 FlexLayout 中打开 panel (Chat/Terminal/Review/Editor/Stats/Git/Notes/Comments)
  onAddPanel?: (type: PanelType) => void;
}

export type TabType = "stats" | "git" | "notes" | "comments";

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
  projectName,
  onClose,
  onRecover,
  onClean,
  isTerminalMode = false,
  activeTab: controlledTab,
  onTabChange,
  onCommit,
  onRebase,
  onSync,
  onMerge,
  onArchive,
  onReset,
  onEnterWorkspace,
  onAddPanel,
}: TaskInfoPanelProps) {
  const { config, terminalAvailable, chatAvailable } = useConfig();
  const isArchived = task.status === "archived";
  const isBroken = task.status === "broken";
  const canOperate = !isArchived && !isBroken;
  const [internalTab, setInternalTab] = useState<TabType>("stats");
  const [expanded, setExpanded] = useState(false);

  // Support controlled/uncontrolled tab mode
  const activeTab = controlledTab ?? internalTab;
  const handleTabChange = (tab: TabType) => {
    setInternalTab(tab);
    onTabChange?.(tab);
  };

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
          {/* Close button */}
          <button
            onClick={onClose}
            className="p-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title="Close panel"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="h-px bg-[var(--color-border)]" />

          {/* Tab icons */}
          <div className="flex-1 flex flex-col py-2">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              // 只在侧边栏模式（没有 onAddPanel）时显示 active 状态
              const isActive = !onAddPanel && activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    // 如果提供了 onAddPanel 回调，在 FlexLayout 中打开 panel
                    if (onAddPanel) {
                      onAddPanel(tab.id);
                    } else {
                      // 否则使用原有的展开侧边栏逻辑（向后兼容）
                      handleTabChange(tab.id);
                      if (!expanded) setExpanded(true);
                    }
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

          {/* Expand/Collapse toggle - 只在侧边栏模式显示 */}
          {!onAddPanel && (
            <>
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
            </>
          )}
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
                <div className="flex items-center gap-1.5">
                  <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
                    {task.name}
                  </h2>
                  {projectName && (
                    <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] rounded">{projectName}</span>
                  )}
                </div>
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
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
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
              {/* 按钮新顺序: Chat Terminal | Review Editor | Commit Rebase Sync Merge | ... (dropdown) | Workspace */}

              {/* Chat 按钮（仅当全局启用 Chat 时显示） */}
              {onAddPanel && config?.enable_chat && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onAddPanel('chat')}
                  disabled={!chatAvailable}
                  title={!chatAvailable ? "No ACP agent available" : undefined}
                  className={`text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] ${!chatAvailable ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <MessageSquare className="w-4 h-4 mr-1" />
                  Chat
                </Button>
              )}

              {/* Terminal 按钮（仅当全局启用 Terminal 时显示） */}
              {onAddPanel && config?.enable_terminal && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onAddPanel('terminal')}
                  disabled={!terminalAvailable}
                  title={!terminalAvailable ? "Requires tmux or zellij" : undefined}
                  className={`text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] ${!terminalAvailable ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <Terminal className="w-4 h-4 mr-1" />
                  Terminal
                </Button>
              )}

              {/* Separator (仅当有 Chat 或 Terminal 时显示) */}
              {onAddPanel && (config?.enable_chat || config?.enable_terminal) && (
                <div className="w-px h-6 bg-[var(--color-border)] mx-1" />
              )}

              {/* Review 按钮 */}
              {onAddPanel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onAddPanel('review')}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <Code className="w-4 h-4 mr-1" />
                  Review
                </Button>
              )}

              {/* Editor 按钮 */}
              {onAddPanel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onAddPanel('editor')}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <FileCode className="w-4 h-4 mr-1" />
                  Editor
                </Button>
              )}

              {/* Separator */}
              {onAddPanel && <div className="w-px h-6 bg-[var(--color-border)] mx-1" />}

              {/* Git actions */}
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

              {/* Workspace 按钮 */}
              {onEnterWorkspace && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onEnterWorkspace}
                >
                  <ChevronRight className="w-4 h-4 mr-1" />
                  Workspace
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Task Name */}
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
            {task.name}
          </h2>
          {projectName && (
            <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] rounded">{projectName}</span>
          )}
        </div>
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
              onClick={() => handleTabChange(tab.id)}
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
