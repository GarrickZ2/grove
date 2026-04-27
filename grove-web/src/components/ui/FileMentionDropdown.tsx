import { useEffect, useRef, useState, useCallback, memo, createElement } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText,
  Folder,
  BookOpen,
  Brain,
  Pencil,
  FileJson,
  FileCode,
  Image as ImageIcon,
  Music,
  Video,
  FileArchive,
  File,
  Link as LinkIcon,
  Bot,
} from "lucide-react";
import type { FilteredMentionItem, MentionItem } from "../../utils/fileMention";
import { agentOptions } from "./AgentPicker";

/**
 * Pick an icon for a mention item. Category-intrinsic concepts (Instruction,
 * Memory, Sketch) get a dedicated icon; otherwise we fall back to the file
 * extension so `.md`, `.json`, `.png`, audio, video etc. are visually distinct.
 */
function iconFor(
  item: Pick<MentionItem, "category" | "path" | "isDir" | "kind" | "agentName">,
) {
  // Agent-graph kinds: render the underlying agent's brand icon when known.
  if (item.kind && item.kind !== "file") {
    const agent = item.agentName
      ? agentOptions.find((o) => o.value === item.agentName || o.id === item.agentName)
      : undefined;
    if (agent?.icon) return agent.icon;
    return Bot;
  }
  if (item.path.toLowerCase().endsWith(".link.json")) return LinkIcon;
  switch (item.category) {
    case "Instruction":
      return BookOpen;
    case "Memory":
      return Brain;
    case "Sketch":
      return Pencil;
  }
  if (item.isDir) return Folder;
  const dot = item.path.lastIndexOf(".");
  const ext = dot >= 0 ? item.path.slice(dot + 1).toLowerCase() : "";
  if (["md", "txt", "rst", "adoc"].includes(ext)) return FileText;
  if (["json", "yaml", "yml", "toml", "ini"].includes(ext)) return FileJson;
  if (
    [
      "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "kt", "c", "cc",
      "cpp", "h", "hpp", "cs", "rb", "php", "swift", "sh", "bash", "zsh",
      "ps1", "lua", "sql", "html", "css", "scss", "vue", "svelte",
    ].includes(ext)
  )
    return FileCode;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"].includes(ext))
    return ImageIcon;
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return Music;
  if (["mp4", "mov", "webm", "avi", "mkv", "m4v"].includes(ext)) return Video;
  if (["zip", "tar", "gz", "bz2", "7z", "rar", "xz"].includes(ext)) return FileArchive;
  return File;
}
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
  onSelect: (path: string, isDir?: boolean, displayName?: string, category?: string) => void;
  onMouseEnter: (idx: number) => void;
  visible: boolean;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  /** Textarea ref — dropdown renders near cursor position via portal */
  anchorRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Character index of the @ symbol in the textarea (for cursor positioning) */
  cursorIdx?: number;
}

interface MentionRowProps {
  item: FilteredMentionItem;
  index: number;
  isSelected: boolean;
  onSelect: FileMentionDropdownProps["onSelect"];
  onMouseEnter: FileMentionDropdownProps["onMouseEnter"];
}

const MentionRow = memo(function MentionRow({
  item,
  index,
  isSelected,
  onSelect,
  onMouseEnter,
}: MentionRowProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (isSelected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isSelected]);

  const hasFriendlyName = item.displayName !== undefined;
  const label = item.displayName ?? item.path;
  return (
    <button
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(item.path, item.isDir, item.displayName, item.category)}
      onMouseEnter={() => onMouseEnter(index)}
      className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
        isSelected
          ? "bg-[var(--color-bg-tertiary)]"
          : "hover:bg-[var(--color-bg-secondary)]"
      }`}
    >
      {createElement(iconFor(item), {
        className:
          item.kind && item.kind !== "file"
            ? "w-3.5 h-3.5 shrink-0"
            : "w-3.5 h-3.5 text-[var(--color-warning)] shrink-0",
      })}
      {item.category && (
        <span className="shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          {item.category}
        </span>
      )}
      <span className="text-sm text-[var(--color-text)] font-mono truncate min-w-0 flex-1">
        {hasFriendlyName ? (
          <HighlightedPath path={label} indices={item.indices} />
        ) : item.indices.length > 0 ? (
          <SmartPath path={item.path} indices={item.indices} maxLen={55} />
        ) : (
          <SmartPath path={item.path} indices={[]} maxLen={55} />
        )}
      </span>
      {!item.category && item.isDir && (
        <span className="text-[10px] text-[var(--color-text-muted)] ml-auto shrink-0">dir</span>
      )}
    </button>
  );
});

function DropdownContent({
  items,
  selectedIdx,
  onSelect,
  onMouseEnter,
}: Pick<FileMentionDropdownProps, "items" | "selectedIdx" | "onSelect" | "onMouseEnter">) {
  return (
    <>
      {items.map((item, i) => (
        <MentionRow
          key={`${item.category ?? ""}-${item.path}`}
          item={item}
          index={i}
          isSelected={i === selectedIdx}
          onSelect={onSelect}
          onMouseEnter={onMouseEnter}
        />
      ))}
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
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({ position: "fixed", top: -9999, left: -9999 });

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
