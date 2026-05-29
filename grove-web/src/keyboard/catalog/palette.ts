import type { CommandDef } from "../types";

/**
 * Command / project / task palette commands. Each palette has its own
 * scope so its Enter / Escape bindings don't collide with the global ones.
 */
export const PALETTE_COMMANDS: CommandDef[] = [
  {
    id: "palette.command.open",
    name: "Open Command Palette",
    category: "Palette",
    defaultBindings: [{ key: "Mod+Shift+P" }],
    passThroughTextInput: true,
  },
  {
    id: "palette.command.close",
    name: "Close Command Palette",
    category: "Palette",
    defaultBindings: [{ key: "Escape" }],
    scope: "palette",
  },
  {
    id: "palette.command.execute",
    name: "Execute Selected Command",
    category: "Palette",
    defaultBindings: [{ key: "Enter" }],
    scope: "palette",
    defaultWhen: "commandSelected",
  },
  {
    id: "palette.project.open",
    name: "Open Project Palette",
    category: "Palette",
    // No default binding — `project.switch` (in project.ts) is the
    // user-facing entry for Mod+P. Keeping a duplicate binding here
    // produced a real conflict (same key, both global scope, both
    // unconditional). The handler stays registered so palette
    // contributions in useCommands.ts and elsewhere keep working.
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "palette.project.close",
    name: "Close Project Palette",
    category: "Palette",
    defaultBindings: [{ key: "Escape" }],
    scope: "palette.project",
  },
  {
    id: "palette.project.select",
    name: "Select Project",
    category: "Palette",
    defaultBindings: [{ key: "Enter" }],
    scope: "palette.project",
    defaultWhen: "projectSelected",
  },
  {
    id: "palette.task.open",
    name: "Open Task Palette",
    category: "Palette",
    defaultBindings: [{ key: "Mod+o" }],
    passThroughTextInput: true,
  },
  {
    id: "palette.task.close",
    name: "Close Task Palette",
    category: "Palette",
    defaultBindings: [{ key: "Escape" }],
    scope: "palette.task",
  },
  {
    id: "palette.task.select",
    name: "Select Task",
    category: "Palette",
    defaultBindings: [{ key: "Enter" }],
    scope: "palette.task",
    defaultWhen: "taskSelected",
  },
  {
    id: "palette.legacy.command.open",
    name: "Open Search Palette",
    category: "Palette",
    description: "Open the sidebar search palette (task/project switcher)",
    defaultBindings: [{ key: "Mod+k" }],
    passThroughTextInput: true,
  },
];
