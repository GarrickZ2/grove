import type { CommandDef } from "../types";

/**
 * View commands — sidebar visibility, zoom level, and UI density.
 */
export const VIEW_COMMANDS: CommandDef[] = [
  {
    id: "view.sidebar.toggle",
    name: "Toggle Sidebar",
    category: "View",
    defaultBindings: [{ key: "Mod+b" }],
  },
  {
    // Three-state cycle: expanded → collapsed → island (Dynamic Island) → expanded.
    // Distinct from `view.sidebar.toggle` (binary expanded ↔ collapsed) so users
    // can pin expanded ⇄ collapsed with Mod+B without ever dropping into the pill.
    id: "view.sidebar.archive",
    name: "Archive Sidebar (Dynamic Island)",
    category: "View",
    defaultBindings: [{ key: "Mod+." }],
  },
  {
    id: "view.zoom.increase",
    name: "Zoom In",
    category: "View",
    defaultBindings: [{ key: "Mod+=" }],
  },
  {
    id: "view.zoom.decrease",
    name: "Zoom Out",
    category: "View",
    defaultBindings: [{ key: "Mod+-" }],
  },
  {
    id: "view.zoom.reset",
    name: "Reset Zoom",
    category: "View",
    defaultBindings: [{ key: "Mod+0" }],
  },
  {
    id: "view.density.compact",
    name: "Compact Density",
    category: "View",
  },
  {
    id: "view.density.cozy",
    name: "Cozy Density",
    category: "View",
  },
  {
    id: "view.density.spacious",
    name: "Spacious Density",
    category: "View",
  },
];
