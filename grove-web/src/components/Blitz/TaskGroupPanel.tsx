import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FolderOpen,
  ChevronRight,
  Plus,
  X,
  Circle,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Laptop,
  Zap,
  Code,
} from "lucide-react";
import type { BlitzTask, TaskGroup, TaskStatus } from "../../data/types";

interface TaskGroupPanelProps {
  groups: TaskGroup[];
  blitzTasks: BlitzTask[];
  onCreateGroup: (name: string) => void;
  onDeleteGroup: (id: string) => void;
  onAssignTask: (
    groupId: string,
    position: number,
    projectId: string,
    taskId: string,
  ) => void;
  onRemoveTask: (groupId: string, position: number) => void;
  onSelectTask: (task: BlitzTask) => void;
  selectedTaskId: string | null;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case "live":
      return "var(--color-success)";
    case "idle":
      return "var(--color-text-muted)";
    case "merged":
      return "#a855f7";
    case "conflict":
    case "broken":
      return "var(--color-error)";
    case "archived":
      return "var(--color-text-muted)";
  }
}

function StatusIcon({ status, className, style }: { status: TaskStatus; className?: string; style?: React.CSSProperties }) {
  const fill = status === "live" ? getStatusColor(status) : "none";
  switch (status) {
    case "live":
    case "idle":
    case "archived":
      return <Circle className={className} style={style} fill={fill} />;
    case "merged":
      return <CheckCircle className={className} style={style} fill={fill} />;
    case "conflict":
      return <AlertTriangle className={className} style={style} fill={fill} />;
    case "broken":
      return <XCircle className={className} style={style} fill={fill} />;
  }
}

/** Compact task row used inside a group folder */
function GroupTaskItem({
  blitzTask,
  isSelected,
  onSelect,
  onRemove,
}: {
  blitzTask: BlitzTask;
  isSelected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  const { task, projectName } = blitzTask;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-md transition-all duration-150 group/item ${
        isSelected
          ? "bg-[var(--color-highlight)]/10 ring-1 ring-[var(--color-highlight)]/30"
          : "hover:bg-[var(--color-bg-tertiary)]"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {/* Type icon */}
        <div className="flex-shrink-0">
          {task.isLocal ? (
            <Laptop
              className="w-3 h-3"
              style={{ color: "var(--color-accent)" }}
            />
          ) : task.createdBy === "agent" ? (
            <Zap
              className="w-3 h-3"
              style={{ color: "var(--color-info)" }}
            />
          ) : (
            <Code
              className="w-3 h-3"
              style={{ color: "var(--color-highlight)" }}
            />
          )}
        </div>

        {/* Status dot */}
        <StatusIcon
          status={task.status}
          className="w-2.5 h-2.5 flex-shrink-0"
          style={{ color: getStatusColor(task.status) }}
        />

        {/* Task name */}
        <span
          className={`text-xs font-medium truncate flex-1 ${
            isSelected
              ? "text-[var(--color-highlight)]"
              : "text-[var(--color-text)]"
          }`}
        >
          {task.name}
        </span>

        {/* Time */}
        <span className="text-[10px] text-[var(--color-text-muted)] flex-shrink-0">
          {formatTimeAgo(task.updatedAt)}
        </span>

        {/* Remove from group button */}
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="opacity-0 group-hover/item:opacity-100 flex-shrink-0 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-all"
            title="Remove from group"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Project badge */}
      <div className="mt-1 ml-[22px]">
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] truncate">
          {projectName}
        </span>
      </div>
    </button>
  );
}

