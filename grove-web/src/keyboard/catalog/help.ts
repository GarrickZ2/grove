import type { CommandDef } from "../types";

/**
 * Help overlay commands — toggle / close the help cheatsheet and jump
 * straight to the keyboard shortcut settings.
 */
export const HELP_COMMANDS: CommandDef[] = [
  {
    id: "help.toggle",
    name: "Toggle Help Overlay",
    category: "Help",
    defaultBindings: [{ key: "Mod+/" }],
    passThroughTextInput: false,
  },
  {
    id: "help.close",
    name: "Close Help Overlay",
    category: "Help",
    defaultBindings: [{ key: "Escape" }],
    scope: "helpOverlay",
  },
  {
    id: "help.openShortcutSettings",
    name: "Open Keyboard Shortcuts Settings",
    category: "Help",
    scope: "helpOverlay",
  },
];
