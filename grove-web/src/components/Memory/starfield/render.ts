// Starfield painters. One scene, three paints: "night" (the full-window sky,
// additive glow), and the inline card in the app's "light" or "dark" theme.
// Everything here is imperative canvas code driven by StarfieldEngine.
import { TAU, clamp, hash32, lerp, mix, rgba, rng, type Cluster, type InlineLook, type RGB, type StarScene } from "./scene";

export type Look = "night" | InlineLook;

export interface Camera { yaw: number; pitch: number; zoom: number; vYaw: number; vPitch: number }
export const CAM_DIST = 3.6;
export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 3.2;
export const DEFAULT_PITCH = -0.24;

/** Canvas size plus the projection viewport (equal to the canvas except mid-expand). */
export interface View {
  W: number; H: number; DPR: number;
  VX: number; VY: number; VW: number; VH: number;
  /** Small cards → smaller stars. */
  viewK: number;
}
export function makeView(W: number, H: number, DPR: number): View {
  const view = { W, H, DPR, VX: 0, VY: 0, VW: W, VH: H, viewK: 1 };
  setViewport(view, 0, 0, W, H);
  return view;
}
export function setViewport(view: View, x: number, y: number, w: number, h: number) {
  view.VX = x; view.VY = y; view.VW = Math.max(1, w); view.VH = Math.max(1, h);
  view.viewK = clamp(Math.sqrt(Math.min(view.VW, view.VH) / 820), 0.74, 1.12);
}

/** What a frame needs besides the scene and the view. */
export interface FrameState {
  cam: Camera;
  /** Animation clock in seconds (frozen when motion is off). */
  t: number;
  still: boolean;
  focusIdx: number;
  focusAmt: number;
  /** 2 = focused star, 1 = its neighbour. */
  focusSet: Uint8Array;
  hoverIdx: number;
  pinIdx: number;
  /** Per-star dimming from the category filter (1 = matches), or null. */
  filter: Float32Array | null;
  /** Per-constellation share of matching stars (for nebula dimming), or null. */
  clusterFilter: Float32Array | null;
  /** How many pending-note glimmers to show (from the real pending count). */
  pending: number;
  /** Screen space reserved at the top and bottom (controls), in CSS px. */
  insetTop: number;
  insetBottom: number;
}

interface Projection { cy: number; sy: number; cp: number; sp: number; unit: number; ox: number; oy: number }

function fitUnit(scene: StarScene, view: View) {
  // Rotation-stable fit: xz radius against width, y extent against height.
  const pad = view.VW < 600 ? 0.48 : 0.44;
  return Math.min((view.VW * pad) / scene.fitXZ, (view.VH * 0.42) / (scene.fitY + 0.18 * scene.fitXZ));
}

/** Project every star into the view; re-sorts `scene.order` far → near. */
export function project(scene: StarScene, view: View, cam: Camera): Projection {
  const { P, n, px, py, ps, pd } = scene;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const unit = fitUnit(scene, view) * cam.zoom, ox = view.VX + view.VW / 2, oy = view.VY + view.VH / 2 + (view.VW < 600 ? 10 : 6);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const s = CAM_DIST / (CAM_DIST + z2);
    px[i] = ox + x1 * s * unit; py[i] = oy + y2 * s * unit; ps[i] = s; pd[i] = clamp((1.25 - z2) / 2.5, 0, 1);
  }
  scene.order.sort((a, b) => pd[a] - pd[b]);
  return { cy, sy, cp, sp, unit, ox, oy };
}
function projectPoint(x: number, y: number, z: number, T: Projection): [number, number, number, number] {
  const x1 = x * T.cy + z * T.sy, z1 = -x * T.sy + z * T.cy;
  const y2 = y * T.cp - z1 * T.sp, z2 = y * T.sp + z1 * T.cp;
  const s = CAM_DIST / (CAM_DIST + z2);
  return [T.ox + x1 * s * T.unit, T.oy + y2 * s * T.unit, s, clamp((1.25 - z2) / 2.5, 0, 1)];
}

/** Nearest star under (x, y) in view space, preferring near stars; -1 for none. Uses the last projection. */
export function hitTest(scene: StarScene, view: View, cam: Camera, x: number, y: number, touch = false) {
  const { stars, px, py, ps, pd, order } = scene;
  let best = -1, bestD = Infinity;
  const minR = touch ? 18 : 9;
  for (let o = order.length - 1; o >= 0; o--) {
    const i = order[o];
    const r = Math.max(minR, stars[i].r * ps[i] * view.viewK * Math.sqrt(cam.zoom) * 2.4);
    const d = Math.hypot(px[i] - x, py[i] - y);
    if (d < r) { const score = d / r - pd[i] * 0.15; if (score < bestD) { bestD = score; best = i; } }
  }
  return best;
}

export function starDim(scene: StarScene, f: FrameState, i: number) {
  let dim = f.filter ? f.filter[i] : 1;
  if (f.focusIdx >= 0 && f.focusAmt > 0) {
    const s = f.focusSet[i];
    const target = s === 2 ? 1.25 : s === 1 ? 1.1 : scene.stars[i].comm === scene.stars[f.focusIdx].comm ? 0.45 : 0.2;
    dim *= lerp(1, target, f.focusAmt);
  }
  return dim;
}
function linkCtrl(x0: number, y0: number, x1: number, y1: number, phase: number): [number, number] {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0;
  const k = (phase < 0.5 ? -1 : 1) * (0.07 + phase * 0.05);
  return [mx - dy * k, my + dx * k];
}
function bez(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number): [number, number] {
  const u = 1 - t;
  return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
}

