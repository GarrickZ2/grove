import { useCommand, useContextKey, useKeyboardScope } from "../../keyboard";
import type { ResourceLibrary } from "./useResourceLibrary";
import type { WorkspaceInstructions } from "./useWorkspaceInstructions";

/** Id of the Workspace Instructions textarea; Cmd/Ctrl+S saves only while it has focus. */
export const INSTRUCTIONS_EDITOR_ID = "resource-instructions-editor";

/**
 * Studio keyboard commands (import, refresh, add link / folder, save / edit
 * instructions), routed through the Scoped Command Registry.
 */
export function useStudioCommands({ library, instructions, openFilePicker }: {
  library: ResourceLibrary;
  instructions: WorkspaceInstructions;
  openFilePicker: () => void;
}) {
  const { hasUnsaved, handleSaveInstructions, isLoadingInstructions, isEditingInstructions, setIsEditingInstructions } = instructions;
  const { isUploading, loadFiles, loadWorkdirs, setAddLinkOpen, handleAddWorkdir, isAddingWorkdir } = library;

  // Cmd/Ctrl+S → save instructions. Context keys keep the binding inert when
  // the buffer is clean.
  // - studioMode: the Studio page only mounts inside Studio surfaces.
  // - instructionsEdited: surfaces the "has unsaved" boolean.
  // - The catalog entries have passThroughTextInput: true so the binding
  //   fires while the editor (which suppresses commands by default) owns focus.
  // The catalog scopes save commands to "workspace"; the Studio page is
  // rendered directly under App (not inside TaskView, which would have
  // already pushed it), so we push the scope ourselves.
  useKeyboardScope("workspace");
  useContextKey("studioMode", true);
  useContextKey("instructionsEdited", hasUnsaved);

  // `enabled` keeps the focus-bound behavior — Cmd+S only saves while the
  // Workspace Instructions editor owns focus.
  useCommand(
    "studio.instructions.save",
    () => {
      if (hasUnsaved) void handleSaveInstructions();
    },
    {
      enabled: () =>
        document.activeElement?.id === INSTRUCTIONS_EDITOR_ID,
    },
    [hasUnsaved, handleSaveInstructions],
  );
  // Edit-mode toggle for Workspace Instructions. Legacy Project Memory is
  // intentionally migration-only so the old and new systems cannot diverge.
  useCommand(
    "studio.instructions.edit",
    () => setIsEditingInstructions(true),
    { enabled: () => !isLoadingInstructions && !isEditingInstructions },
    [isLoadingInstructions, isEditingInstructions],
  );

  // Import = primary file upload button. Disabled while a previous upload is
  // in flight, mirroring the button's `disabled` state.
  useCommand(
    "studio.resource.import",
    openFilePicker,
    { enabled: () => !isUploading },
    [isUploading, openFilePicker],
  );

  // Refresh both the file list and the linked workdirs.
  useCommand(
    "studio.resource.refresh",
    () => {
      void loadFiles();
      void loadWorkdirs();
    },
    [loadFiles, loadWorkdirs],
  );

  // Add Link opens the dialog; Add Folder triggers the folder picker, gated
  // by `isAddingWorkdir` to avoid stacking duplicate picker invocations.
  useCommand(
    "studio.resource.addLink",
    () => setAddLinkOpen(true),
    [],
  );
  useCommand(
    "studio.resource.addFolder",
    () => { void handleAddWorkdir(); },
    { enabled: () => !isAddingWorkdir },
    [handleAddWorkdir, isAddingWorkdir],
  );
}
