import { useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { ArrowUpRight, ChevronDown, Circle, Download, Frame, Hand, Maximize, MessageSquare, Minus, MousePointer2, Pencil, Play, Plus, Redo2, SlidersHorizontal, Square, StickyNote, Type, Undo2, X } from "lucide-react";
import { designFilesBase, getDesignPage, isChangedSince, updateDesignPage, updateDesignStyle, type Design, type DesignMark, type DesignComment, type DesignPage, type LabelChange, type PageChange } from "../../../api/designs";
import { usePopover } from "../../../orbit/ui";
import { MarkdownRenderer } from "../../ui/MarkdownRenderer";
import { DesignFrame, type AnchorBoxes, type DesignFrameHandle, type DesignVariable, type FrameWheel, type PickedElement, type TreeNode } from "./DesignFrame";
import { DesignMarks } from "./DesignMarks";
import { DesignCommentList, DesignInspector } from "./DesignInspector";
import { applyEdits, checkOf, setCssVariable, setPageVariable, type DesignEdit } from "./designEdit";
import { DesignSelectBar } from "./DesignSelectBar";
import { Avatar } from "./DesignThread";
import {
  GUIDE_WIDTH, LABEL_SIZE, boardBounds, fitView, guidePosition, pageComments, pageHeight, pinPosition, zoomAt,
  type BoardView,
} from "./designModel";
import { usePageHtml, type LoadedPage } from "./useDesignData";

interface Props {
  projectId: string;
  taskId: string;
  token: string;
  design: Design;
  /** The design system's DESIGN.md, shown as a card on its board. */
  guide: string | null;
  comments: DesignComment[];
  /** A page the board opens on, as a `design://` link to it asks. */
  focusPage?: string | null;
  onMove: (changes: { pages?: PageChange[]; labels?: LabelChange[] }) => void;
  onOpenThread: (comment: DesignComment, at: { x: number; y: number }) => void;
  /** A link in a page that leads to another design. */
  onOpenDesign: (design: string) => void;
  /** Start a comment on an element; `at` is a viewport point beside it. */
  onComment: (file: string, element: PickedElement, at: { x: number; y: number }, done: () => void) => void;
  /** The agent is working on the files: pages can be looked at, not changed. */
  readOnly: boolean;
  /** A page's file was rewritten; the designs should be read again. */
  onSaved: () => void;
  onNotice: (message: string) => void;
  /** The user wrote, drew, moved or removed something on the board. */
  onMarks: (marks: DesignMark[]) => void;
  /** The user drew a frame: an empty page goes there. */
  onFrame: (frame: { x: number; y: number; width: number; height: number }) => void;
  /** Someone else's board, opened from a share link: it can be looked at and, where allowed, commented on. */
  viewer?: { canComment: boolean };
  /** Save a page as a file; absent where that is not offered. */
  onExportPage?: (file: string, format: "html" | "png") => void;
  /** The chat's agent, and whether a chat is open to send comments to. */
  agent?: string | null;
  canSend?: boolean;
  onSendComments?: (comments: DesignComment[]) => void;
}

/** Room left around a fitted board: the controls float over its top and bottom edges. */
const FIT_MARGIN = 64;

/** What the pointer does on the board. */
type DrawTool = "text" | "frame" | "note" | "pen" | "rect" | "ellipse" | "arrow";
type Tool = "select" | "hand" | "play" | DrawTool;

const TOOLS: Array<[Tool, typeof Hand, string] | null> = [
  ["select", MousePointer2, "Select: point at an element to change it or comment on it"],
  ["hand", Hand, "Hand: move around the board"],
  null,
  ["text", Type, "Text: click to write on the board"],
  ["frame", Frame, "Frame: drag out an empty page"],
  ["note", StickyNote, "Note: click to leave a sticky note"],
  ["pen", Pencil, "Pen: draw on the board"],
  ["rect", Square, "Rectangle"],
  ["ellipse", Circle, "Ellipse"],
  ["arrow", ArrowUpRight, "Arrow"],
];

function isDrawTool(tool: Tool): tool is DrawTool {
  return tool !== "select" && tool !== "hand" && tool !== "play";
}

/** The mark a drag has drawn so far, from where it began to where the pointer is. */
function drawn(tool: DrawTool, from: Point, to: Point, points: number[]): DesignMark {
  if (tool === "pen") {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let index = 0; index + 1 < points.length; index += 2) {
      left = Math.min(left, points[index]);
      right = Math.max(right, points[index]);
      top = Math.min(top, points[index + 1]);
      bottom = Math.max(bottom, points[index + 1]);
    }
    return {
      id: "draft", kind: "pen", x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top),
      points: points.map((value, index) => Math.round((value - (index % 2 === 0 ? left : top)) * 10) / 10),
    };
  }
  const x = Math.round(Math.min(from.x, to.x));
  const y = Math.round(Math.min(from.y, to.y));
  const box = { id: "draft", x, y, width: Math.round(Math.abs(to.x - from.x)), height: Math.round(Math.abs(to.y - from.y)) };
  if (tool === "arrow") return { ...box, kind: "arrow", points: [from.x - x, from.y - y, to.x - x, to.y - y].map(Math.round) };
  return { ...box, kind: tool === "ellipse" ? "ellipse" : "rect" };
}

