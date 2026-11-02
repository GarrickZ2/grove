import { FileText, Edit3, Save, X, Loader2 } from "lucide-react";
import { Button, MarkdownRenderer, FileMentionDropdown } from "../../../ui";
import type { Task } from "../../../../data/types";
import { useOrbitInterface } from "../../../../orbit/ui/interfaceContext";
import { OrbitNotesPanel } from "../../../../orbit/workspace/panels/OrbitNotesPanel";
import { useTaskNotes } from "./useTaskNotes";

interface NotesTabProps {
  projectId?: string;
  task: Task;
}

export function NotesTab(props: NotesTabProps) {
  const orbit = useOrbitInterface();
  if (orbit) return <OrbitNotesPanel projectId={props.projectId} task={props.task} />;
  return <WorkbenchNotesTab {...props} />;
}

function WorkbenchNotesTab({ projectId, task }: NotesTabProps) {
  const {
    isEditing, setIsEditing, content, setContent, isLoading, isSaving, error,
    handleSave, handleCancel, textareaRef, containerRef, detectAtMention, handleKeyDown,
    filteredFiles, fileSelectedIdx, setFileSelectedIdx, insertFileMention, showFileMenu, atCharIdx,
  } = useTaskNotes(projectId, task.id);

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] mb-3 animate-spin" />
        <p className="text-[var(--color-text-muted)]">Loading notes...</p>
      </div>
    );
  }

  if (!content && !isEditing) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <FileText className="w-12 h-12 text-[var(--color-text-muted)] mb-3" />
        <p className="text-[var(--color-text-muted)] mb-4">No notes for this task</p>
        <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
          <Edit3 className="w-4 h-4 mr-1.5" />
          Add Notes
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-end mb-3">
        {isEditing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSaving}>
              <X className="w-4 h-4 mr-1" />
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1" />
              )}
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
            <Edit3 className="w-4 h-4 mr-1" />
            Edit
          </Button>
        )}
      </div>

      {/* Content */}
      {isEditing ? (
        <div ref={containerRef} className="flex-1 min-h-0 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              requestAnimationFrame(detectAtMention);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Write your notes in Markdown... (type @ to mention files)"
            className="w-full h-full p-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
              text-sm text-[var(--color-text)] font-mono resize-none
              focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
              transition-all duration-200"
          />
          <FileMentionDropdown
            items={filteredFiles}
            selectedIdx={fileSelectedIdx}
            onSelect={insertFileMention}
            onMouseEnter={setFileSelectedIdx}
            visible={showFileMenu}
            anchorRef={textareaRef}
            cursorIdx={atCharIdx}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <MarkdownRenderer content={content} />
        </div>
      )}

      {/* Error message */}
      {error && (
        <p className="text-xs text-[var(--color-error)] mt-2">{error}</p>
      )}
    </div>
  );
}
