import { useState } from "react";
import { TaskHeader } from "./TaskHeader";
import { TaskTerminal } from "./TaskTerminal";
import { TaskTabs } from "./TaskTabs";
import { TaskActions } from "./TaskActions";
import { GitTab } from "./tabs/GitTab";
import { NotesTab } from "./tabs/NotesTab";
import { ReviewTab } from "./tabs/ReviewTab";
import { AITab } from "./tabs/AITab";
import { StatsTab } from "./tabs/StatsTab";
import type { Task } from "../../../data/types";

interface TaskDetailProps {
  /** Project ID for the task */
  projectId: string;
  task: Task;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onRecover: () => void;
}

export type TabType = "git" | "notes" | "review" | "ai" | "stats";

export function TaskDetail({
  projectId,
  task,
  onSync,
  onMerge,
  onArchive,
  onClean,
  onRecover,
}: TaskDetailProps) {
  const [activeTab, setActiveTab] = useState<TabType>("git");

  const renderTabContent = () => {
    switch (activeTab) {
      case "git":
        return <GitTab task={task} />;
      case "notes":
        return <NotesTab task={task} />;
      case "review":
        return <ReviewTab task={task} />;
      case "ai":
        return <AITab task={task} />;
      case "stats":
        return <StatsTab projectId={projectId} task={task} />;
    }
  };

  return (
    <div className="h-full flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Header */}
      <TaskHeader task={task} />

      {/* Terminal (only for live/idle tasks) */}
      {task.status !== "archived" && task.status !== "merged" && (
        <TaskTerminal projectId={projectId} task={task} />
      )}

      {/* Tabs */}
      <TaskTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div className="flex-1 min-h-0 p-4 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto">
          {renderTabContent()}
        </div>
      </div>

      {/* Actions */}
      <TaskActions
        task={task}
        onSync={onSync}
        onMerge={onMerge}
        onArchive={onArchive}
        onClean={onClean}
        onRecover={onRecover}
      />
    </div>
  );
}
