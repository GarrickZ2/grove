import type { CommandDef } from "../types";

/**
 * Project-level commands — add / switch / refresh projects, and open the
 * current project in external tools (IDE, terminal).
 */
export const PROJECT_COMMANDS: CommandDef[] = [
  {
    id: "project.add",
    name: "Add Project",
    category: "Project",
  },
  {
    id: "project.open",
    name: "Open Project",
    category: "Project",
    description: "Open/switch to a specific project by name or ID",
  },
  {
    id: "project.switch",
    name: "Switch Project",
    category: "Project",
    // Mod+P opens the project palette. This binding lives here (not on
    // palette.project.open) so there's exactly one owner of the combo —
    // palette.project.open stays hidden/unbound to avoid a duplicate.
    defaultBindings: [{ key: "Mod+p" }],
  },
  {
    id: "project.openIDE",
    name: "Open Project in IDE",
    category: "Project",
    scope: "workspace",
    defaultWhen: "projectSelected",
  },
  {
    id: "project.openTerminal",
    name: "Open Project in Terminal",
    category: "Project",
    scope: "workspace",
    defaultWhen: "projectSelected",
  },
  {
    id: "project.refresh",
    name: "Refresh Project",
    category: "Project",
  },
];
