// StarfieldEngine: camera, focus, frame loop and the card → night expand
// transition. React owns the DOM; the engine paints into the canvases it is
// given and reports focus / corner / phase changes back through hooks.
import { clamp, lerp, type InlineLook, type StarScene } from "./scene";
import { DEFAULT_PITCH, MAX_ZOOM, MIN_ZOOM, SkyPainter, hitTest, makeView, project, setViewport, type Camera, type FrameState, type InlineGround, type View } from "./render";

export type Phase = "card" | "expanding" | "expanded" | "collapsing";
export type Corner = "tl" | "tr" | "bl" | "br";
export interface FocusSnapshot { hoverIdx: number; pinIdx: number; focusIdx: number }
export interface EngineHooks {
  onFocus?: (focus: FocusSnapshot) => void;
  onCorner?: (corner: Corner) => void;
  onPhase?: (phase: Phase) => void;
}
interface Scheduler { raf: (cb: (now: number) => void) => number; caf: (id: number) => void; now: () => number }

/** Idle yaw drift, rad/s; the inline card drifts at half the night speed. */
export const IDLE_YAW = 0.022;
export const INLINE_IDLE = 0.5;
/** Orbit motion: card → night expand. */
export const EXPAND_MS = 600;
export const EXPAND_REDUCED_MS = 220;
const ORBIT_X = 0.0042, ORBIT_Y = 0.0036;
const INSET_TOP = 12, INSET_BOTTOM = 52;

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const smooth = (a: number, b: number, x: number) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

interface CardSurface { el: HTMLElement; painter: SkyPainter; view: View }
interface FullSurface { stage: HTMLElement; scrim: HTMLElement; inline: SkyPainter; night: SkyPainter; view: View }
interface Transition { dir: 1 | -1; start: number; dur: number; rect: { x: number; y: number; w: number; h: number }; p: number }
interface Drag { id: number; x0: number; y0: number; lx: number; ly: number; lt: number; moved: boolean }

