import type { CommandDef } from "../types";

/**
 * Native desktop-window controls (Tauri GUI only). Handlers live in App.tsx
 * and call the Tauri window API; they're enabled only inside the desktop
 * shell — in the browser Web IDE the OS/browser owns the window, so these
 * are no-ops there (gated via `enabled: isTauri`).
 *
 * No default bindings on purpose: window controls overlap OS/browser reserved
 * combos (Cmd+M minimize, Cmd+W close, Ctrl+Cmd+F fullscreen…), so they're
 * Palette-first and left for the user to bind if they want.
 */
export const WINDOW_COMMANDS: CommandDef[] = [
  {
    id: "window.minimize",
    name: "Minimize Window",
    category: "Window",
    description: "Minimize the desktop window (GUI only)",
  },
  {
    id: "window.maximize.toggle",
    name: "Toggle Maximize Window",
    category: "Window",
    description: "Maximize or restore the desktop window (GUI only)",
  },
  {
    id: "window.fullscreen.toggle",
    name: "Toggle Native Fullscreen",
    category: "Window",
    description: "Enter or leave the OS fullscreen mode (GUI only)",
  },
  {
    id: "window.close",
    name: "Close Window",
    category: "Window",
    description: "Close the desktop window (GUI only)",
  },
];
