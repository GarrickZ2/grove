import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { FileMentionDropdown } from "../../../ui/FileMentionDropdown";
import { useTheme } from "../../../../context";
import { nextMentionIndex } from "../../../../utils/fileMention";
import { useProjectMentions } from "../useProjectMentions";
import { createMentionChip, filterComposerMentions, getPromptFromEditable, isComposerChip, mentionCategorySelectors, mentionStartIndex, parseMentionQuery } from "../composerMentions";
import type { MentionSources } from "./useMentionSources";

export interface MentionEditableHandle {
  element: HTMLDivElement | null;
  focus: () => void;
  /** Replace the content with plain text and put the caret at its end. */
  setText: (text: string) => void;
  clear: () => void;
}

interface MentionEditableProps {
  sources: MentionSources;
  /** Draft markup to start from (chips included). */
  initialHtml?: string;
  placeholder?: string;
  className?: string;
  /** The prompt as it will be sent (chips serialized) plus the markup, on every edit. */
  onChange: (value: { text: string; html: string }) => void;
  /** Enter without Shift while no picker row is active. */
  onSubmit: () => void;
  onPasteFiles?: (files: File[]) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

type MenuState = { category: string | null; filter: string };

/**
 * The chat composer's @-mention input — the same chips, picker and prompt
 * serialization as TaskChat — for composers that only need text + mentions
 * (Orbit's New page). TaskChat keeps its own editor for slash commands,
 * queue edits and drafts.
 */
export const MentionEditable = forwardRef<MentionEditableHandle, MentionEditableProps>(function MentionEditable(
  { sources, initialHtml, placeholder, className, onChange, onSubmit, onPasteFiles, onFocus, onBlur },
  ref,
) {
  const { theme } = useTheme();
  const elRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [empty, setEmpty] = useState(!initialHtml);
  const deferredFilter = useDeferredValue(menu?.filter ?? "");
  const { refresh, loadBrowserTabs } = sources;
  const projectMentions = useProjectMentions(menu?.category === "project", menu?.filter ?? "");

  const selectors = useMemo(
    () => mentionCategorySelectors({ studio: sources.studio, browserTabs: sources.browserTabsAvailable }),
    [sources.studio, sources.browserTabsAvailable],
  );
  const items = useMemo(() => menu ? filterComposerMentions({
    items: sources.items,
    browserTabs: sources.browserTabs,
    selectors,
    activeCategory: menu.category,
    filter: menu.filter,
    deferredFilter,
    projects: projectMentions.projects,
    projectContents: projectMentions.contents,
    projectsLoading: projectMentions.projectsLoading,
    projectsError: projectMentions.projectsError,
  }) : [], [menu, sources.items, sources.browserTabs, selectors, deferredFilter, projectMentions]);

  useEffect(() => {
    if (menu?.category === "browsertabs") loadBrowserTabs();
  }, [menu?.category, loadBrowserTabs]);

  // Restore the draft once; later edits belong to the DOM.
  useEffect(() => {
    if (elRef.current && initialHtml) elRef.current.innerHTML = initialHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const text = getPromptFromEditable(el);
    const hasChip = !!el.querySelector("[data-file],[data-mention-kind],[data-command]");
    setEmpty(!text && !hasChip);
    // A browser leaves a lone <br> behind once everything is deleted.
    if (!text && !hasChip && el.innerHTML) el.innerHTML = "";
    onChange({ text, html: el.innerHTML });
  }, [onChange]);

  const caretToEnd = () => {
    const el = elRef.current;
    if (!el) return;
    el.focus();
    const selection = window.getSelection();
    selection?.selectAllChildren(el);
    selection?.collapseToEnd();
  };

  useImperativeHandle(ref, () => ({
    get element() { return elRef.current; },
    focus: caretToEnd,
    setText: (text: string) => {
      if (!elRef.current) return;
      elRef.current.textContent = text;
      caretToEnd();
      emit();
    },
    clear: () => {
      if (!elRef.current) return;
      elRef.current.innerHTML = "";
      setMenu(null);
      emit();
    },
  }), [emit]);

  /** The text node holding the caret, with the caret offset in it. */
  const caretText = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !elRef.current?.contains(node)) return null;
    return { selection, node, offset: range.startOffset, text: node.textContent || "" };
  };

  const updateMenu = () => {
    const caret = caretText();
    const query = caret ? parseMentionQuery(caret.text, caret.offset, sources.studio) : null;
    if (!query) {
      setMenu(null);
      return;
    }
    if (!menu) refresh();
    setMenu({ category: query.category, filter: query.filter });
    setSelectedIdx(0);
  };

