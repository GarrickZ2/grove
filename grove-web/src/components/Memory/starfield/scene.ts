// Starfield scene: everything the renderer needs, computed once per
// (entities, relations) and then frozen. Pure and deterministic — the same
// memories always land in the same place with the same colours, so the map
// never jitters between renders and tests can pin the output.
import type { MemoryEntity, MemoryRelation } from "../../../api/memory";
import { selectVisibleRelations } from "../memoryGraphRelations";

export type RGB = [number, number, number];
export type InlineLook = "light" | "dark";

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** FNV-1a with a salt and an avalanche step. */
export function hash32(str: string, salt = 0) {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
export const hashUnit = (str: string, salt: number) => hash32(str, salt) / 4294967296;
/** mulberry32 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hexRgb(hex: string): RGB { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const mix = (c1: RGB, c2: RGB, t: number): RGB => [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];

/** Night: star colour temperatures (pale) with deep nebula tones for additive blending. */
export const NIGHT_PALETTE = [
  { rgb: hexRgb("#94b9ff"), nebRgb: hexRgb("#2f56d8") }, // pale blue
  { rgb: hexRgb("#ffcb7d"), nebRgb: hexRgb("#b8682a") }, // warm gold
  { rgb: hexRgb("#ff9fb6"), nebRgb: hexRgb("#b23f72") }, // rose
  { rgb: hexRgb("#b7a3ff"), nebRgb: hexRgb("#6342d6") }, // soft violet
  { rgb: hexRgb("#e2ecff"), nebRgb: hexRgb("#5a74b8") }, // icy white
  { rgb: hexRgb("#93dfdc"), nebRgb: hexRgb("#1f8f9a") }, // pale aqua
];
const NIGHT_STRAY = hexRgb("#c7d0e4");
/**
 * Inline (app theme) palettes in the same order. The light set is deepened for
 * white and spaced by lightness too (slate ≈ L30, violet 36, blue 45, rose 52,
 * aqua 56, gold 64), so clusters stay apart for colour-blind readers.
 */
export const INLINE_PALETTE: Record<InlineLook, RGB[]> = {
  light: ["#2c63d8", "#c98a12", "#d2466f", "#5b34c4", "#34405c", "#13958f"].map(hexRgb),
  dark: ["#7ea8ff", "#efc36e", "#f093ad", "#ad98ff", "#b9c3d6", "#80d5d0"].map(hexRgb),
};
const INLINE_STRAY: Record<InlineLook, RGB> = { light: hexRgb("#8a8f9a"), dark: hexRgb("#8f96a6") };

export interface StarNode { i: number; e: MemoryEntity; nb: number[]; deg: number }
export interface StarLink { r: MemoryRelation; s: number; t: number; w: number; phase: number }
export interface Star {
  i: number; e: MemoryEntity; comm: number; rank: number;
  /** Magnitude 0..1 (mostly rank-based). */
  m: number;
  /** Core radius in CSS px at unit scale. */
  r: number;
  bright: number;
  phase: number; phase2: number; freq: number; freq2: number;
  spike: boolean;
}
export interface Cluster {
  members: number[];
  stray: boolean;
  /** Dominant first-tag key, the constellation's name. */
  name: string;
  rgb: RGB; nebRgb: RGB; pal: number;
  inl: Record<InlineLook, RGB>;
  inlStr: Record<InlineLook, string>;
  lineStr: string;
}
export interface Blob { x: number; y: number; z: number; rad: number; rgb: RGB; comm: number; a: number }
export interface Glimmer { x: number; y: number; z: number; rgb: RGB; comm: number; phase: number; period: number }

export interface StarScene {
  n: number;
  nodes: StarNode[];
  links: StarLink[];
  /** World positions, xyz interleaved, normalised to ~unit radius. */
  P: Float64Array;
  fitXZ: number;
  fitY: number;
  stars: Star[];
  clusters: Cluster[];
  blobs: Blob[];
  /** Candidate spots for pending notes, round-robin across constellations. */
  glimmers: Glimmer[];
  labelSet: Set<number>;
  indexById: Map<string, number>;
  /** Per-frame projection scratch (screen x/y, perspective scale, depth 0 far..1 near). */
  px: Float32Array; py: Float32Array; ps: Float32Array; pd: Float32Array;
  /** Star indices, re-sorted far → near on every projection. */
  order: number[];
}

/** A graph this dense would hide its own shape; keep each memory's strongest links. */
const MAX_DEGREE = 8;

function buildGraph(entities: MemoryEntity[], relations: MemoryRelation[]) {
  const nodes: StarNode[] = entities.map((e, i) => ({ i, e, nb: [], deg: 0 }));
  const byId = new Map(nodes.map((n) => [n.e.entity_id, n]));
  const chosen = relations.length > entities.length * 4 ? selectVisibleRelations(relations, byId, MAX_DEGREE) : relations;
  const links: StarLink[] = [];
  const seen = new Set<string>();
  // Stable order: the API order can shift between fetches.
  const sorted = [...chosen].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    const a = byId.get(r.source_entity_id), b = byId.get(r.target_entity_id);
    if (!a || !b || a === b) continue;
    const key = a.i < b.i ? `${a.i}-${b.i}` : `${b.i}-${a.i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ r, s: a.i, t: b.i, w: 0.35 + (clamp(r.score, 0, 100) / 100) * 0.65, phase: hashUnit(r.id, 3) });
    a.nb.push(b.i); b.nb.push(a.i); a.deg++; b.deg++;
  }
  return { nodes, links };
}

/**
 * Louvain local-moving pass (modularity gain) in a stable hash order.
 * Label propagation tends to swallow small graphs into one blob; this keeps
 * e.g. "frontend/design" apart from "core engineering" at 15 nodes.
 */
export function detectCommunities(nodes: StarNode[], links: StarLink[]) {
  const n = nodes.length;
  const lab = Int32Array.from({ length: n }, (_, i) => i);
  const adj: Array<Array<[number, number]>> = nodes.map(() => []);
  const k = new Float64Array(n);
  let m2 = 0;
  for (const l of links) { adj[l.s].push([l.t, l.w]); adj[l.t].push([l.s, l.w]); k[l.s] += l.w; k[l.t] += l.w; m2 += 2 * l.w; }
  const tot = Float64Array.from(k);
  const order = nodes.map((nd) => nd.i).sort((a, b) => hash32(nodes[a].e.entity_id, 7) - hash32(nodes[b].e.entity_id, 7) || a - b);
  for (let pass = 0; pass < 25 && m2 > 0; pass++) {
    let moved = false;
    for (const i of order) {
      if (!adj[i].length) continue;
      const ci = lab[i];
      tot[ci] -= k[i];
      const kin = new Map<number, number>();
      for (const [j, w] of adj[i]) kin.set(lab[j], (kin.get(lab[j]) || 0) + w);
      let best = ci, bestG = (kin.get(ci) || 0) - (tot[ci] * k[i]) / m2;
      for (const [c, w] of kin) {
        const gain = w - (tot[c] * k[i]) / m2;
        if (gain > bestG + 1e-12 || (Math.abs(gain - bestG) <= 1e-12 && c < best)) { best = c; bestG = gain; }
      }
      tot[best] += k[i];
      if (best !== ci) { lab[i] = best; moved = true; }
    }
    if (!moved) break;
  }
  // Fold tiny communities into their best-connected neighbour.
  const size = new Map<number, number>();
  lab.forEach((c) => size.set(c, (size.get(c) || 0) + 1));
  for (let i = 0; i < n; i++) {
    if ((size.get(lab[i]) ?? 0) >= 3) continue;
    const cnt = new Map<number, number>();
    for (const j of nodes[i].nb) if ((size.get(lab[j]) ?? 0) >= 3) cnt.set(lab[j], (cnt.get(lab[j]) || 0) + 1);
    let best = -1, bc = 0;
    for (const [key, c] of cnt) if (c > bc || (c === bc && key < best)) { best = key; bc = c; }
    if (best >= 0) { size.set(lab[i], (size.get(lab[i]) ?? 1) - 1); lab[i] = best; size.set(best, (size.get(best) ?? 0) + 1); }
  }
  const grouped = new Map<number, number[]>();
  lab.forEach((c, i) => { const list = grouped.get(c) ?? []; list.push(i); grouped.set(c, list); });
  const groups = [...grouped.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const comm = new Int32Array(n);
  groups.forEach((m, ci) => m.forEach((i) => { comm[i] = ci; }));
  return { comm, groups };
}

/**
 * Merge communities into at most six "galaxies" (one hue each) by link
 * density, so twenty small constellations don't turn into confetti; siblings
 * inside a galaxy get tonal variants.
 */
function galaxies(links: StarLink[], comm: Int32Array, groups: number[][]) {
  const target = NIGHT_PALETTE.length;
  const parent = groups.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const size = groups.map((m) => m.length);
  const W = new Map<string, number>();
  for (const l of links) {
    const a = comm[l.s], b = comm[l.t];
    if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    W.set(key, (W.get(key) || 0) + 1);
  }
  let count = groups.filter((m) => m.length >= 3).length;
  while (count > target) {
    const agg = new Map<string, number>();
    for (const [key, w] of W) {
      let [a, b] = key.split(",").map(Number);
      a = find(a); b = find(b);
      if (a === b || groups[a].length < 3 || groups[b].length < 3) continue;
      const k2 = a < b ? `${a},${b}` : `${b},${a}`;
      agg.set(k2, (agg.get(k2) || 0) + w);
    }
    let best: string | null = null, bs = -1;
    for (const [key, w] of agg) {
      const [a, b] = key.split(",").map(Number);
      const sc = w / Math.sqrt(size[a] * size[b]);
      if (sc > bs || (sc === bs && best !== null && key < best)) { bs = sc; best = key; }
    }
    if (!best) break;
    const [a, b] = best.split(",").map(Number);
    const keep = Math.min(a, b), drop = Math.max(a, b);
    parent[drop] = keep; size[keep] += size[drop]; count--;
  }
  const roots = [...new Set(groups.map((m, k) => (m.length >= 3 ? find(k) : -1)).filter((r) => r >= 0))].sort((a, b) => a - b);
  const gal = groups.map((m, k) => (m.length >= 3 ? roots.indexOf(find(k)) : -1));
  const sib = groups.map(() => 0), seen = new Map<number, number>();
  groups.forEach((_, k) => { if (gal[k] < 0) return; const c = seen.get(gal[k]) || 0; sib[k] = c; seen.set(gal[k], c + 1); });
  return { gal, sib };
}

/**
 * 3D force layout (springs, 1/d² repulsion, weak gravity, community cohesion)
 * seeded from stable hashes and run a fixed number of steps, then frozen.
 */
function forceLayout(nodes: StarNode[], links: StarLink[], comm: Int32Array, groups: number[][]) {
  const n = nodes.length;
  const P = new Float64Array(n * 3), V = new Float64Array(n * 3), F = new Float64Array(n * 3);
  const spread = Math.cbrt(n) * 0.9;
  const K = groups.length, golden = Math.PI * (3 - Math.sqrt(5));
  // Each community gets an anchor on a thick sunflower disc (wide, so it
  // survives yaw rotation); members get a stable hash offset around it.
  const anchors = groups.map((m, k) => {
    if (K === 1) return [0, 0, 0];
    const th = k * golden, rr = Math.sqrt((k + 0.5) / K) * spread * 0.95;
    const y = (hashUnit(m.map((i) => nodes[i].e.entity_id).join(), 8) - 0.5) * spread * 0.4;
    return [Math.cos(th) * rr, y, Math.sin(th) * rr];
  });
  nodes.forEach((nd, i) => {
    const id = nd.e.entity_id;
    const u = hashUnit(id, 1), v = hashUnit(id, 2) * 2 - 1, w = Math.cbrt(hashUnit(id, 3));
    const ring = Math.sqrt(1 - v * v);
    const a = anchors[comm[i]], loc = spread * (0.15 + 0.35 * Math.sqrt(groups[comm[i]].length / n));
    P[i * 3] = a[0] + Math.cos(u * TAU) * ring * w * loc;
    P[i * 3 + 1] = a[1] + v * w * loc;
    P[i * 3 + 2] = a[2] + Math.sin(u * TAU) * ring * w * loc;
  });
  const C = new Float64Array(K * 3);
  const iters = n > 200 ? 320 : 420;
  const kRep = 0.9, kGrav = 0.012, decay = 0.42;
  let alpha = 1;
  const alphaDecay = 1 - Math.pow(0.002, 1 / iters);
  for (let it = 0; it < iters; it++) {
    F.fill(0);
    for (let i = 0; i < n; i++) {
      const ix = P[i * 3], iy = P[i * 3 + 1], iz = P[i * 3 + 2];
      for (let j = i + 1; j < n; j++) {
        let dx = ix - P[j * 3], dy = iy - P[j * 3 + 1], dz = iz - P[j * 3 + 2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 64) continue;
        if (d2 < 1e-4) { dx = 0.01 * (i - j); d2 = 1e-4; }
        const f = kRep / (d2 * Math.sqrt(d2));
        dx *= f; dy *= f; dz *= f;
        F[i * 3] += dx; F[i * 3 + 1] += dy; F[i * 3 + 2] += dz;
        F[j * 3] -= dx; F[j * 3 + 1] -= dy; F[j * 3 + 2] -= dz;
      }
    }
    for (const l of links) {
      const a = l.s * 3, b = l.t * 3;
      const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const rest = 1.15 - l.w * 0.45;
      const k = 0.55 / Math.min(nodes[l.s].deg, nodes[l.t].deg);
      const f = ((d - rest) / d) * k;
      const ba = nodes[l.s].deg / (nodes[l.s].deg + nodes[l.t].deg);
      F[a] += dx * f * (1 - ba); F[a + 1] += dy * f * (1 - ba); F[a + 2] += dz * f * (1 - ba);
      F[b] -= dx * f * ba; F[b + 1] -= dy * f * ba; F[b + 2] -= dz * f * ba;
    }
    C.fill(0);
    for (let i = 0; i < n; i++) { const c = comm[i] * 3; C[c] += P[i * 3]; C[c + 1] += P[i * 3 + 1]; C[c + 2] += P[i * 3 + 2]; }
    for (let i = 0; i < n; i++) {
      const k = comm[i], sz = groups[k].length;
      if (sz < 3) continue;
      for (let d = 0; d < 3; d++) F[i * 3 + d] += (C[k * 3 + d] / sz - P[i * 3 + d]) * 0.06;
    }
    for (let i = 0; i < n * 3; i++) {
      F[i] -= P[i] * kGrav;
      V[i] = (V[i] + F[i] * alpha) * (1 - decay);
      P[i] += clamp(V[i], -0.5, 0.5);
    }
    alpha *= 1 - alphaDecay;
  }
  // Pivot on a blend of bounding-box centre and mean; flatten into a disc; normalise.
  const mid = (d: number) => {
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let i = 0; i < n; i++) { const v = P[i * 3 + d]; lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
    return n ? 0.6 * ((lo + hi) / 2) + (0.4 * sum) / n : 0;
  };
  const cx = mid(0), cy = mid(1), cz = mid(2);
  const rxz: number[] = [], ry: number[] = [];
  for (let i = 0; i < n; i++) {
    P[i * 3] -= cx; P[i * 3 + 1] = (P[i * 3 + 1] - cy) * 0.68; P[i * 3 + 2] -= cz;
    rxz.push(Math.hypot(P[i * 3], P[i * 3 + 2])); ry.push(Math.abs(P[i * 3 + 1]));
  }
  const pct = (arr: number[], q: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] || 1; };
  const norm = Math.max(pct(rxz, 0.95), 1e-3);
  for (let i = 0; i < n * 3; i++) P[i] /= norm;
  const maxXZ = rxz.length ? Math.max(...rxz) : norm;
  return { P, fitXZ: Math.max(1, (maxXZ / norm) * 0.92), fitY: Math.max(0.35, pct(ry, 0.97) / norm) };
}

export function buildStarScene(entities: MemoryEntity[], relations: MemoryRelation[]): StarScene {
  // Stable node order regardless of how the list was sorted for display.
  const sortedEntities = [...entities].sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  const { nodes, links } = buildGraph(sortedEntities, relations);
  const n = nodes.length;
  const { comm, groups } = detectCommunities(nodes, links);
  const meta = galaxies(links, comm, groups);
  const lay = forceLayout(nodes, links, comm, groups);
  const scores = nodes.map((nd) => nd.e.score);
  const sizeMul = clamp(1.9 - 0.42 * Math.log10(Math.max(n, 2)), 0.8, 1.5);
  const ranked = nodes.map((nd) => nd.i).sort((a, b) => scores[b] - scores[a] || a - b);
  const rankOf = new Int32Array(n);
  ranked.forEach((i, r) => { rankOf[i] = r; });

  const clusters: Cluster[] = groups.map((m, ci) => {
    const stray = m.length < 3;
    const gi = meta.gal[ci] < 0 ? 0 : meta.gal[ci] % NIGHT_PALETTE.length, sv = meta.sib[ci];
    const pal = NIGHT_PALETTE[gi], next = NIGHT_PALETTE[(gi + 1) % NIGHT_PALETTE.length];
    const tone = sv === 0 ? pal.rgb : sv % 2 ? mix(pal.rgb, [255, 255, 255], 0.22) : mix(pal.rgb, next.rgb, 0.22);
    const rgb = stray ? NIGHT_STRAY : tone;
    const cnt = new Map<string, number>();
    m.forEach((i) => { const key = nodes[i].e.tags[0]?.key; if (key) cnt.set(key, (cnt.get(key) || 0) + 1); });
    const name = [...cnt.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "Constellation";
    const nebRgb: RGB = stray ? [70, 84, 130] : sv % 2 ? mix(pal.nebRgb, NIGHT_PALETTE[(gi + 3) % NIGHT_PALETTE.length].nebRgb, 0.3) : pal.nebRgb;
    const inl = {} as Record<InlineLook, RGB>;
    for (const lk of ["light", "dark"] as const) {
      const P0 = INLINE_PALETTE[lk][gi], P1 = INLINE_PALETTE[lk][(gi + 1) % INLINE_PALETTE[lk].length];
      inl[lk] = stray ? INLINE_STRAY[lk] : sv === 0 ? P0 : sv % 2 ? mix(P0, lk === "light" ? [255, 255, 255] : [22, 22, 21], 0.2) : mix(P0, P1, 0.22);
    }
    return {
      members: m, stray, name, rgb, nebRgb, pal: stray ? -1 : gi, inl,
      inlStr: { light: rgba(inl.light, 1), dark: rgba(inl.dark, 1) },
      lineStr: rgba(mix(rgb, [190, 205, 240], 0.35), 1),
    };
  });

  // Small graphs: every memory matters (flat curve). Big graphs: steep, few bright stars.
  const bigness = clamp(Math.log10(Math.max(n, 1) / 15) / Math.log10(20), 0, 1);
  const rankExp = lerp(1.15, 5, bigness), rankW = lerp(0.55, 0.88, bigness);
  const stars: Star[] = nodes.map((nd) => {
    const i = nd.i, e = nd.e, id = e.entity_id;
    const pct = n > 1 ? 1 - rankOf[i] / (n - 1) : 1;
    const m = clamp(rankW * Math.pow(pct, rankExp) + ((1 - rankW) * clamp(e.score, 0, 100)) / 100, 0, 1);
    return {
      i, e, m, comm: comm[i], rank: rankOf[i],
      r: (0.95 + Math.pow(m, 2) * 6.2) * sizeMul,
      bright: 0.42 + 0.58 * Math.pow(m, 0.9),
      phase: hashUnit(id, 11) * TAU, phase2: hashUnit(id, 12) * TAU,
      freq: 0.6 + hashUnit(id, 13) * 1.5, freq2: 1.7 + hashUnit(id, 14) * 2.4,
      spike: false,
    };
  });
  ranked.slice(0, n >= 60 ? 4 : 3).forEach((i) => { if (stars[i].m > 0.7) stars[i].spike = true; });

  const blobs: Blob[] = [];
  const slotsByCluster: Glimmer[][] = [];
  clusters.forEach((c, ci) => {
    if (c.stray) return;
    let cx = 0, cy = 0, cz = 0;
    c.members.forEach((i) => { cx += lay.P[i * 3]; cy += lay.P[i * 3 + 1]; cz += lay.P[i * 3 + 2]; });
    const k = c.members.length;
    cx /= k; cy /= k; cz /= k;
    let sp = 0;
    c.members.forEach((i) => { sp += (lay.P[i * 3] - cx) ** 2 + (lay.P[i * 3 + 1] - cy) ** 2 + (lay.P[i * 3 + 2] - cz) ** 2; });
    sp = clamp(Math.sqrt(sp / k), 0.12, 0.7);
    const mass = clamp(Math.sqrt(k / Math.max(n, 1)) * 2.2, 0.55, 1.35);
    blobs.push({ x: cx, y: cy, z: cz, rad: sp * 2.3, rgb: c.nebRgb, comm: ci, a: 0.5 * mass });
    const byScore = [...c.members].sort((a, b) => scores[b] - scores[a] || a - b);
    byScore.slice(0, k > 20 ? 4 : 2).forEach((i, j) => {
      const alt = j === 1 ? mix(c.nebRgb, NIGHT_PALETTE[(c.pal + 3) % NIGHT_PALETTE.length].nebRgb, 0.5) : c.nebRgb;
      blobs.push({ x: lerp(cx, lay.P[i * 3], 0.75), y: lerp(cy, lay.P[i * 3 + 1], 0.75), z: lerp(cz, lay.P[i * 3 + 2], 0.75), rad: sp * (1 + 0.3 * hashUnit(String(i), 5)), rgb: alt, comm: ci, a: 0.6 * mass });
    });
    byScore.slice(0, 24).forEach((i) => {
      blobs.push({ x: lay.P[i * 3], y: lay.P[i * 3 + 1], z: lay.P[i * 3 + 2], rad: sp * (0.45 + 0.35 * hashUnit(String(i), 6)), rgb: c.nebRgb, comm: ci, a: 0.28 * mass });
    });
    const R = rng(hash32(c.name + ci, 21));
    const slots: Glimmer[] = [];
    for (let q = 0; q < 6; q++) {
      const u = R() * TAU, v = R() * 2 - 1, w = Math.cbrt(R()) * sp * 1.4, ring = Math.sqrt(1 - v * v);
      slots.push({ x: cx + Math.cos(u) * ring * w, y: cy + v * w * 0.7, z: cz + Math.sin(u) * ring * w, rgb: mix(c.rgb, [255, 255, 255], 0.4), comm: ci, phase: R() * TAU, period: 5 + R() * 6 });
    }
    slotsByCluster.push(slots);
  });
  // Round-robin, biggest constellations first: the first N slots are where N pending notes glimmer.
  const glimmers: Glimmer[] = [];
  for (let q = 0; q < 6; q++) for (const slots of slotsByCluster) glimmers.push(slots[q]);

  const labelSet = new Set(ranked.slice(0, Math.min(5, Math.ceil(n / 3))));
  const bestPerGal = new Map<number, number>();
  ranked.forEach((i) => { const c = comm[i]; if (clusters[c].stray) return; const g = meta.gal[c]; if (!bestPerGal.has(g)) bestPerGal.set(g, i); });
  for (const i of bestPerGal.values()) { if (labelSet.size >= 8) break; labelSet.add(i); }

  return {
    n, nodes, links, P: lay.P, fitXZ: lay.fitXZ, fitY: lay.fitY, stars, clusters, blobs, glimmers, labelSet,
    indexById: new Map(nodes.map((nd) => [nd.e.entity_id, nd.i])),
    px: new Float32Array(n), py: new Float32Array(n), ps: new Float32Array(n), pd: new Float32Array(n),
    order: ranked.slice(),
  };
}
