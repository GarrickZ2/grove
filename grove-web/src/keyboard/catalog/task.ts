import type { CommandDef } from "../types";

/**
 * Task lifecycle and selection commands. These are the primary "noun"
 * of grove — every workflow starts by creating, selecting, entering, or
 * archiving a task.
 *
 * Scopes:
 *   tasks      — TasksPage / BlitzPage (Zen/Blitz mode top-level)
 *   workspace  — TaskView (inside a task)
 */
export const TASK_COMMANDS: CommandDef[] = [
  {
    id: "task.new",
    name: "New Task",
    category: "Task",
    description: "Create a new task on the current project",
    defaultBindings: [{ key: "Mod+Alt+n" }],
    scope: "tasks",
  },
  {
    id: "task.open",
    name: "Enter Workspace",
    category: "Task",
    description: "Open the selected task's workspace",
    defaultBindings: [{ key: "Enter" }],
    scope: "tasks",
    defaultWhen: "taskSelected && !inWorkspace",
  },
  {
    id: "task.close",
    name: "Close Workspace",
    category: "Task",
    description: "Leave the current task and return to the task list",
    defaultBindings: [{ key: "Escape" }],
    scope: "workspace",
    defaultWhen: "inWorkspace && !terminalFocus",
  },
  {
    id: "task.selectNext",
    name: "Select Next Task",
    category: "Task Navigation",
    defaultBindings: [{ key: "ArrowDown" }],
    scope: "tasks",
    defaultWhen: "!inWorkspace",
  },
  {
    id: "task.selectPrevious",
    name: "Select Previous Task",
    category: "Task Navigation",
    defaultBindings: [{ key: "ArrowUp" }],
    scope: "tasks",
    defaultWhen: "!inWorkspace",
  },
  {
    id: "task.contextMenu",
    name: "Open Task Context Menu",
    category: "Task Navigation",
    defaultBindings: [{ key: "Space" }],
    scope: "tasks",
    defaultWhen: "taskSelected && !inWorkspace",
  },
  {
    id: "task.search",
    name: "Focus Task Search",
    category: "Task Navigation",
    defaultBindings: [{ key: "Mod+Shift+f" }],
    scope: "tasks",
    defaultWhen: "!inWorkspace",
  },
  {
    id: "task.rename",
    name: "Rename Task",
    category: "Task",
    description: "Rename the current task",
    defaultBindings: [{ key: "F2" }],
    scope: "workspace",
    defaultWhen: "taskSelected",
  },
  {
    id: "task.archive",
    name: "Archive Task",
    category: "Task",
    description: "Archive the current task (preserves history)",
    scope: "workspace",
    defaultWhen: "taskSelected && !archived && canOperate",
  },
  {
    id: "task.unarchive",
    name: "Unarchive Task",
    category: "Task",
    scope: "workspace",
    defaultWhen: "taskSelected && archived",
  },
  {
    id: "task.reset",
    name: "Reset Task (Recreate Worktree)",
    category: "Task",
    description: "Discard the worktree and rebuild from the branch tip",
    scope: "workspace",
    defaultWhen: "taskSelected && canOperate",
  },
  {
    id: "task.clean",
    name: "Clean Task (Delete Worktree)",
    category: "Task",
    description: "Delete the worktree files; keeps the branch",
    scope: "workspace",
    defaultWhen: "taskSelected",
  },
];
