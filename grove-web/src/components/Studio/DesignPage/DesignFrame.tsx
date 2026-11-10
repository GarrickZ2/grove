import { useEffect, useId, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import type { DesignAnchor, DesignReport } from "../../../api/designs";
import type { DesignEdit } from "./designEdit";
import { buildDesignDocument, screenshotLibrary } from "./designFrameDoc";

/** What the bridge says about an element the user pointed at. */
export interface PickedElement extends DesignAnchor {
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  html?: string;
  /** What the element is: Button, Text, Row, … */
  kind: string;
  /** Holds text and nothing else, so its text can be typed over. */
  textOnly: boolean;
  /** Computed values, plus the width and height the page's author fixed. */
  styles: Record<string, string>;
}

/** A CSS variable a page is tuned by, and the stylesheet that defines it. */
export interface DesignVariable {
  name: string;
  /** As written in the stylesheet. */
  value: string;
  /** What it comes to on the page. */
  resolved: string;
  kind: "color" | "length" | "other";
  /** Path under `design/` of the stylesheet; empty for a `<style>` in the page, which `index` then counts. */
  file: string;
  index: number;
}

/** One element in a page's layer tree; `path` is its XPath. */
export interface TreeNode {
  path: string;
  kind: string;
  name: string;
  children: TreeNode[];
}

export interface FrameCapture {
  /** PNG as base64, without the data-URL prefix. */
  image?: string;
  report: DesignReport;
  error?: string;
}

export interface DesignFrameHandle {
  /** Draw the page to an image and check it. Rejects if the frame is gone. */
  capture: () => Promise<FrameCapture>;
  clearSelection: () => void;
  /** Choose the element at this XPath, as if the user had pointed at it. */
  select: (path: string) => void;
  /** Make a change in the page as it stands; the caller writes the file. */
  edit: (op: DesignEdit) => void;
  /** Show a CSS variable at another value; the caller writes the stylesheet. */
  setVariable: (name: string, value: string) => void;
}

/** A scroll over the page; `x` and `y` are page pixels. */
export interface FrameWheel {
  deltaX: number;
  deltaY: number;
  zoom: boolean;
  x: number;
  y: number;
}

/**
 * Where each comment's element is now. `changed`: it no longer reads as it did
 * when the comment was made. `missing`: nothing is left where it was.
 */
export type AnchorBoxes = Record<string, { x: number; y: number; width: number; height: number; changed?: boolean } | { missing: true }>;

interface DesignFrameProps {
  ref?: Ref<DesignFrameHandle>;
  html: string;
  /** Reloads the frame when it changes, even if the HTML itself did not (a stylesheet did). */
  version: string;
  /** Absolute URL of the design's directory; relative files load from it. */
  filesBase: string;
  title: string;
  width: number;
  height: number;
  /** False on the board, where the artboard takes the pointer. */
  interactive: boolean;
  /** Pointing selects an element in place of using the page. */
  picking?: boolean;
  /** Scrolling over the page goes to `onWheel`, unless something inside the page scrolls. */
  forwardWheel?: boolean;
  /** Report the page's layer tree, and again whenever it changes. */
  tree?: boolean;
  /** The chosen element can be resized by its corners and dragged to another place. */
  editable?: boolean;
  /** How small the page is drawn; selection outlines keep their weight on screen. */
  scale?: number;
  /** Elements whose current boxes the frame should report (comment pins). */
  anchors?: Array<{ id: string; selector?: string; xpath?: string; text?: string }>;
  onReady?: (report: DesignReport) => void;
  onHeight?: (height: number) => void;
  onSelected?: (element: PickedElement) => void;
  onNavigate?: (design: string, file: string) => void;
  onScrollTo?: (y: number) => void;
  onEscape?: () => void;
  onLocated?: (boxes: AnchorBoxes) => void;
  onWheel?: (wheel: FrameWheel) => void;
  onTree?: (tree: TreeNode[]) => void;
  /** An edit was made; the element chosen afterwards, if any. */
  onEdited?: (element: PickedElement | null) => void;
  onVariables?: (variables: DesignVariable[]) => void;
  /** The user resized or repositioned the chosen element; already shown in the page. */
  onChanged?: (props: Record<string, string>) => void;
  /** The user dragged the chosen element to another place among the elements. */
  onMoved?: (move: { path: string; target: string; place: "before" | "after" | "inside" }) => void;
  /** ⌘Z pressed inside the page. */
  onUndo?: (redo: boolean) => void;
}

const CAPTURE_TIMEOUT_MS = 25_000;
/** Taller pages are drawn up to here; the check still covers the whole page. */
const CAPTURE_MAX_HEIGHT = 6000;
// Scripts run, but with an opaque origin: no cookies, no storage, no Grove API.
// Popups are for links that leave the design; they open as ordinary tabs.
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

function accentColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--color-highlight").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#0d9488";
}

/**
 * One design page in its sandboxed frame. The page cannot reach Grove; this
 * component and the bridge script inside the frame talk over postMessage.
 */
