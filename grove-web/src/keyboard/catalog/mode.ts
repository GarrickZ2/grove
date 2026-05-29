import type { CommandDef } from "../types";

/**
 * Mode-switching commands — Zen vs Blitz, IDE layout, fullscreen, theme.
 */
export const MODE_COMMANDS: CommandDef[] = [
  {
    id: "mode.zen.activate",
    name: "Switch to Zen Mode",
    category: "Mode",
    defaultWhen: "inBlitzMode",
  },
  {
    id: "mode.blitz.activate",
    name: "Switch to Blitz Mode",
    category: "Mode",
    defaultWhen: "inZenMode",
  },
  {
    id: "mode.ide.layout.toggle",
    name: "Toggle IDE Layout",
    category: "Mode",
    scope: "workspace",
  },
  {
    id: "mode.fullscreen.toggle",
    name: "Toggle Fullscreen",
    category: "Mode",
    scope: "workspace",
    defaultWhen: "inWorkspace",
  },
  {
    id: "mode.theme.toggle",
    name: "Toggle Theme (Dark/Light)",
    category: "Mode",
  },
];
