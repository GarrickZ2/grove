import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "framer-motion";
import { Maximize2, Minimize2, Minus, Pause, Play, Plus, Scan } from "lucide-react";
import type { MemoryEntity, MemoryRelation } from "../../../api/memory";
import { useEscapeScope } from "../../../keyboard/useEscapeScope";
import { DialogLayerContext } from "../../ui/dialogLayerContext";
import { buildStarScene, hexRgb, type InlineLook, type RGB } from "./scene";
import { DEFAULT_GROUND } from "./render";
import { StarfieldEngine, type Corner, type FocusSnapshot, type Phase } from "./engine";
import "./starfield.css";

export interface StarfieldGraphProps {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
  /** "Read memory" on a pinned star. */
  onOpen: (entityId: string) => void;
  /** The inline card follows the app theme; the expanded view is always the night sky. */
  look: InlineLook;
  /** Stars without a tag of this category dim. */
  activeCategory?: string | null;
  /** Real pending-note count: that many unformed glimmers appear near constellations. */
  pendingCount?: number;
}

const NO_FOCUS: FocusSnapshot = { hoverIdx: -1, pinIdx: -1, focusIdx: -1 };

function parseColor(value: string): RGB | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return hexRgb(v);
  if (/^#[0-9a-f]{3}$/i.test(v)) return hexRgb(`#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`);
  const m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return m ? [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])] : null;
}

function relativePreviewDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
const humanize = (value: string) => value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

/** Pointer position relative to the element the handler sits on. */
function local(event: ReactPointerEvent<HTMLElement> | PointerEvent, el: HTMLElement): [number, number] {
  const r = el.getBoundingClientRect();
  return [event.clientX - r.left, event.clientY - r.top];
}

/**
 * Memory mind map as a star map. Inline it is a light or dark Orbit card;
 * Expand opens the full-window night sky with a continuous transition.
 */