/** A single collapsible TaskGroup folder */
function TaskGroupFolder({
  group,
  assignedTasks,
  availableTasks,
  selectedTaskId,
  onSelectTask,
  onDeleteGroup,
  onAssignTask,
  onRemoveTask,
}: {
  group: TaskGroup;
  assignedTasks: BlitzTask[];
  availableTasks: BlitzTask[];
  selectedTaskId: string | null;
  onSelectTask: (bt: BlitzTask) => void;
  onDeleteGroup: (id: string) => void;
  onAssignTask: (
    groupId: string,
    position: number,
    projectId: string,
    taskId: string,
  ) => void;
  onRemoveTask: (groupId: string, position: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAddDropdown, setShowAddDropdown] = useState(false);

  // Tasks not yet in this group
  const unassignedInDropdown = useMemo(() => {
    const assignedIds = new Set(group.slots.map((s) => s.task_id));
    return availableTasks.filter((bt) => !assignedIds.has(bt.task.id));
  }, [availableTasks, group.slots]);

  const nextPosition = useMemo(() => {
    if (group.slots.length === 0) return 0;
    return Math.max(...group.slots.map((s) => s.position)) + 1;
  }, [group.slots]);

  return (
    <div className="rounded-lg">
      {/* Group header */}
      <div className="flex items-center gap-1 group/header">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </motion.span>
          <FolderOpen
            className="w-3.5 h-3.5"
            style={{ color: group.color || "var(--color-highlight)" }}
          />
          <span className="truncate">{group.name}</span>
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-normal text-[var(--color-text-muted)]">
            {assignedTasks.length}
          </span>
        </button>

        {/* Add task button */}
        <div className="relative">
          <button
            onClick={() => setShowAddDropdown(!showAddDropdown)}
            className="opacity-0 group-hover/header:opacity-100 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)] transition-all"
            title="Add task to group"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>

          {/* Dropdown for adding tasks */}
          {showAddDropdown && (
            <>
              {/* Backdrop to close dropdown */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowAddDropdown(false)}
              />
              <div className="absolute right-0 top-full mt-1 z-50 w-56 max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
                {unassignedInDropdown.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                    No unassigned tasks
                  </div>
                ) : (
                  unassignedInDropdown.map((bt) => (
                    <button
                      key={`${bt.projectId}-${bt.task.id}`}
                      onClick={() => {
                        onAssignTask(
                          group.id,
                          nextPosition,
                          bt.projectId,
                          bt.task.id,
                        );
                        setShowAddDropdown(false);
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--color-bg-tertiary)] transition-colors flex items-center gap-2"
                    >
                      <span className="truncate text-[var(--color-text)]">
                        {bt.task.name}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-muted)] flex-shrink-0">
                        {bt.projectName}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {/* Delete group button */}
        <button
          onClick={() => onDeleteGroup(group.id)}
          className="opacity-0 group-hover/header:opacity-100 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-error)] hover:bg-[var(--color-bg-tertiary)] transition-all"
          title="Delete group"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Expanded task list */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-0.5 pl-2 pt-1">
              {assignedTasks.length === 0 ? (
                <div className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] italic">
                  No tasks assigned
                </div>
              ) : (
                assignedTasks.map((bt) => {
                  const slot = group.slots.find(
                    (s) => s.task_id === bt.task.id,
                  );
                  return (
                    <GroupTaskItem
                      key={`${bt.projectId}-${bt.task.id}`}
                      blitzTask={bt}
                      isSelected={selectedTaskId === bt.task.id}
                      onSelect={() => onSelectTask(bt)}
                      onRemove={
                        slot
                          ? () => onRemoveTask(group.id, slot.position)
                          : undefined
                      }
                    />
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TaskGroupPanel({
  groups,
  blitzTasks,
  onCreateGroup,
  onDeleteGroup,
  onAssignTask,
  onRemoveTask,
  onSelectTask,
  selectedTaskId,
}: TaskGroupPanelProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  // Build a map of task_id -> BlitzTask for quick lookup
  const taskMap = useMemo(() => {
    const map = new Map<string, BlitzTask>();
    for (const bt of blitzTasks) {
      map.set(bt.task.id, bt);
    }
    return map;
  }, [blitzTasks]);

  // Compute assigned task IDs across all groups
  const assignedTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups) {
      for (const slot of g.slots) {
        ids.add(slot.task_id);
      }
    }
    return ids;
  }, [groups]);

  // Ungrouped tasks
  const ungroupedTasks = useMemo(
    () => blitzTasks.filter((bt) => !assignedTaskIds.has(bt.task.id)),
    [blitzTasks, assignedTaskIds],
  );

  const handleCreateSubmit = useCallback(() => {
    const trimmed = newGroupName.trim();
    if (trimmed) {
      onCreateGroup(trimmed);
      setNewGroupName("");
      setIsCreating(false);
    }
  }, [newGroupName, onCreateGroup]);

  return (
    <div className="flex flex-col gap-1">
      {/* Groups */}
      {groups.map((group) => {
        // Resolve slots to BlitzTasks
        const assignedTasks = group.slots
          .sort((a, b) => a.position - b.position)
          .map((slot) => taskMap.get(slot.task_id))
          .filter((bt): bt is BlitzTask => bt !== undefined);

        return (
          <TaskGroupFolder
            key={group.id}
            group={group}
            assignedTasks={assignedTasks}
            availableTasks={blitzTasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            onDeleteGroup={onDeleteGroup}
            onAssignTask={onAssignTask}
            onRemoveTask={onRemoveTask}
          />
        );
      })}

      {/* Ungrouped section */}
      {ungroupedTasks.length > 0 && (
        <UngroupedSection
          tasks={ungroupedTasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      )}

      {/* Add group inline input */}
      {isCreating ? (
        <div className="px-3 py-2">
          <input
            autoFocus
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSubmit();
              if (e.key === "Escape") {
                setIsCreating(false);
                setNewGroupName("");
              }
            }}
            onBlur={() => {
              if (newGroupName.trim()) {
                handleCreateSubmit();
              } else {
                setIsCreating(false);
              }
            }}
            placeholder="Group name..."
            className="w-full px-2 py-1.5 text-xs bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md
              text-[var(--color-text)] placeholder-[var(--color-text-muted)]
              focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
              transition-all duration-200"
          />
        </div>
      ) : (
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Group
        </button>
      )}
    </div>
  );
}

/** Ungrouped tasks section at the bottom */
function UngroupedSection({
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: BlitzTask[];
  selectedTaskId: string | null;
  onSelectTask: (bt: BlitzTask) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-lg mt-1 border-t border-[var(--color-border)]/50 pt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </motion.span>
        <span>Ungrouped</span>
        <span className="ml-auto px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[10px]">
          {tasks.length}
        </span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-0.5 pl-2 pt-1">
              {tasks.map((bt) => (
                <GroupTaskItem
                  key={`${bt.projectId}-${bt.task.id}`}
                  blitzTask={bt}
                  isSelected={selectedTaskId === bt.task.id}
                  onSelect={() => onSelectTask(bt)}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
