/* Copied verbatim from scratchpad/starfield/starfield.html (Night renderer): utilities, graph analysis, scene, sprites. */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
function hash32(str, salt = 0) {               // FNV-1a, salted
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
const hashUnit = (str, salt) => hash32(str, salt) / 4294967296;
function rng(seed) {                            // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (c1, c2, t) => [0, 1, 2].map(i => Math.round(lerp(c1[i], c2[i], t)));
/* =====================================================================
   2. Graph analysis: degree, layout (3D force, frozen), communities
   ===================================================================== */
const PALETTE = [  // star colour temperatures
  { name: "pale blue", hex: "#94b9ff", neb: "#2f56d8" },
  { name: "warm gold", hex: "#ffcb7d", neb: "#b8682a" },
  { name: "rose", hex: "#ff9fb6", neb: "#b23f72" },
  { name: "soft violet", hex: "#b7a3ff", neb: "#6342d6" },
  { name: "icy white", hex: "#e2ecff", neb: "#5a74b8" },
  { name: "pale aqua", hex: "#93dfdc", neb: "#1f8f9a" },
].map(p => ({ ...p, rgb: hexRgb(p.hex), nebRgb: hexRgb(p.neb) }));  // stars pale, nebulae deep (additive)
const STRAY_RGB = hexRgb("#c7d0e4");
// Inline (app-theme) palettes: same order as PALETTE. Light ones are deepened for white
// and spaced by lightness too (slate ≈ L30, violet 36, blue 45, rose 52, aqua 56, gold 64).
const INL_PAL = {
  light: ["#2c63d8", "#c98a12", "#d2466f", "#5b34c4", "#34405c", "#13958f"].map(hexRgb),
  dark: ["#7ea8ff", "#efc36e", "#f093ad", "#ad98ff", "#b9c3d6", "#80d5d0"].map(hexRgb),
};
const INL_STRAY = { light: hexRgb("#8a8f9a"), dark: hexRgb("#8f96a6") };

function buildGraph(data) {
  const nodes = data.entities.map((e, i) => ({ i, e, nb: [], deg: 0 }));
  const byId = new Map(nodes.map(n => [n.e.entity_id, n]));
  const links = [];
  const seen = new Set();
  for (const r of data.relations) {
    const a = byId.get(r.source_entity_id), b = byId.get(r.target_entity_id);
    if (!a || !b || a === b) continue;
    const key = a.i < b.i ? `${a.i}-${b.i}` : `${b.i}-${a.i}`;
    if (seen.has(key)) continue; seen.add(key);
    const l = { r, s: a.i, t: b.i, w: 0.35 + r.score / 100 * 0.65, phase: hashUnit(r.id, 3) };
    links.push(l); a.nb.push(b.i); b.nb.push(a.i); a.deg++; b.deg++;
  }
  return { nodes, links };
}

function forceLayout(g, comm, groups) {
  const n = g.nodes.length;
  const P = new Float64Array(n * 3), V = new Float64Array(n * 3), F = new Float64Array(n * 3);
  const spread = Math.cbrt(n) * 0.9;
  // Seed: each community gets a stable anchor on a Fibonacci sphere; members get a
  // stable hash offset around it. Deterministic, and constellations start apart.
  const K = groups.length, golden = Math.PI * (3 - Math.sqrt(5));
  const anchors = groups.map((m, k) => {
    if (K === 1) return [0, 0, 0];
    // thick disc (sunflower spiral): spreads across the wide axis, survives yaw rotation
    const th = k * golden, rr = Math.sqrt((k + 0.5) / K) * spread * 0.95;
    const y = (hashUnit(groups[k].map(i => g.nodes[i].e.entity_id).join(), 8) - 0.5) * spread * 0.4;
    return [Math.cos(th) * rr, y, Math.sin(th) * rr];
  });
  g.nodes.forEach((nd, i) => {
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
  let alpha = 1; const alphaDecay = 1 - Math.pow(0.002, 1 / iters);
  for (let it = 0; it < iters; it++) {
    F.fill(0);
    for (let i = 0; i < n; i++) {               // repulsion (1/d^2 in 3D)
      const ix = P[i * 3], iy = P[i * 3 + 1], iz = P[i * 3 + 2];
      for (let j = i + 1; j < n; j++) {
        let dx = ix - P[j * 3], dy = iy - P[j * 3 + 1], dz = iz - P[j * 3 + 2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 64) continue;
        if (d2 < 1e-4) { dx = 0.01 * (i - j); d2 = 1e-4; }
        const d = Math.sqrt(d2), f = kRep / (d2 * d);
        dx *= f; dy *= f; dz *= f;
        F[i * 3] += dx; F[i * 3 + 1] += dy; F[i * 3 + 2] += dz;
        F[j * 3] -= dx; F[j * 3 + 1] -= dy; F[j * 3 + 2] -= dz;
      }
    }
    for (const l of g.links) {                  // springs; strong relations pull tighter
      const a = l.s * 3, b = l.t * 3;
      const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const rest = 1.15 - l.w * 0.45;
      const k = 0.55 / Math.min(g.nodes[l.s].deg, g.nodes[l.t].deg);
      const f = (d - rest) / d * k;
      const ba = g.nodes[l.s].deg / (g.nodes[l.s].deg + g.nodes[l.t].deg);
      F[a] += dx * f * (1 - ba); F[a + 1] += dy * f * (1 - ba); F[a + 2] += dz * f * (1 - ba);
      F[b] -= dx * f * ba; F[b + 1] -= dy * f * ba; F[b + 2] -= dz * f * ba;
    }
    C.fill(0);                                  // community cohesion → tight constellations
    for (let i = 0; i < n; i++) { const c = comm[i] * 3; C[c] += P[i * 3]; C[c + 1] += P[i * 3 + 1]; C[c + 2] += P[i * 3 + 2]; }
    for (let i = 0; i < n; i++) {
      const k = comm[i], sz = groups[k].length; if (sz < 3) continue;
      for (let d = 0; d < 3; d++) F[i * 3 + d] += (C[k * 3 + d] / sz - P[i * 3 + d]) * 0.06;
    }
    for (let i = 0; i < n * 3; i++) {
      F[i] -= P[i] * kGrav;
      V[i] = (V[i] + F[i] * alpha) * (1 - decay);
      const step = clamp(V[i], -0.5, 0.5);
      P[i] += step;
    }
    alpha *= 1 - alphaDecay;
  }
  // centre, flatten slightly into a disc (wide sky, reads better in landscape), normalise
  // pivot = blend of bounding-box centre and mean, so outliers don't leave the view lopsided
  const mid = d => { let lo = Infinity, hi = -Infinity, sum = 0; for (let i = 0; i < n; i++) { const v = P[i * 3 + d]; lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; } return 0.6 * (lo + hi) / 2 + 0.4 * sum / n; };
  const cx = mid(0), cy = mid(1), cz = mid(2);
  const rxz = [], ry = [];
  for (let i = 0; i < n; i++) {
    P[i * 3] -= cx; P[i * 3 + 1] = (P[i * 3 + 1] - cy) * 0.68; P[i * 3 + 2] -= cz;
    rxz.push(Math.hypot(P[i * 3], P[i * 3 + 2])); ry.push(Math.abs(P[i * 3 + 1]));
  }
  const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] || 1; };
  const norm = Math.max(pct(rxz, 0.95), 1e-3);
  for (let i = 0; i < n * 3; i++) P[i] /= norm;
  return { P, fitXZ: Math.max(1, Math.max(...rxz) / norm * 0.92), fitY: Math.max(0.35, pct(ry, 0.97) / norm) };
}

function communities(g) {
  // Louvain local-moving phase (modularity gain), deterministic visiting order.
  // Label propagation tends to swallow small graphs into one blob; this keeps
  // e.g. "frontend/design" apart from "core engineering" at 15 nodes.
  const n = g.nodes.length;
  const lab = new Int32Array(n).map((_, i) => i);
  const adj = g.nodes.map(() => []);
  const k = new Float64Array(n);
  let m2 = 0;
  for (const l of g.links) { adj[l.s].push([l.t, l.w]); adj[l.t].push([l.s, l.w]); k[l.s] += l.w; k[l.t] += l.w; m2 += 2 * l.w; }
  const tot = Float64Array.from(k);
  const order = g.nodes.map(nd => nd.i).sort((a, b) => hash32(g.nodes[a].e.entity_id, 7) - hash32(g.nodes[b].e.entity_id, 7));
  const gamma = 1.0;
  for (let pass = 0; pass < 25 && m2 > 0; pass++) {
    let moved = false;
    for (const i of order) {
      if (!adj[i].length) continue;
      const ci = lab[i];
      tot[ci] -= k[i];
      const kin = new Map();
      for (const [j, w] of adj[i]) kin.set(lab[j], (kin.get(lab[j]) || 0) + w);
      let best = ci, bestG = (kin.get(ci) || 0) - gamma * tot[ci] * k[i] / m2;
      for (const [c, w] of kin) {
        const gain = w - gamma * tot[c] * k[i] / m2;
        if (gain > bestG + 1e-12 || (Math.abs(gain - bestG) <= 1e-12 && c < best)) { best = c; bestG = gain; }
      }
      tot[best] += k[i];
      if (best !== ci) { lab[i] = best; moved = true; }
    }
    if (!moved) break;
  }
  // merge tiny communities into their most-connected neighbour community
  const size = new Map(); lab.forEach(c => size.set(c, (size.get(c) || 0) + 1));
  for (let i = 0; i < n; i++) {
    if (size.get(lab[i]) >= 3) continue;
    const cnt = new Map(); for (const j of g.nodes[i].nb) if (size.get(lab[j]) >= 3) cnt.set(lab[j], (cnt.get(lab[j]) || 0) + 1);
    let best = -1, bc = 0; for (const [k, c] of cnt) if (c > bc) { best = k; bc = c; }
    if (best >= 0) { size.set(lab[i], size.get(lab[i]) - 1); lab[i] = best; size.set(best, size.get(best) + 1); }
  }
  // relabel by community size desc → palette index
  const groups = new Map(); lab.forEach((c, i) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); });
  const list = [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const comm = new Int32Array(n);
  list.forEach((m, ci) => m.forEach(i => comm[i] = ci));
  return { comm, groups: list };
}

// Merge communities into ≤6 "galaxies" (one palette hue each) so 20 small
// constellations don't turn into confetti; siblings get tonal variations.
function metaGroups(g, comm, groups) {
  const K = groups.length, target = PALETTE.length;
  const parent = groups.map((_, k) => k);
  const find = k => parent[k] === k ? k : (parent[k] = find(parent[k]));
  const size = groups.map(m => m.length);
  const W = new Map();
  for (const l of g.links) {
    const a = comm[l.s], b = comm[l.t]; if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`; W.set(key, (W.get(key) || 0) + 1);
  }
  let count = groups.filter(m => m.length >= 3).length;
  while (count > target) {
    const agg = new Map();
    for (const [key, w] of W) {
      let [a, b] = key.split(",").map(Number); a = find(a); b = find(b); if (a === b) continue;
      if (groups[a].length < 3 || groups[b].length < 3) continue;
      const k2 = a < b ? `${a},${b}` : `${b},${a}`; agg.set(k2, (agg.get(k2) || 0) + w);
    }
    let best = null, bs = -1;
    for (const [key, w] of agg) { const [a, b] = key.split(",").map(Number); const sc = w / Math.sqrt(size[a] * size[b]); if (sc > bs || (sc === bs && key < best)) { bs = sc; best = key; } }
    if (!best) break;
    const [a, b] = best.split(",").map(Number);
    const keep = Math.min(a, b), drop = Math.max(a, b);
    parent[drop] = keep; size[keep] += size[drop]; count--;
  }
  // galaxy index ordered by root (roots are size-ordered communities)
  const roots = [...new Set(groups.map((m, k) => m.length >= 3 ? find(k) : -1).filter(r => r >= 0))].sort((a, b) => a - b);
  const gal = groups.map((m, k) => m.length >= 3 ? roots.indexOf(find(k)) : -1);
  const sib = groups.map(() => 0), seen = new Map();
  groups.forEach((m, k) => { if (gal[k] < 0) return; const c = seen.get(gal[k]) || 0; sib[k] = c; seen.set(gal[k], c + 1); });
  return { gal, sib };
}

/* =====================================================================
   3. Scene: everything precomputed once per dataset
   ===================================================================== */
function buildScene(data) {
  const g = buildGraph(data);
  const n = g.nodes.length;
  const { comm, groups } = communities(g);
  const meta = metaGroups(g, comm, groups);
  const lay = forceLayout(g, comm, groups);
  const scores = g.nodes.map(nd => nd.e.score);
  const sMin = Math.min(...scores), sMax = Math.max(...scores);
  const sizeMul = clamp(1.9 - 0.42 * Math.log10(Math.max(n, 2)), 0.8, 1.5);
  const ranked = g.nodes.map(nd => nd.i).sort((a, b) => scores[b] - scores[a] || a - b);
  const rankOf = new Int32Array(n); ranked.forEach((i, r) => rankOf[i] = r);

  const clusterInfo = groups.map((m, ci) => {
    const stray = m.length < 3;
    const gi = meta.gal[ci] < 0 ? 0 : meta.gal[ci] % PALETTE.length, sv = meta.sib[ci];
    const pal = PALETTE[gi];
    // sibling constellations inside a galaxy: alternate lighter / slightly shifted toward the next hue
    const tone = sv === 0 ? pal.rgb : sv % 2 ? mix(pal.rgb, [255, 255, 255], 0.22) : mix(pal.rgb, PALETTE[(gi + 1) % PALETTE.length].rgb, 0.22);
    const rgb = stray ? STRAY_RGB : tone;
    // dominant topic tag as the constellation's name
    const cnt = new Map();
    m.forEach(i => { const t = g.nodes[i].e.tags.find(x => x.key === "topic"); if (t) cnt.set(t.value, (cnt.get(t.value) || 0) + 1); });
    const name = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Constellation";
    const nebRgb = stray ? [70, 84, 130] : (sv % 2 ? mix(pal.nebRgb, PALETTE[(gi + 3) % PALETTE.length].nebRgb, 0.3) : pal.nebRgb);
    const inl = {};
    for (const lk of ["light", "dark"]) {
      const P0 = INL_PAL[lk][gi], P1 = INL_PAL[lk][(gi + 1) % INL_PAL[lk].length];
      inl[lk] = stray ? INL_STRAY[lk] : sv === 0 ? P0 : sv % 2 ? mix(P0, lk === "light" ? [255, 255, 255] : [22, 22, 21], 0.2) : mix(P0, P1, 0.22);
    }
    return { members: m, stray, rgb, nebRgb, pal: stray ? -1 : gi, name, inl, inlStr: { light: rgba(inl.light, 1), dark: rgba(inl.dark, 1) } };
  });

  // small graphs: every memory matters → flatter curve; big graphs: steep, few bright stars
  const bigness = clamp(Math.log10(n / 15) / Math.log10(20), 0, 1);
  const rankExp = lerp(1.15, 5, bigness), rankW = lerp(0.55, 0.88, bigness);
  const stars = g.nodes.map(nd => {
    const i = nd.i, e = nd.e;
    // magnitude 0..1: mostly rank-based so only a few stars are truly bright,
    // whatever the score distribution; raw score keeps absolute meaning.
    const pct = n > 1 ? 1 - rankOf[i] / (n - 1) : 1;
    const m = clamp(rankW * Math.pow(pct, rankExp) + (1 - rankW) * e.score / 100, 0, 1);
    const id = e.entity_id;
    return {
      i, e, m, comm: comm[i], rank: rankOf[i],
      r: (0.95 + Math.pow(m, 2) * 6.2) * sizeMul,                     // core radius in CSS px at scale 1
      bright: 0.42 + 0.58 * Math.pow(m, 0.9),
      phase: hashUnit(id, 11) * TAU, phase2: hashUnit(id, 12) * TAU,
      freq: 0.6 + hashUnit(id, 13) * 1.5, freq2: 1.7 + hashUnit(id, 14) * 2.4,
      spike: false,
    };
  });
  const spikeCount = n >= 60 ? 4 : 3;
  ranked.slice(0, spikeCount).forEach(i => { if (stars[i].m > 0.7) stars[i].spike = true; });

  // nebula blobs: centroid + brightest members, spread-scaled
  const blobs = [], glimmers = [];
  clusterInfo.forEach((c, ci) => {
    if (c.stray) return;
    let cx = 0, cy = 0, cz = 0;
    c.members.forEach(i => { cx += lay.P[i * 3]; cy += lay.P[i * 3 + 1]; cz += lay.P[i * 3 + 2]; });
    const k = c.members.length; cx /= k; cy /= k; cz /= k;
    let sp = 0; c.members.forEach(i => { sp += (lay.P[i * 3] - cx) ** 2 + (lay.P[i * 3 + 1] - cy) ** 2 + (lay.P[i * 3 + 2] - cz) ** 2; });
    sp = clamp(Math.sqrt(sp / k), 0.12, 0.7);
    c.centroid = [cx, cy, cz]; c.spread = sp;
    const mass = clamp(Math.sqrt(k / Math.max(n, 1)) * 2.2, 0.55, 1.35);
    blobs.push({ x: cx, y: cy, z: cz, rad: sp * 2.3, rgb: c.nebRgb, comm: ci, a: 0.5 * mass });
    const top = [...c.members].sort((a, b) => scores[b] - scores[a]).slice(0, k > 20 ? 4 : 2);
    top.forEach((i, j) => {
      const alt = j === 1 ? mix(c.nebRgb, PALETTE[(c.pal + 3) % PALETTE.length].nebRgb, 0.5) : c.nebRgb;  // a second hue for depth
      blobs.push({ x: lerp(cx, lay.P[i * 3], 0.75), y: lerp(cy, lay.P[i * 3 + 1], 0.75), z: lerp(cz, lay.P[i * 3 + 2], 0.75), rad: sp * (1.0 + 0.3 * hashUnit(String(i), 5)), rgb: alt, comm: ci, a: 0.6 * mass });
    });
    // wisps: small blobs on members so each cloud follows its constellation's shape
    [...c.members].sort((a, b) => scores[b] - scores[a]).slice(0, 24).forEach(i => {
      blobs.push({ x: lay.P[i * 3], y: lay.P[i * 3 + 1], z: lay.P[i * 3 + 2], rad: sp * (0.45 + 0.35 * hashUnit(String(i), 6)), rgb: c.nebRgb, comm: ci, a: 0.28 * mass });
    });
    const R = rng(hash32(c.name + ci, 21));
    const gcount = clamp(Math.round(k / 6) + 1, 1, 6);
    for (let q = 0; q < gcount; q++) {
      const u = R() * TAU, v = R() * 2 - 1, w = Math.cbrt(R()) * sp * 1.4, ring = Math.sqrt(1 - v * v);
      glimmers.push({ x: cx + Math.cos(u) * ring * w, y: cy + v * w * 0.7, z: cz + Math.sin(u) * ring * w, rgb: mix(c.rgb, [255, 255, 255], 0.4), phase: R() * TAU, period: 5 + R() * 6 });
    }
  });

  // always-on labels: the brightest few, plus the brightest star of each galaxy (like constellation names)
  const labelSet = new Set(ranked.slice(0, Math.min(5, Math.ceil(n / 3))));
  const bestPerGal = new Map();
  ranked.forEach(i => { const c = comm[i]; if (clusterInfo[c].stray) return; const gk = meta.gal[c]; if (!bestPerGal.has(gk)) bestPerGal.set(gk, i); });
  for (const i of bestPerGal.values()) { if (labelSet.size >= 8) break; labelSet.add(i); }
  return {
    n, g, P: lay.P, fitXZ: lay.fitXZ, fitY: lay.fitY, stars, links: g.links, clusters: clusterInfo, blobs, glimmers,
    labelSet,
    px: new Float32Array(n), py: new Float32Array(n), ps: new Float32Array(n), pd: new Float32Array(n), order: ranked.slice(),
  };
}

/* =====================================================================
   4. Sprites (pre-rendered, tinted, drawn with additive blending)
   ===================================================================== */
function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function radialSprite(size, stops) {
  const c = makeCanvas(size, size), x = c.getContext("2d"), h = size / 2;
  const gr = x.createRadialGradient(h, h, 0, h, h, h);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  x.fillStyle = gr; x.fillRect(0, 0, size, size); return c;
}
const spriteCache = new Map();
function sprites(rgb) {
  const key = rgb.join(",");
  if (spriteCache.has(key)) return spriteCache.get(key);
  const white = mix(rgb, [255, 255, 255], 0.75);
  // glow: near-gaussian halo
  const glowStops = [];
  for (let k = 0; k <= 12; k++) { const o = k / 12; glowStops.push([o, rgba(rgb, (Math.exp(-o * o * 7) * 0.9 + Math.exp(-o * 26) * 0.6) * (1 - o))]); }
  const glow = radialSprite(128, glowStops);
  // core: white-hot centre, tinted rim
  const core = radialSprite(64, [[0, "rgba(255,255,255,1)"], [0.16, rgba(white, 0.98)], [0.32, rgba(rgb, 0.55)], [0.55, rgba(rgb, 0.12)], [1, rgba(rgb, 0)]]);
  // nebula: very wide gaussian
  const nebStops = []; for (let k = 0; k <= 14; k++) { const o = k / 14; nebStops.push([o, rgba(rgb, Math.exp(-o * o * 4.2) * (1 - o * o))]); }
  const neb = radialSprite(256, nebStops);
  // 4-point diffraction spike
  const S = 256, sc = makeCanvas(S, S), sx = sc.getContext("2d"); const h = S / 2;
  for (const horiz of [true, false]) {
    const gr = horiz ? sx.createLinearGradient(0, h, S, h) : sx.createLinearGradient(h, 0, h, S);
    gr.addColorStop(0, rgba(rgb, 0)); gr.addColorStop(0.36, rgba(rgb, 0.12)); gr.addColorStop(0.47, rgba(white, 0.55));
    gr.addColorStop(0.5, "rgba(255,255,255,0.95)"); gr.addColorStop(0.53, rgba(white, 0.55)); gr.addColorStop(0.64, rgba(rgb, 0.12)); gr.addColorStop(1, rgba(rgb, 0));
    sx.fillStyle = gr;
    if (horiz) { sx.fillRect(0, h - 0.75, S, 1.5); sx.globalAlpha = 0.35; sx.fillRect(0, h - 2, S, 4); sx.globalAlpha = 1; }
    else { sx.fillRect(h - 0.75, 0, 1.5, S); sx.globalAlpha = 0.35; sx.fillRect(h - 2, 0, 4, S); sx.globalAlpha = 1; }
  }
  const out = { glow, core, neb, spike: sc, line: rgba(mix(rgb, [190, 205, 240], 0.35), 1), rgb };
  spriteCache.set(key, out); return out;
}
const NEUTRAL = sprites([200, 212, 238]);

