import type { CommandDef } from "../types";

/**
 * Info tab / side panel commands. In Zen mode the digit keys switch the
 * task's info tab; in Blitz (workspace) mode the digit keys open the
 * corresponding standalone panel.
 */
export const INFOTAB_COMMANDS: CommandDef[] = [
  {
    id: "infotab.stats.show",
    name: "Show Stats Tab",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+1" }],
    scope: "tasks",
    defaultWhen: "taskSelected && !inWorkspace",
  },
  {
    id: "infotab.git.show",
    name: "Show Git Tab",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+2" }],
    scope: "tasks",
    defaultWhen: "taskSelected && !inWorkspace && !studioMode",
  },
  {
    id: "infotab.notes.show",
    name: "Show Notes Tab",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+3" }],
    scope: "tasks",
    defaultWhen: "taskSelected && !inWorkspace",
  },
  {
    id: "infotab.comments.show",
    name: "Show Comments Tab",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+4" }],
    scope: "tasks",
    defaultWhen: "taskSelected && !inWorkspace && !studioMode",
  },
  {
    id: "panel.stats.open",
    name: "Open Stats Panel",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+1" }],
    scope: "workspace",
    defaultWhen: "inWorkspace",
  },
  {
    id: "panel.git.open",
    name: "Open Git Panel",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+2" }],
    scope: "workspace",
    defaultWhen: "inWorkspace && !studioMode",
  },
  {
    id: "panel.notes.open",
    name: "Open Notes Panel",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+3" }],
    scope: "workspace",
    defaultWhen: "inWorkspace",
  },
  {
    id: "panel.comments.open",
    name: "Open Comments Panel",
    category: "Info Tabs",
    defaultBindings: [{ key: "Mod+Alt+4" }],
    scope: "workspace",
    defaultWhen: "inWorkspace && !studioMode",
  },
];
