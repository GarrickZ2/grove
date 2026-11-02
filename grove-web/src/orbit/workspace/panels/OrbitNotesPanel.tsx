import type { KeyboardEvent } from "react";
import { Eye, FileText, Loader2, Pencil } from "lucide-react";
import type { Task } from "../../../data/types";
import { MarkdownRenderer, FileMentionDropdown } from "../../../components/ui";
import { useTaskNotes } from "../../../components/Tasks/TaskInfoPanel/tabs/useTaskNotes";
import { formatKeyDisplay } from "../../../keyboard";
import { Button } from "../../ui/Button";
import { PanelEmpty, PanelError, PanelLoading } from "../../ui/PanelShell";
import { HeaderActions, PanelBody } from "./PanelStates";

const SAVE_KEY = formatKeyDisplay("Mod+S");
const SHARED_COPY = "Agents in this task can read these notes.";

/** Notes panel body: the task's Markdown notes, read or edited in place. */
export function OrbitNotesPanel({ projectId, task }: { projectId?: string; task: Task }) {
  const notes = useTaskNotes(projectId, task.id);
  const {
    isEditing, setIsEditing, content, setContent, isDirty, isLoading, isSaving, error, loadError, reload,
    handleSave, handleCancel, textareaRef, containerRef, detectAtMention, handleKeyDown,
    filteredFiles, fileSelectedIdx, setFileSelectedIdx, insertFileMention, showFileMenu, atCharIdx,
  } = notes;

  if (isLoading) {
    return (
      <PanelBody label="Notes">
        <PanelLoading label="Loading notes" />
      </PanelBody>
    );
  }

  if (loadError && !isEditing) {
    return (
      <PanelBody label="Notes">
        <PanelError title="Couldn’t load the notes" onRetry={reload}>
          Grove didn’t return this task’s notes. Nothing was changed; try again in a moment.
        </PanelError>
      </PanelBody>
    );
  }

  if (!content && !isEditing) {
    return (
      <PanelBody label="Notes">
        <PanelEmpty
          icon={FileText}
          title="No notes yet"
          action={<Button variant="primary" size="sm" onClick={() => setIsEditing(true)}>Start a note</Button>}
        >
          Write the goal, constraints or a checklist. {SHARED_COPY}
        </PanelEmpty>
      </PanelBody>
    );
  }

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    handleKeyDown(event);
    if (event.defaultPrevented) return;
    if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "Enter")) {
      event.preventDefault();
      if (!isSaving) void handleSave();
    } else if (event.key === "Escape" && !showFileMenu && !isDirty) {
      event.preventDefault();
      handleCancel();
    }
  };

  return (
    <PanelBody label="Notes">
      <div className="owp-notes">
        <div className="owp-notebar">
          <span className="owp-notebar-copy"><Eye aria-hidden="true" /><span title={SHARED_COPY}>{SHARED_COPY}</span></span>
          {!isEditing ? (
            <HeaderActions
              fallback={<Button size="sm" variant="ghost" onClick={() => setIsEditing(true)}><Pencil aria-hidden="true" />Edit</Button>}
            >
              <Button size="sm" variant="ghost" iconOnly onClick={() => setIsEditing(true)} aria-label="Edit notes" title="Edit notes">
                <Pencil aria-hidden="true" />
              </Button>
            </HeaderActions>
          ) : null}
        </div>

        {isEditing ? (
          <>
            <div ref={containerRef} className="owp-editor">
              <textarea
                ref={textareaRef}
                value={content}
                autoFocus
                aria-label="Task notes (Markdown)"
                onChange={(event) => {
                  setContent(event.target.value);
                  requestAnimationFrame(detectAtMention);
                }}
                onKeyDown={onEditorKeyDown}
                placeholder="Write in Markdown. Type @ to mention a file."
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
            <div className="owp-notefoot">
              <span className="owp-notefoot-hint"><kbd>@</kbd> mention a file · <kbd>{SAVE_KEY}</kbd> save</span>
              <Button size="sm" variant="ghost" onClick={handleCancel} disabled={isSaving}>Cancel</Button>
              <Button size="sm" variant="primary" onClick={() => void handleSave()} disabled={isSaving}>
                {isSaving ? <Loader2 className="oui-spin" aria-hidden="true" /> : null}
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        ) : (
          <div className="owp-note">
            <MarkdownRenderer content={content} />
          </div>
        )}

        {error ? <p className="owp-inline-error" role="alert">{error}</p> : null}
      </div>
    </PanelBody>
  );
}
