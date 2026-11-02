import { useState, useEffect, useRef, useMemo, useCallback, type KeyboardEvent } from "react";
import { useProject } from "../../../../context/ProjectContext";
import { getNotes, updateNotes, getTaskFiles } from "../../../../api";
import { buildMentionItems, filterMentionItems } from "../../../../utils/fileMention";

/**
 * Task notes: load, edit, save/cancel, auto-save when leaving mid-edit, and
 * the textarea's @ file-mention menu. Shared by the Workbench and Orbit renders.
 */
export function useTaskNotes(projectId: string | undefined, taskId: string) {
  const { selectedProject } = useProject();
  const resolvedProjectId = projectId || selectedProject?.id;
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last load failed (Workbench shows the empty state; Orbit offers a retry). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const resolvedProjectIdRef = useRef(resolvedProjectId);

  // Refs for auto-save on navigate away
  const isEditingRef = useRef(isEditing);
  const contentRef = useRef(content);
  const originalContentRef = useRef(originalContent);

  // Sync refs in effects (cannot mutate refs during render). The ref consumers
  // are unmount cleanup + async event handlers, both of which run after the
  // commit/effect phase, so the one-tick delay is safe.
  useEffect(() => {
    resolvedProjectIdRef.current = resolvedProjectId;
  }, [resolvedProjectId]);
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  useEffect(() => {
    originalContentRef.current = originalContent;
  }, [originalContent]);

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

  // Only reload when taskId changes — not on project refreshes
  useEffect(() => {
    const pid = resolvedProjectIdRef.current;
    if (!pid) return;

    let cancelled = false;
    // Initial loading state before async getNotes fetch below; driven by
    // taskId change with no equivalent event hook upstream.
    setIsLoading(true);
    setError(null);
    setLoadError(null);
    setIsEditing(false);

    getNotes(pid, taskId)
      .then((response) => {
        if (cancelled) return;
        setContent(response.content);
        setOriginalContent(response.content);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load notes:", err);
        setLoadError(err instanceof Error && err.message ? err.message : "Failed to load notes");
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
          updateNotes(pid, taskId, contentRef.current).catch(() => {});
        }
      }
    };
  }, [taskId, reloadKey]);

  // Load task files for @ mention
  useEffect(() => {
    const pid = resolvedProjectIdRef.current;
    if (!pid) return;
    getTaskFiles(pid, taskId)
      .then((res) => setTaskFiles(res.files))
      .catch(() => {});
  }, [taskId]);

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
      await updateNotes(resolvedProjectId, taskId, content);
      setOriginalContent(content);
      setIsEditing(false);
    } catch (err) {
      console.error("Failed to save notes:", err);
      setError("Failed to save notes");
    }
    setIsSaving(false);
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
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
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

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const isDirty = content !== originalContent;

  return {
    isEditing,
    setIsEditing,
    content,
    setContent,
    isDirty,
    isLoading,
    isSaving,
    error,
    loadError,
    reload,
    handleSave,
    handleCancel,
    textareaRef,
    containerRef,
    detectAtMention,
    handleKeyDown,
    filteredFiles,
    fileSelectedIdx,
    setFileSelectedIdx,
    insertFileMention,
    showFileMenu,
    atCharIdx,
  };
}
