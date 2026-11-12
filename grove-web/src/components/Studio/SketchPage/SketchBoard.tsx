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
import type { SketchAnchor, SketchBox, SketchComment, SketchMeta } from "../../../api";
import { usePopover } from "../../../orbit/ui";
import { ConfirmDialog } from "../../Dialogs/ConfirmDialog";
import { DesignCommentList } from "../DesignPage/DesignInspector";
import { Avatar, DesignThread } from "../DesignPage/DesignThread";
import { SketchCanvas } from "./SketchCanvas";
import { exportSketchPng } from "./sketchExport";
import { anchorOn, anchorOnArea, idsAt, placeLabel, placeOf, type SceneElement } from "./sketchAnchor";
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
          onClick={(event) => {
            // Shapes chosen on the canvas: the comment is on them, at once.
            const chosen = api && !commenting ? selectionAnchor(api) : null;
            if (chosen && activeId) {
              const box = event.currentTarget.getBoundingClientRect();
              setThread({ kind: "new", sketch: activeId, anchor: chosen, at: { x: box.left - 330, y: box.bottom + 8 } });
              return;
            }
            setCommenting((on) => !on);
          }}
          title="Comment on the shapes chosen, or click a shape or drag over an area"
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
          // The elements of the thread open, outlined on the canvas.
          shown={thread?.kind === "new" ? thread.anchor : existing?.anchor ?? null}
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
                const ids = new Set((comment.anchor?.items ?? []).map((item) => item.id));
                const targets = api?.getSceneElements().filter((entry) => ids.has(entry.id)) ?? [];
                if (api && targets.length) api.scrollToContent(targets, { animate: true });
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

/** A comment's place on the shapes chosen on the canvas, if any are. */
function selectionAnchor(api: ExcalidrawImperativeAPI): SketchAnchor | null {
  const chosen = Object.entries(api.getAppState().selectedElementIds).filter(([, on]) => on).map(([id]) => id);
  if (chosen.length === 0) return null;
  return anchorOn(api.getSceneElements() as unknown as readonly SceneElement[], chosen);
}

/**
 * Comment pins over the canvas, kept on their elements as the canvas pans,
 * zooms and changes, and an outline around the elements of the thread open
 * or the pin pointed at. While commenting, a click picks the shape under it
 * (with its group) and a drag picks an area.
 */
function SketchPins({ api, comments, commenting, onPick, onOpen, shown }: {
  api: ExcalidrawImperativeAPI;
  comments: SketchComment[];
  commenting: boolean;
  onPick: (anchor: SketchAnchor, at: { x: number; y: number }) => void;
  onOpen: (comment: SketchComment, at: { x: number; y: number }) => void;
  shown: SketchAnchor | null;
}) {
  const [view, setView] = useState<View>(() => {
    const state = api.getAppState();
    return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
  });
  const [elements, setElements] = useState<readonly SceneElement[]>(() => api.getSceneElements() as unknown as readonly SceneElement[]);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [band, setBand] = useState<SketchBox | null>(null);

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
  const toScreen = (box: SketchBox) => ({
    left: (box.x + view.scrollX) * view.zoom,
    top: (box.y + view.scrollY) * view.zoom,
    width: box.width * view.zoom,
    height: box.height * view.zoom,
  });
  const toScene = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / view.zoom - view.scrollX, y: (event.clientY - box.top) / view.zoom - view.scrollY };
  };
  const hovered = hover !== null ? comments.find((comment) => comment.id === hover)?.anchor ?? null : null;
  const outline = placeOf(hovered ?? shown, byId);

  return (
    <div
      className={`sketch-pins${commenting ? " is-commenting" : ""}`}
      onPointerDown={(event) => {
        if (!commenting || event.button !== 0 || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = toScene(event);
        drag.current = { ...at, sx: event.clientX, sy: event.clientY };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const at = toScene(event);
        if (Math.hypot(event.clientX - start.sx, event.clientY - start.sy) < 4) return;
        setBand({ x: Math.min(start.x, at.x), y: Math.min(start.y, at.y), width: Math.abs(at.x - start.x), height: Math.abs(at.y - start.y) });
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        drag.current = null;
        if (!start) return;
        const area = band;
        setBand(null);
        const live = api.getSceneElements() as unknown as readonly SceneElement[];
        const at = { x: event.clientX, y: event.clientY };
        if (area) {
          onPick(anchorOnArea(live, area), at);
          return;
        }
        // A click on empty canvas picks nothing: drag over an area instead.
        const anchor = anchorOn(live, idsAt(live, start.x, start.y, view.zoom));
        if (anchor) onPick(anchor, at);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setBand(null);
      }}
    >
      {outline ? <div className={`sketch-target${outline.stale ? " is-stale" : ""}`} style={toScreen(outline.box)} /> : null}
      {band ? <div className="sketch-target is-band" style={toScreen(band)} /> : null}
      {comments.map((comment) => {
        const place = placeOf(comment.anchor, byId);
        if (!place) return null;
        const at = toScreen(place.box);
        return (
          <button
            key={comment.id}
            type="button"
            className={`design-pin${place.stale ? " is-stale" : ""}`}
            style={{ left: at.left + at.width, top: at.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerEnter={() => setHover(comment.id)}
            onPointerLeave={() => setHover((id) => (id === comment.id ? null : id))}
            onClick={(event) => onOpen(comment, { x: event.clientX, y: event.clientY })}
            title={`${comment.author}: ${comment.content}${place.stale ? " · Its elements are no longer on the sketch" : ""}`}
          >
            <Avatar name={comment.author} size={24} />
          </button>
        );
      })}
    </div>
  );
}
