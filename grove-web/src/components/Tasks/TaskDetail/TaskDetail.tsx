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
  task: Task;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onRecover: () => void;
  onStartSession: () => void;
}

export type TabType = "git" | "notes" | "review" | "ai" | "stats";

export function TaskDetail({
  task,
  onSync,
  onMerge,
  onArchive,
  onClean,
  onRecover,
  onStartSession,
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
        return <StatsTab task={task} />;
    }
  };

  return (
    <div className="h-full flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Header */}
      <TaskHeader task={task} />

      {/* Terminal (only for live/idle tasks) */}
      {task.status !== "archived" && task.status !== "merged" && (
        <TaskTerminal
          task={task}
          onStartSession={onStartSession}
        />
      )}

      {/* Tabs */}
      <TaskTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {renderTabContent()}
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
