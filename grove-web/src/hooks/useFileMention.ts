import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { filterMentionItems } from "../utils/fileMention";
import type { MentionItem, FilteredMentionItem } from "../utils/fileMention";

export interface UseFileMentionConfig {
  mentionItems: MentionItem[] | null; // null = disabled
}

export interface UseFileMentionReturn {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  showDropdown: boolean;
  filteredItems: FilteredMentionItem[];
  selectedIdx: number;
  atCharIdx: number;
  /** Call inside textarea onChange after updating your own state */
  handleChange: (value: string) => void;
  /** Call inside textarea onKeyDown. Returns true if event was consumed. Pass setText so keyboard selection can update caller state. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, setText: (v: string) => void) => boolean;
  /** Call when user clicks a dropdown item. Returns new text or null. */
  handleSelect: (path: string) => string | null;
  setSelectedIdx: (idx: number) => void;
  dismiss: () => void;
}

/** Scan backwards from cursor to find the @ trigger position */
function findAtIndex(textarea: HTMLTextAreaElement): number {
  const text = textarea.value;
  const cursor = textarea.selectionStart;
  for (let i = cursor - 1; i >= 0; i--) {
    if (text[i] === "@") {
      if (i === 0 || /\s|\n/.test(text[i - 1])) return i;
      break;
    }
    if (/\s|\n/.test(text[i])) break;
  }
  return -1;
}

/** Build new text by replacing @query with filePath */
function buildInsertedText(textarea: HTMLTextAreaElement, atIdx: number, filePath: string) {
  const text = textarea.value;
  const cursor = textarea.selectionStart;
  const before = text.slice(0, atIdx);
  const after = text.slice(cursor);
  const insertion = filePath + " ";
  return {
    newValue: before + insertion + after,
    newCursor: before.length + insertion.length,
  };
}

export function useFileMention({ mentionItems }: UseFileMentionConfig): UseFileMentionReturn {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [atCharIdx, setAtCharIdx] = useState(0);

  const filteredItems = useMemo(
    () => (mentionItems ? filterMentionItems(mentionItems, fileFilter) : []),
    [mentionItems, fileFilter],
  );

  // Auto-close on blur (with delay so dropdown click fires first)
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !showDropdown) return;
    const handleBlur = () => setTimeout(() => setShowDropdown(false), 150);
    textarea.addEventListener("blur", handleBlur);
    return () => textarea.removeEventListener("blur", handleBlur);
  }, [showDropdown]);

  const handleChange = useCallback(
    (_value: string) => {
      if (!mentionItems || mentionItems.length === 0) return;
      const textarea = textareaRef.current;
      if (!textarea) return;

      requestAnimationFrame(() => {
        const idx = findAtIndex(textarea);
        if (idx >= 0) {
          const cursor = textarea.selectionStart;
          setFileFilter(textarea.value.slice(idx + 1, cursor));
          setAtCharIdx(idx);
          setShowDropdown(true);
          setSelectedIdx(0);
        } else {
          setShowDropdown(false);
        }
      });
    },
    [mentionItems],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, setText: (v: string) => void): boolean => {
      if (!showDropdown || filteredItems.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev + 1) % filteredItems.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey)) {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) return true;
        const atIdx = findAtIndex(textarea);
        if (atIdx < 0) return true;

        const filePath = filteredItems[selectedIdx].path;
        const { newValue, newCursor } = buildInsertedText(textarea, atIdx, filePath);
        setText(newValue);
        setShowDropdown(false);

        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(newCursor, newCursor);
        });
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowDropdown(false);
        return true;
      }
      return false;
    },
    [showDropdown, filteredItems, selectedIdx],
  );

  const handleSelect = useCallback(
    (path: string): string | null => {
      const textarea = textareaRef.current;
      if (!textarea) return null;
      const atIdx = findAtIndex(textarea);
      if (atIdx < 0) return null;

      const { newValue, newCursor } = buildInsertedText(textarea, atIdx, path);
      setShowDropdown(false);

      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursor, newCursor);
      });

      return newValue;
    },
    [],
  );

  const dismiss = useCallback(() => setShowDropdown(false), []);

  return {
    textareaRef,
    showDropdown,
    filteredItems,
    selectedIdx,
    atCharIdx,
    handleChange,
    handleKeyDown,
    handleSelect,
    setSelectedIdx,
    dismiss,
  };
}
