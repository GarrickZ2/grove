import { useEffect, useRef } from "react";
import { Edit3, FileText, Plus } from "lucide-react";
import { MarkdownRenderer } from "../../components/ui/MarkdownRenderer";
import { INSTRUCTIONS_EDITOR_ID } from "../../components/Studio/useStudioCommands";
import type { WorkspaceInstructions } from "../../components/Studio/useWorkspaceInstructions";
import { Button, Card, EmptyState, SavedChip, StatusDot } from "../ui";
import { availableTemplates } from "./studioView";

const PLACEHOLDER = "# Workspace rules\n\nAdd shared expectations for every task in this Studio.\n\nExamples:\n- Use formal tone for reports\n- Output files in Markdown format\n- Reference data from resource/ when available";

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Workspace Instructions: read as rendered Markdown, edit in place, add a section from a template. */
export function InstructionsCard({ state }: { state: WorkspaceInstructions }) {
  const {
    instructions, setInstructions, isLoadingInstructions, isSaving, saveMessage, saveCount,
    isEditingInstructions, setIsEditingInstructions, hasUnsaved, instructionLineCount,
    handleSaveInstructions, cancelEditing, insertTemplate,
  } = state;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pendingFlash = useRef(false);
  const templates = availableTemplates(instructions);
  const saveError = saveMessage && saveMessage !== "Saved" ? saveMessage : null;

  // Entering edit mode focuses the editor; a template lands at the end, so
  // scroll there and glow it once so you see what was added.
  useEffect(() => {
    if (!isEditingInstructions) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    if (!pendingFlash.current) return;
    pendingFlash.current = false;
    editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.scrollTop = editor.scrollHeight;
    if (!prefersReducedMotion()) {
      editor.parentElement?.animate(
        [{ boxShadow: "0 0 0 4px var(--osd-studio-soft)" }, { boxShadow: "0 0 0 0 transparent" }],
        { duration: 1100, easing: "ease-out" },
      );
    }
  }, [isEditingInstructions, instructions]);

  const addTemplate = (content: string) => {
    pendingFlash.current = true;
    insertTemplate(content);
    setIsEditingInstructions(true);
  };

  const actions = isEditingInstructions ? (
    <>
      <Button variant="ghost" size="sm" disabled={isSaving} onClick={cancelEditing}>Cancel</Button>
      <Button variant="primary" size="sm" disabled={isSaving || !hasUnsaved} onClick={() => void handleSaveInstructions()}>
        {isSaving ? "Saving…" : "Save"}
      </Button>
    </>
  ) : (
    <>
      <SavedChip count={saveCount} />
      <Button variant="ghost" size="sm" disabled={isLoadingInstructions} onClick={() => setIsEditingInstructions(true)}><Edit3 />Edit</Button>
    </>
  );

  let body;
  if (isLoadingInstructions) {
    body = <div className="osd-doc-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>;
  } else if (isEditingInstructions) {
    body = (
      <div className="osd-doc is-edit">
        <textarea
          ref={editorRef}
          id={INSTRUCTIONS_EDITOR_ID}
          className="oui-scroll"
          value={instructions}
          aria-label="Workspace instructions"
          placeholder={PLACEHOLDER}
          spellCheck={false}
          onChange={(event) => setInstructions(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !hasUnsaved) {
              event.stopPropagation();
              cancelEditing();
            }
          }}
        />
      </div>
    );
  } else if (instructions.trim()) {
    body = (
      <div key={saveCount} className="osd-doc oui-scroll is-read" onDoubleClick={() => setIsEditingInstructions(true)}>
        <MarkdownRenderer content={instructions} />
      </div>
    );
  } else {
    body = (
      <EmptyState
        icon={FileText}
        title="No instructions yet"
        action={<Button variant="secondary" size="sm" onClick={() => setIsEditingInstructions(true)}><Edit3 />Write instructions</Button>}
      />
    );
  }

  return (
    <Card className="osd-ins" aria-label="Instructions for agents" title="Instructions for agents" actions={actions}>
      {!isLoadingInstructions && templates.length > 0 ? (
        <div className="osd-tmpl">
          <span>Add a section</span>
          {templates.map((template) => (
            <button key={template.label} type="button" className="osd-tchip" onClick={() => addTemplate(template.content)}>
              <Plus aria-hidden="true" />{template.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="osd-ins-body">{body}</div>
      <div className="osd-ins-foot">
        <StatusDot tone="ok" ring />
        <span className="oui-truncate">Shared as <code>instructions.md</code> with every task</span>
        <span className="osd-sp" />
        {saveError ? <span className="osd-ins-err" role="alert">{saveError}</span>
          : isEditingInstructions ? (
            hasUnsaved ? <span className="osd-ins-unsaved">Unsaved changes</span> : <span>No changes</span>
          ) : (
            <span className="oui-tnum">{instructionLineCount > 0 ? `${instructionLineCount} ${instructionLineCount === 1 ? "line" : "lines"}` : "Empty"}</span>
          )}
      </div>
    </Card>
  );
}
