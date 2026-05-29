import type { CommandDef } from "../types";

/**
 * Top-level navigation commands — switching between the project's primary
 * pages (Dashboard, Work, Tasks, Skills, AI, Statistics, Settings, ...) and
 * cycling through nav items.
 */
export const NAV_COMMANDS: CommandDef[] = [
  {
    id: "nav.dashboard",
    name: "Go to Dashboard",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+1" }],
    defaultWhen: "!inWorkspace",
    passThroughTextInput: true,
  },
  {
    id: "nav.work",
    name: "Go to Work",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+2" }],
    defaultWhen: "!inWorkspace && !studioProject",
    passThroughTextInput: true,
  },
  {
    id: "nav.tasks",
    name: "Go to Tasks",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+3" }],
    defaultWhen: "!inWorkspace && !studioProject",
    passThroughTextInput: true,
  },
  {
    id: "nav.resource",
    name: "Go to Resource",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+3" }],
    defaultWhen: "!inWorkspace && studioProject",
    passThroughTextInput: true,
  },
  {
    id: "nav.skills",
    name: "Go to Skills",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+4" }],
    defaultWhen: "!inWorkspace",
    passThroughTextInput: true,
  },
  {
    id: "nav.ai",
    name: "Go to AI",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+5" }],
    defaultWhen: "!inWorkspace",
    passThroughTextInput: true,
  },
  {
    id: "nav.statistics",
    name: "Go to Statistics",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+6" }],
    defaultWhen: "!inWorkspace",
    passThroughTextInput: true,
  },
  {
    id: "nav.settings",
    name: "Go to Settings",
    category: "Navigation",
    // Cmd+, is the universal "Preferences" shortcut.
    defaultBindings: [{ key: "Mod+," }],
  },
  {
    id: "nav.projects",
    name: "Go to Projects",
    category: "Navigation",
  },
  {
    id: "nav.notifications.toggle",
    name: "Toggle Notifications Panel",
    category: "Navigation",
    description: "Open or close the notifications popover in the sidebar",
  },
  {
    id: "nav.cycle.next",
    name: "Cycle to Next Nav Item",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+Alt+ArrowDown" }],
    defaultWhen: "!inWorkspace",
  },
  {
    id: "nav.cycle.previous",
    name: "Cycle to Previous Nav Item",
    category: "Navigation",
    defaultBindings: [{ key: "Mod+Alt+ArrowUp" }],
    defaultWhen: "!inWorkspace",
  },
];