const NO_MARKS: DesignMark[] = [];

/** Something done on the board that can be taken back: what was there before, and after. */
type Step =
  | { kind: "page"; file: string; before: string; after: string }
  | { kind: "style"; path: string; before: string; after: string }
  | { kind: "marks"; before: DesignMark[]; after: DesignMark[] };

const HISTORY_LIMIT = 60;

function newMarkId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const INSPECTOR_PREF = "grove:design-inspector";
/** How long edits wait for more before the file is written. */
const SAVE_DELAY_MS = 350;

function inspectorPref(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_PREF) !== "closed";
  } catch {
    return true;
  }
}

type Drag =
  | { kind: "pan"; startX: number; startY: number; view: BoardView }
  | { kind: "page"; file: string; startX: number; startY: number; x: number; y: number; at: Point | null }
  | { kind: "label"; index: number; startX: number; startY: number; x: number; y: number; at: Point | null }
  | { kind: "mark"; id: string; startX: number; startY: number; x: number; y: number; at: Point | null }
  /** `x`, `y` and `points` are board pixels. */
  | { kind: "draw"; tool: DrawTool; startX: number; startY: number; x: number; y: number; points: number[]; moved: boolean };

interface Point {
  x: number;
  y: number;
}

/** A dragged position, shown until design.json moves on from where the drag began. */
interface Override extends Point {
  fromX: number;
  fromY: number;
}

function withOverride<T extends Point>(item: T, override: Override | undefined): T {
  return override && override.fromX === item.x && override.fromY === item.y ? { ...item, x: override.x, y: override.y } : item;
}

/** Height of an artboard's title row, in screen pixels. */
const HEAD_HEIGHT = 30;
/** Board pixels a label normally keeps above the artboards under it. */
const LABEL_CLEARANCE = 44;
/** A press that travels less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** How many times a frame may grow to its content before it is left alone. */
const MAX_GROWS = 6;

/** Board pixels kept above an artboard the board moves to. */
const FOCUS_TOP = 72;

/** A scroll at a point of the board: pan, or zoom about that point. */
function wheelView(view: BoardView, deltaX: number, deltaY: number, zoom: boolean, x: number, y: number): BoardView {
  return zoom ? zoomAt(view, Math.exp(-deltaY * 0.01), x, y) : { ...view, x: view.x - deltaX, y: view.y - deltaY };
}

/**
 * The board: every page of a design as an artboard, where `design.json` puts
 * it. Scroll or drag the background to pan, pinch or ⌘-scroll to zoom, drag an
 * artboard by its title, or a label, to move it.
 *
 * The tool decides what the pointer does. Select chooses an element: the
 * inspector beside the board shows its layers and properties, and a bar by the
 * element holds the quick edits and comments. Hand only moves the board. Play
 * makes the pages work in place: controls respond, and a link to another page
 * moves the board there. The rest write and draw on the board itself (text,
 * notes, shapes, pen) or drag out a frame for a new page.
 */
