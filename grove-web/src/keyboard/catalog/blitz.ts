import type { CommandDef } from "../types";

/**
 * Blitz mode commands — Cmd+1..9, Cmd+0 jump to the Nth task in the
 * main Blitz list. Catalog overlap with nav.* is intentional: nav.* is
 * global, blitz.task.jump.* is scoped to "tasks" + `inBlitzMode`, so
 * the dispatcher picks the right one based on the active scope stack.
 * Mod+0 likewise shadows view.zoom.reset while in Blitz — intentional;
 * Blitz's focused task-jumping mode has no zoom need.
 *
 * Scope:
 *   tasks  — TasksPage / BlitzPage
 */
function makeJump(n: number): CommandDef {
  // Cmd+1 = first task, …, Cmd+9 = ninth task, Cmd+0 = tenth task.
  const key = `Mod+${n === 10 ? 0 : n}`;
  return {
    id: `blitz.task.jump${n}`,
    name: `Jump to Task ${n}`,
    category: "Blitz",
    description: `Jump to the ${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"} task in the Blitz list`,
    defaultBindings: [{ key }],
    scope: "tasks",
    defaultWhen: "inBlitzMode",
  };
}

export const BLITZ_COMMANDS: CommandDef[] = [
  ...Array.from({ length: 10 }, (_, i) => makeJump(i + 1)),
  {
    id: "blitz.grid.toggle",
    name: "Toggle Grid Workspace",
    category: "Blitz",
    description: "Switch Blitz between the task list and the grid workspace",
    // Mod = ⌘ on macOS, Ctrl on Linux/Windows.
    defaultBindings: [{ key: "Mod+g" }],
    scope: "tasks",
    defaultWhen: "inBlitzMode",
    // Holding the chord shouldn't rapidly flip grid on/off.
    ignoreRepeat: true,
  },
  {
    id: "blitz.grid.exit",
    name: "Exit Grid Workspace",
    category: "Blitz",
    description: "Leave the Blitz grid workspace and return to the task list",
    defaultBindings: [{ key: "Escape" }],
    scope: "tasks",
    // Only while the grid is showing — keeps Escape free for the task list.
    defaultWhen: "blitzGridActive",
  },
];
