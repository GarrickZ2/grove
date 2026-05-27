import { useEffect, useRef, useState, useCallback, memo, createElement } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText,
  Folder,
  BookOpen,
  Brain,
  FileJson,
  FileCode,
  Image as ImageIcon,
  Music,
  Video,
  FileArchive,
  File,
  Link as LinkIcon,
  MessageSquare,
  Bot,
  Briefcase,
  Globe,
  Palette,
} from "lucide-react";
import type { FilteredMentionItem, MentionItem } from "../../utils/fileMention";
import { agentIconComponent } from "../../utils/agentIcon";
import { VSCodeIcon } from "./VSCodeIcon";
import { getProjectStyle } from "../../utils/projectStyle";
import { useTheme } from "../../context";


/**
 * Pick an icon for a mention item. Category-intrinsic concepts (Instruction,
 * Memory, Sketch) get a dedicated icon; otherwise we fall back to the file
 * extension so `.md`, `.json`, `.png`, audio, video etc. are visually distinct.
 */
function iconFor(
  item: Pick<MentionItem, "category" | "path" | "isDir" | "kind" | "agentName">,
) {
  if (item.category === "category_selector") {
    if (item.path === "conversation") return MessageSquare;
    if (item.path === "file") return Folder;
    if (item.path === "agent") return Bot;
    if (item.path === "project") return Briefcase;
    if (item.path === "browsertabs") return Globe;
    if (item.path === "sketch") return Palette;
  }
  // Agent-graph kinds: render the underlying agent's brand icon when known.
  // `agentIconComponent` already falls back to lucide Bot for unknown keys,
  // so this branch is total.
  if (item.kind && item.kind !== "file") {
    if (item.kind === "browsertabs") return Globe;
    return agentIconComponent(item.agentName);
  }
  if (item.path.toLowerCase().endsWith(".link.json")) return LinkIcon;
  switch (item.category) {
    case "Instruction":
      return BookOpen;
    case "Memory":
      return Brain;
    case "Sketch":
      return Palette;
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

function styleForCategorySelector(path: string): { bg: string; fg: string } {
  switch (path) {
    case "conversation":
      return { bg: "rgba(139, 92, 246, 0.15)", fg: "rgb(167, 139, 250)" }; // Purple
    case "file":
      return { bg: "rgba(59, 130, 246, 0.15)", fg: "rgb(96, 165, 250)" }; // Blue
    case "agent":
      return { bg: "rgba(245, 158, 11, 0.15)", fg: "rgb(251, 191, 36)" }; // Gold
    case "project":
      return { bg: "rgba(16, 185, 129, 0.15)", fg: "rgb(52, 211, 153)" }; // Emerald
    case "browsertabs":
      return { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(129, 140, 248)" }; // Indigo
    case "sketch":
      return { bg: "rgba(236, 72, 153, 0.15)", fg: "rgb(244, 114, 182)" }; // Rose/Pink
    default:
      return { bg: "rgba(107, 114, 128, 0.15)", fg: "rgb(156, 163, 175)" }; // Gray
  }
}

function styleForSpecialCategory(category: string): { bg: string; fg: string } | null {
  switch (category) {
    case "Instruction":
      return { bg: "rgba(6, 182, 212, 0.15)", fg: "rgb(34, 211, 238)" }; // Cyan
    case "Memory":
      return { bg: "rgba(168, 85, 247, 0.15)", fg: "rgb(192, 132, 252)" }; // Purple
    case "Sketch":
      return { bg: "rgba(236, 72, 153, 0.15)", fg: "rgb(244, 114, 182)" }; // Rose/Pink
    default:
      return null;
  }
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

  const { theme } = useTheme();
  const isProjectItem = item.category === "Coding Project" || item.category === "Studio Project" || item.category === "Project Root";
  const projectStyle = isProjectItem ? getProjectStyle(item.sessionId || item.path, theme.accentPalette) : null;
  const categoryStyle = item.category === "category_selector" ? styleForCategorySelector(item.path) : null;
  const specialStyle = item.category && item.category !== "category_selector" ? styleForSpecialCategory(item.category) : null;

  let resolvedFavicon: string | null = null;
  // Only allow https favicons — Studio `.link.json` files are agent-authored
  // and can carry arbitrary URLs, so reject http://, javascript:, data:, etc.
  // See `MentionItem.favIconUrl` in utils/fileMention.ts for the trust note.
  if (item.favIconUrl && item.favIconUrl.startsWith("https://")) {
    resolvedFavicon = item.favIconUrl;
  } else if (item.kind === "browsertabs" && item.category !== "category_selector") {
    try {
      const domain = new URL(item.path).hostname;
      resolvedFavicon = `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
    } catch {
      // Bad URL — leave favicon blank, the kind/category fallback icons
      // below will render instead.
      resolvedFavicon = "";
    }
  }

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
      {projectStyle ? (
        <div
          className="w-5 h-5 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: projectStyle.color.bg }}
        >
          <projectStyle.Icon className="w-3 h-3" style={{ color: projectStyle.color.fg }} />
        </div>
      ) : categoryStyle ? (
        <div
          className="w-5 h-5 rounded flex items-center justify-center shrink-0 transition-transform hover:scale-110"
          style={{ backgroundColor: categoryStyle.bg, color: categoryStyle.fg }}
        >
          {createElement(iconFor(item), {
            className: "w-3 h-3 shrink-0",
          })}
        </div>
      ) : specialStyle ? (
        <div
          className="w-5 h-5 rounded flex items-center justify-center shrink-0 transition-transform hover:scale-110"
          style={{ backgroundColor: specialStyle.bg, color: specialStyle.fg }}
        >
          {createElement(iconFor(item), {
            className: "w-3 h-3 shrink-0",
          })}
        </div>
      ) : resolvedFavicon ? (
        <img
          src={resolvedFavicon}
          alt=""
          className="w-3.5 h-3.5 object-contain shrink-0 rounded-sm"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      ) : item.kind && item.kind !== "file" ? (
        createElement(iconFor(item), {
          className: "w-3.5 h-3.5 shrink-0",
        })
      ) : (
        <VSCodeIcon
          filename={item.path.split("/").pop() || item.path}
          isFolder={item.isDir}
          size={14}
          className="shrink-0"
        />
      )}
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
    // updatePosition reads anchor DOM rect and setPortalStyle; we must compute
    // it here because the listener-driven updates only fire on scroll/resize.
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