export function DesignBoard({
  projectId, taskId, token, design, guide, comments, focusPage, onMove, onOpenThread, onOpenDesign, onComment,
  readOnly, onSaved, onNotice, onMarks, onFrame, viewer, onExportPage, agent, canSend, onSendComments,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Null until the user pans or zooms: the board then fits itself to the panel.
  const [userView, setUserView] = useState<BoardView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(viewer && !viewer.canComment ? "play" : "select");
  // The one page being used where it sits, whatever the tool: its PLAY button turns this on and off.
  const [playing, setPlaying] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ file: string; element: PickedElement } | null>(null);
  const [trees, setTrees] = useState<Record<string, TreeNode[]>>({});
  const [inspector, setInspector] = useState(inspectorPref);
  const [variables, setVariables] = useState<Record<string, DesignVariable[]>>({});
  const [draft, setDraft] = useState<DesignMark | null>(null);
  const [markChosen, setMarkChosen] = useState<string | null>(null);
  const [markEditing, setMarkEditing] = useState<string | null>(null);
  const [markAt, setMarkAt] = useState<{ id: string; x: number; y: number } | null>(null);
  const artboards = useRef(new Map<string, ArtboardHandle>());
  const tweaks = useRef(new Map<string, number>());
  const history = useRef<{ done: Step[]; undone: Step[] }>({ done: [], undone: [] });
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  const stored = design.marks ?? NO_MARKS;
  const marks = useMemo(
    () => stored.map((mark) => (markAt?.id === mark.id ? { ...mark, x: markAt.x, y: markAt.y } : mark)),
    [stored, markAt],
  );
  const [moved, setMoved] = useState<{ pages: Record<string, Override>; labels: Record<string, Override> }>({ pages: {}, labels: {} });
  const drag = useRef<Drag | null>(null);

  const placed = useMemo<Design>(() => ({
    ...design,
    pages: design.pages.map((page) => withOverride(page, moved.pages[page.file])),
    labels: design.labels.map((label, index) => withOverride(label, moved.labels[`${index}:${label.text}`])),
  }), [design, moved]);

  const guideAt = useMemo(() => (guide ? guidePosition(design) : null), [guide, design]);
  const fitted = useMemo(() => {
    const asked = focusPage ? design.pages.find((page) => page.file === focusPage) : null;
    if (asked) return fitView({ left: asked.x, top: asked.y - 60, right: asked.x + asked.width, bottom: asked.y + pageHeight(asked) }, size, FIT_MARGIN);
    const extra = guideAt ? [{ left: guideAt.x, top: guideAt.y, right: guideAt.x + GUIDE_WIDTH, bottom: guideAt.y + 900 }] : [];
    return fitView(boardBounds(design, extra), size, FIT_MARGIN);
  }, [design, guideAt, size, focusPage]);
  const view = userView ?? fitted;
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(root);
    // Wheel must be able to cancel the browser's own zoom and scroll.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      setUserView(wheelView(viewRef.current, event.deltaX, event.deltaY, event.ctrlKey || event.metaKey, event.clientX - rect.left, event.clientY - rect.top));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      root.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Artboard titles keep their size on screen, so zoomed out they reach
  // further up the board. Labels move up by the same amount to stay clear.
  const labelLift = Math.max(0, HEAD_HEIGHT / view.k - LABEL_CLEARANCE);

  /** A scroll over a page, which the frame hands back with the point in page pixels. */
  const wheelOver = (page: DesignPage, wheel: FrameWheel) => {
    const current = viewRef.current;
    setUserView(wheelView(
      current, wheel.deltaX, wheel.deltaY, wheel.zoom,
      current.x + (page.x + wheel.x) * current.k, current.y + (page.y + wheel.y) * current.k,
    ));
  };

  /** Bring a point of a page near the top of the panel; with `center`, the page to the middle. */
  const focus = (page: DesignPage, y: number, center: boolean) => {
    setSelected(page.file);
    setUserView({
      k: view.k,
      x: center ? size.width / 2 - (page.x + page.width / 2) * view.k : view.x,
      y: FOCUS_TOP - (page.y + y) * view.k,
    });
  };

  const follow = (slug: string, file: string) => {
    if (slug !== design.slug) return onOpenDesign(slug);
    const target = placed.pages.find((page) => page.file === file);
    if (!target) return;
    focus(target, 0, true);
    // Following a link out of a page being played carries on in the page it leads to.
    if (playing) setPlaying(file);
  };

  const clearPicked = () => {
    if (picked) artboards.current.get(picked.file)?.clearSelection();
    setPicked(null);
  };

  const pick = (file: string, element: PickedElement | null) => {
    if (picked && picked.file !== file) artboards.current.get(picked.file)?.clearSelection();
    setPicked(element ? { file, element } : null);
    if (element) setSelected(file);
  };

  const switchTool = (next: Tool) => {
    if (next !== "select") clearPicked();
    setTool(next);
  };

  // Someone looking at a shared board has the comments beside it, and nothing else.
  const [viewerComments, setViewerComments] = useState(false);
  const showInspector = (open: boolean) => {
    setInspector(open);
    try {
      localStorage.setItem(INSPECTOR_PREF, open ? "open" : "closed");
    } catch { /* the choice lasts for this visit */ }
  };

  /** Change the chosen element, in the page and in its file. */
  const edit = (change: DesignEdit) => {
    if (!picked || readOnly) return;
    artboards.current.get(picked.file)?.edit({ ...change, check: checkOf(picked.element) });
  };
  const chosenPath = picked?.element.xpath ?? "";

  /** Where the pointer is on the board, in board pixels. */
  const toBoard = (event: { clientX: number; clientY: number }): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: (event.clientX - (rect?.left ?? 0) - view.x) / view.k, y: (event.clientY - (rect?.top ?? 0) - view.y) / view.k };
  };

  const record = (step: Step) => {
    const log = history.current;
    log.done = [...log.done, step].slice(-HISTORY_LIMIT);
    log.undone = [];
    setDepth({ undo: log.done.length, redo: 0 });
  };

  /** A step that could not be put back: the file is no longer what the step left, so it leaves the history. */
  const failed = (step: Step, error: unknown) => {
    const log = history.current;
    log.done = log.done.filter((entry) => entry !== step);
    log.undone = log.undone.filter((entry) => entry !== step);
    setDepth({ undo: log.done.length, redo: log.undone.length });
    onNotice(isChangedSince(error) ? "The file was changed after that, so it can't be undone" : "Couldn't undo that");
  };

  /** Put one step's earlier or later state back, wherever it lives, when the file is still as the step left it. */
  const restore = (step: Step, to: "before" | "after") => {
    const from = to === "before" ? "after" : "before";
    if (step.kind === "marks") {
      onMarks(step[to]);
    } else if (step.kind === "page") {
      artboards.current.get(step.file)?.restore(step[to], step[from], (error) => failed(step, error));
    } else {
      updateDesignStyle(projectId, taskId, step.path, step[to], step[from]).then(onSaved, (error) => failed(step, error));
    }
  };

  const undo = (redo = false) => {
    if (readOnly) return;
    const log = history.current;
    const step = redo ? log.undone[log.undone.length - 1] : log.done[log.done.length - 1];
    if (!step) return;
    if (redo) {
      log.undone = log.undone.slice(0, -1);
      log.done = [...log.done, step];
    } else {
      log.done = log.done.slice(0, -1);
      log.undone = [...log.undone, step];
    }
    setDepth({ undo: log.done.length, redo: log.undone.length });
    clearPicked();
    setMarkChosen(null);
    restore(step, redo ? "after" : "before");
  };

  const commitMarks = (next: DesignMark[]) => {
    record({ kind: "marks", before: stored, after: next });
    onMarks(next);
  };

  const removeMark = (id: string) => {
    setMarkChosen(null);
    setMarkEditing(null);
    commitMarks(stored.filter((mark) => mark.id !== id));
  };

  /** Show a CSS variable at a new value everywhere, then write it where it is defined. */
  const tweak = (page: string, variable: DesignVariable, value: string) => {
    if (readOnly) return;
    artboards.current.forEach((artboard) => artboard.setVariable(variable.name, value));
    window.clearTimeout(tweaks.current.get(variable.name));
    tweaks.current.set(variable.name, window.setTimeout(async () => {
      try {
        if (variable.file) {
          const root = designFilesBase(token, projectId, taskId, design.slug).replace(/[^/]+\/$/, "");
          const css = await (await fetch(new URL(variable.file, root).href)).text();
          const next = setCssVariable(css, variable.name, value);
          if (next === null) throw new Error("not defined there");
          await updateDesignStyle(projectId, taskId, variable.file, next, css);
          record({ kind: "style", path: variable.file, before: css, after: next });
        } else {
          const html = await getDesignPage(projectId, taskId, design.slug, page);
          const next = setPageVariable(html, variable.index, variable.name, value);
          if (next === null) throw new Error("not defined there");
          await updateDesignPage(projectId, taskId, design.slug, page, next, html);
          record({ kind: "page", file: page, before: html, after: next });
        }
        onSaved();
      } catch {
        onNotice(`Couldn't save ${variable.name}`);
      }
    }, SAVE_DELAY_MS));
  };

  const zoomBy = (factor: number) => setUserView(zoomAt(view, factor, size.width / 2, size.height / 2));

  const begin = (event: ReactPointerEvent, next: Drag) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    rootRef.current?.focus({ preventScroll: true });
    drag.current = next;
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.kind === "pan") {
      setUserView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
      return;
    }
    if (current.kind === "draw") {
      if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.moved = true;
      if (current.tool === "note" || current.tool === "text") return;
      const to = toBoard(event);
      if (current.tool === "pen") current.points.push(to.x, to.y);
      setDraft(drawn(current.tool, current, to, current.points));
      return;
    }
    if (viewer || (!current.at && Math.hypot(dx, dy) < DRAG_THRESHOLD)) return;
    const at = { x: Math.round(current.x + dx / view.k), y: Math.round(current.y + dy / view.k) };
    current.at = at;
    if (current.kind === "mark") {
      setMarkAt({ id: current.id, ...at });
      return;
    }
    const override = { ...at, fromX: current.x, fromY: current.y };
    setMoved((previous) => current.kind === "page"
      ? { ...previous, pages: { ...previous.pages, [current.file]: override } }
      : { ...previous, labels: { ...previous.labels, [`${current.index}:${design.labels[current.index]?.text}`]: override } });
  };

  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (!current || current.kind === "pan") return;
    if (current.kind === "draw") {
      const shape = draft;
      setDraft(null);
      const id = newMarkId();
      const at = { x: Math.round(current.x), y: Math.round(current.y) };
      if (current.tool === "note" || current.tool === "text") {
        commitMarks([...stored, current.tool === "note" ? { id, kind: "note", ...at, width: 200, height: 120, text: "" } : { id, kind: "text", ...at, width: 0, height: 0, text: "" }]);
        setMarkChosen(id);
        setMarkEditing(id);
        setTool("select");
      } else if (current.tool === "frame") {
        onFrame(shape && shape.width > 40 && shape.height > 40 ? { x: shape.x, y: shape.y, width: shape.width, height: shape.height } : { ...at, width: 1280, height: 800 });
        setTool("select");
      } else if (shape && (shape.width > 6 || shape.height > 6)) {
        commitMarks([...stored, { ...shape, id }]);
        if (current.tool !== "pen") setTool("select");
      }
      return;
    }
    if (current.kind === "mark") {
      setMarkAt(null);
      if (current.at) commitMarks(stored.map((mark) => (mark.id === current.id ? { ...mark, ...current.at } : mark)));
      else setMarkChosen(current.id);
      return;
    }
    if (current.kind === "page") {
      if (current.at) onMove({ pages: [{ file: current.file, ...current.at }] });
      else setSelected(current.file);
    } else if (current.at) {
      const label = design.labels[current.index];
      if (label) onMove({ labels: [{ index: current.index, text: label.text, ...current.at }] });
    }
  };

  return (
    <div className="design-board-wrap">
    <div
      ref={rootRef}
      className={`design-board is-${isDrawTool(tool) ? "draw" : tool}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (markEditing) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          undo(event.shiftKey);
          return;
        }
        if ((event.key === "Delete" || event.key === "Backspace") && markChosen) removeMark(markChosen);
        if (event.key === "Escape") {
          setMarkChosen(null);
          if (isDrawTool(tool)) setTool("select");
        }
      }}
      onPointerDownCapture={(event) => {
        if (!isDrawTool(tool) || event.button !== 0 || (event.target as HTMLElement).closest(".design-tools, .design-zoom")) return;
        event.stopPropagation();
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = toBoard(event);
        drag.current = { kind: "draw", tool, startX: event.clientX, startY: event.clientY, x: at.x, y: at.y, points: [at.x, at.y], moved: false };
      }}
      onPointerDown={(event) => {
        setSelected(null);
        setMarkChosen(null);
        begin(event, { kind: "pan", startX: event.clientX, startY: event.clientY, view });
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="design-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {placed.labels.map((label, index) => (
          <div
            key={`${index}:${label.text}`}
            className={`design-label is-${label.size}`}
            style={{ left: label.x, top: label.y, fontSize: LABEL_SIZE[label.size], transform: `translateY(${-labelLift}px)` }}
            onPointerDown={(event) => begin(event, { kind: "label", index, startX: event.clientX, startY: event.clientY, x: label.x, y: label.y, at: null })}
          >
            {label.text}
          </div>
        ))}
        {placed.pages.map((page) => (
          <Artboard
            key={page.file}
            projectId={projectId}
            taskId={taskId}
            filesBase={designFilesBase(token, projectId, taskId, design.slug)}
            design={design.slug}
            page={page}
            zoom={view.k}
            selected={selected === page.file}
            ref={(handle) => {
              if (handle) artboards.current.set(page.file, handle);
              else artboards.current.delete(page.file);
            }}
            tool={tool}
            readOnly={readOnly}
            selection={picked?.file === page.file ? picked.element : null}
            onSelected={(element) => pick(page.file, element)}
            onClearSelection={clearPicked}
            onEscape={clearPicked}
            onTree={(tree) => setTrees((previous) => ({ ...previous, [page.file]: tree }))}
            onVariables={(list) => setVariables((previous) => ({ ...previous, [page.file]: list }))}
            onMoved={(move) => edit({ type: "move", path: move.path, target: move.target, place: move.place })}
            onStyle={(props) => edit({ type: "style", path: chosenPath, props })}
            onDuplicate={() => edit({ type: "duplicate", path: chosenPath })}
            onRemove={() => edit({ type: "remove", path: chosenPath })}
            onSaved={onSaved}
            onNotice={onNotice}
            onWrote={(before, after) => record({ kind: "page", file: page.file, before, after })}
            onUndo={undo}
            onWheel={(wheel) => wheelOver(page, wheel)}
            onNavigate={follow}
            onScrollTo={(y) => focus(page, y, false)}
            onComment={(element, at) => onComment(page.file, element, at, () => {})}
            comments={pageComments(comments, design.slug, page.file)}
            onPointerDown={(event) => begin(event, { kind: "page", file: page.file, startX: event.clientX, startY: event.clientY, x: page.x, y: page.y, at: null })}
            playing={playing === page.file}
            onExport={onExportPage ? (format) => onExportPage(page.file, format) : undefined}
            onPlay={() => {
              if (picked?.file === page.file) clearPicked();
              setPlaying(playing === page.file ? null : page.file);
            }}
            onOpenThread={onOpenThread}
          />
        ))}
        <DesignMarks
          marks={draft ? [...marks, draft] : marks}
          zoom={view.k}
          active={tool === "select" && !viewer}
          selected={markChosen}
          editing={markEditing}
          onPointerDown={(mark, event) => {
            clearPicked();
            begin(event, { kind: "mark", id: mark.id, startX: event.clientX, startY: event.clientY, x: mark.x, y: mark.y, at: null });
          }}
          onEdit={(id) => {
            setMarkChosen(id);
            setMarkEditing(id);
          }}
          onText={(id, text) => {
            setMarkEditing(null);
            if (!text.trim()) removeMark(id);
            else if (stored.find((mark) => mark.id === id)?.text !== text) commitMarks(stored.map((mark) => (mark.id === id ? { ...mark, text } : mark)));
          }}
          onRemove={removeMark}
          onColor={(id, color) => commitMarks(stored.map((mark) => (mark.id === id ? { ...mark, color } : mark)))}
          onStroke={(id, stroke) => commitMarks(stored.map((mark) => (mark.id === id ? { ...mark, stroke } : mark)))}
        />
        {guide && guideAt ? (
          <div className="design-guide" style={{ left: guideAt.x, top: guideAt.y, width: GUIDE_WIDTH }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="design-artboard-head" style={{ transform: `scale(${1 / view.k})`, width: GUIDE_WIDTH * view.k }}>
              <span className="design-artboard-title">DESIGN.md</span>
            </div>
            <div className="design-guide-body">
              <MarkdownRenderer content={guide} renderMode="document" />
            </div>
          </div>
        ) : null}
      </div>
      <div className="design-zoom" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`design-icon-btn${tool === "play" ? " is-on" : ""}`}
          aria-pressed={tool === "play"}
          onClick={() => switchTool(tool === "play" ? (viewer && !viewer.canComment ? "hand" : "select") : "play")}
          title="Play: use the pages where they are"
          aria-label="Play"
        >
          <Play size={14} />
        </button>
        {viewer ? (
          <button
            type="button"
            className={`design-icon-btn${viewerComments ? " is-on" : ""}`}
            aria-pressed={viewerComments}
            onClick={() => setViewerComments((shown) => !shown)}
            title="Comments"
            aria-label={viewerComments ? "Hide the comments" : "Show the comments"}
          >
            <MessageSquare size={14} />
          </button>
        ) : (
          <button
            type="button"
            className={`design-icon-btn${inspector ? " is-on" : ""}`}
            aria-pressed={inspector}
            onClick={() => showInspector(!inspector)}
            title="Layers, properties and comments"
            aria-label={inspector ? "Hide the inspector" : "Show the inspector"}
          >
            <SlidersHorizontal size={14} />
          </button>
        )}
        <ZoomMenu percent={Math.round(view.k * 100)} onZoom={zoomBy} onFit={() => setUserView(null)} />
      </div>
      <div className="design-tools" role="toolbar" aria-label="Tools" onPointerDown={(event) => event.stopPropagation()}>
        {(viewer ? TOOLS.slice(viewer.canComment ? 0 : 1, 2) : TOOLS).map((entry, index) => {
          if (!entry) return <span key={`rule-${index}`} className="design-select-rule" />;
          const [name, Icon, title] = entry;
          return (
            <button key={name} type="button" className={tool === name ? "is-on" : ""} aria-pressed={tool === name} onClick={() => switchTool(name)} title={title} aria-label={title}>
              <Icon size={15} />
            </button>
          );
        })}
        {viewer ? null : (
          <>
            <span className="design-select-rule" />
            <button type="button" disabled={readOnly || depth.undo === 0} onClick={() => undo()} title="Undo" aria-label="Undo"><Undo2 size={15} /></button>
            <button type="button" disabled={readOnly || depth.redo === 0} onClick={() => undo(true)} title="Redo" aria-label="Redo"><Redo2 size={15} /></button>
          </>
        )}
      </div>
    </div>
    {viewer && viewerComments ? (
      <aside className="design-inspector" onPointerDown={(event) => event.stopPropagation()}>
        <div className="design-inspector-tabs">
          <span className="design-tab is-active">Comments</span>
          <span className="design-play-gap" />
          <button type="button" className="design-icon-btn" onClick={() => setViewerComments(false)} title="Hide" aria-label="Hide the comments"><X size={14} /></button>
        </div>
        <DesignCommentList
          placeOf={(comment) => design.pages.find((page) => page.file === comment.page)?.title ?? comment.page}
          comments={comments.filter((comment) => comment.design === design.slug && comment.status === "open")}
          onOpen={(comment, at) => {
            const target = placed.pages.find((page) => page.file === comment.page);
            if (target) focus(target, 0, true);
            onOpenThread(comment, at);
          }}
        />
      </aside>
    ) : null}
    {inspector && !viewer ? (
      <DesignInspector
        projectId={projectId}
        taskId={taskId}
        design={design}
        trees={trees}
        variables={variables}
        onTweak={tweak}
        selected={selected}
        picked={picked}
        readOnly={readOnly}
        onSelectPage={(file) => {
          const target = placed.pages.find((page) => page.file === file);
          if (target) focus(target, 0, true);
        }}
        onSelectNode={(file, path) => {
          if (tool !== "select") setTool("select");
          artboards.current.get(file)?.select(path);
        }}
        onStyle={(props) => edit({ type: "style", path: chosenPath, props })}
        onText={(value) => edit({ type: "text", path: chosenPath, value })}
        onDuplicate={() => edit({ type: "duplicate", path: chosenPath })}
        onRemove={() => edit({ type: "remove", path: chosenPath })}
        onMove={(file, path, target, place) => {
          if (!readOnly) artboards.current.get(file)?.edit({ type: "move", path, target, place });
        }}
        comments={comments}
        agent={agent ?? null}
        canSend={Boolean(canSend)}
        onSendComments={(list) => onSendComments?.(list)}
        onOpenThread={onOpenThread}
        onClose={() => showInspector(false)}
      />
    ) : null}
    </div>
  );
}

interface ArtboardProps {
  projectId: string;
  taskId: string;
  filesBase: string;
  design: string;
  page: DesignPage;
  zoom: number;
  selected: boolean;
  ref?: Ref<ArtboardHandle>;
  tool: Tool;
  readOnly: boolean;
  /** The element chosen on this page, if the board's selection is here. */
  selection: PickedElement | null;
  comments: DesignComment[];
  /** A press on the title row: the handle the artboard is dragged by. */
  onPointerDown: (event: ReactPointerEvent) => void;
  /** This page is being used where it sits. */
  playing: boolean;
  onPlay: () => void;
  /** Save the page as a file; absent where that is not offered. */
  onExport?: (format: "html" | "png") => void;
  onOpenThread: (comment: DesignComment, at: { x: number; y: number }) => void;
  onSelected: (element: PickedElement) => void;
  onClearSelection: () => void;
  onEscape: () => void;
  onWheel: (wheel: FrameWheel) => void;
  onNavigate: (design: string, file: string) => void;
  onScrollTo: (y: number) => void;
  onComment: (element: PickedElement, at: { x: number; y: number }) => void;
  onTree: (tree: TreeNode[]) => void;
  onVariables: (variables: DesignVariable[]) => void;
  onMoved: (move: { path: string; target: string; place: "before" | "after" | "inside" }) => void;
  /** An edit reached the file: what the file held before, and holds now. */
  onWrote: (before: string, after: string) => void;
  onUndo: (redo: boolean) => void;
  onStyle: (props: Record<string, string>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSaved: () => void;
  onNotice: (message: string) => void;
}

/** What the board asks of one artboard. */
interface ArtboardHandle {
  select: (path: string) => void;
  clearSelection: () => void;
  /** Make the change in the page now, and in its file shortly after. */
  edit: (op: DesignEdit) => void;
  setVariable: (name: string, value: string) => void;
  /** Make the page's file this HTML again, and show it, when the file still holds `expect`. */
  restore: (html: string, expect: string, onFailed: (error: unknown) => void) => void;
}

/** How close the board is looked at, with the ways to change it. */
function ZoomMenu({ percent, onZoom, onFit }: { percent: number; onZoom: (factor: number) => void; onFit: () => void }) {
  const { open, close, toggle, rootRef } = usePopover();
  return (
    <span ref={rootRef} className="design-zoom-menu">
      <button type="button" className="design-zoom-value" aria-haspopup="menu" aria-expanded={open} aria-label={`Zoom, ${percent}%`} onClick={toggle}>
        {percent}%
        <ChevronDown size={11} />
      </button>
      {open ? (
        <span className="design-menu is-end" role="menu" aria-label="Zoom">
          <button type="button" role="menuitem" onClick={() => onZoom(1.25)}><Plus size={13} /><span>Zoom in</span></button>
          <button type="button" role="menuitem" onClick={() => onZoom(1 / 1.25)}><Minus size={13} /><span>Zoom out</span></button>
          <button type="button" role="menuitem" onClick={() => { close(); onFit(); }}><Maximize size={13} /><span>Fit the board</span></button>
        </span>
      ) : null}
    </span>
  );
}

/** The page as a file: one HTML file, or the image of it. */
function PageExport({ title, hasImage, onExport }: { title: string; hasImage: boolean; onExport: (format: "html" | "png") => void }) {
  const { open, close, toggle, rootRef } = usePopover();
  return (
    <span ref={rootRef} className="design-page-export" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className={`design-page-export-btn${open ? " is-on" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Export ${title}`} title="Export" onClick={toggle}>
        <Download size={11} />
      </button>
      {open ? (
        <span className="design-page-export-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { close(); onExport("html"); }}>HTML</button>
          <button type="button" role="menuitem" disabled={!hasImage} onClick={() => { close(); onExport("png"); }}>PNG</button>
        </span>
      ) : null}
    </span>
  );
}

/** Later edits to the same thing replace earlier ones that are still waiting. */
function queueEdit(waiting: DesignEdit[], op: DesignEdit): DesignEdit[] {
  const last = waiting[waiting.length - 1];
  if (last && last.path === op.path) {
    if (last.type === "style" && op.type === "style") return [...waiting.slice(0, -1), { ...last, props: { ...last.props, ...op.props } }];
    if (last.type === "text" && op.type === "text") return [...waiting.slice(0, -1), op];
  }
  return [...waiting, op];
}

function Artboard({
  ref, projectId, taskId, filesBase, design, page, zoom, selected, tool, readOnly, selection, comments, onPointerDown, playing, onPlay, onExport, onOpenThread,
  onSelected, onClearSelection, onEscape, onWheel, onNavigate, onScrollTo, onComment,
  onTree, onVariables, onMoved, onWrote, onUndo, onStyle, onDuplicate, onRemove, onSaved, onNotice,
}: ArtboardProps) {
  const frame = useRef<DesignFrameHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  // After an edit the page in the frame already is what the file now says, so
  // the frame keeps the document it has and does not load the page again.
  const [held, setHeld] = useState<{ shown: LoadedPage; accepted: string[] } | null>(null);
  const [reloads, setReloads] = useState(0);
  const saving = useRef<{ waiting: DesignEdit[]; timer: number; chain: Promise<void> }>({ waiting: [], timer: 0, chain: Promise.resolve() });
  const latest = usePageHtml(projectId, taskId, design, page.file, page.version);
  const loaded = latest && held?.accepted.includes(latest.html) ? held.shown : latest;
  const frameVersion = loaded ? `${loaded.version}#${reloads}` : "";
  const shownRef = useRef(loaded);
  useEffect(() => { shownRef.current = loaded; });
  // The frame grows to its content; counted per document so a page that keeps
  // growing with its own viewport cannot run away.
  const [grown, setGrown] = useState<{ version: string; height: number; times: number } | null>(null);
  const [boxes, setBoxes] = useState<AnchorBoxes>({});
  const base = pageHeight(page);
  const height = grown?.version === frameVersion ? Math.max(base, grown.height) : base;

  const grow = (reported: number) => {
    setGrown((previous) => {
      const same = previous?.version === frameVersion ? previous : null;
      if (same && (same.times >= MAX_GROWS || reported <= same.height + 1)) return previous;
      return { version: frameVersion, height: Math.max(reported, same?.height ?? 0), times: (same?.times ?? 0) + 1 };
    });
  };

  const save = async () => {
    const edits = saving.current.waiting;
    saving.current.waiting = [];
    const shown = shownRef.current;
    if (!edits.length || !shown) return;
    try {
      const source = await getDesignPage(projectId, taskId, design, page.file);
      const next = applyEdits(source, edits);
      if (next === null) throw new Error("not in the file");
      await updateDesignPage(projectId, taskId, design, page.file, next, source);
      setHeld((previous) => {
        const mine = previous?.shown === shown ? previous.accepted : [shown.html];
        // The file had moved on under the frame: show what is really there.
        if (!mine.includes(source)) return null;
        return { shown, accepted: [shown.html, ...mine.slice(1).slice(-8), next] };
      });
      onWrote(source, next);
      onSaved();
    } catch (error) {
      // The page shows a change its file does not have: load the file again.
      setHeld(null);
      setReloads((count) => count + 1);
      onClearSelection();
      onNotice(isChangedSince(error)
        ? "The page was changed while you were editing, so that change wasn't saved"
        : "That element is drawn by the page's own script, so it can't be changed here. Ask the agent to change it.");
    }
  };

  useImperativeHandle(ref, () => ({
    select: (path) => frame.current?.select(path),
    clearSelection: () => frame.current?.clearSelection(),
    setVariable: (name, value) => frame.current?.setVariable(name, value),
    restore: (html, expect, onFailed) => {
      saving.current.chain = saving.current.chain.then(async () => {
        try {
          await updateDesignPage(projectId, taskId, design, page.file, html, expect);
          setHeld(null);
          setReloads((count) => count + 1);
          onSaved();
        } catch (error) {
          onFailed(error);
        }
      });
    },
    edit: (op) => {
      frame.current?.edit(op);
      const state = saving.current;
      state.waiting = queueEdit(state.waiting, op);
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        state.chain = state.chain.then(save);
      }, SAVE_DELAY_MS);
    },
  }));

  const anchors = useMemo(
    () => comments.filter((comment) => comment.anchor).map((comment) => ({ id: String(comment.id), selector: comment.anchor?.selector, xpath: comment.anchor?.xpath, text: comment.anchor?.text })),
    [comments],
  );

  return (
    <div className={`design-artboard${selected ? " is-selected" : ""}${playing ? " is-playing" : ""}`} style={{ left: page.x, top: page.y, width: page.width }}>
      <div className="design-artboard-head is-handle" style={{ transform: `scale(${1 / zoom})`, width: page.width * zoom }} onPointerDown={onPointerDown}>
        <span className="design-artboard-title" title={page.file}>{page.title}</span>
        <button
          type="button"
          className={`design-play${playing ? " is-on" : ""}`}
          aria-pressed={playing}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onPlay}
          title={playing ? `Stop using ${page.title}` : `Use ${page.title} right here`}
        >
          {playing ? <Square size={9} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
          {playing ? "Stop" : "Play"}
        </button>
        {onExport ? <PageExport title={page.title} hasImage={Boolean(page.capture_version)} onExport={onExport} /> : null}
      </div>
      <div ref={body} className="design-artboard-body" style={{ height }}>
        {loaded ? (
          <DesignFrame
            ref={frame}
            html={loaded.html}
            version={frameVersion}
            filesBase={filesBase}
            title={page.title}
            width={page.width}
            height={height}
            interactive={playing || tool === "select" || tool === "play"}
            picking={!playing && tool === "select"}
            editable={!playing && tool === "select" && !readOnly}
            onVariables={onVariables}
            onChanged={onStyle}
            onMoved={onMoved}
            onUndo={onUndo}
            tree
            scale={zoom}
            onTree={onTree}
            onEdited={(element) => (element ? onSelected(element) : onClearSelection())}
            forwardWheel
            anchors={anchors}
            onReady={(report) => grow(report.height)}
            onHeight={grow}
            onLocated={setBoxes}
            onSelected={onSelected}
            onNavigate={onNavigate}
            onScrollTo={onScrollTo}
            onEscape={onEscape}
            onWheel={onWheel}
          />
        ) : null}
      </div>
      {comments.map((comment, index) => {
        const located = boxes[String(comment.id)];
        const missing = located !== undefined && "missing" in located;
        const stale = missing ? "Its element is no longer on the page" : located && located.changed ? "Its element has changed since" : null;
        const at = pinPosition(comment.anchor, missing ? undefined : located, page, index);
        return (
          <button
            key={comment.id}
            type="button"
            className={`design-pin${stale ? " is-stale" : ""}`}
            style={{ left: at.x, top: at.y, transform: `translate(0, -100%) scale(${1 / zoom})` }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onOpenThread(comment, { x: event.clientX, y: event.clientY })}
            title={`${comment.author}: ${comment.content}${stale ? ` · ${stale}` : ""}`}
          >
            <Avatar name={comment.author} size={26} />
          </button>
        );
      })}
      {selection ? (
        <DesignSelectBar
          selection={selection}
          scale={zoom}
          onComment={() => {
            const rect = body.current?.getBoundingClientRect();
            onComment(selection, { x: (rect?.left ?? 0) + (selection.x + selection.width) * zoom, y: (rect?.top ?? 0) + selection.y * zoom });
          }}
          onClear={onClearSelection}
          edit={readOnly ? undefined : { onStyle, onDuplicate, onRemove }}
        />
      ) : null}
    </div>
  );
}
