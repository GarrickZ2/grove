import type { CommandDef } from "../types";

/**
 * Panel commands. Open, toggle, split, and close FlexLayout panels
 * inside the task workspace.
 *
 * Scopes:
 *   workspace  — TaskView (inside a task)
 */
export const PANEL_COMMANDS: CommandDef[] = [
  {
    id: "panel.chat.open",
    name: "Open Agent Panel",
    category: "Panels",
    description: "Open the agent panel for the current task",
    defaultBindings: [{ key: "Mod+Alt+c" }],
    scope: "workspace",
    defaultWhen: "taskSelected && !archived",
  },
  {
    id: "panel.terminal.open",
    name: "Open Terminal Panel",
    category: "Panels",
    description: "Open a terminal panel attached to the current worktree",
    defaultBindings: [{ key: "Mod+Alt+t" }],
    scope: "workspace",
    defaultWhen: "taskSelected && !archived",
  },
  {
    id: "panel.editor.open",
    name: "Open Editor Panel",
    category: "Panels",
    description: "Open the Monaco editor panel for the current task",
    defaultBindings: [{ key: "Mod+Alt+e" }],
    scope: "workspace",
    defaultWhen: "taskSelected && !archived",
  },
  {
    id: "panel.review.open",
    name: "Open Review Panel",
    category: "Panels",
    description: "Open the code review panel for the current task",
    defaultBindings: [{ key: "Mod+Alt+r" }],
    scope: "workspace",
    defaultWhen: "taskSelected && !archived && !studioMode",
  },
  {
    id: "panel.artifacts.open",
    name: "Open Artifacts Panel",
    category: "Panels",
    description: "Open the Studio artifacts panel for the current task",
    defaultBindings: [{ key: "Mod+Alt+a" }],
    scope: "workspace",
    // Project-level (the task lives inside a studio project) — not
    // page-level. `studioMode` is only set true when ResourcePage is
    // mounted, which it isn't from inside a TaskView, so checking it
    // here would always fail.
    defaultWhen: "taskSelected && studioProject",
  },
  {
    id: "panel.graph.open",
    name: "Open Graph Panel",
    category: "Panels",
    description: "Open the agent graph panel for the current task",
    defaultBindings: [{ key: "Mod+Alt+g" }],
    scope: "workspace",
    defaultWhen: "taskSelected && !archived",
  },
  {
    id: "panel.info.toggle",
    name: "Toggle Info Panel",
    category: "Panels",
    description: "Show or hide the task info side panel",
    scope: "workspace",
    defaultWhen: "taskSelected",
  },
  {
    id: "panel.closeActive",
    name: "Close Active Tab",
    category: "Panels",
    description: "Close the currently focused panel tab",
    defaultBindings: [{ key: "Mod+Alt+w" }],
    scope: "workspace",
    defaultWhen: "panelOpen",
  },
];
