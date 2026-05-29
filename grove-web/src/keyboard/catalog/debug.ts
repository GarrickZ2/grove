import type { CommandDef } from "../types";

/**
 * Debug-only commands. All entries are hidden so they don't surface in the
 * Command Palette or Settings UI — they're invokable by binding or by
 * programmatic dispatch only.
 */
export const DEBUG_COMMANDS: CommandDef[] = [
  {
    id: "debug.perfPanel.toggle",
    name: "Debug: Toggle Perf Panel",
    category: "Debug",
    // Was Ctrl+Shift+P — on Win/Linux that's the SAME chord as the command
    // palette's Mod+Shift+P (Mod=Ctrl there), and the literal-string conflict
    // detector missed it. Use a distinct combo.
    defaultBindings: [{ key: "Mod+Alt+Shift+P" }],
    hidden: true,
  },
  {
    id: "debug.devtools.toggle",
    name: "Debug: Toggle DevTools",
    category: "Debug",
    description: "Show or hide the Tauri WebView devtools",
    defaultBindings: [{ key: "F12" }, { key: "Mod+Alt+i" }],
    hidden: true,
  },
  {
    id: "debug.reload",
    name: "Debug: Reload Window",
    category: "Debug",
    // No default binding — Mod+R is the browser's reload in the Web IDE.
    hidden: true,
  },
  {
    id: "debug.logState",
    name: "Debug: Log Internal State",
    category: "Debug",
    hidden: true,
  },
  {
    id: "debug.commandRegistry.list",
    name: "Debug: List All Commands",
    category: "Debug",
    hidden: true,
  },
];
