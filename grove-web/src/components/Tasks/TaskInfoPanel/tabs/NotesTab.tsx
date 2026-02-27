import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { FileText, Edit3, Save, X, Loader2 } from "lucide-react";
import { Button, MarkdownRenderer, FileMentionDropdown } from "../../../ui";
import type { Task } from "../../../../data/types";
import { useProject } from "../../../../context/ProjectContext";
import { getNotes, updateNotes, getTaskFiles } from "../../../../api";
import { buildMentionItems, filterMentionItems } from "../../../../utils/fileMention";

interface NotesTabProps {
  projectId?: string;
  task: Task;
}

export function NotesTab({ projectId, task }: NotesTabProps) {
  const { selectedProject } = useProject();
  const resolvedProjectId = projectId || selectedProject?.id;
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedProjectIdRef = useRef(resolvedProjectId);
  resolvedProjectIdRef.current = resolvedProjectId;

  // Refs for auto-save on navigate away
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  const contentRef = useRef(content);
  contentRef.current = content;
  const originalContentRef = useRef(originalContent);
  originalContentRef.current = originalContent;

  // @ mention state
  const [taskFiles, setTaskFiles] = useState<string[]>([]);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileSelectedIdx, setFileSelectedIdx] = useState(0);
  const [atCharIdx, setAtCharIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const mentionItems = useMemo(() => buildMentionItems(taskFiles), [taskFiles]);
  const filteredFiles = useMemo(
    () => filterMentionItems(mentionItems, fileFilter),
    [mentionItems, fileFilter],
  );

  // Only reload when task.id changes — not on project refreshes
  useEffect(() => {
    const pid = resolvedProjectIdRef.current;
    if (!pid) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setIsEditing(false);

    getNotes(pid, task.id)
      .then((response) => {
        if (cancelled) return;
        setContent(response.content);
        setOriginalContent(response.content);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load notes:", err);
        setContent("");
        setOriginalContent("");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      // Auto-save on navigate away (task switch or unmount)
      if (isEditingRef.current && contentRef.current !== originalContentRef.current) {
        const pid = resolvedProjectIdRef.current;
        if (pid) {
          updateNotes(pid, task.id, contentRef.current).catch(() => {});
        }
      }
    };
  }, [task.id]);

  // Load task files for @ mention
  useEffect(() => {
    const pid = resolvedProjectIdRef.current;
    if (!pid) return;
    getTaskFiles(pid, task.id)
      .then((res) => setTaskFiles(res.files))
      .catch(() => {});
  }, [task.id]);

  // Close file menu when clicking outside
  useEffect(() => {
    if (!showFileMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowFileMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showFileMenu]);

  const handleSave = async () => {
    if (!resolvedProjectId) return;

    try {
      setIsSaving(true);
      setError(null);
      await updateNotes(resolvedProjectId, task.id, content);
      setOriginalContent(content);
      setIsEditing(false);
    } catch (err) {
      console.error("Failed to save notes:", err);
      setError("Failed to save notes");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setIsEditing(false);
    setShowFileMenu(false);
  };

  /** Detect @ in textarea and show file menu */
  const detectAtMention = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || taskFiles.length === 0) return;

    const text = textarea.value;
    const cursor = textarea.selectionStart;

    let atIdx = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (text[i] === "@") {
        if (i === 0 || /\s|\n/.test(text[i - 1])) atIdx = i;
        break;
      }
      if (/\s|\n/.test(text[i])) break;
    }

    if (atIdx >= 0) {
      setFileFilter(text.slice(atIdx + 1, cursor));
      setAtCharIdx(atIdx);
      setShowFileMenu(true);
      setFileSelectedIdx(0);
    } else {
      setShowFileMenu(false);
    }
  }, [taskFiles.length]);

  /** Insert a file path at cursor, replacing @query */
  const insertFileMention = useCallback((filePath: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.value;
    const cursor = textarea.selectionStart;

    let atIdx = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (text[i] === "@") {
        if (i === 0 || /\s|\n/.test(text[i - 1])) atIdx = i;
        break;
      }
      if (/\s|\n/.test(text[i])) break;
    }
    if (atIdx < 0) return;

    const before = text.slice(0, atIdx);
    const after = text.slice(cursor);
    const insertion = filePath + " ";
    const newValue = before + insertion + after;
    const newCursor = before.length + insertion.length;

    setContent(newValue);
    setShowFileMenu(false);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursor, newCursor);
    });
  }, []);

  /** Handle keyboard navigation in file menu */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showFileMenu || filteredFiles.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFileSelectedIdx((prev) => (prev + 1) % filteredFiles.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFileSelectedIdx((prev) => (prev - 1 + filteredFiles.length) % filteredFiles.length);
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      insertFileMention(filteredFiles[fileSelectedIdx].path);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setShowFileMenu(false);
      return;
    }
  }, [showFileMenu, filteredFiles, fileSelectedIdx, insertFileMention]);

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
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Task Notes
        </h3>
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
