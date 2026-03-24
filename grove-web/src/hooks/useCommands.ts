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
        { id: "nav-dashboard", name: "Go to Dashboard", category: "Navigation", icon: LayoutGrid, handler: () => onNavigate("dashboard"), keywords: ["home"] },
        { id: "nav-tasks", name: "Go to Tasks", category: "Navigation", icon: ListTodo, handler: () => onNavigate("tasks"), keywords: ["zen"] },
        { id: "nav-skills", name: "Go to Skills", category: "Navigation", icon: Blocks, handler: () => onNavigate("skills"), keywords: ["agent", "plugin"] },
        { id: "nav-statistics", name: "Go to Statistics", category: "Navigation", icon: BarChart2, handler: () => onNavigate("statistics"), keywords: ["stats", "analytics"] },
        { id: "nav-settings", name: "Go to Settings", category: "Navigation", icon: Settings, handler: () => onNavigate("settings"), keywords: ["config", "preferences"] },
        { id: "nav-projects", name: "Go to Projects", category: "Navigation", icon: FolderOpen, handler: () => onNavigate("projects"), keywords: ["manage"] },
      );
    }

    // --- Palette launchers ---
    if (palettes) {
      commands.push(
        {
          id: "palette-project",
          name: "Switch Project",
          category: "Navigation",
          icon: FolderOpen,
          shortcut: "\u2318P",
          handler: palettes.onOpenProjectPalette,
          keywords: ["project", "switch", "select"],
        },
        {
          id: "palette-task",
          name: "Switch Task",
          category: "Navigation",
          icon: ListTodo,
          shortcut: "\u2318O",
          handler: palettes.onOpenTaskPalette,
          keywords: ["task", "switch", "select"],
        },
      );
    }

    // --- Project switching ---
    if (project) {
      const { projects, selectedProject, onSelectProject, onAddProject, onProjectSwitch, accentPalette } = project;
      for (const p of projects) {
        const style = getProjectStyle(p.id, accentPalette);
        commands.push({
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
        });
      }
      commands.push({
        id: "project-add",
        name: "Add Project",
        category: "Project",
        icon: Plus,
        handler: onAddProject,
        keywords: ["new", "register"],
      });
    }

    // --- Mode ---
    if (mode) {
      const { tasksMode, onToggleMode, onToggleSidebar } = mode;
      commands.push(
        {
          id: "mode-toggle",
          name: tasksMode === "zen" ? "Switch to Blitz Mode" : "Switch to Zen Mode",
          category: "Mode",
          icon: tasksMode === "zen" ? Zap : Columns2,
          handler: onToggleMode,
          keywords: ["mode", "zen", "blitz", "cross-project"],
        },
        {
          id: "sidebar-toggle",
          name: "Toggle Sidebar",
          category: "Mode",
          icon: PanelLeftClose,
          handler: onToggleSidebar,
          keywords: ["collapse", "expand", "sidebar"],
        },
      );
    }

    // --- Task Actions (only when task context available) ---
    if (taskActions) {
      const { selectedTask, inWorkspace, opsHandlers, onEnterWorkspace, onOpenPanel, onSwitchInfoTab, onRefresh, onNewTask } = taskActions;
      const isActive = selectedTask && selectedTask.status !== "archived";
      const canOperate = isActive && selectedTask.status !== "broken";

      if (onNewTask) {
        commands.push({
          id: "task-new",
          name: "New Task",
          category: "Task Actions",
          icon: Plus,
          shortcut: "n",
          handler: onNewTask,
          keywords: ["create", "add"],
        });
      }

      if (selectedTask && isActive && !inWorkspace) {
        commands.push({
          id: "task-enter",
          name: "Enter Workspace",
          category: "Task Actions",
          icon: Terminal,
          shortcut: "Enter",
          handler: onEnterWorkspace,
          keywords: ["workspace", "terminal"],
        });
      }

      if (isActive) {
        commands.push({
          id: "task-commit",
          name: "Commit",
          category: "Task Actions",
          icon: GitCommitHorizontal,
          shortcut: "c",
          handler: opsHandlers.handleCommit,
          keywords: ["git", "save"],
        });
      }

      if (canOperate) {
        commands.push(
          {
            id: "task-sync",
            name: "Sync",
            category: "Task Actions",
            icon: RefreshCw,
            shortcut: "s",
            handler: opsHandlers.handleSync,
            keywords: ["fetch", "pull", "update"],
          },
          {
            id: "task-merge",
            name: "Merge",
            category: "Task Actions",
            icon: GitMerge,
            shortcut: "m",
            handler: opsHandlers.handleMerge,
            keywords: ["squash", "merge-commit"],
          },
          {
            id: "task-rebase",
            name: "Rebase",
            category: "Task Actions",
            icon: GitBranch,
            shortcut: "b",
            handler: opsHandlers.handleRebase,
            keywords: ["branch", "target"],
          },
        );
      }

      if (selectedTask && isActive) {
        commands.push({
          id: "task-archive",
          name: "Archive",
          category: "Task Actions",
          icon: Archive,
          shortcut: "a",
          handler: opsHandlers.handleArchive,
          keywords: ["done", "finish", "close"],
        });
      }

      if (canOperate) {
        commands.push({
          id: "task-reset",
          name: "Reset",
          category: "Task Actions",
          icon: RotateCcw,
          shortcut: "x",
          handler: opsHandlers.handleReset,
          keywords: ["recreate", "worktree"],
        });
      }

      if (selectedTask) {
        commands.push({
          id: "task-clean",
          name: "Clean (Delete Worktree)",
          category: "Task Actions",
          icon: Trash2,
          shortcut: "X",
          handler: opsHandlers.handleClean,
          keywords: ["delete", "remove", "destroy"],
        });
      }

      // Panels
      if (selectedTask && isActive) {
        commands.push(
          {
            id: "panel-chat",
            name: "Open Chat",
            category: "Panels",
            icon: MessageSquare,
            shortcut: "i",
            handler: () => onOpenPanel("chat"),
            keywords: ["ai", "agent", "conversation"],
          },
          {
            id: "panel-terminal",
            name: "Open Terminal Panel",
            category: "Panels",
            icon: Terminal,
            handler: () => onOpenPanel("terminal"),
            keywords: ["tmux", "shell", "panel"],
          },
          {
            id: "panel-review",
            name: "Open Review",
            category: "Panels",
            icon: FileSearch,
            shortcut: "d",
            handler: () => onOpenPanel("review"),
            keywords: ["diff", "code review"],
          },
          {
            id: "panel-editor",
            name: "Open Editor",
            category: "Panels",
            icon: Code2,
            shortcut: "e",
            handler: () => onOpenPanel("editor"),
            keywords: ["file", "edit", "code"],
          },
        );
      }

      // Info Panel Tabs — in workspace: open as panel; outside: switch info tab
      if (selectedTask) {
        const infoHandler = (tab: "stats" | "git" | "notes" | "comments") =>
          inWorkspace ? () => onOpenPanel(tab) : () => onSwitchInfoTab(tab);

        commands.push(
          {
            id: "tab-stats",
            name: inWorkspace ? "Open Stats Panel" : "Show Stats Tab",
            category: "Info Panel",
            icon: ChartBar,
            shortcut: "1",
            handler: infoHandler("stats"),
            keywords: ["statistics", "info", "overview"],
          },
          {
            id: "tab-git",
            name: inWorkspace ? "Open Git Panel" : "Show Git Tab",
            category: "Info Panel",
            icon: GitFork,
            shortcut: "2",
            handler: infoHandler("git"),
            keywords: ["branch", "commit", "history"],
          },
          {
            id: "tab-notes",
            name: inWorkspace ? "Open Notes Panel" : "Show Notes Tab",
            category: "Info Panel",
            icon: StickyNote,
            shortcut: "3",
            handler: infoHandler("notes"),
            keywords: ["note", "memo", "description"],
          },
          {
            id: "tab-comments",
            name: inWorkspace ? "Open Comments Panel" : "Show Comments Tab",
            category: "Info Panel",
            icon: MessageCircle,
            shortcut: "4",
            handler: infoHandler("comments"),
            keywords: ["comment", "discussion", "feedback"],
          },
        );
      }

      // Refresh
      commands.push({
        id: "task-refresh",
        name: "Refresh",
        category: "Task Actions",
        icon: RefreshCw,
        shortcut: "r",
        handler: onRefresh,
        keywords: ["reload", "update"],
      });
    }

    // --- Project Actions ---
    if (projectActions) {
      commands.push(
        {
          id: "project-ide",
          name: "Open Project in IDE",
          category: "Project Actions",
          icon: ExternalLink,
          handler: projectActions.onOpenIDE,
          keywords: ["vscode", "cursor", "editor", "external"],
        },
        {
          id: "project-terminal",
          name: "Open Project in Terminal App",
          category: "Project Actions",
          icon: SquareTerminal,
          handler: projectActions.onOpenTerminal,
          keywords: ["iterm", "warp", "shell", "external"],
        },
      );
    }

    return commands;
}