export function DesignFrame({
  ref, html, version, filesBase, title, width, height, interactive, picking = false, forwardWheel = false, tree = false, editable = false, scale = 1, anchors,
  onReady, onHeight, onSelected, onNavigate, onScrollTo, onEscape, onLocated, onWheel, onTree, onEdited, onVariables, onChanged, onMoved, onUndo,
}: DesignFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameId = useId();
  const ready = useRef(false);
  const pending = useRef(new Map<string, (capture: FrameCapture) => void>());
  const handlers = useRef({ onReady, onHeight, onSelected, onNavigate, onScrollTo, onEscape, onLocated, onWheel, onTree, onEdited, onVariables, onChanged, onMoved, onUndo });
  const state = useRef({ picking, forwardWheel, tree, editable, scale, anchors });

  const srcDoc = useMemo(
    () => buildDesignDocument(html, { frameId, filesBase, accent: accentColor(), version }),
    [html, frameId, filesBase, version],
  );

  const send = (type: string, data: Record<string, unknown> = {}) => {
    frameRef.current?.contentWindow?.postMessage({ ...data, type: `grove-design:${type}`, frameId }, "*");
  };
  const sendRef = useRef(send);

  useEffect(() => {
    handlers.current = { onReady, onHeight, onSelected, onNavigate, onScrollTo, onEscape, onLocated, onWheel, onTree, onEdited, onVariables, onChanged, onMoved, onUndo };
    state.current = { picking, forwardWheel, tree, editable, scale, anchors };
    sendRef.current = send;
  });

  // A new document starts over: not ready, nothing in flight.
  useEffect(() => {
    ready.current = false;
    const waiting = pending.current;
    return () => {
      waiting.forEach((resolve) => resolve({ report: { height: 0, issues: [] }, error: "The page was reloaded" }));
      waiting.clear();
    };
  }, [srcDoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; frameId?: string } & Record<string, unknown>;
      if (!data || data.frameId !== frameId || typeof data.type !== "string") return;
      const on = handlers.current;
      switch (data.type) {
        case "grove-design:ready":
          ready.current = true;
          sendRef.current("pick", { on: state.current.picking });
          sendRef.current("forward-wheel", { on: state.current.forwardWheel });
          sendRef.current("scale", { k: state.current.scale });
          sendRef.current("tree", { on: state.current.tree });
          sendRef.current("editable", { on: state.current.editable });
          if (state.current.anchors?.length) sendRef.current("locate", { anchors: state.current.anchors });
          on.onReady?.(data.report as DesignReport);
          break;
        case "grove-design:height":
          if (typeof data.height === "number") on.onHeight?.(data.height);
          if (state.current.anchors?.length) sendRef.current("locate", { anchors: state.current.anchors });
          break;
        case "grove-design:selected":
          on.onSelected?.(data.anchor as PickedElement);
          break;
        case "grove-design:navigate":
          if (typeof data.design === "string" && typeof data.file === "string") on.onNavigate?.(data.design, data.file);
          break;
        case "grove-design:scroll":
          if (typeof data.y === "number") on.onScrollTo?.(data.y);
          break;
        case "grove-design:escape":
          on.onEscape?.();
          break;
        case "grove-design:wheel":
          on.onWheel?.(data as unknown as FrameWheel);
          break;
        case "grove-design:tree":
          on.onTree?.(data.tree as TreeNode[]);
          break;
        case "grove-design:variables":
          on.onVariables?.(data.variables as DesignVariable[]);
          break;
        case "grove-design:changed":
          on.onChanged?.(data.props as Record<string, string>);
          break;
        case "grove-design:moved":
          on.onMoved?.(data as unknown as { path: string; target: string; place: "before" | "after" | "inside" });
          break;
        case "grove-design:undo":
          on.onUndo?.(Boolean(data.redo));
          break;
        case "grove-design:edited":
          on.onEdited?.((data.anchor as PickedElement | null) ?? null);
          break;
        case "grove-design:located":
          on.onLocated?.(data.boxes as AnchorBoxes);
          break;
        case "grove-design:captured": {
          const resolve = pending.current.get(String(data.requestId));
          if (!resolve) break;
          pending.current.delete(String(data.requestId));
          const image = typeof data.image === "string" ? data.image.replace(/^data:image\/png;base64,/, "") : undefined;
          resolve({ image, report: data.report as DesignReport, error: data.error as string | undefined });
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId]);

  useEffect(() => {
    if (ready.current) sendRef.current("pick", { on: picking });
  }, [picking]);

  useEffect(() => {
    if (ready.current) sendRef.current("forward-wheel", { on: forwardWheel });
  }, [forwardWheel]);

  useEffect(() => {
    if (ready.current) sendRef.current("tree", { on: tree });
  }, [tree]);

  useEffect(() => {
    if (ready.current) sendRef.current("scale", { k: scale });
  }, [scale]);

  useEffect(() => {
    if (ready.current) sendRef.current("editable", { on: editable });
  }, [editable]);

  const anchorKey = JSON.stringify(anchors ?? []);
  useEffect(() => {
    if (ready.current) sendRef.current("locate", { anchors: JSON.parse(anchorKey) });
  }, [anchorKey]);

  useImperativeHandle(ref, () => ({
    capture: async () => {
      if (!ready.current) throw new Error("The page has not finished loading");
      const library = await screenshotLibrary();
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise<FrameCapture>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.current.delete(requestId);
          reject(new Error("Drawing the page took too long"));
        }, CAPTURE_TIMEOUT_MS);
        pending.current.set(requestId, (capture) => {
          window.clearTimeout(timer);
          resolve(capture);
        });
        sendRef.current("capture", { requestId, library, maxHeight: CAPTURE_MAX_HEIGHT });
      });
    },
    clearSelection: () => sendRef.current("clear"),
    select: (path) => sendRef.current("select", { path }),
    edit: (op) => sendRef.current("edit", { op }),
    setVariable: (name, value) => sendRef.current("variable", { name, value }),
  }), []);

  return (
    <iframe
      ref={frameRef}
      srcDoc={srcDoc}
      sandbox={SANDBOX}
      title={title}
      className="design-frame"
      style={{ width, height, pointerEvents: interactive ? "auto" : "none" }}
    />
  );
}