/* ---------------------------------------------------------------- sprites */
function makeCanvas(w: number, h: number) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function radialSprite(size: number, stops: Array<[number, string]>) {
  const c = makeCanvas(size, size), x = c.getContext("2d");
  if (!x) return c;
  const h = size / 2, gr = x.createRadialGradient(h, h, 0, h, h, h);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  x.fillStyle = gr; x.fillRect(0, 0, size, size);
  return c;
}
interface NightSprites { glow: HTMLCanvasElement; core: HTMLCanvasElement; neb: HTMLCanvasElement; spike: HTMLCanvasElement }
const nightCache = new Map<string, NightSprites>();
function sprites(rgb: RGB): NightSprites {
  const key = rgb.join(",");
  const hit = nightCache.get(key);
  if (hit) return hit;
  const white = mix(rgb, [255, 255, 255], 0.75);
  const glowStops: Array<[number, string]> = [];
  for (let k = 0; k <= 12; k++) { const o = k / 12; glowStops.push([o, rgba(rgb, (Math.exp(-o * o * 7) * 0.9 + Math.exp(-o * 26) * 0.6) * (1 - o))]); }
  const nebStops: Array<[number, string]> = [];
  for (let k = 0; k <= 14; k++) { const o = k / 14; nebStops.push([o, rgba(rgb, Math.exp(-o * o * 4.2) * (1 - o * o))]); }
  const S = 256, spike = makeCanvas(S, S), sx = spike.getContext("2d"), h = S / 2;
  if (sx) {
    for (const horiz of [true, false]) {
      const gr = horiz ? sx.createLinearGradient(0, h, S, h) : sx.createLinearGradient(h, 0, h, S);
      gr.addColorStop(0, rgba(rgb, 0)); gr.addColorStop(0.36, rgba(rgb, 0.12)); gr.addColorStop(0.47, rgba(white, 0.55));
      gr.addColorStop(0.5, "rgba(255,255,255,0.95)"); gr.addColorStop(0.53, rgba(white, 0.55)); gr.addColorStop(0.64, rgba(rgb, 0.12)); gr.addColorStop(1, rgba(rgb, 0));
      sx.fillStyle = gr;
      if (horiz) { sx.fillRect(0, h - 0.75, S, 1.5); sx.globalAlpha = 0.35; sx.fillRect(0, h - 2, S, 4); sx.globalAlpha = 1; }
      else { sx.fillRect(h - 0.75, 0, 1.5, S); sx.globalAlpha = 0.35; sx.fillRect(h - 2, 0, 4, S); sx.globalAlpha = 1; }
    }
  }
  const out = {
    glow: radialSprite(128, glowStops),
    core: radialSprite(64, [[0, "rgba(255,255,255,1)"], [0.16, rgba(white, 0.98)], [0.32, rgba(rgb, 0.55)], [0.55, rgba(rgb, 0.12)], [1, rgba(rgb, 0)]]),
    neb: radialSprite(256, nebStops),
    spike,
  };
  nightCache.set(key, out);
  return out;
}
interface LightSprites { core: HTMLCanvasElement; halo: HTMLCanvasElement; spike: HTMLCanvasElement }
const lightCache = new Map<string, LightSprites>();
/** Light: saturated core, lighter centre, darker rim; soft tinted halo; fine spikes. */
function lsprites(rgb: RGB): LightSprites {
  const key = rgb.join(",");
  const hit = lightCache.get(key);
  if (hit) return hit;
  const hi = mix(rgb, [255, 255, 255], 0.42), lo = mix(rgb, [0, 0, 0], 0.3);
  const hs: Array<[number, string]> = [];
  for (let k = 0; k <= 12; k++) { const o = k / 12; hs.push([o, rgba(rgb, 0.34 * Math.exp(-o * o * 5) * (1 - o))]); }
  const S = 256, spike = makeCanvas(S, S), sx = spike.getContext("2d"), h = S / 2;
  if (sx) {
    for (const horiz of [true, false]) {
      const gr = horiz ? sx.createLinearGradient(0, h, S, h) : sx.createLinearGradient(h, 0, h, S);
      gr.addColorStop(0, rgba(rgb, 0)); gr.addColorStop(0.4, rgba(rgb, 0.18)); gr.addColorStop(0.5, rgba(rgb, 0.8)); gr.addColorStop(0.6, rgba(rgb, 0.18)); gr.addColorStop(1, rgba(rgb, 0));
      sx.fillStyle = gr;
      if (horiz) sx.fillRect(0, h - 0.6, S, 1.2); else sx.fillRect(h - 0.6, 0, 1.2, S);
    }
  }
  const out = {
    core: radialSprite(64, [[0, rgba(hi, 1)], [0.3, rgba(rgb, 1)], [0.58, rgba(rgb, 1)], [0.68, rgba(lo, 0.95)], [0.76, rgba(lo, 0.22)], [1, rgba(lo, 0)]]),
    halo: radialSprite(128, hs),
    spike,
  };
  lightCache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------- dust */
interface Dust { u: number; v: number; layer: 0 | 1 | 2; s: number; b: number; tw: boolean; ph: number; f: number; col: string; sparkle: boolean }
const PARALLAX = [0.05, 0.13, 0.28];
let dustPool: Dust[] | null = null;
function dust(): Dust[] {
  if (dustPool) return dustPool;
  const R = rng(1337), out: Dust[] = [];
  for (let k = 0; k < 1500; k++) {
    const band = R() < 0.32;
    const u = R();
    const v = band ? 0.52 + (u - 0.5) * -0.42 + (R() + R() + R() - 1.5) * 0.1 : R();
    const lr = R();
    const layer = (lr < 0.62 ? 0 : lr < 0.9 ? 1 : 2) as 0 | 1 | 2;
    const warm = R();
    const tint = warm < 0.12 ? [255, 214, 170] : warm < 0.3 ? [180, 200, 255] : [225, 232, 255];
    out.push({
      u, v: ((v % 1) + 1) % 1, layer, s: [0.55, 0.85, 1.25][layer] * (0.7 + R() * 0.6), b: [0.32, 0.5, 0.72][layer] * (0.45 + R() * 0.55),
      tw: R() < 0.4, ph: R() * TAU, f: 0.5 + R() * 2.2, col: `rgb(${tint[0]},${tint[1]},${tint[2]})`, sparkle: layer === 2 && R() < 0.35,
    });
  }
  dustPool = out;
  return out;
}

/* ------------------------------------------------------------------ looks */
interface LabelStyle { shadow: string | null; halo: string | null; fill: string; fill3: string; sub: (c: Cluster) => string; subA: number; aK: number }
const NIGHT_LABELS: LabelStyle = { shadow: "rgba(2,4,12,0.9)", halo: null, fill: "rgb(238,242,255)", fill3: "rgb(206,218,250)", sub: (c) => rgba(mix(c.rgb, [255, 255, 255], 0.3), 1), subA: 0.62, aK: 1 };

/** Theme-derived ground for the inline card (read from the Orbit tokens). */
export interface InlineGround { ground: RGB; ink: RGB; accent: RGB }
export const DEFAULT_GROUND: Record<InlineLook, InlineGround> = {
  light: { ground: [249, 249, 248], ink: [28, 27, 25], accent: [5, 150, 105] },
  dark: { ground: [22, 22, 21], ink: [236, 235, 232], accent: [42, 170, 140] },
};
interface InlineStyle {
  gridA: number; washA: number; dust: RGB; cross: string; blend: GlobalCompositeOperation; nebA: number; lineK: number; hotK: number; labels: LabelStyle;
}
function inlineStyle(lk: InlineLook, g: InlineGround): InlineStyle {
  const light = lk === "light";
  return {
    gridA: light ? 0.085 : 0.05,
    washA: light ? 0.05 : 0.06,
    dust: light ? mix(g.ink, g.ground, 0.45) : mix(g.ink, g.ground, 0.3),
    cross: light ? "rgb(112,116,128)" : "rgb(150,156,172)",
    blend: light ? "source-over" : "lighter",
    nebA: light ? 0.1 : 0.11,
    lineK: light ? 1.65 : 1.25,
    hotK: light ? 3.4 : 3.6,
    labels: {
      shadow: null, halo: rgba(g.ground, 0.92), fill: rgba(g.ink, 1), fill3: rgba(mix(g.ink, g.ground, 0.22), 1),
      sub: (c) => c.inlStr[lk], subA: light ? 0.9 : 0.78, aK: light ? 1.3 : 1.15,
    },
  };
}

const NEB_SCALE = 0.25;
const FONT = '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';

/** Paints one look into one canvas. Owns its context and offscreen buffers. */
export class SkyPainter {
  readonly ctx: CanvasRenderingContext2D | null;
  private neb: HTMLCanvasElement | null = null;
  private nebCtx: CanvasRenderingContext2D | null = null;
  private bg: HTMLCanvasElement | null = null;
  private bgKey = "";
  private grid: { key: string; pattern: CanvasPattern | null } = { key: "", pattern: null };
  ground: Record<InlineLook, InlineGround> = { ...DEFAULT_GROUND };

  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
    this.ctx = ctx;
  }

  resize(view: View) {
    const w = Math.max(1, Math.round(view.W * view.DPR)), h = Math.max(1, Math.round(view.H * view.DPR));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (!this.ctx) return;
    if (!this.neb) { this.neb = makeCanvas(4, 4); this.nebCtx = this.neb.getContext("2d"); }
    this.neb.width = Math.max(4, Math.round(view.W * NEB_SCALE));
    this.neb.height = Math.max(4, Math.round(view.H * NEB_SCALE));
  }

  paint(look: Look, scene: StarScene, view: View, f: FrameState) {
    // No 2D context (e.g. jsdom): still project, so hit tests keep working.
    if (!this.ctx) { project(scene, view, f.cam); return; }
    if (look === "night") this.paintNight(scene, view, f);
    else this.paintInline(look, scene, view, f);
  }

  private nightBackground(view: View) {
    const key = `${view.W}x${view.H}@${view.DPR}`;
    if (this.bg && this.bgKey === key) return this.bg;
    const { W, H, DPR } = view;
    const bg = makeCanvas(Math.round(W * DPR), Math.round(H * DPR)), b = bg.getContext("2d");
    this.bg = bg; this.bgKey = key;
    if (!b) return bg;
    b.scale(DPR, DPR);
    const lg = b.createLinearGradient(0, 0, W * 0.3, H);
    lg.addColorStop(0, "#0c1533"); lg.addColorStop(0.45, "#070b1d"); lg.addColorStop(1, "#03040a");
    b.fillStyle = lg; b.fillRect(0, 0, W, H);
    const soft = (x: number, y: number, r: number, col: RGB, a: number) => {
      const gr = b.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
      b.fillStyle = gr; b.fillRect(0, 0, W, H);
    };
    const D = Math.max(W, H);
    soft(W * 0.72, H * 0.18, D * 0.55, [40, 62, 140], 0.22);
    soft(W * 0.18, H * 0.85, D * 0.45, [70, 40, 110], 0.12);
    b.save(); b.translate(W / 2, H * 0.52); b.rotate(Math.atan2(-0.42 * H, W)); b.scale(1, 0.16);
    const band = b.createRadialGradient(0, 0, 0, 0, 0, D * 0.7);
    band.addColorStop(0, "rgba(120,140,210,0.07)"); band.addColorStop(1, "rgba(120,140,210,0)");
    b.fillStyle = band; b.fillRect(-D, -D * 3, D * 2, D * 6); b.restore();
    const vg = b.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,6,0.55)");
    b.fillStyle = vg; b.fillRect(0, 0, W, H);
    return bg;
  }

  private paintNebulae(scene: StarScene, view: View, f: FrameState, T: Projection, blend: GlobalCompositeOperation, color: (b: StarScene["blobs"][number]) => RGB, alphaK: number, depthBase: number, focusBoost: number) {
    const ctx = this.ctx, nc = this.nebCtx, neb = this.neb;
    if (!ctx || !nc || !neb) return;
    nc.setTransform(1, 0, 0, 1, 0, 0);
    nc.globalCompositeOperation = "source-over"; nc.clearRect(0, 0, neb.width, neb.height);
    nc.globalCompositeOperation = blend;
    const sx = neb.width / view.W, sy = neb.height / view.H;
    for (const b of scene.blobs) {
      const [x, y, s, dep] = projectPoint(b.x, b.y, b.z, T);
      const r = Math.min(b.rad * s * T.unit, Math.min(view.VW, view.VH) * 0.42);
      let dim = 1;
      if (f.focusIdx >= 0) dim = lerp(1, b.comm === scene.stars[f.focusIdx].comm ? focusBoost : 0.45, f.focusAmt);
      if (f.clusterFilter) dim *= lerp(0.25, 1, f.clusterFilter[b.comm]);
      nc.globalAlpha = clamp(b.a * alphaK * (depthBase + (1 - depthBase) * dep) * dim, 0, 1);
      nc.drawImage(sprites(color(b)).neb, (x - r) * sx, (y - r) * sy, 2 * r * sx, 2 * r * sy);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(neb, 0, 0, view.W, view.H);
  }

  private paintNight(scene: StarScene, view: View, f: FrameState) {
    const ctx = this.ctx!;
    const T = project(scene, view, f.cam);
    const { stars, links, px, py, ps, pd, order } = scene;
    const { W, H } = view, t = f.t, still = f.still, cam = f.cam;
    ctx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.drawImage(this.nightBackground(view), 0, 0, W, H);

    // dust with parallax by layer
    ctx.globalCompositeOperation = "lighter";
    const pool = dust();
    const dustN = Math.round(0.5 * pool.length * clamp((W * H) / (1440 * 900), 0.35, 1.2));
    const offX = cam.yaw * W, offY = cam.pitch * H;
    for (let k = 0; k < dustN; k++) {
      const d = pool[k], par = PARALLAX[d.layer];
      let x = (d.u * W - offX * par) % W; if (x < 0) x += W;
      let y = (d.v * H - offY * par) % H; if (y < 0) y += H;
      let a = d.b * (f.focusAmt > 0 ? 1 - f.focusAmt * 0.35 : 1);
      if (d.tw && !still) a *= 1 + 0.45 * Math.sin(t * d.f + d.ph);
      if (a <= 0.01) continue;
      if (d.sparkle) { ctx.globalAlpha = clamp(a * 0.5, 0, 1); const s = d.s * 4.5; ctx.drawImage(sprites([200, 212, 238]).glow, x - s, y - s, s * 2, s * 2); }
      ctx.globalAlpha = clamp(a, 0, 1); ctx.fillStyle = d.col; ctx.fillRect(x - d.s / 2, y - d.s / 2, d.s, d.s);
    }

    this.paintNebulae(scene, view, f, T, "lighter", (b) => b.rgb, 0.2, 0.55, 1.3);

    // pending-note glimmers: unformed light inside the nebulae
    for (let q = 0; q < Math.min(f.pending, scene.glimmers.length); q++) {
      const gm = scene.glimmers[q];
      const [x, y, s, dep] = projectPoint(gm.x, gm.y, gm.z, T);
      const life = still ? 0.6 : 0.5 + 0.5 * Math.sin((t / gm.period) * TAU + gm.phase);
      const a = 0.22 * life * life * (0.5 + 0.5 * dep) * (1 - f.focusAmt * 0.6);
      if (a < 0.01) continue;
      const r = (5 + 5 * life) * s;
      ctx.globalAlpha = a; ctx.drawImage(sprites(gm.rgb).glow, x - r, y - r, 2 * r, 2 * r);
      ctx.globalAlpha = a * 1.6; ctx.fillStyle = "rgba(235,240,255,1)"; ctx.fillRect(x - 0.4, y - 0.4, 0.8, 0.8);
    }

    // constellation lines
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const nLinkScale = clamp(1.25 - Math.log10(Math.max(links.length, 1)) * 0.22, 0.6, 1);
    for (const l of links) {
      const a = l.s, b = l.t, sa = stars[a], sb = stars[b];
      let alpha = (0.07 + 0.13 * l.w) * nLinkScale * (0.35 + (0.65 * (pd[a] + pd[b])) / 2);
      if (f.filter) alpha *= Math.min(f.filter[a], f.filter[b]);
      let width = 0.55 + 0.35 * l.w;
      if (f.focusIdx >= 0 && f.focusAmt > 0) {
        const hot = a === f.focusIdx || b === f.focusIdx;
        const inComm = sa.comm === stars[f.focusIdx].comm && sb.comm === stars[f.focusIdx].comm;
        alpha *= lerp(1, hot ? 4.2 : inComm ? 0.9 : 0.18, f.focusAmt);
        if (hot) width = lerp(width, 1.05, f.focusAmt);
      }
      if (alpha < 0.004) continue;
      const x0 = px[a], y0 = py[a], x1 = px[b], y1 = py[b];
      const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.strokeStyle = sa.comm === sb.comm ? scene.clusters[sa.comm].lineStr : "rgb(176,190,228)";
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1); ctx.stroke();
    }

    // light pulses: outward along the focused star's links, or a rare ambient one
    if (!still) {
      if (f.focusIdx >= 0 && f.focusAmt > 0.2) {
        const spr = sprites(scene.clusters[stars[f.focusIdx].comm].rgb).glow;
        for (const l of links) {
          if (l.s !== f.focusIdx && l.t !== f.focusIdx) continue;
          const x0 = px[l.s], y0 = py[l.s], x1 = px[l.t], y1 = py[l.t];
          const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
          const ph = (t * 0.5 + l.phase) % 1;
          const [x, y] = bez(x0, y0, cx, cy, x1, y1, f.focusIdx === l.s ? ph : 1 - ph);
          const a = Math.sin(Math.PI * ph) * f.focusAmt * 0.9;
          ctx.globalAlpha = a; ctx.drawImage(spr, x - 7, y - 7, 14, 14);
          ctx.globalAlpha = a * 0.9; ctx.fillStyle = "#fff"; ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
        }
      } else if (links.length) {
        const period = 3.4, round = Math.floor(t / period), ph = (t % period) / 1.8;
        if (ph < 1) {
          const l = links[hash32(`pulse${round}`, 4) % links.length];
          const x0 = px[l.s], y0 = py[l.s], x1 = px[l.t], y1 = py[l.t];
          const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
          const [x, y] = bez(x0, y0, cx, cy, x1, y1, ph);
          ctx.globalAlpha = Math.sin(Math.PI * ph) * 0.45;
          ctx.drawImage(sprites(scene.clusters[stars[l.s].comm].rgb).glow, x - 5, y - 5, 10, 10);
        }
      }
    }

    // stars, far → near
    for (let o = 0; o < order.length; o++) {
      const i = order[o], st = stars[i], dep = pd[i], s = ps[i];
      const spr = sprites(scene.clusters[st.comm].rgb);
      let tw = 1;
      if (!still) tw = 1 + (0.16 + 0.16 * (1 - st.m)) * (Math.sin(t * st.freq + st.phase) * 0.65 + Math.sin(t * st.freq2 + st.phase2) * 0.35);
      const r = Math.max(0.55, st.r * s * view.viewK * Math.sqrt(cam.zoom) * (0.8 + 0.2 * dep));
      let a = clamp(st.bright * (0.42 + 0.58 * dep) * tw * starDim(scene, f, i), 0, 1.4);
      if (f.focusSet[i] && f.focusAmt > 0) a = Math.max(a, 0.78 * f.focusAmt);
      const x = px[i], y = py[i];
      if (st.m > 0.5) {
        const g = r * (3.4 + 3.6 * st.m) * (1.15 - 0.3 * dep);
        ctx.globalAlpha = clamp(a * (st.m - 0.45) * 1.5, 0, 1);
        ctx.drawImage(spr.glow, x - g, y - g, g * 2, g * 2);
      }
      if (st.spike) {
        const L = r * 9.5 * (0.85 + 0.15 * tw);
        ctx.globalAlpha = clamp(a * 0.55, 0, 1);
        ctx.drawImage(spr.spike, x - L, y - L, L * 2, L * 2);
      }
      const c = r * 2.3 * (1.1 - 0.15 * dep);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.drawImage(spr.core, x - c, y - c, c * 2, c * 2);
    }
    this.reticle(scene, view, f, "rgba(225,233,255,1)", 0.55, 0.32, 2.2);
    this.labels(scene, view, f, NIGHT_LABELS);
    ctx.globalAlpha = 1;
  }

  private gridPattern(lk: InlineLook, view: View, g: InlineGround) {
    const key = `${lk}${view.DPR}${g.ink.join()}`;
    if (this.grid.key === key) return this.grid.pattern;
    const size = 22, c = makeCanvas(Math.round(size * view.DPR), Math.round(size * view.DPR)), x = c.getContext("2d");
    let pattern: CanvasPattern | null = null;
    if (x && this.ctx) {
      x.scale(view.DPR, view.DPR);
      x.fillStyle = rgba(g.ink, inlineStyle(lk, g).gridA);
      x.beginPath(); x.arc(size / 2, size / 2, 0.85, 0, TAU); x.fill();
      pattern = this.ctx.createPattern(c, "repeat");
      if (pattern && typeof DOMMatrix !== "undefined") pattern.setTransform(new DOMMatrix().scale(1 / view.DPR));
    }
    this.grid = { key, pattern };
    return pattern;
  }

  private paintInline(lk: InlineLook, scene: StarScene, view: View, f: FrameState) {
    const ctx = this.ctx!;
    const g = this.ground[lk], S = inlineStyle(lk, g), light = lk === "light";
    const T = project(scene, view, f.cam);
    const { stars, links, px, py, ps, pd, order } = scene;
    const { W, H, VX, VY, VW, VH } = view, t = f.t, still = f.still, cam = f.cam;
    ctx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    // ground: the card colour, a soft accent wash and a faint dot grid (Orbit graph board)
    ctx.fillStyle = rgba(g.ground, 1); ctx.fillRect(0, 0, W, H);
    const wx = VX + VW / 2, wy = VY + VH * 0.42, wr = Math.max(VW, VH) * 0.62;
    const wash = ctx.createRadialGradient(wx, wy, 0, wx, wy, wr);
    wash.addColorStop(0, rgba(g.accent, S.washA)); wash.addColorStop(1, rgba(g.accent, 0));
    ctx.fillStyle = wash; ctx.fillRect(0, 0, W, H);
    const pattern = this.gridPattern(lk, view, g);
    if (pattern) { ctx.save(); ctx.translate(VX, VY); ctx.fillStyle = pattern; ctx.fillRect(-VX, -VY, W, H); ctx.restore(); }

    // nebulae as watercolour washes
    this.paintNebulae(scene, view, f, T, S.blend, (b) => (light ? mix(scene.clusters[b.comm].inl.light, [255, 255, 255], 0.2) : scene.clusters[b.comm].inl.dark), S.nebA, 0.6, 1.35);

    // dust: faint specks with depth parallax, a few tinted
    const pool = dust();
    const dustN = Math.round(0.16 * pool.length * clamp((VW * VH) / (1440 * 900), 0.35, 1.2));
    const offX = cam.yaw * VW, offY = cam.pitch * VH;
    const dustCol = rgba(S.dust, 1);
    for (let k = 0; k < dustN; k++) {
      const d = pool[k], par = PARALLAX[d.layer];
      let x = (d.u * VW - offX * par) % VW; if (x < 0) x += VW;
      let y = (d.v * VH - offY * par) % VH; if (y < 0) y += VH;
      let a = d.b * (light ? 0.5 : 0.42) * (1 - f.focusAmt * 0.3);
      if (d.tw && !still) a *= 1 + 0.18 * Math.sin(t * d.f * 0.6 + d.ph);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.fillStyle = k % 11 === 0 ? rgba(scene.clusters[k % scene.clusters.length]?.inl[lk] ?? S.dust, 1) : dustCol;
      const sz = d.s * 1.15;
      ctx.fillRect(VX + x - sz / 2, VY + y - sz / 2, sz, sz);
    }

    // pending-note glimmers: tiny tinted breaths inside the washes
    for (let q = 0; q < Math.min(f.pending, scene.glimmers.length); q++) {
      const gm = scene.glimmers[q];
      const [x, y, s, dep] = projectPoint(gm.x, gm.y, gm.z, T);
      const life = still ? 0.6 : 0.5 + 0.5 * Math.sin((t / gm.period) * TAU + gm.phase);
      const a = (light ? 0.3 : 0.22) * life * (0.5 + 0.5 * dep) * (1 - f.focusAmt * 0.6);
      if (a < 0.01) continue;
      const r = (3.5 + 3 * life) * s;
      ctx.globalAlpha = a;
      ctx.drawImage(light ? lsprites(scene.clusters[gm.comm].inl.light).halo : sprites(scene.clusters[gm.comm].inl.dark).glow, x - r, y - r, 2 * r, 2 * r);
    }

    // constellation lines in the cluster tint
    ctx.globalCompositeOperation = S.blend; ctx.lineCap = "round";
    const nLinkScale = clamp(1.25 - Math.log10(Math.max(links.length, 1)) * 0.22, 0.6, 1);
    for (const l of links) {
      const a = l.s, b = l.t, sa = stars[a], sb = stars[b];
      let alpha = (0.07 + 0.13 * l.w) * nLinkScale * (0.35 + (0.65 * (pd[a] + pd[b])) / 2) * S.lineK;
      if (f.filter) alpha *= Math.min(f.filter[a], f.filter[b]);
      let width = 0.6 + 0.35 * l.w;
      if (f.focusIdx >= 0 && f.focusAmt > 0) {
        const hot = a === f.focusIdx || b === f.focusIdx;
        const inComm = sa.comm === stars[f.focusIdx].comm && sb.comm === stars[f.focusIdx].comm;
        alpha *= lerp(1, hot ? S.hotK : inComm ? 0.9 : 0.2, f.focusAmt);
        if (hot) width = lerp(width, 1.1, f.focusAmt);
      }
      if (alpha < 0.004) continue;
      const x0 = px[a], y0 = py[a], x1 = px[b], y1 = py[b];
      const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.strokeStyle = sa.comm === sb.comm ? scene.clusters[sa.comm].inlStr[lk] : S.cross;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1); ctx.stroke();
    }

    // pulses: a small bright-to-accent dot travelling outward
    ctx.globalCompositeOperation = "source-over";
    const dot = (x: number, y: number, col: RGB, a: number, size: number) => {
      const sp = lsprites(col);
      ctx.globalAlpha = a * 0.7; ctx.drawImage(sp.halo, x - size * 2.2, y - size * 2.2, size * 4.4, size * 4.4);
      ctx.globalAlpha = a; ctx.drawImage(sp.core, x - size, y - size, size * 2, size * 2);
    };
    if (!still) {
      if (f.focusIdx >= 0 && f.focusAmt > 0.2) {
        const col = scene.clusters[stars[f.focusIdx].comm].inl[lk];
        for (const l of links) {
          if (l.s !== f.focusIdx && l.t !== f.focusIdx) continue;
          const x0 = px[l.s], y0 = py[l.s], x1 = px[l.t], y1 = py[l.t];
          const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
          const ph = (t * 0.42 + l.phase) % 1;
          const [x, y] = bez(x0, y0, cx, cy, x1, y1, f.focusIdx === l.s ? ph : 1 - ph);
          dot(x, y, col, Math.sin(Math.PI * ph) * f.focusAmt * 0.9, 2.6);
        }
      } else if (links.length) {
        const period = 4.2, round = Math.floor(t / period), ph = (t % period) / 2.2;
        if (ph < 1) {
          const l = links[hash32(`pulse${round}`, 4) % links.length];
          const x0 = px[l.s], y0 = py[l.s], x1 = px[l.t], y1 = py[l.t];
          const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
          const [x, y] = bez(x0, y0, cx, cy, x1, y1, ph);
          dot(x, y, scene.clusters[stars[l.s].comm].inl[lk], Math.sin(Math.PI * ph) * 0.5, 2.1);
        }
      }
    }

    // stars: normal blending on light, gentle additive on dark
    for (let o = 0; o < order.length; o++) {
      const i = order[o], st = stars[i], dep = pd[i], s = ps[i];
      const col = scene.clusters[st.comm].inl[lk];
      let tw = 1, sc = 1;
      if (!still) { tw = 1 + 0.07 * Math.sin(t * st.freq * 0.7 + st.phase); sc = 1 + 0.035 * Math.sin(t * st.freq2 * 0.5 + st.phase2); }
      const r = Math.max(0.8, st.r * s * view.viewK * Math.sqrt(cam.zoom) * (0.82 + 0.18 * dep)) * sc * (light ? 0.86 : 0.92);
      let a = clamp((light ? 0.5 + 0.5 * st.bright : st.bright) * (light ? 0.58 + 0.42 * dep : 0.45 + 0.55 * dep) * tw * starDim(scene, f, i), 0, 1);
      if (f.focusSet[i] && f.focusAmt > 0) a = Math.max(a, 0.85 * f.focusAmt);
      const x = px[i], y = py[i];
      if (light) {
        const sp = lsprites(col);
        ctx.globalCompositeOperation = "source-over";
        if (st.m > 0.3) {
          const gl = r * (2.6 + 3.2 * st.m);
          ctx.globalAlpha = clamp(a * (st.m - 0.15) * 0.95, 0, 1);
          ctx.drawImage(sp.halo, x - gl, y - gl, gl * 2, gl * 2);
        }
        if (st.spike) {
          const L = r * 6.5;
          ctx.globalAlpha = clamp(a * 0.32, 0, 1);
          ctx.drawImage(sp.spike, x - L, y - L, L * 2, L * 2);
        }
        const c = r * 1.45;
        ctx.globalAlpha = a; ctx.drawImage(sp.core, x - c, y - c, c * 2, c * 2);
      } else {
        const sp = sprites(col);
        ctx.globalCompositeOperation = "lighter";
        if (st.m > 0.5) {
          const gl = r * (3 + 2.8 * st.m);
          ctx.globalAlpha = clamp(a * (st.m - 0.45) * 1.1, 0, 1);
          ctx.drawImage(sp.glow, x - gl, y - gl, gl * 2, gl * 2);
        }
        if (st.spike) {
          const L = r * 7;
          ctx.globalAlpha = clamp(a * 0.3, 0, 1);
          ctx.drawImage(sp.spike, x - L, y - L, L * 2, L * 2);
        }
        const c = r * 2.1;
        ctx.globalAlpha = a; ctx.drawImage(sp.core, x - c, y - c, c * 2, c * 2);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    this.reticle(scene, view, f, rgba(g.ink, 1), 0.45, 0.26, 2);
    this.labels(scene, view, f, S.labels);
    ctx.globalAlpha = 1;
  }

  private reticle(scene: StarScene, view: View, f: FrameState, stroke: string, pinA: number, hoverA: number, k: number) {
    const ctx = this.ctx!;
    const { stars, px, py, ps } = scene;
    ctx.globalCompositeOperation = "source-over";
    for (const idx of new Set([f.pinIdx, f.hoverIdx])) {
      if (idx < 0 || idx >= scene.n) continue;
      const r = Math.max(6, stars[idx].r * ps[idx] * view.viewK * Math.sqrt(f.cam.zoom) * k + 5);
      ctx.globalAlpha = (idx === f.pinIdx ? pinA : hoverA) * Math.max(f.focusAmt, 0.4);
      ctx.strokeStyle = stroke; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(px[idx], py[idx], r, 0, TAU); ctx.stroke();
      if (idx === f.pinIdx) {
        ctx.beginPath();
        for (let q = 0; q < 4; q++) {
          const an = (q * Math.PI) / 2;
          ctx.moveTo(px[idx] + Math.cos(an) * (r + 3), py[idx] + Math.sin(an) * (r + 3));
          ctx.lineTo(px[idx] + Math.cos(an) * (r + 7), py[idx] + Math.sin(an) * (r + 7));
        }
        ctx.stroke();
      }
    }
  }

  /** Greedy label placement: focus, pin, neighbours, then the always-on few; avoids overlaps and bright stars. */
  private labels(scene: StarScene, view: View, f: FrameState, S: LabelStyle) {
    const X = this.ctx!;
    const { stars, px, py, ps } = scene;
    const { W, H } = view;
    const want: Array<[number, number]> = [];
    if (f.focusIdx >= 0) want.push([f.focusIdx, 0]);
    if (f.pinIdx >= 0 && f.pinIdx !== f.focusIdx) want.push([f.pinIdx, 1]);
    if (f.focusIdx >= 0 && f.focusAmt > 0.3) {
      scene.nodes[f.focusIdx].nb.slice().sort((a, b) => stars[b].e.score - stars[a].e.score || a - b).slice(0, W < 600 ? 4 : 7).forEach((j) => want.push([j, 2]));
    }
    [...scene.labelSet].sort((a, b) => stars[a].rank - stars[b].rank).forEach((j) => want.push([j, 3]));
    const placed: number[][] = [], done = new Set<number>();
    const pad = 3;
    const obstacles: number[][] = [];
    for (let i = 0; i < scene.n; i++) {
      if (stars[i].m < 0.62) continue;
      const rr = stars[i].r * ps[i] * view.viewK * 1.4 + 2;
      obstacles.push([px[i] - rr, py[i] - rr, px[i] + rr, py[i] + rr]);
    }
    X.textBaseline = "middle";
    const spaced = "letterSpacing" in X;
    for (const [i, tier] of want) {
      if (done.has(i)) continue;
      const st = stars[i], x = px[i], y = py[i];
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      if (tier === 3 && f.filter && f.filter[i] < 1) continue;
      const r = st.r * ps[i] * view.viewK * Math.sqrt(f.cam.zoom) * 1.6 + 6;
      const maxChars = tier === 0 ? 34 : 22;
      let text = st.e.title;
      if ([...text].length > maxChars) text = `${[...text].slice(0, maxChars - 1).join("")}…`;
      const fs = tier === 0 ? 12.5 : tier === 3 ? 11 : 10.5;
      X.font = `${tier === 0 ? 600 : 500} ${fs}px ${FONT}`;
      if (spaced) X.letterSpacing = tier === 3 ? "0.3px" : "0px";
      const tw = X.measureText(text).width, th = fs + 2;
      const sub = tier === 0 ? `${st.e.score} · ${scene.nodes[i].deg} links` : null;
      const boxH = sub ? th + 13 : th;
      const cands = [[x + r, y - boxH / 2], [x - r - tw, y - boxH / 2], [x - tw / 2, y - r - boxH], [x - tw / 2, y + r], [x + r * 0.7, y - r - boxH * 0.8], [x - r * 0.7 - tw, y + r * 0.6], [x + r * 0.7, y + r * 0.4], [x - r * 0.7 - tw, y - r - boxH * 0.6]];
      let spot: number[] | null = null;
      for (const [lx, ly] of cands) {
        const rect = [lx - pad, ly - pad, lx + tw + pad, ly + boxH + pad];
        if (rect[0] < 6 || rect[2] > W - 6 || rect[1] < f.insetTop || rect[3] > H - f.insetBottom) continue;
        const hits = (p: number[]) => !(rect[2] < p[0] || rect[0] > p[2] || rect[3] < p[1] || rect[1] > p[3]);
        if (placed.some(hits) || (tier > 0 && obstacles.some(hits))) continue;
        spot = [lx, ly, ...rect];
        break;
      }
      if (!spot) continue;
      placed.push(spot.slice(2)); done.add(i);
      let a: number;
      if (tier === 0) a = 0.96 * Math.max(f.focusAmt, 0.5);
      else if (tier === 1) a = 0.8;
      else if (tier === 2) a = 0.7 * f.focusAmt;
      else a = 0.62 * starDim(scene, f, i) * (f.focusIdx >= 0 ? lerp(1, 0.7, f.focusAmt) : 1);
      if (a < 0.03) continue;
      X.globalAlpha = Math.min(1, a * S.aK);
      if (S.shadow) { X.shadowColor = S.shadow; X.shadowBlur = 6; }
      if (S.halo) { X.lineJoin = "round"; X.lineWidth = 3.4; X.strokeStyle = S.halo; X.strokeText(text, spot[0], spot[1] + th / 2); }
      X.fillStyle = tier === 3 ? S.fill3 : S.fill;
      X.fillText(text, spot[0], spot[1] + th / 2);
      if (sub) {
        X.font = `400 10px ${FONT}`;
        X.globalAlpha = a * S.subA; X.fillStyle = S.sub(scene.clusters[st.comm]);
        if (S.halo) X.strokeText(sub, spot[0], spot[1] + th + 7);
        X.fillText(sub, spot[0], spot[1] + th + 7);
      }
      X.shadowBlur = 0;
    }
    if (spaced) X.letterSpacing = "0px";
  }
}
