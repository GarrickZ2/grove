import { useState } from "react";
import { FolderX, Trash2 } from "lucide-react";
import { useProject } from "../../context";
import type { Project } from "../../data/types";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

/**
 * Full-page state shown when the selected project's filesystem path no longer
 * exists. Only action offered is Delete (clean up Grove's stale metadata).
 *
 * Rendered by App.tsx as a hard overlay on top of every project-scoped page
 * (everything except Projects and Settings). The user can still navigate to
 * Projects or Settings from the sidebar to escape.
 */
export function MissingProjectState({ project }: { project: Project }) {
  const { deleteProject } = useProject();
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirmDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteProject(project.id);
      // deleteProject updates context — the overlay disappears automatically.
    } catch (err: unknown) {
      console.error("Failed to delete project:", err);
      setError(err instanceof Error ? err.message : "Failed to delete project");
      setIsDeleting(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-center h-full px-6">
        <div className="max-w-md w-full text-center">
          <div className="mx-auto mb-6 w-16 h-16 rounded-full bg-[var(--color-error)]/10 flex items-center justify-center border border-[var(--color-error)]/30">
            <FolderX className="w-8 h-8 text-[var(--color-error)]" />
          </div>
          <h2 className="text-xl font-semibold text-[var(--color-text)] mb-2">
            Project Missing
          </h2>
          <p className="text-sm text-[var(--color-text-muted)] mb-1">
            {project.name}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mb-6 break-all font-mono line-through">
            {project.path}
          </p>
          <p className="text-sm text-[var(--color-text-muted)] mb-6">
            The directory no longer exists on disk. Grove still has this project's
            metadata (notes, tasks, chat history). Restore the directory to keep
            working, or delete to clean up.
          </p>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isDeleting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--color-error)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4" />
            {isDeleting ? "Deleting..." : "Delete from Grove"}
          </button>
          {error && (
            <p className="mt-4 text-xs text-[var(--color-error)]">{error}</p>
          )}
        </div>
      </div>

      <DeleteProjectDialog
        isOpen={showConfirm}
        project={project}
        onClose={() => {
          if (!isDeleting) setShowConfirm(false);
        }}
        onConfirm={handleConfirmDelete}
        isLoading={isDeleting}
      />
    </>
  );
}
