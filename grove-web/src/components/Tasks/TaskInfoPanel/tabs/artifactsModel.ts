// Pure helpers behind the task Artifacts panel. Shared by the Workbench
// ArtifactsTab and the Orbit artifacts body.
import type { ArtifactFile } from "../../../../api";

/** dataTransfer type carried by internal file drags (FileTree, artifact rows). */
export const GROVE_FILE_DRAG_TYPE = "application/x-grove-file-path";

export function dropContainsDirectory(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items || [])) {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

/** True if the current drag carries a grove file path — i.e. it's an internal
 *  drag from another FileCard or from FileTree, not an OS file upload. We use
 *  this to suppress the "Drop files to upload" overlay (misleading when the
 *  user is moving a chip to the chat composer) and to no-op the drop handler. */
export function dragCarriesGrovePath(dt: DataTransfer): boolean {
  const types = dt.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === GROVE_FILE_DRAG_TYPE) return true;
  }
  return false;
}

export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

export function getDirectChildren(files: ArtifactFile[], parent: string): ArtifactFile[] {
  const normalizedParent = parent.trim().replace(/^\/+|\/+$/g, "");
  return files
    .filter((file) => parentPath(file.path) === normalizedParent)
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      // Sort by modified_at descending (newest first)
      const timeA = a.modified_at ? new Date(a.modified_at).getTime() : 0;
      const timeB = b.modified_at ? new Date(b.modified_at).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Resolves an external "show this artifact" request (a path the agent or chat
 * mentioned, e.g. `output/site/index.html`, `./report.pdf` or a bare name) to a
 * listed file. Returns null when nothing in the task's artifacts matches.
 */
export function resolvePreviewTarget(
  requestedPath: string,
  inputFiles: ArtifactFile[],
  outputFiles: ArtifactFile[],
): ArtifactFile | null {
  const trimmedPath = requestedPath.trim().replace(/^\.?\//, "");
  if (!trimmedPath) return null;
  const requestedSegments = trimmedPath.split("/");

  let requestedDir = requestedSegments[0] === "input" || requestedSegments[0] === "output"
    ? requestedSegments[0]
    : null;
  const normalizedRequestedPath = requestedDir
    ? requestedSegments.slice(1).join("/")
    : trimmedPath;

  const allFiles = [...inputFiles, ...outputFiles].filter((file) => !file.is_dir);

  let target = allFiles.find((file) =>
    (requestedDir === null || file.directory === requestedDir) && (
      file.path === normalizedRequestedPath ||
      file.name === normalizedRequestedPath ||
      file.path.endsWith(`/${normalizedRequestedPath}`)
    )
  );

  if (!target && !requestedDir) {
    const inputIdx = requestedSegments.findIndex(s => s === "input" || s === "output");
    if (inputIdx !== -1) {
      requestedDir = requestedSegments[inputIdx];
      const remainingSegments = requestedSegments.slice(inputIdx + 1);
      const relativePath = remainingSegments.join("/");
      target = allFiles.find((file) =>
        file.directory === requestedDir && (
          file.path === relativePath ||
          file.name === relativePath ||
          file.path.endsWith(`/${relativePath}`) ||
          file.name === relativePath.split("/").pop()
        )
      );
    }
  }

  if (!target) {
    const fileName = trimmedPath.split("/").pop() || trimmedPath;
    target = allFiles.find((file) => file.name === fileName);
  }

  return target ?? null;
}
