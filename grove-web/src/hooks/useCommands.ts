import {
  LayoutGrid,
  ListTodo,
  Blocks,
  BarChart2,
  Settings,
  FolderOpen,
  Zap,
  Columns2,
  PanelLeftClose,
  Plus,
  GitCommitHorizontal,
  RefreshCw,
  GitMerge,
  GitBranch,
  Archive,
  RotateCcw,
  Trash2,
  Terminal,
  Code2,
  FileSearch,
  MessageSquare,
  ExternalLink,
  SquareTerminal,
  ChartBar,
  GitFork,
  StickyNote,
  MessageCircle,
} from "lucide-react";
import type { Command } from "../context/CommandPaletteContext";
import type { Project, Task } from "../data/types";
import type { TaskOperationsHandlers } from "./useTaskOperations";
import { getProjectStyle } from "../utils/projectStyle";

function withRanking(command: Command, ranking: Command["ranking"]): Command {
  return {
    ...command,
    ranking,
  };
}

export interface UseCommandsOptions {
  // Navigation (optional - skip if not provided)
  navigation?: {
    onNavigate: (page: string) => void;
    activeItem: string;
  };
  // Project (optional)
  project?: {
    projects: Project[];
    selectedProject: Project | null;
    onSelectProject: (project: Project) => void;
    onAddProject: () => void;
    onProjectSwitch?: () => void;
    accentPalette?: string[];
  };
  // Mode (optional)
  mode?: {
    tasksMode: "zen" | "blitz";
    onToggleMode: () => void;
    onToggleSidebar: () => void;
  };
  // Task (optional)
  taskActions?: {
    selectedTask: Task | null;
    inWorkspace: boolean;
    opsHandlers: TaskOperationsHandlers;
    onEnterWorkspace: () => void;
    onOpenPanel: (panel: string) => void;
    onSwitchInfoTab: (tab: "stats" | "git" | "notes" | "comments") => void;
    onRefresh: () => void;
    onNewTask?: () => void;
  };
  // Palette launchers (optional)
  palettes?: {
    onOpenProjectPalette: () => void;
    onOpenTaskPalette: () => void;
  };
  // Project actions (optional)
  projectActions?: {
    onOpenIDE: () => void;
    onOpenTerminal: () => void;
  };
}