export class StarfieldEngine {
  scene: StarScene | null = null;
  readonly cam: Camera = { yaw: 0.35, pitch: DEFAULT_PITCH, zoom: 1, vYaw: 0, vPitch: 0 };
  look: InlineLook = "light";
  phase: Phase = "card";
  private card: CardSurface | null = null;
  private full: FullSurface | null = null;
  private trans: Transition | null = null;
  private infoEl: HTMLElement | null = null;
  private corner: Corner = "tl";
  private t = 0;
  private lastNow = 0;
  private rafId = 0;
  private paused = false;
  private reduced = false;
  private visible = true;
  private pending = 0;
  private filterKey: string | null = null;
  private filter: Float32Array | null = null;
  private clusterFilter: Float32Array | null = null;
  private hoverIdx = -1;
  private pinIdx = -1;
  private focusIdx = -1;
  private focusAmt = 0;
  private focusSet = new Uint8Array(0);
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d0: number; z0: number } | null = null;
  private readonly sched: Scheduler;

  private readonly hooks: EngineHooks;

  constructor(hooks: EngineHooks = {}, scheduler?: Partial<Scheduler>) {
    this.hooks = hooks;
    const hasWindow = typeof window !== "undefined";
    this.sched = {
      raf: scheduler?.raf ?? ((cb) => (hasWindow ? window.requestAnimationFrame(cb) : 0)),
      caf: scheduler?.caf ?? ((id) => { if (hasWindow) window.cancelAnimationFrame(id); }),
      now: scheduler?.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now())),
    };
  }

  /* ------------------------------------------------------------- inputs */
  setScene(scene: StarScene) {
    const pinnedId = this.pinIdx >= 0 ? this.scene?.stars[this.pinIdx]?.e.entity_id : undefined;
    this.scene = scene;
    this.hoverIdx = -1;
    this.pinIdx = pinnedId ? scene.indexById.get(pinnedId) ?? -1 : -1;
    this.focusIdx = -2; // force a refresh
    this.applyFilter();
    this.refreshFocus();
    this.requestDraw();
  }
  setLook(look: InlineLook) { if (this.look !== look) { this.look = look; this.requestDraw(); } }
  setGround(look: InlineLook, ground: InlineGround) {
    if (this.card) this.card.painter.ground[look] = ground;
    if (this.full) this.full.inline.ground[look] = ground;
    this.requestDraw();
  }
  /** `paused`: the user's motion toggle; `reduced`: prefers-reduced-motion. Either stops all motion. */
  setMotion(paused: boolean, reduced: boolean) {
    this.paused = paused; this.reduced = reduced;
    if (this.still) { this.cam.vYaw = 0; this.cam.vPitch = 0; }
    this.requestDraw();
  }
  get still() { return this.paused || this.reduced; }
  setVisible(visible: boolean) { this.visible = visible; if (visible) this.requestDraw(); }
  setPending(count: number) { this.pending = Math.max(0, Math.floor(count)); this.requestDraw(); }
  /** Stars without a tag of this category dim; null clears. */
  setCategory(category: string | null | undefined) { this.filterKey = category ?? null; this.applyFilter(); this.requestDraw(); }
  private applyFilter() {
    const scene = this.scene;
    if (!scene || !this.filterKey) { this.filter = null; this.clusterFilter = null; return; }
    const key = this.filterKey;
    const filter = Float32Array.from(scene.stars, (st) => (st.e.tags.some((tag) => tag.key === key) ? 1 : 0.18));
    this.filter = filter;
    this.clusterFilter = Float32Array.from(scene.clusters, (c) => c.members.filter((i) => filter[i] === 1).length / Math.max(1, c.members.length));
  }
  setInfoElement(el: HTMLElement | null) { this.infoEl = el; }

  /* ----------------------------------------------------------- surfaces */
  attachCard(el: HTMLElement, canvas: HTMLCanvasElement) {
    this.card = { el, painter: new SkyPainter(canvas), view: makeView(1, 1, 1) };
    this.resize();
  }
  detachCard() { this.card = null; }
  attachFull(stage: HTMLElement, scrim: HTMLElement, inlineCanvas: HTMLCanvasElement, nightCanvas: HTMLCanvasElement) {
    this.full = { stage, scrim, inline: new SkyPainter(inlineCanvas), night: new SkyPainter(nightCanvas), view: makeView(1, 1, 1) };
    if (this.card) this.full.inline.ground = { ...this.card.painter.ground };
    this.resize();
    if (this.phase === "expanding" && !this.trans) this.beginTransition(1);
  }
  detachFull() { this.full = null; }

  private dpr() { return Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2); }

  resize() {
    const dpr = this.dpr();
    if (this.card) {
      const r = this.card.el.getBoundingClientRect();
      this.card.view = makeView(Math.max(1, r.width), Math.max(1, r.height), dpr);
      this.card.painter.resize(this.card.view);
    }
    if (this.full) {
      const W = Math.max(1, window.innerWidth), H = Math.max(1, window.innerHeight);
      const keep = this.trans ? { ...this.full.view } : null;
      this.full.view = makeView(W, H, dpr);
      if (keep) setViewport(this.full.view, keep.VX, keep.VY, keep.VW, keep.VH);
      this.full.night.resize(this.full.view);
      // The inline layer only shows mid-transition; keep it tiny otherwise.
      if (this.phase === "expanded") this.full.inline.resize(makeView(1, 1, 1));
      else this.full.inline.resize(this.full.view);
    }
    this.requestDraw();
  }

  /** The view that pointer coordinates and hit tests refer to. */
  private activeView(): View | null {
    if (this.phase === "expanded") return this.full?.view ?? null;
    if (this.phase === "card") return this.card?.view ?? null;
    return null;
  }

  /* ------------------------------------------------------------- focus */
  private refreshFocus() {
    const scene = this.scene;
    const idx = this.hoverIdx >= 0 ? this.hoverIdx : this.pinIdx;
    if (idx !== this.focusIdx) {
      this.focusIdx = idx;
      this.focusSet = new Uint8Array(scene?.n ?? 0);
      if (scene && idx >= 0) { this.focusSet[idx] = 2; for (const j of scene.nodes[idx].nb) this.focusSet[j] = 1; }
    }
    this.hooks.onFocus?.({ hoverIdx: this.hoverIdx, pinIdx: this.pinIdx, focusIdx: this.focusIdx });
    this.requestDraw();
  }
  get pinned() { return this.pinIdx; }
  pin(idx: number) { this.pinIdx = idx; this.refreshFocus(); }
  unpin() { if (this.pinIdx >= 0) { this.pinIdx = -1; this.refreshFocus(); } }
  setHover(idx: number) { if (idx !== this.hoverIdx) { this.hoverIdx = idx; this.refreshFocus(); } }

  /* ------------------------------------------------------- interactions */
  pointerDown(id: number, x: number, y: number) {
    this.pointers.set(id, { x, y });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.cam.zoom };
      this.drag = null;
      return;
    }
    this.drag = { id, x0: x, y0: y, lx: x, ly: y, lt: this.sched.now(), moved: false };
    this.cam.vYaw = 0; this.cam.vPitch = 0;
  }
  /** Returns true when the pointer is over a star (for the cursor). */
  pointerMove(id: number, x: number, y: number, touch: boolean): boolean {
    if (this.pointers.has(id)) this.pointers.set(id, { x, y });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.cam.zoom = clamp(this.pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d0), MIN_ZOOM, MAX_ZOOM);
      this.requestDraw();
      return false;
    }
    const drag = this.drag;
    if (drag && drag.id === id) {
      const dx = x - drag.lx, dy = y - drag.ly, now = this.sched.now(), dts = Math.max(1, now - drag.lt) / 1000;
      if (Math.hypot(x - drag.x0, y - drag.y0) > (touch ? 8 : 4)) drag.moved = true;
      if (drag.moved) {
        this.cam.yaw += dx * ORBIT_X;
        this.cam.pitch = clamp(this.cam.pitch + dy * ORBIT_Y, -1.1, 1.1);
        this.cam.vYaw = lerp(this.cam.vYaw, (dx * ORBIT_X) / dts, 0.3);
        this.cam.vPitch = lerp(this.cam.vPitch, (dy * ORBIT_Y) / dts, 0.3);
        if (this.hoverIdx >= 0) this.setHover(-1);
        this.requestDraw();
      }
      drag.lx = x; drag.ly = y; drag.lt = now;
      return false;
    }
    if (touch) return false;
    const hit = this.hit(x, y, false);
    this.setHover(hit);
    return hit >= 0;
  }
  pointerUp(id: number, x: number, y: number, touch: boolean) {
    this.pointers.delete(id);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    const drag = this.drag;
    if (!drag || drag.id !== id) return;
    this.drag = null;
    if (!drag.moved) {
      // Click toggles a star's pin; clicking empty space unpins.
      const hit = this.hit(x, y, touch);
      this.pinIdx = hit >= 0 && hit !== this.pinIdx ? hit : -1;
      this.hoverIdx = touch ? -1 : hit === this.pinIdx ? hit : -1;
      this.refreshFocus();
    }
    if (this.sched.now() - drag.lt > 80 || this.still) { this.cam.vYaw = 0; this.cam.vPitch = 0; }
    this.cam.vYaw = clamp(this.cam.vYaw, -1.2, 1.2);
    this.cam.vPitch = clamp(this.cam.vPitch, -0.8, 0.8);
    this.requestDraw();
  }
  pointerCancel(id: number) { this.pointers.delete(id); this.pinch = null; if (this.drag?.id === id) this.drag = null; }
  pointerLeave() { if (!this.drag) this.setHover(-1); }
  get dragging() { return Boolean(this.drag?.moved) || Boolean(this.pinch); }
  wheel(deltaY: number) { this.zoomBy(Math.exp(-deltaY * 0.0012)); }
  zoomBy(factor: number) { this.cam.zoom = clamp(this.cam.zoom * factor, MIN_ZOOM, MAX_ZOOM); this.requestDraw(); }
  fitView() { this.cam.zoom = 1; this.cam.pitch = DEFAULT_PITCH; this.cam.vYaw = 0; this.cam.vPitch = 0; this.requestDraw(); }
  private hit(x: number, y: number, touch: boolean) {
    const view = this.activeView();
    if (!this.scene || !view) return -1;
    project(this.scene, view, this.cam);
    return hitTest(this.scene, view, this.cam, x, y, touch);
  }

  /* --------------------------------------------------------- transition */
  /** Card → night. The caller mounts the full-window surface; the animation starts once it attaches. */
  expand() {
    if (this.phase !== "card") return;
    this.setHover(-1);
    this.setPhase("expanding");
    if (this.full) this.beginTransition(1);
  }
  collapse() {
    if (this.phase !== "expanded") return;
    this.setHover(-1);
    this.setPhase("collapsing");
    this.beginTransition(-1);
  }
  private setPhase(phase: Phase) { this.phase = phase; this.hooks.onPhase?.(phase); }
  private beginTransition(dir: 1 | -1) {
    const full = this.full;
    if (!full) return;
    const r = this.card?.el.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    const rect = r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: W * 0.1, y: H * 0.1, w: W * 0.8, h: H * 0.8 };
    this.trans = { dir, start: this.sched.now(), dur: this.reduced ? EXPAND_REDUCED_MS : EXPAND_MS, rect, p: dir > 0 ? 0 : 1 };
    this.resize();
    this.applyTransition(this.trans.p);
    this.requestDraw();
  }
  private applyTransition(p: number) {
    const full = this.full, tr = this.trans;
    if (!full || !tr) return;
    const { W, H } = full.view;
    if (this.reduced) {
      // Reduced motion: no growth, a plain crossfade.
      setViewport(full.view, 0, 0, W, H);
      full.stage.style.clipPath = "none";
      full.stage.style.opacity = String(p);
      full.night.canvas.style.opacity = "1";
      full.inline.canvas.style.opacity = "0";
      full.scrim.style.opacity = String(p * 0.9);
      return;
    }
    const e = easeInOut(p), R = tr.rect;
    setViewport(full.view, lerp(R.x, 0, e), lerp(R.y, 0, e), lerp(R.w, W, e), lerp(R.h, H, e));
    const v = full.view;
    full.stage.style.opacity = "1";
    full.stage.style.clipPath = `inset(${v.VY}px ${W - v.VX - v.VW}px ${H - v.VY - v.VH}px ${v.VX}px round ${lerp(12, 0, e)}px)`;
    // Night comes in over the first half so the white↔navy midpoint only lasts a few frames.
    full.night.canvas.style.opacity = String(smooth(0.06, 0.55, p));
    full.inline.canvas.style.opacity = "1";
    full.scrim.style.opacity = String(smooth(0, 0.6, p) * 0.94);
  }
  private finishTransition() {
    const tr = this.trans, full = this.full;
    this.trans = null;
    if (full) {
      full.stage.style.clipPath = ""; full.stage.style.opacity = "";
      full.night.canvas.style.opacity = ""; full.inline.canvas.style.opacity = "";
      full.scrim.style.opacity = tr?.dir === 1 ? "0.94" : "0";
    }
    this.setPhase(tr?.dir === 1 ? "expanded" : "card");
    this.resize();
  }

  /* --------------------------------------------------------------- loop */
  requestDraw() {
    if (this.rafId || !this.scene) return;
    this.rafId = this.sched.raf((now) => this.frame(now));
  }
  private frameState(): FrameState {
    return {
      cam: this.cam, t: this.t, still: this.still, focusIdx: this.focusIdx, focusAmt: this.focusAmt, focusSet: this.focusSet,
      hoverIdx: this.hoverIdx, pinIdx: this.pinIdx, filter: this.filter, clusterFilter: this.clusterFilter, pending: this.pending, insetTop: INSET_TOP, insetBottom: INSET_BOTTOM,
    };
  }
  /** One frame; exposed for tests. */
  frame(now: number) {
    this.rafId = 0;
    const scene = this.scene;
    if (!scene) return;
    const dt = this.lastNow ? clamp((now - this.lastNow) / 1000, 0, 0.05) : 0.016;
    this.lastNow = now;
    const still = this.still;
    if (!still) {
      this.t += dt;
      if (!this.drag && !this.pinch) {
        const idle = IDLE_YAW * (this.phase === "card" ? INLINE_IDLE : 1) * (this.focusIdx >= 0 ? 0.25 : 1);
        this.cam.yaw += (idle + this.cam.vYaw) * dt;
        this.cam.pitch = clamp(this.cam.pitch + this.cam.vPitch * dt, -1.1, 1.1);
        const k = Math.exp(-dt * 3.2);
        this.cam.vYaw *= k; this.cam.vPitch *= k;
      }
    }
    const target = this.focusIdx >= 0 ? 1 : 0;
    this.focusAmt = still ? target : lerp(this.focusAmt, target, 1 - Math.exp(-dt * 9));
    if (Math.abs(this.focusAmt - target) < 0.002) this.focusAmt = target;
    if (this.trans) {
      const raw = clamp((now - this.trans.start) / this.trans.dur, 0, 1);
      this.trans.p = this.trans.dir > 0 ? raw : 1 - raw;
      this.applyTransition(this.trans.p);
      if (raw >= 1) this.finishTransition();
    }
    this.paint();
    const animating = (!still && this.visible) || this.focusAmt !== target || this.trans !== null;
    if (animating && !this.rafId) this.rafId = this.sched.raf((n) => this.frame(n));
    else if (!this.rafId) this.lastNow = 0;
  }
  private paint() {
    const scene = this.scene!;
    const f = this.frameState();
    if (this.trans && this.full) {
      this.full.inline.paint(this.look, scene, this.full.view, f);
      this.full.night.paint("night", scene, this.full.view, f);
      return;
    }
    if (this.phase === "expanded" && this.full) {
      this.full.night.paint("night", scene, this.full.view, f);
      this.placeInfo(this.full.view);
      return;
    }
    if (this.phase === "card" && this.card && this.visible) {
      this.card.painter.paint(this.look, scene, this.card.view, f);
      this.placeInfo(this.card.view);
    }
  }
  /** Dock the info card in whichever corner doesn't cover the focused star. */
  private placeInfo(view: View) {
    const scene = this.scene, el = this.infoEl;
    if (!scene || !el || this.focusIdx < 0) return;
    const cw = el.offsetWidth, ch = el.offsetHeight, x = scene.px[this.focusIdx], y = scene.py[this.focusIdx], m = 28;
    const corners: Array<[Corner, number, number]> = [["tl", 12, 12], ["tr", view.W - cw - 12, 12], ["bl", 12, view.H - ch - INSET_BOTTOM], ["br", view.W - cw - 12, view.H - ch - INSET_BOTTOM]];
    const ok = corners.filter(([, cx, cy]) => !(x > cx - m && x < cx + cw + m && y > cy - m && y < cy + ch + m));
    const pick = ok.find((c) => c[0] === this.corner) ?? ok[0] ?? corners[0];
    if (pick[0] !== this.corner) { this.corner = pick[0]; this.hooks.onCorner?.(this.corner); }
  }

  destroy() {
    if (this.rafId) this.sched.caf(this.rafId);
    this.rafId = 0;
    this.card = null; this.full = null; this.scene = null;
  }
}
