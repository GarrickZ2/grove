import type { CommandDef } from "../types";

/**
 * Workspace-level commands: fullscreen and layout mode toggles for the
 * TaskView shell. Sidebar toggle lives at the global level
 * (`view.sidebar.toggle`); split/move operations would require FlexLayout
 * to expose APIs the components don't currently offer.
 *
 * Scopes:
 *   workspace  — TaskView (inside a task)
 */
export const WORKSPACE_COMMANDS: CommandDef[] = [
  {
    id: "workspace.fullscreen.toggle",
    name: "Toggle Fullscreen",
    category: "Workspace",
    description: "Toggle the workspace fullscreen mode",
    scope: "workspace",
  },
  {
    id: "workspace.layout.toggle",
    name: "Toggle Layout Mode",
    category: "Workspace",
    description: "Switch between default and custom panel layouts",
    scope: "workspace",
  },
  {
    id: "workspace.ideLayout.toggle",
    name: "Toggle IDE Layout",
    category: "Workspace",
    description: "Toggle the IDE-style layout preset",
    scope: "workspace",
  },
];
