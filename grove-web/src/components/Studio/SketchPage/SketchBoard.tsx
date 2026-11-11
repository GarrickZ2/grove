import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Download,
  History,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SketchAnchor, SketchComment, SketchMeta } from "../../../api";
import { usePopover } from "../../../orbit/ui";
import { ConfirmDialog } from "../../Dialogs/ConfirmDialog";
import { DesignCommentList } from "../DesignPage/DesignInspector";
import { Avatar, DesignThread } from "../DesignPage/DesignThread";
import { SketchCanvas } from "./SketchCanvas";
import { exportSketchPng } from "./sketchExport";
import "../DesignPage/design.css";
import "./sketch.css";

/** What the owner of the task can do that a share link's reader cannot. */
export interface SketchOwnerActions {
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onHistory: () => void;
  onChange: (scene: unknown) => void;
  /** The agent is working: the canvas is read-only meanwhile. */
  aiBusy?: boolean;
  /** `false` once the live connection dropped; nothing shown before it opened. */
  wsConnected?: boolean;
}

interface Props {
  sketches: SketchMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  scene: unknown | null;
  /** Changes when the canvas has to start over from `scene`. */
  sceneKey: string;
  sceneLoading: boolean;
  owner?: SketchOwnerActions;
  comments: SketchComment[];
  /** Absent where comments can only be read. */
  onAddComment?: (sketch: string, anchor: SketchAnchor, content: string) => Promise<void>;
  onReply?: (id: number, content: string) => Promise<void>;
  onResolve?: (comment: SketchComment) => void;
  onSend?: (comments: SketchComment[]) => void;
  agent: string | null;
  canSend: boolean;
  onApi?: (api: ExcalidrawImperativeAPI | null) => void;
  /** Shown when there is no sketch. */
  empty: ReactNode;
}

type Thread =
  | { kind: "existing"; id: number; at: { x: number; y: number } }
  | { kind: "new"; sketch: string; anchor: SketchAnchor; at: { x: number; y: number } };