export function buildCommands(options: UseCommandsOptions): Command[] {
  const { navigation, project, mode, palettes, taskActions, projectActions } = options;

    const commands: Command[] = [];

    // --- Navigation ---
    if (navigation) {
      const { onNavigate } = navigation;
      commands.push(
        withRanking({ id: "nav-dashboard", name: "Go to Dashboard", category: "Navigation", icon: LayoutGrid, handler: () => onNavigate("dashboard"), keywords: ["home"] }, { contexts: { default: 28, tasks: 4, workspace: -8 } }),
        withRanking({ id: "nav-tasks", name: "Go to Tasks", category: "Navigation", icon: ListTodo, handler: () => onNavigate("tasks"), keywords: ["zen"] }, { contexts: { default: 48, tasks: 8, workspace: 0 } }),
        withRanking({ id: "nav-skills", name: "Go to Skills", category: "Navigation", icon: Blocks, handler: () => onNavigate("skills"), keywords: ["agent", "plugin"] }, { contexts: { default: 12, tasks: -8, workspace: -12 } }),
        withRanking({ id: "nav-statistics", name: "Go to Statistics", category: "Navigation", icon: BarChart2, handler: () => onNavigate("statistics"), keywords: ["stats", "analytics"] }, { contexts: { default: 10, tasks: -6, workspace: -10 } }),
        withRanking({ id: "nav-settings", name: "Go to Settings", category: "Navigation", icon: Settings, handler: () => onNavigate("settings"), keywords: ["config", "preferences"] }, { contexts: { default: 8, tasks: -4, workspace: -8 } }),
        withRanking({ id: "nav-projects", name: "Go to Projects", category: "Navigation", icon: FolderOpen, handler: () => onNavigate("projects"), keywords: ["manage"] }, { contexts: { default: 24, tasks: 4, workspace: 8 } }),
      );
    }

    // --- Palette launchers ---
    if (palettes) {
      commands.push(
        withRanking({
          id: "palette-project",
          name: "Switch Project",
          category: "Navigation",
          icon: FolderOpen,
          shortcut: "\u2318P",
          handler: palettes.onOpenProjectPalette,
          keywords: ["project", "switch", "select"],
        }, { contexts: { default: 36, tasks: 6, workspace: 10 } }),
        withRanking({
          id: "palette-task",
          name: "Switch Task",
          category: "Navigation",
          icon: ListTodo,
          shortcut: "\u2318O",
          handler: palettes.onOpenTaskPalette,
          keywords: ["task", "switch", "select"],
        }, { contexts: { default: 34, tasks: 42, workspace: 4 } }),
      );
    }

    // --- Project switching ---
    if (project) {
      const { projects, selectedProject, onSelectProject, onAddProject, onProjectSwitch, accentPalette } = project;
      for (const p of projects) {
        const style = getProjectStyle(p.id, accentPalette);
        commands.push(withRanking({
          id: `project-${p.id}`,
          name: `Switch to: ${p.name}`,
          category: "Project",
          icon: style.Icon,
          handler: () => {
            const switched = selectedProject?.id !== p.id;
            onSelectProject(p);
            if (switched) onProjectSwitch?.();
          },
          keywords: [p.name, "switch", "project"],
        }, { contexts: { default: 18, tasks: 0, workspace: 10 } }));
      }
      commands.push(withRanking({
        id: "project-add",
        name: "Add Project",
        category: "Project",
        icon: Plus,
        handler: onAddProject,
        keywords: ["new", "register"],
      }, { contexts: { default: 16, tasks: -6, workspace: 8 } }));
    }

    // --- Mode ---
    if (mode) {
      const { tasksMode, onToggleMode, onToggleSidebar } = mode;
      commands.push(
        withRanking({
          id: "mode-toggle",
          name: tasksMode === "zen" ? "Switch to Blitz Mode" : "Switch to Zen Mode",
          category: "Mode",
          icon: tasksMode === "zen" ? Zap : Columns2,
          handler: onToggleMode,
          keywords: ["mode", "zen", "blitz", "cross-project"],
        }, { contexts: { default: 6, tasks: 14, workspace: 2 } }),
        withRanking({
          id: "sidebar-toggle",
          name: "Toggle Sidebar",
          category: "Mode",
          icon: PanelLeftClose,
          handler: onToggleSidebar,
          keywords: ["collapse", "expand", "sidebar"],
        }, { contexts: { default: 2, tasks: 8, workspace: 0 } }),
      );
    }

    // --- Task Actions (only when task context available) ---
    if (taskActions) {
      const { selectedTask, inWorkspace, opsHandlers, onEnterWorkspace, onOpenPanel, onSwitchInfoTab, onRefresh, onNewTask } = taskActions;
      const isActive = selectedTask && selectedTask.status !== "archived";
      const canOperate = isActive && selectedTask.status !== "broken";

      if (onNewTask) {
        commands.push(withRanking({
          id: "task-new",
          name: "New Task",
          category: "Task Actions",
          icon: Plus,
          shortcut: "n",
          handler: onNewTask,
          keywords: ["create", "add"],
        }, { contexts: { default: 22, tasks: 44, workspace: 8 } }));
      }

      if (selectedTask && isActive && !inWorkspace) {
        commands.push(withRanking({
          id: "task-enter",
          name: "Enter Workspace",
          category: "Task Actions",
          icon: Terminal,
          shortcut: "Enter",
          handler: onEnterWorkspace,
          keywords: ["workspace", "terminal"],
        }, { contexts: { default: 6, tasks: 38, workspace: 0 } }));
      }

      if (isActive) {
        commands.push(withRanking({
          id: "task-commit",
          name: "Commit",
          category: "Task Actions",
          icon: GitCommitHorizontal,
          shortcut: "c",
          handler: opsHandlers.handleCommit,
          keywords: ["git", "save"],
        }, { contexts: { default: 0, tasks: 18, workspace: 34 } }));
      }

      if (canOperate) {
        commands.push(
          withRanking({
            id: "task-sync",
            name: "Sync",
            category: "Task Actions",
            icon: RefreshCw,
            shortcut: "s",
            handler: opsHandlers.handleSync,
            keywords: ["fetch", "pull", "update"],
          }, { contexts: { default: 0, tasks: 12, workspace: 30 } }),
          withRanking({
            id: "task-merge",
            name: "Merge",
            category: "Task Actions",
            icon: GitMerge,
            shortcut: "m",
            handler: opsHandlers.handleMerge,
            keywords: ["squash", "merge-commit"],
          }, { contexts: { default: -2, tasks: 10, workspace: 28 } }),
          withRanking({
            id: "task-rebase",
            name: "Rebase",
            category: "Task Actions",
            icon: GitBranch,
            shortcut: "b",
            handler: opsHandlers.handleRebase,
            keywords: ["branch", "target"],
          }, { contexts: { default: -2, tasks: 10, workspace: 28 } }),
        );
      }

      if (selectedTask && isActive) {
        commands.push(withRanking({
          id: "task-archive",
          name: "Archive",
          category: "Task Actions",
          icon: Archive,
          shortcut: "a",
          handler: opsHandlers.handleArchive,
          keywords: ["done", "finish", "close"],
        }, { contexts: { default: -4, tasks: 8, workspace: 14 } }));
      }

      if (canOperate) {
        commands.push(withRanking({
          id: "task-reset",
          name: "Reset",
          category: "Task Actions",
          icon: RotateCcw,
          shortcut: "x",
          handler: opsHandlers.handleReset,
          keywords: ["recreate", "worktree"],
        }, { contexts: { default: -8, tasks: 4, workspace: 12 } }));
      }

      if (selectedTask) {
        commands.push(withRanking({
          id: "task-clean",
          name: "Clean (Delete Worktree)",
          category: "Task Actions",
          icon: Trash2,
          shortcut: "X",
          handler: opsHandlers.handleClean,
          keywords: ["delete", "remove", "destroy"],
        }, { contexts: { default: -10, tasks: -2, workspace: 0 } }));
      }

      // Panels
      if (selectedTask && isActive) {
        commands.push(
          withRanking({
            id: "panel-chat",
            name: "Open Chat",
            category: "Action Panel",
            icon: MessageSquare,
            shortcut: "i",
            handler: () => onOpenPanel("chat"),
            keywords: ["ai", "agent", "conversation"],
          }, { contexts: { default: 0, tasks: 10, workspace: 34 } }),
          withRanking({
            id: "panel-terminal",
            name: "Open Terminal Panel",
            category: "Action Panel",
            icon: Terminal,
            handler: () => onOpenPanel("terminal"),
            keywords: ["tmux", "shell", "panel"],
          }, { contexts: { default: 0, tasks: 12, workspace: 38 } }),
          withRanking({
            id: "panel-review",
            name: "Open Review",
            category: "Action Panel",
            icon: FileSearch,
            shortcut: "d",
            handler: () => onOpenPanel("review"),
            keywords: ["diff", "code review"],
          }, { contexts: { default: 0, tasks: 8, workspace: 30 } }),
          withRanking({
            id: "panel-editor",
            name: "Open Editor",
            category: "Action Panel",
            icon: Code2,
            shortcut: "e",
            handler: () => onOpenPanel("editor"),
            keywords: ["file", "edit", "code"],
          }, { contexts: { default: 0, tasks: 8, workspace: 34 } }),
        );
      }

      // Info Panel Tabs — in workspace: open as panel; outside: switch info tab
      if (selectedTask) {
        const infoHandler = (tab: "stats" | "git" | "notes" | "comments") =>
          inWorkspace ? () => onOpenPanel(tab) : () => onSwitchInfoTab(tab);

        commands.push(
          withRanking({
            id: "tab-stats",
            name: inWorkspace ? "Open Stats Panel" : "Show Stats Tab",
            category: "Info Panel",
            icon: ChartBar,
            shortcut: "1",
            handler: infoHandler("stats"),
            keywords: ["statistics", "info", "overview"],
          }, { contexts: { default: 0, tasks: 8, workspace: 22 } }),
          withRanking({
            id: "tab-git",
            name: inWorkspace ? "Open Git Panel" : "Show Git Tab",
            category: "Info Panel",
            icon: GitFork,
            shortcut: "2",
            handler: infoHandler("git"),
            keywords: ["branch", "commit", "history"],
          }, { contexts: { default: 0, tasks: 8, workspace: 22 } }),
          withRanking({
            id: "tab-notes",
            name: inWorkspace ? "Open Notes Panel" : "Show Notes Tab",
            category: "Info Panel",
            icon: StickyNote,
            shortcut: "3",
            handler: infoHandler("notes"),
            keywords: ["note", "memo", "description"],
          }, { contexts: { default: 0, tasks: 6, workspace: 18 } }),
          withRanking({
            id: "tab-comments",
            name: inWorkspace ? "Open Comments Panel" : "Show Comments Tab",
            category: "Info Panel",
            icon: MessageCircle,
            shortcut: "4",
            handler: infoHandler("comments"),
            keywords: ["comment", "discussion", "feedback"],
          }, { contexts: { default: 0, tasks: 6, workspace: 18 } }),
        );
      }

      // Refresh
      commands.push(withRanking({
        id: "task-refresh",
        name: "Refresh",
        category: "Task Actions",
        icon: RefreshCw,
        shortcut: "r",
        handler: onRefresh,
        keywords: ["reload", "update"],
      }, { contexts: { default: 4, tasks: 14, workspace: 18 } }));
    }

    // --- Project Actions ---
    if (projectActions) {
      commands.push(
        withRanking({
          id: "project-ide",
          name: "Open Project in IDE",
          category: "Project Actions",
          icon: ExternalLink,
          handler: projectActions.onOpenIDE,
          keywords: ["vscode", "cursor", "editor", "external"],
        }, { contexts: { default: 8, tasks: 0, workspace: 6 } }),
        withRanking({
          id: "project-terminal",
          name: "Open Project in Terminal App",
          category: "Project Actions",
          icon: SquareTerminal,
          handler: projectActions.onOpenTerminal,
          keywords: ["iterm", "warp", "shell", "external"],
        }, { contexts: { default: 8, tasks: 0, workspace: 8 } }),
      );
    }

    return commands;
}