export function StarfieldGraph({ entities, relations, onOpen, look, activeCategory, pendingCount = 0 }: StarfieldGraphProps) {
  const [focus, setFocus] = useState<FocusSnapshot>(NO_FOCUS);
  const [corner, setCorner] = useState<Corner>("tl");
  const [phase, setPhase] = useState<Phase>("card");
  const [paused, setPaused] = useState(false);
  const reduced = Boolean(useReducedMotion());
  const layer = useContext(DialogLayerContext);
  const coarse = useMemo(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches), []);
  const [engine] = useState(() => new StarfieldEngine({ onFocus: setFocus, onCorner: setCorner, onPhase: setPhase }));
  const scene = useMemo(() => (entities.length ? buildStarScene(entities, relations) : null), [entities, relations]);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const fullInlineRef = useRef<HTMLCanvasElement>(null);
  const nightRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { if (scene) engine.setScene(scene); }, [engine, scene]);
  useEffect(() => { engine.setMotion(paused, reduced); }, [engine, paused, reduced]);
  useEffect(() => { engine.setPending(pendingCount); }, [engine, pendingCount]);
  useEffect(() => { engine.setCategory(activeCategory); }, [engine, activeCategory]);
  useEffect(() => () => engine.destroy(), [engine]);

  // The inline ground, ink and accent come from the Orbit theme tokens.
  useLayoutEffect(() => {
    engine.setLook(look);
    const root = rootRef.current;
    if (!root || typeof getComputedStyle === "undefined") return;
    const cs = getComputedStyle(root);
    const fallback = DEFAULT_GROUND[look];
    engine.setGround(look, {
      ground: parseColor(cs.backgroundColor) ?? fallback.ground,
      ink: parseColor(cs.color) ?? fallback.ink,
      accent: parseColor(cs.getPropertyValue("--o-accent")) ?? fallback.accent,
    });
  }, [engine, look]);

  // Card surface: size, visibility (offscreen or hidden tab pauses the loop).
  useLayoutEffect(() => {
    const root = rootRef.current, canvas = canvasRef.current;
    if (!root || !canvas) return;
    engine.attachCard(root, canvas);
    let onScreen = true;
    const update = () => engine.setVisible(onScreen && document.visibilityState !== "hidden");
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => engine.resize()) : null;
    ro?.observe(root);
    const io = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => { onScreen = entries.some((entry) => entry.isIntersecting); update(); })
      : null;
    io?.observe(root);
    document.addEventListener("visibilitychange", update);
    return () => { ro?.disconnect(); io?.disconnect(); document.removeEventListener("visibilitychange", update); engine.detachCard(); };
  }, [engine]);

  // Full-window surface while expanding / expanded / collapsing.
  const fullOpen = phase !== "card";
  useLayoutEffect(() => {
    if (!fullOpen) return;
    const stage = stageRef.current, scrim = scrimRef.current, inline = fullInlineRef.current, night = nightRef.current;
    if (!stage || !scrim || !inline || !night) return;
    engine.attachFull(stage, scrim, inline, night);
    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); engine.detachFull(); };
  }, [engine, fullOpen]);

  // Esc unpins first, then closes the night sky.
  useEscapeScope(focus.pinIdx >= 0 || phase === "expanded", () => {
    if (engine.pinned >= 0) engine.unpin();
    else engine.collapse();
  });

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const targets = [canvasRef.current, nightRef.current].filter((el): el is HTMLCanvasElement => Boolean(el));
    const onWheel = (event: WheelEvent) => { event.preventDefault(); engine.wheel(event.deltaY); };
    targets.forEach((el) => el.addEventListener("wheel", onWheel, { passive: false }));
    return () => targets.forEach((el) => el.removeEventListener("wheel", onWheel));
  }, [engine, phase]);

  const pointer = useMemo(() => ({
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* pointer already gone */ }
      const [x, y] = local(event, event.currentTarget);
      engine.pointerDown(event.pointerId, x, y);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const [x, y] = local(event, event.currentTarget);
      const over = engine.pointerMove(event.pointerId, x, y, event.pointerType !== "mouse");
      event.currentTarget.style.cursor = engine.dragging ? "grabbing" : over ? "pointer" : "grab";
    },
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const [x, y] = local(event, event.currentTarget);
      engine.pointerUp(event.pointerId, x, y, event.pointerType !== "mouse");
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      event.currentTarget.style.cursor = "grab";
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLCanvasElement>) => engine.pointerCancel(event.pointerId),
    onPointerLeave: () => engine.pointerLeave(),
    onDoubleClick: () => engine.fitView(),
  }), [engine]);

  const infoRef = useCallback((el: HTMLElement | null) => engine.setInfoElement(el), [engine]);
  const focused = scene && focus.focusIdx >= 0 ? scene.stars[focus.focusIdx] : null;
  const pinned = focused !== null && focus.focusIdx === focus.pinIdx;
  const cluster = focused && scene ? scene.clusters[focused.comm] : null;
  const accent = cluster ? `rgb(${(phase === "card" ? cluster.inl[look] : cluster.rgb).join(",")})` : undefined;

  const info = focused ? (
    <article ref={infoRef} className={`osf-info is-${corner}${pinned ? " is-pinned" : ""}`} aria-label={`Preview ${focused.e.title}`} style={accent ? { ["--osf-star" as string]: accent } : undefined}>
      <div className="osf-info-bar" />
      <div className="osf-info-body">
        <div className="osf-info-head">
          <div className="osf-info-titles">
            <p className="osf-info-eyebrow">Memory document{cluster && !cluster.stray ? ` · ${humanize(cluster.name)}` : ""}</p>
            <h3>{focused.e.title}</h3>
          </div>
          <span className="osf-info-score" title={`Score ${focused.e.score}`}>{focused.e.score}</span>
        </div>
        {focused.e.description ? <p className="osf-info-desc">{focused.e.description}</p> : null}
        {focused.e.tags.length > 0 ? (
          <div className="osf-info-tags">
            {focused.e.tags.slice(0, 4).map((tag) => <span key={`${tag.key}:${tag.value}`}>{tag.icon ? `${tag.icon} ` : ""}{humanize(tag.key)} · {tag.value}</span>)}
          </div>
        ) : null}
      </div>
      <div className="osf-info-foot">
        <span>Updated {relativePreviewDate(focused.e.updated_at)}</span>
        {pinned ? (
          <button type="button" className="osf-read" onClick={() => onOpen(focused.e.entity_id)}>Read memory</button>
        ) : <span>{coarse ? "Tap" : "Click"} to pin</span>}
      </div>
    </article>
  ) : null;

  const tools = (night: boolean) => (
    <div className="osf-tools" role="toolbar" aria-label="Mind map controls">
      <button type="button" onClick={() => engine.zoomBy(1.18)} title="Zoom in" aria-label="Zoom in"><Plus /></button>
      <button type="button" onClick={() => engine.zoomBy(1 / 1.18)} title="Zoom out" aria-label="Zoom out"><Minus /></button>
      <button type="button" onClick={() => setPaused((value) => !value)} title={paused ? "Resume motion" : "Pause motion"} aria-label={paused ? "Resume motion" : "Pause motion"} aria-pressed={paused}>{paused ? <Play /> : <Pause />}</button>
      <button type="button" onClick={() => engine.fitView()} title="Reset view" aria-label="Reset view"><Scan /></button>
      <span className="osf-tools-sep" />
      {night
        ? <button type="button" onClick={() => engine.collapse()} title="Close (Esc)" aria-label="Close night sky"><Minimize2 /></button>
        : <button type="button" onClick={() => engine.expand()} title="Open the night sky" aria-label="Expand mind map"><Maximize2 /></button>}
    </div>
  );

  const hooks = scene ? {
    "data-memory-node-radii": scene.stars.map((st) => `${st.e.score}:${st.r.toFixed(2)}`).join(","),
    "data-memory-relation-widths": scene.links.map((l) => `${l.r.score}:${(0.55 + 0.35 * l.w).toFixed(2)}`).join(","),
    "data-memory-constellations": String(scene.clusters.filter((c) => !c.stray).length),
  } : {};

  return (
    <div ref={rootRef} className={`osf is-${look}`} data-memory-look={look} data-memory-phase={phase} {...hooks}>
      <canvas
        ref={canvasRef}
        className="osf-canvas"
        role="img"
        aria-label={`Memory star map: ${entities.length} memories, ${scene?.links.length ?? 0} links`}
        {...pointer}
      />
      {phase === "card" ? info : null}
      {tools(false)}
      {coarse ? null : <span className="osf-hint" aria-hidden="true">Hover a star · click to pin · drag to orbit</span>}
      {fullOpen && typeof document !== "undefined" ? createPortal(
        <div className={`osf-full${phase === "expanded" ? " is-open" : ""}`} style={{ zIndex: Math.max(60, layer) }} role="dialog" aria-modal="true" aria-label="Memory night sky">
          <div ref={scrimRef} className="osf-scrim" />
          <div ref={stageRef} className="osf-stage">
            <canvas ref={fullInlineRef} className="osf-canvas osf-canvas-under" aria-hidden="true" />
            <canvas ref={nightRef} className="osf-canvas" role="img" aria-label="Memory night sky" {...pointer} />
            {phase === "expanded" ? info : null}
            {tools(true)}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