/** How a comment's place reads: what its element says, or that it is on the canvas. */
function placeLabel(anchor: SketchAnchor | null | undefined): string {
  if (!anchor) return "the sketch";
  const text = anchor.text?.trim();
  if (text) return `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
  return anchor.element ? "an element" : "the canvas";
}

/**
 * The Sketch panel's surface: the canvas, the sketch picker in its top left
 * corner, view controls in its top right, and comments pinned on elements.
 * Laid out as the Design panel is.
 */
export function SketchBoard({
  sketches, activeId, onSelect, scene, sceneKey, sceneLoading, owner,
  comments, onAddComment, onReply, onResolve, onSend, agent, canSend, onApi, empty,
}: Props) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SketchMeta | null>(null);

  const active = sketches.find((sketch) => sketch.id === activeId) ?? null;
  const open = comments.filter((comment) => comment.sketch === activeId && comment.status === "open");
  const locked = owner ? Boolean(owner.aiBusy) : true;

  const takeApi = useCallback((next: ExcalidrawImperativeAPI) => {
    setApi(next);
    onApi?.(next);
  }, [onApi]);
  useEffect(() => () => onApi?.(null), [onApi]);
  // A new sketch, or the canvas starting over: the old canvas is gone.
  const [prevKey, setPrevKey] = useState(sceneKey);
  if (prevKey !== sceneKey) {
    setPrevKey(sceneKey);
    setApi(null);
    setThread(null);
  }

  useEffect(() => {
    if (!commenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !thread) setCommenting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commenting, thread]);

  const openThread = useCallback((comment: SketchComment, at: { x: number; y: number }) => {
    setThread({ kind: "existing", id: comment.id, at });
  }, []);

  const name = active?.name ?? "sketch";
  const existing = thread?.kind === "existing" ? comments.find((comment) => comment.id === thread.id) : undefined;

  const tools = (
    <div className="sketch-tools" onPointerDown={(event) => event.stopPropagation()}>
      {owner?.aiBusy ? <span className="sketch-busy" title="The agent is drawing: the canvas is read-only until it stops" aria-label="The agent is drawing" /> : null}
      {owner?.wsConnected === false ? (
        <span className="sketch-offline" title="Live updates paused, reconnecting" aria-label="Reconnecting"><WifiOff size={13} /></span>
      ) : null}
      {onAddComment ? (
        <button
          type="button"
          className={`design-icon-btn${commenting ? " is-on" : ""}`}
          aria-pressed={commenting}
          onClick={() => setCommenting((on) => !on)}
          title="Comment: click an element or a spot on the canvas"
          aria-label="Comment"
        >
          <MessageSquarePlus size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className={`design-icon-btn${listOpen ? " is-on" : ""}`}
        aria-pressed={listOpen}
        onClick={() => setListOpen((shown) => !shown)}
        title="Comments"
        aria-label={listOpen ? "Hide the comments" : "Show the comments"}
      >
        <MessageSquare size={14} />
        {open.length ? <span className="sketch-count">{open.length}</span> : null}
      </button>
      {owner ? (
        <button type="button" className="design-icon-btn" onClick={owner.onHistory} title="History" aria-label="History">
          <History size={14} />
        </button>
      ) : null}
    </div>
  );

  const body = sketches.length === 0 ? empty : sceneLoading || !activeId ? (
    <div className="flex items-center justify-center h-full text-sm" style={{ color: "var(--color-text-muted)" }}>Loading sketch…</div>
  ) : (
    <>
      <SketchCanvas
        // Remote-driven updates remount Excalidraw with fresh initialData:
        // its own reconciliation does not reliably apply out-of-process writes.
        key={sceneKey}
        scene={scene}
        onChange={owner?.onChange ?? (() => {})}
        onExcalidrawAPI={takeApi}
        // Read-only while the agent draws (its writes and the user's would
        // overwrite each other), and always for a share link's reader.
        locked={locked}
        library={Boolean(owner)}
      />
      {api && activeId ? (
        <SketchPins
          api={api}
          comments={open}
          commenting={commenting}
          onPick={(anchor, at) => setThread({ kind: "new", sketch: activeId, anchor, at })}
          onOpen={openThread}
        />
      ) : null}
    </>
  );

  return (
    <div className="design-panel sketch-panel">
      <div className="sketch-body">
        <div className="sketch-stage">
          {sketches.length > 0 && active ? (
            <SketchPicker
              sketches={sketches}
              current={active}
              onShow={(id) => {
                setThread(null);
                onSelect(id);
              }}
              owner={owner}
              onDelete={() => setConfirmDelete(active)}
              onExport={api ? () => void exportSketchPng(api, name).catch((error) => console.error("sketch export failed", error)) : undefined}
              // The canvas keeps its own theme with the sketch.
              isDark={() => api?.getAppState().theme === "dark"}
              onTheme={api ? () => api.updateScene({ appState: { theme: api.getAppState().theme === "dark" ? "light" : "dark" } }) : undefined}
            />
          ) : null}
          {sketches.length > 0 ? tools : null}
          {body}
        </div>
        {listOpen ? (
          <aside className="design-inspector" onPointerDown={(event) => event.stopPropagation()}>
            <div className="design-inspector-tabs">
              <span className="design-tab is-active">Comments</span>
              <span className="design-play-gap" />
              <button type="button" className="design-icon-btn" onClick={() => setListOpen(false)} title="Hide" aria-label="Hide the comments"><X size={14} /></button>
            </div>
            <DesignCommentList
              comments={open}
              placeOf={(comment) => placeLabel(comment.anchor)}
              agent={agent}
              canSend={canSend}
              onSend={onSend}
              onOpen={(comment, at) => {
                const element = comment.anchor?.element
                  ? api?.getSceneElements().find((entry) => entry.id === comment.anchor?.element)
                  : undefined;
                if (api && element) api.scrollToContent(element, { animate: true });
                openThread(comment, at);
              }}
            />
          </aside>
        ) : null}
      </div>
      {thread?.kind === "new" && onAddComment ? (
        <DesignThread
          at={thread.at}
          target={`${name} · ${placeLabel(thread.anchor)}`}
          agent={agent}
          canSend={canSend}
          onClose={() => setThread(null)}
          onSubmit={async (text) => {
            await onAddComment(thread.sketch, thread.anchor, text);
            setThread(null);
          }}
        />
      ) : null}
      {thread?.kind === "existing" && existing ? (
        <DesignThread
          at={thread.at}
          comment={existing}
          target={`${name} · ${placeLabel(existing.anchor)}`}
          agent={agent}
          canSend={canSend}
          compose={Boolean(onReply)}
          onClose={() => setThread(null)}
          onResolve={onResolve ? () => {
            onResolve(existing);
            if (existing.status === "open") setThread(null);
          } : undefined}
          onSend={onSend ? () => {
            onSend([existing]);
            setThread(null);
          } : undefined}
          onSubmit={async (text) => {
            if (onReply) await onReply(existing.id, text);
          }}
        />
      ) : null}
      {owner ? (
        <ConfirmDialog
          isOpen={confirmDelete !== null}
          title="Delete sketch"
          message={confirmDelete ? `Delete "${confirmDelete.name}"? This action cannot be undone.` : ""}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => {
            if (confirmDelete) owner.onDelete(confirmDelete.id);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  );
}

/** Which sketch is shown, chosen from the canvas's top left corner; a sketch is made, renamed and removed here too. */
function SketchPicker({ sketches, current, onShow, owner, onDelete, onExport, isDark, onTheme }: {
  sketches: SketchMeta[];
  current: SketchMeta;
  onShow: (id: string) => void;
  owner?: SketchOwnerActions;
  onDelete: () => void;
  onExport?: () => void;
  isDark: () => boolean;
  onTheme?: () => void;
}) {
  const { open, close, toggle, rootRef } = usePopover<HTMLDivElement>();
  const [renaming, setRenaming] = useState<string | null>(null);

  if (renaming !== null && owner) {
    const finish = (save: boolean) => {
      const value = renaming.trim();
      if (save && value && value !== current.name) owner.onRename(current.id, value);
      setRenaming(null);
    };
    return (
      <div className="design-picker" onPointerDown={(event) => event.stopPropagation()}>
        <input
          className="sketch-picker-rename"
          autoFocus
          value={renaming}
          aria-label="Sketch name"
          onChange={(event) => setRenaming(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") finish(true);
            else if (event.key === "Escape") {
              event.stopPropagation();
              finish(false);
            }
          }}
        />
      </div>
    );
  }

  const item = (label: string, icon: ReactNode, action: () => void, disabled = false) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => { close(); action(); }}>
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div ref={rootRef} className="design-picker" onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="design-picker-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        onDoubleClick={owner ? () => { close(); setRenaming(current.name); } : undefined}
      >
        <Pencil size={13} />
        <span>{current.name}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (() => {
        const dark = isDark();
        return (
        <div className="design-menu" role="menu" aria-label="Sketches">
          {sketches.map((entry) => (
            <button key={entry.id} type="button" role="menuitemradio" aria-checked={entry.id === current.id} onClick={() => { close(); onShow(entry.id); }}>
              <Pencil size={13} />
              <span>{entry.name}</span>
              {entry.id === current.id ? <Check size={14} className="design-menu-check" /> : null}
            </button>
          ))}
          <span className="design-menu-rule" />
          {owner ? item("New sketch", <Plus size={13} />, owner.onCreate) : null}
          {owner ? item("Rename", <Pencil size={13} />, () => setRenaming(current.name)) : null}
          {onExport ? item("Export as PNG", <Download size={13} />, onExport) : null}
          {onTheme ? item(dark ? "Light canvas" : "Dark canvas", dark ? <Sun size={13} /> : <Moon size={13} />, onTheme) : null}
          {owner ? (
            <>
              <span className="design-menu-rule" />
              {item("Delete", <Trash2 size={13} />, onDelete)}
            </>
          ) : null}
        </div>
        );
      })() : null}
    </div>
  );
}

interface View {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  containerId?: string | null;
  text?: string;
  points?: readonly (readonly [number, number])[];
}

/** An element's box in scene coordinates. */
function boxOf(element: SceneElement): { left: number; top: number; right: number; bottom: number } {
  if (element.points && element.points.length) {
    const xs = element.points.map((point) => point[0]);
    const ys = element.points.map((point) => point[1]);
    return {
      left: element.x + Math.min(...xs),
      top: element.y + Math.min(...ys),
      right: element.x + Math.max(...xs),
      bottom: element.y + Math.max(...ys),
    };
  }
  const left = Math.min(element.x, element.x + element.width);
  const top = Math.min(element.y, element.y + element.height);
  return { left, top, right: left + Math.abs(element.width), bottom: top + Math.abs(element.height) };
}

/** The front-most element under a scene point; a label counts as its shape. Frames only when nothing else is there. */
function elementAt(elements: readonly SceneElement[], x: number, y: number, zoom: number): SceneElement | null {
  const slack = 6 / zoom;
  const byId = new Map(elements.map((element) => [element.id, element]));
  let frame: SceneElement | null = null;
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element.isDeleted) continue;
    const box = boxOf(element);
    if (x < box.left - slack || x > box.right + slack || y < box.top - slack || y > box.bottom + slack) continue;
    if (element.type === "frame" || element.type === "magicframe") {
      frame ??= element;
      continue;
    }
    const container = element.containerId ? byId.get(element.containerId) : undefined;
    return container && !container.isDeleted ? container : element;
  }
  return frame;
}

/** What an element reads: its own text, or its label's. */
function textOf(elements: readonly SceneElement[], element: SceneElement): string | undefined {
  const own = element.type === "text" ? element.text : elements.find((entry) => entry.containerId === element.id && !entry.isDeleted)?.text;
  const text = own?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

/** Where a comment's pin is in the scene, and whether its element is gone. */
function pinOf(comment: SketchComment, byId: Map<string, SceneElement>): { x: number; y: number; stale: boolean } | null {
  const anchor = comment.anchor;
  if (!anchor || typeof anchor.x !== "number" || typeof anchor.y !== "number") return null;
  if (!anchor.element) return { x: anchor.x, y: anchor.y, stale: false };
  const element = byId.get(anchor.element);
  if (!element || element.isDeleted) return { x: anchor.x, y: anchor.y, stale: true };
  return { x: element.x + (anchor.dx ?? 0), y: element.y + (anchor.dy ?? 0), stale: false };
}

/**
 * Comment pins over the canvas, kept on their elements as the canvas pans,
 * zooms and changes. While commenting, a click picks the element under it
 * (or the spot, on empty canvas) for a new comment.
 */
function SketchPins({ api, comments, commenting, onPick, onOpen }: {
  api: ExcalidrawImperativeAPI;
  comments: SketchComment[];
  commenting: boolean;
  onPick: (anchor: SketchAnchor, at: { x: number; y: number }) => void;
  onOpen: (comment: SketchComment, at: { x: number; y: number }) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => {
    const state = api.getAppState();
    return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
  });
  const [elements, setElements] = useState<readonly SceneElement[]>(() => api.getSceneElements() as unknown as readonly SceneElement[]);

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const state = api.getAppState();
        setView((prev) =>
          prev.scrollX === state.scrollX && prev.scrollY === state.scrollY && prev.zoom === state.zoom.value
            ? prev
            : { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value },
        );
        const next = api.getSceneElements() as unknown as readonly SceneElement[];
        setElements((prev) => (prev === next ? prev : next));
      });
    };
    sync();
    const offChange = api.onChange(sync);
    const offScroll = api.onScrollChange(sync);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      offChange();
      offScroll();
    };
  }, [api]);

  const byId = new Map(elements.map((element) => [element.id, element]));
  const toScreen = (x: number, y: number) => ({ left: (x + view.scrollX) * view.zoom, top: (y + view.scrollY) * view.zoom });

  return (
    <div
      ref={layerRef}
      className={`sketch-pins${commenting ? " is-commenting" : ""}`}
      onPointerDown={(event) => {
        if (!commenting || event.button !== 0 || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - box.left) / view.zoom - view.scrollX;
        const y = (event.clientY - box.top) / view.zoom - view.scrollY;
        const live = api.getSceneElements() as unknown as readonly SceneElement[];
        const element = elementAt(live, x, y, view.zoom);
        const anchor: SketchAnchor = element
          ? { element: element.id, text: textOf(live, element), x, y, dx: x - element.x, dy: y - element.y }
          : { x, y };
        onPick(anchor, { x: event.clientX, y: event.clientY });
      }}
    >
      {comments.map((comment) => {
        const pin = pinOf(comment, byId);
        if (!pin) return null;
        const at = toScreen(pin.x, pin.y);
        return (
          <button
            key={comment.id}
            type="button"
            className={`design-pin${pin.stale ? " is-stale" : ""}`}
            style={{ left: at.left, top: at.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onOpen(comment, { x: event.clientX, y: event.clientY })}
            title={`${comment.author}: ${comment.content}${pin.stale ? " · Its element is no longer on the sketch" : ""}`}
          >
            <Avatar name={comment.author} size={24} />
          </button>
        );
      })}
    </div>
  );
}
