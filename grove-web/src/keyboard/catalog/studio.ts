import type { CommandDef } from "../types";

/**
 * Studio commands — first-class surface for non-coders (designers, PMs,
 * brand). Covers shared resources, workspace instructions, project memory,
 * and Excalidraw sketches.
 *
 * Selection-based per-row operations (resource.export/delete/rename,
 * sketch.rename) live in row context menus, not as shortcuts. Duplicate
 * is omitted until the backend supports a fork endpoint.
 *
 * Scope:
 *   workspace — Studio surfaces live inside the workspace
 */
export const STUDIO_COMMANDS: CommandDef[] = [
  {
    id: "studio.resource.import",
    name: "Import Resource",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.resource.refresh",
    name: "Refresh Resources",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.resource.addLink",
    name: "Add Link to Shared Assets",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.resource.addFolder",
    name: "Add Folder to Shared Assets",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.instructions.save",
    name: "Save Workspace Instructions",
    category: "Studio",
    defaultBindings: [{ key: "Mod+s" }],
    scope: "workspace",
    defaultWhen: "studioMode && instructionsEdited",
    // Monaco / textarea focus suppresses commands by default; the save
    // shortcut must fire even while the user is mid-edit in the editor.
    passThroughTextInput: true,
  },
  {
    id: "studio.instructions.edit",
    name: "Edit Workspace Instructions",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.memory.save",
    name: "Save Project Memory",
    category: "Studio",
    defaultBindings: [{ key: "Mod+s" }],
    scope: "workspace",
    defaultWhen: "studioMode && memoryEdited",
    // Monaco / textarea focus suppresses commands by default; the save
    // shortcut must fire even while the user is mid-edit in the editor.
    passThroughTextInput: true,
  },
  {
    id: "studio.memory.edit",
    name: "Edit Project Memory",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.sketch.create",
    name: "Create Sketch",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode",
  },
  {
    id: "studio.sketch.delete",
    name: "Delete Sketch",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode && sketchSelected",
  },
  {
    id: "studio.sketch.export",
    name: "Export Sketch",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode && sketchSelected",
  },
  {
    id: "studio.sketch.history.open",
    name: "Open Sketch History",
    category: "Studio",
    scope: "workspace",
    defaultWhen: "studioMode && sketchSelected",
  },
];
