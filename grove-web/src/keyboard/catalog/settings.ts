import type { CommandDef } from "../types";

/**
 * Settings commands — opening and closing the settings surface.
 *
 * Settings-page-internal operations (tab switches, theme/MCP/agent/keymap
 * management) intentionally do NOT have keyboard shortcuts: they're mouse-
 * driven configuration, not workflow actions. Adding shortcuts to those
 * would clutter the catalog without ergonomic benefit.
 */
export const SETTINGS_COMMANDS: CommandDef[] = [
  // Note: "open" intentionally not declared — `nav.settings` (in nav.ts)
  // is the SSoT for "switch to Settings page". Having a second command
  // doing the same thing only confused users in the keymap list.
  {
    id: "settings.close",
    name: "Close Settings",
    category: "Settings",
    defaultBindings: [{ key: "Escape" }],
    scope: "settings",
  },
];
