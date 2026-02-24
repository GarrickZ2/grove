import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, Folder } from "lucide-react";
import type { FilteredMentionItem } from "../../utils/fileMention";
import { compactPath } from "../../utils/pathUtils";

/** Render a file path with fuzzy-matched characters highlighted */
function HighlightedPath({ path, indices }: { path: string; indices: number[] }) {
  const indexSet = new Set(indices);
  return (
    <span>
      {Array.from(path).map((char, i) =>
        indexSet.has(i) ? (
          <span key={i} className="text-[var(--color-warning)] font-semibold">{char}</span>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </span>
  );
}

/**
 * Display a file path with smart compression for long paths.
 * Shows: compressed_parent_dir / highlighted_filename
 * The parent dir is shown in muted color, filename has fuzzy highlighting.
 */
function SmartPath({ path, indices, maxLen = 50 }: { path: string; indices: number[]; maxLen?: number }) {
  if (path.length <= maxLen || !path.includes("/")) {
    return <HighlightedPath path={path} indices={indices} />;
  }

  const lastSlash = path.lastIndexOf("/");
  const parentDir = path.substring(0, lastSlash);
  const fileName = path.substring(lastSlash + 1);

  // Budget: reserve space for filename + " / " separator
  const separatorLen = 3; // " / "
  const parentBudget = maxLen - fileName.length - separatorLen;

  let displayParent: string;
  if (parentBudget <= 3) {
    // No room for parent — just abbreviate to first chars
    displayParent = parentDir.split("/").map(d => d.charAt(0)).join("/");
  } else {
    displayParent = compactPath(parentDir, parentBudget);
  }

  // Map original indices to filename portion (offset by lastSlash + 1)
  const fileStartIdx = lastSlash + 1;
  const fileIndices = indices
    .filter(idx => idx >= fileStartIdx)
    .map(idx => idx - fileStartIdx);

  return (
    <span className="flex items-baseline gap-0 min-w-0">
      <span className="text-[var(--color-text-muted)] shrink truncate" title={parentDir}>
        {displayParent}/
      </span>
      <span className="shrink-0">
        <HighlightedPath path={fileName} indices={fileIndices} />
      </span>
    </span>
  );
}

/**
 * Get the pixel coordinates of a character at `charIdx` inside a <textarea>.
 * Uses a hidden mirror div that replicates the textarea's styling.
 */
function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  charIdx: number,
): { top: number; left: number; lineHeight: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");

  // Copy all relevant styles from textarea to mirror
  const props = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "textTransform", "wordSpacing", "lineHeight", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
    "borderBottomWidth", "borderLeftWidth", "boxSizing", "whiteSpace",
    "wordWrap", "overflowWrap", "tabSize",
  ] as const;
  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";
  mirror.style.width = style.width;
  for (const prop of props) {
    mirror.style.setProperty(prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), style[prop]);
  }
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";

  document.body.appendChild(mirror);

  const text = textarea.value.substring(0, charIdx);
  mirror.textContent = text;

  // Add a marker span at the caret position
  const marker = document.createElement("span");
  marker.textContent = "\u200b"; // zero-width space
  mirror.appendChild(marker);

  const markerTop = marker.offsetTop - textarea.scrollTop;
  const markerLeft = marker.offsetLeft;
  const lineHeight = parseInt(style.lineHeight) || parseInt(style.fontSize) * 1.5;

  document.body.removeChild(mirror);

  return { top: markerTop, left: markerLeft, lineHeight };
}

interface FileMentionDropdownProps {
  items: FilteredMentionItem[];
  selectedIdx: number;
  onSelect: (path: string, isDir?: boolean) => void;
  onMouseEnter: (idx: number) => void;
  visible: boolean;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  /** Textarea ref — dropdown renders near cursor position via portal */
  anchorRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Character index of the @ symbol in the textarea (for cursor positioning) */
  cursorIdx?: number;
}

function DropdownContent({
  items,
  selectedIdx,
  onSelect,
  onMouseEnter,
}: Pick<FileMentionDropdownProps, "items" | "selectedIdx" | "onSelect" | "onMouseEnter">) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    itemRefs.current[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  return (
    <>
      {items.map((item, i) => {
        const Icon = item.isDir ? Folder : FileText;
        return (
          <button
            key={item.path}
            ref={(el) => { itemRefs.current[i] = el; }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(item.path, item.isDir)}
            onMouseEnter={() => onMouseEnter(i)}
            className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
              i === selectedIdx
                ? "bg-[var(--color-bg-tertiary)]"
                : "hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            <Icon className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0" />
            <span className="text-sm text-[var(--color-text)] font-mono truncate min-w-0 flex-1">
              {item.indices.length > 0 ? (
                <SmartPath path={item.path} indices={item.indices} maxLen={55} />
              ) : (
                <SmartPath path={item.path} indices={[]} maxLen={55} />
              )}
            </span>
            {item.isDir && (
              <span className="text-[10px] text-[var(--color-text-muted)] ml-auto shrink-0">dir</span>
            )}
          </button>
        );
      })}
    </>
  );
}

export function FileMentionDropdown({
  items,
  selectedIdx,
  onSelect,
  onMouseEnter,
  visible,
  menuRef,
  className = "absolute bottom-full left-3 right-3 mb-1",
  anchorRef,
  cursorIdx,
}: FileMentionDropdownProps) {
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!anchorRef?.current || cursorIdx == null) return;
    const textarea = anchorRef.current;
    const rect = textarea.getBoundingClientRect();
    const caret = getCaretCoordinates(textarea, cursorIdx);

    const dropdownWidth = 480;
    const dropdownMaxHeight = 224; // max-h-56 = 14rem = 224px
    const gap = 4;

    // Position below the @ line by default
    const caretScreenTop = rect.top + caret.top;
    const caretScreenLeft = rect.left + caret.left;
    const spaceBelow = window.innerHeight - (caretScreenTop + caret.lineHeight + gap);

    let top: number;
    if (spaceBelow >= dropdownMaxHeight) {
      // Show below
      top = caretScreenTop + caret.lineHeight + gap;
    } else {
      // Show above
      top = caretScreenTop - dropdownMaxHeight - gap;
      if (top < 0) top = gap;
    }

    let left = caretScreenLeft;
    // Clamp to viewport
    if (left + dropdownWidth > window.innerWidth - 8) {
      left = window.innerWidth - dropdownWidth - 8;
    }
    if (left < 8) left = 8;

    setPortalStyle({
      position: "fixed",
      top,
      left,
      width: dropdownWidth,
      zIndex: 9999,
    });
  }, [anchorRef, cursorIdx]);

  useEffect(() => {
    if (!visible || !anchorRef) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [visible, anchorRef, updatePosition]);

  // Portal mode (when anchorRef is provided)
  if (anchorRef) {
    return createPortal(
      <AnimatePresence>
        {visible && items.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            style={portalStyle}
            className="max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
          >
            <DropdownContent items={items} selectedIdx={selectedIdx} onSelect={onSelect} onMouseEnter={onMouseEnter} />
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    );
  }

  // Inline mode (default, used by Chat)
  return (
    <AnimatePresence>
      {visible && items.length > 0 && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className={`${className} max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg z-50`}
        >
          <DropdownContent items={items} selectedIdx={selectedIdx} onSelect={onSelect} onMouseEnter={onMouseEnter} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