  /** Replace the `@query` at the caret with `replacement`, caret after it. */
  const replaceQuery = (replacement: Node | string) => {
    const caret = caretText();
    if (!caret) return false;
    const atIdx = mentionStartIndex(caret.text, caret.offset, sources.studio);
    const parent = caret.node.parentNode;
    if (atIdx < 0 || !parent) return false;
    const before = caret.text.slice(0, atIdx);
    const after = caret.text.slice(caret.offset);
    const range = document.createRange();
    if (typeof replacement === "string") {
      const node = document.createTextNode(before + replacement + after);
      parent.replaceChild(node, caret.node);
      range.setStart(node, before.length + replacement.length);
    } else {
      const fragment = document.createDocumentFragment();
      if (before) fragment.appendChild(document.createTextNode(before));
      fragment.appendChild(replacement);
      const afterNode = document.createTextNode(after || " ");
      fragment.appendChild(afterNode);
      parent.replaceChild(fragment, caret.node);
      range.setStart(afterNode, after ? 0 : 1);
    }
    range.collapse(true);
    caret.selection.removeAllRanges();
    caret.selection.addRange(range);
    return true;
  };

  const select = (path: string, isDir?: boolean, displayLabel?: string, category?: string) => {
    const matched = items.find((item) => item.path === path && (item.category ?? "") === (category ?? ""));
    if (matched?.disabled) return;
    // Category rows and projects narrow the picker instead of inserting a chip.
    if (category === "category_selector" || category === "Coding Project" || category === "Studio Project") {
      const next = category === "category_selector" ? { category: path, filter: "" } : { category: "project", filter: `${path}/` };
      if (replaceQuery(`@${next.category}:${next.filter}`)) {
        setMenu(next);
        setSelectedIdx(0);
      }
      return;
    }
    if (replaceQuery(createMentionChip(matched, path, isDir, displayLabel, category, theme.accentPalette))) {
      setMenu(null);
      emit();
    }
  };

  /** Tab on a folder or file completes the query rather than inserting a chip. */
  const autocomplete = (path: string, isDir: boolean) => {
    const caret = caretText();
    if (!caret || !menu) return;
    const prefix = menu.category ? `@${menu.category}:` : "@";
    const completed = path + (isDir ? "/" : "");
    if (replaceQuery(prefix + completed)) {
      setMenu({ ...menu, filter: completed });
      setSelectedIdx(0);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menu && items.length > 0) {
      const item = items[selectedIdx];
      const consume = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "ArrowDown") { consume(); setSelectedIdx((index) => nextMentionIndex(items, index, 1)); return; }
      if (event.key === "ArrowUp") { consume(); setSelectedIdx((index) => nextMentionIndex(items, index, -1)); return; }
      if (event.key === "Escape") { consume(); setMenu(null); return; }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        consume();
        if (!item || item.disabled) return;
        const narrows = item.category === "category_selector" || item.category === "Coding Project" || item.category === "Studio Project" || item.category === "Task";
        if (event.key === "Tab" && !narrows) autocomplete(item.path, item.isDir);
        else select(item.path, item.isDir, item.displayName, item.category);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
      return;
    }
    // Backspace right after a chip removes the whole chip.
    if (event.key === "Backspace" && !event.metaKey && !event.altKey) {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      if (!selection?.isCollapsed || !anchor) return;
      const offset = selection.anchorOffset;
      let chip: Node | null = null;
      if (anchor.nodeType === Node.TEXT_NODE && offset === 0) chip = anchor.previousSibling;
      else if (anchor.nodeType === Node.ELEMENT_NODE && offset > 0) chip = anchor.childNodes[offset - 1];
      else if (anchor.nodeType === Node.TEXT_NODE && !(anchor.textContent ?? "").slice(0, offset).trim()) chip = anchor.previousSibling;
      if (isComposerChip(chip)) {
        event.preventDefault();
        chip.remove();
        emit();
      }
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      onPasteFiles?.(files);
      return;
    }
    // Plain text only: pasted markup would bypass the chip serialization.
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  };

  return (
    <div className="relative">
      <div
        ref={elRef}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-empty={empty || undefined}
        className={className}
        onInput={() => { emit(); updateMenu(); }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") updateMenu(); }}
        onPaste={handlePaste}
        onFocus={onFocus}
        onBlur={() => { setMenu(null); onBlur?.(); }}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest("[data-chip-close]")) return;
          event.preventDefault();
          target.closest("[data-command],[data-file],[data-mention-kind]")?.remove();
          emit();
        }}
      />
      <FileMentionDropdown
        items={items}
        selectedIdx={selectedIdx}
        onSelect={select}
        onMouseEnter={setSelectedIdx}
        visible={!!menu && items.length > 0}
        menuRef={menuRef}
        className="absolute bottom-full left-0 right-0 z-50 mb-3"
      />
    </div>
  );
});
