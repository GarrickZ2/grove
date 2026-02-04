import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus } from "lucide-react";
import { TaskSidebar } from "./TaskSidebar/TaskSidebar";
import { TaskInfoPanel } from "./TaskInfoPanel";
import { TaskView } from "./TaskView";
import { NewTaskDialog } from "./NewTaskDialog";
import { Button } from "../ui";
import { useProject } from "../../context";
import type { Task, TaskFilter } from "../../data/types";

type ViewMode = "list" | "info" | "terminal";

export function TasksPage() {
  const { selectedProject } = useProject();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [filter, setFilter] = useState<TaskFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewTaskDialog, setShowNewTaskDialog] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Get tasks for current project
  const tasks = selectedProject?.tasks || [];

  // Filter and search tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Apply status filter
      if (filter === "active" && task.status === "archived") {
        return false;
      }
      if (filter === "archived" && task.status !== "archived") {
        return false;
      }

      // Apply search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          task.name.toLowerCase().includes(query) ||
          task.branch.toLowerCase().includes(query)
        );
      }

      return true;
    });
  }, [tasks, filter, searchQuery]);

  // Handle single click - show Info Panel
  const handleSelectTask = (task: Task) => {
    setSelectedTask(task);
    if (viewMode === "list") {
      setViewMode("info");
    }
  };

  // Handle double click - enter Terminal mode (only for non-archived tasks)
  const handleDoubleClickTask = (task: Task) => {
    if (task.status === "archived") return;
    setSelectedTask(task);
    setViewMode("terminal");
    setReviewOpen(false);
  };

  // Handle closing task view - return to list mode
  const handleCloseTask = () => {
    if (viewMode === "terminal") {
      // From terminal, go back to info mode
      setViewMode("info");
      setReviewOpen(false);
    } else {
      // From info, go back to list mode
      setSelectedTask(null);
      setViewMode("list");
    }
  };

  // Handle entering terminal mode from info panel (only for non-archived tasks)
  const handleEnterTerminal = () => {
    if (selectedTask?.status === "archived") return;
    setViewMode("terminal");
  };

  // Handle recover archived task
  const handleRecover = () => {
    console.log("Recovering task...");
  };

  // Handle toggle review
  const handleToggleReview = () => {
    setReviewOpen(!reviewOpen);
  };

  // Handle new task creation
  const handleCreateTask = (name: string, targetBranch: string, notes: string) => {
    console.log("Creating task:", name, "with target:", targetBranch, "notes:", notes);
    setShowNewTaskDialog(false);
  };

  // Handle task actions
  const handleCommit = () => console.log("Opening commit dialog...");
  const handleRebase = () => console.log("Opening rebase dialog...");
  const handleSync = () => console.log("Syncing task...");
  const handleMerge = () => console.log("Merging task...");
  const handleArchive = () => console.log("Archiving task...");
  const handleClean = () => console.log("Cleaning task...");
  const handleReset = () => console.log("Resetting task...");
  const handleStartSession = () => {
    // Start session and enter terminal mode
    setViewMode("terminal");
    console.log("Starting session...");
  };

  // If no project selected
  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">
          Select a project to view tasks
        </p>
      </div>
    );
  }

  const isTerminalMode = viewMode === "terminal";
  const isInfoMode = viewMode === "info";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-[calc(100vh-48px)] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Tasks</h1>
        <Button onClick={() => setShowNewTaskDialog(true)} size="sm">
          <Plus className="w-4 h-4 mr-1.5" />
          New Task
        </Button>
      </div>

      {/* Main Content */}
      <div className="flex-1 relative overflow-hidden">
        {/* List Mode & Info Mode: Task List + Info Panel side by side */}
        <motion.div
          animate={{
            opacity: isTerminalMode ? 0 : 1,
            x: isTerminalMode ? -20 : 0,
          }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className={`absolute inset-0 flex gap-4 ${isTerminalMode ? "pointer-events-none" : ""}`}
        >
          {/* Task Sidebar */}
          <div className="w-72 flex-shrink-0 h-full">
            <TaskSidebar
              tasks={filteredTasks}
              selectedTask={selectedTask}
              filter={filter}
              searchQuery={searchQuery}
              onSelectTask={handleSelectTask}
              onDoubleClickTask={handleDoubleClickTask}
              onFilterChange={setFilter}
              onSearchChange={setSearchQuery}
            />
          </div>

          {/* Right Panel: Empty State or Info Panel */}
          <div className="flex-1 h-full">
            <AnimatePresence mode="wait">
              {isInfoMode && selectedTask ? (
                <motion.div
                  key="info-panel"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ type: "spring", damping: 25, stiffness: 200 }}
                  className="h-full"
                >
                  <TaskInfoPanel
                    task={selectedTask}
                    onClose={handleCloseTask}
                    onEnterTerminal={selectedTask.status !== "archived" ? handleEnterTerminal : undefined}
                    onRecover={selectedTask.status === "archived" ? handleRecover : undefined}
                    onClean={selectedTask.status === "archived" ? handleClean : undefined}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="h-full flex items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
                >
                  <div className="text-center">
                    <p className="text-[var(--color-text-muted)] mb-2">
                      Select a task to view details
                    </p>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      Double-click to enter Terminal mode
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Terminal Mode: Info Panel + TaskView */}
        <AnimatePresence>
          {isTerminalMode && selectedTask && (
            <motion.div
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="absolute inset-0 flex gap-3"
            >
              {/* Info Panel (collapsible vertical bar in terminal mode) */}
              <TaskInfoPanel
                task={selectedTask}
                onClose={handleCloseTask}
                isTerminalMode
              />

              {/* TaskView (Terminal + optional Code Review) */}
              <TaskView
                task={selectedTask}
                reviewOpen={reviewOpen}
                onToggleReview={handleToggleReview}
                onCommit={handleCommit}
                onRebase={handleRebase}
                onSync={handleSync}
                onMerge={handleMerge}
                onArchive={handleArchive}
                onClean={handleClean}
                onReset={handleReset}
                onStartSession={handleStartSession}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* New Task Dialog */}
      <NewTaskDialog
        isOpen={showNewTaskDialog}
        onClose={() => setShowNewTaskDialog(false)}
        onCreate={handleCreateTask}
      />
    </motion.div>
  );
}
