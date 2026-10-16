import { isIosClient } from "../../utils/platform";
import { GripVertical } from "lucide-react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TaskFileDragLocation {
  projectId: string;
  taskId: string;
  path: string;
}

const isTauriDesktop = !isIosClient && typeof window !== "undefined" && (
  "__TAURI__" in window || "__TAURI_INTERNALS__" in window
);

// A compact transparent PNG. The native drag API requires an image for the
// cursor preview; macOS replaces it with the normal file thumbnail.
const DRAG_PREVIEW_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8GQAAAABJRU5ErkJggg==";

async function startExternalFileDrag(event: DragEvent, location: TaskFileDragLocation) {
  event.preventDefault();
  event.stopPropagation();
  try {
    const path = await invoke<string>("resolve_external_drag_path", {
      projectId: location.projectId,
      taskId: location.taskId,
      path: location.path,
    });
    await invoke("plugin:drag|start_drag", {
      item: [path],
      image: DRAG_PREVIEW_PNG,
      options: { mode: "copy" },
    });
  } catch (error) {
    // Deleted/stale review entries cannot be exported as the current worktree
    // file. Keep the failure non-disruptive and leave selection unchanged.
    console.error("[external-file-drag] failed to start", error);
  }
}

/**
 * A dedicated native-drag affordance. The surrounding row retains its normal
 * HTML drag behavior (for example, moving a file inside the editor tree).
 */
export function ExternalFileDragHandle({ location }: { location: TaskFileDragLocation }) {
  if (!isTauriDesktop) return null;
  return (
    <span
      draggable
      role="button"
      aria-label="Drag file to another app"
      title="Drag to another app or upload area"
      className="ml-auto inline-flex cursor-grab items-center text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing hover:text-[var(--color-highlight)]"
      onDragStart={(event) => { void startExternalFileDrag(event, location); }}
      onClick={(event) => event.stopPropagation()}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
  );
}
