/* Grove site — the night sky.
   Engine (layout, communities, sprites) is copied from the starfield prototype
   in sky-engine.js. This file holds: the project's memories (data), the fixed
   deep-sky backdrop, and the interactive hero constellation. */
"use strict";

/* ---------------------------------------------------------------------
   1. A project's memories. Each has a title and keywords so the composer
      can pull the believable ones out of the sky.
   --------------------------------------------------------------------- */
const MEMORY_TOPICS = [
  { key: "auth", name: "Auth & sessions", items: [
    ["Sessions: short-lived JWT + refresh cookie", "auth login session jwt token refresh cookie sign signin", 92],
    ["Refresh tokens rotate on every use", "refresh token tokens rotate rotation auth login security reuse", 84],
    ["OAuth: Google and GitHub only", "oauth google github login sso sign signin", 58],
    ["Passwords hash with argon2id", "password passwords hash argon security", 52],
    ["Login is rate-limited: 5 tries / 10 min", "rate limit login brute throttle security", 46],
    ["Magic links expire in 15 minutes", "magic link email login expire expiry", 38],
    ["Logout revokes every device", "logout revoke session device devices auth", 41],
    ["2FA is TOTP — SMS was rejected", "2fa totp mfa sms security auth", 35],
  ]},
  { key: "payments", name: "Payments", items: [
    ["Prices are stored in integer cents", "price prices cents money currency checkout payment payments total totals amount", 90],
    ["Stripe is the only payment provider", "stripe payment payments provider checkout card", 74],
    ["Apple Pay on checkout (iOS Safari)", "apple pay checkout mobile wallet ios safari", 55],
    ["Webhooks are idempotent by event id", "webhook webhooks idempotent stripe event payment", 62],
    ["Refunds need a manager approval", "refund refunds approval payment manager", 40],
    ["Tax is computed server-side", "tax vat checkout price server total", 57],
    ["Flaky test: payment webhook retries", "flaky test tests payment payments webhook retry ci fix", 44],
    ["Carts persist for 30 days", "cart carts checkout persist", 33],
  ]},
  { key: "design", name: "Design system", items: [
    ["Brand guide v3 lives in Studio", "brand guide design color colors logo typography style page", 86],
    ["Checkout layout sketch", "checkout layout sketch design page wireframe summary", 70],
    ["Tokens: 8px radius, ink buttons", "design token tokens radius button buttons ui style", 60],
    ["Mobile nav is a bottom sheet", "mobile nav navigation sheet phone", 48],
    ["Empty states always offer one action", "empty state states ui design", 36],
    ["Dark mode parity on every screen", "dark mode theme design screen", 42],
    ["Icons: 1.8 stroke, rounded caps", "icon icons stroke design", 30],
    ["Body type: Inter 13 / 20", "typography font text design type", 34],
  ]},
  { key: "api", name: "API", items: [
    ["API errors follow RFC 7807", "api error errors problem json response", 76],
    ["Pagination is cursor-based", "api pagination cursor list page", 50],
    ["Public API: 100 requests / min", "api rate limit token tokens", 45],
    ["Versioned under /v1 — never break it", "api version versioned breaking", 54],
    ["Webhooks are signed with HMAC-SHA256", "webhook webhooks hmac signature security api", 49],
    ["OpenAPI spec is the source of truth", "api openapi spec docs", 43],
  ]},
  { key: "data", name: "Data", items: [
    ["Postgres migrations run through sqlx", "postgres migration migrations database sql schema db", 72],
    ["Users soft-delete, purge after 30 days", "delete user users gdpr data privacy", 51],
    ["Never mock the DB in integration tests", "test tests mock database db integration", 64],
    ["Read replicas serve analytics only", "database replica analytics db", 37],
    ["Timestamps are UTC, always", "time timestamp timestamps utc timezone date", 47],
    ["Search index rebuilds nightly", "search index nightly", 32],
  ]},
  { key: "voice", name: "Brand voice", items: [
    ["Brand voice: plain, warm, no exclamation marks", "brand voice copy tone writing text words release notes", 88],
    ["Release notes lead with the user benefit", "release notes changelog writing write", 56],
    ["The product name is lowercase: atlas", "name brand copy atlas", 39],
    ["Error messages say what to do next", "error errors message messages copy ux", 53],
    ["Onboarding copy: three steps, max", "onboarding copy steps", 36],
  ]},
  { key: "ship", name: "Testing & release", items: [
    ["CI must stay under 10 minutes", "ci test tests pipeline speed fast", 66],
    ["Every checkout change ships behind a flag", "feature flag flags checkout release rollout ship", 58],
    ["Release train leaves on Tuesdays", "release deploy ship tuesday", 44],
    ["E2E tests run on Playwright", "test tests e2e playwright browser", 50],
    ["Bug: Safari drops the refresh cookie", "safari cookie bug refresh auth login fix", 61],
    ["Lint rule: no default exports", "lint export exports code style", 31],
  ]},
];
const CROSS_LINKS = [
  ["auth:1", "ship:4"], ["api:4", "payments:3"], ["payments:6", "ship:0"], ["design:1", "ship:1"],
  ["design:0", "voice:0"], ["data:2", "ship:3"], ["api:0", "voice:3"], ["auth:4", "api:2"],
  ["payments:0", "payments:5"], ["design:1", "payments:0"], ["auth:0", "data:4"], ["voice:1", "ship:2"],
];

function memoryDataset() {
  const R = rng(20261102);
  const entities = [], relations = [], idOf = new Map();
  let rid = 0;
  const rel = (a, b, score) => relations.push({ id: `r${rid++}`, source_entity_id: a, target_entity_id: b, score });
  for (const t of MEMORY_TOPICS) {
    t.items.forEach(([title, kw, score], k) => {
      const id = `${t.key}:${k}`;
      idOf.set(id, entities.length);
      entities.push({ entity_id: id, title, score, kw: kw.split(" "), topic: t.name,
        tags: [{ key: "topic", value: t.name }] });
      if (k > 0) {
        rel(id, `${t.key}:0`, 50 + R() * 40);                       // hub
        if (k > 1 && R() < 0.75) rel(id, `${t.key}:${1 + Math.floor(R() * (k - 1))}`, 25 + R() * 40);
      }
    });
  }
  CROSS_LINKS.forEach(([a, b]) => rel(a, b, 30));
  return { entities, relations };
}

const STOP = new Set("the a an and or to of in on for with my our your is are be it this that from into at by as make makes add fix use using write".split(" "));
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(w => w.length >= 2 && !STOP.has(w));
}
/* Score every memory against the words typed so far. */
function matchMemories(text, entities, max = 8) {
  const toks = tokenize(text);
  if (!toks.length) return [];
  const out = [];
  entities.forEach((e, i) => {
    let s = 0;
    const titleWords = tokenize(e.title);
    for (const t of toks) {
      let best = 0;
      for (const k of e.kw) {
        if (k === t) best = Math.max(best, 3);
        else if (t.length >= 3 && k.startsWith(t)) best = Math.max(best, 1.6);
        else if (t.length >= 4 && t.startsWith(k) && k.length >= 4) best = Math.max(best, 2.4);  // plurals
      }
      for (const w of titleWords) if (t.length >= 3 && w.startsWith(t)) best = Math.max(best, 2);
      s += best;
    }
    if (s >= 2.6) out.push({ i, s: s + e.score / 200 });
  });
  out.sort((a, b) => b.s - a.s);
  if (!out.length) return [];
  const floor = Math.max(2.6, out[0].s * 0.33);
  return out.filter(o => o.s >= floor).slice(0, max).map(o => o.i);
}

/* ---------------------------------------------------------------------
   2. Deep sky: painted once per size, fixed behind the whole page.
   --------------------------------------------------------------------- */
const SKY_DUST = (() => {
  const R = rng(1337), out = [];
  for (let k = 0; k < 1500; k++) {
    const band = R() < 0.32;
    let u = R(), v;
    if (band) { const gauss = (R() + R() + R() - 1.5) * 0.1; v = 0.52 + (u - 0.5) * -0.42 + gauss; } else v = R();
    const layerR = R();
    const layer = layerR < 0.62 ? 0 : layerR < 0.9 ? 1 : 2;
    const warm = R();
    const tint = warm < 0.12 ? [255, 214, 170] : warm < 0.3 ? [180, 200, 255] : [225, 232, 255];
    out.push({ u, v: ((v % 1) + 1) % 1, layer, s: [0.55, 0.85, 1.25][layer] * (0.7 + R() * 0.6), b: [0.32, 0.5, 0.72][layer] * (0.45 + R() * 0.55),
      tw: R() < 0.4, ph: R() * TAU, f: 0.5 + R() * 2.2, tint, col: `rgb(${tint[0]},${tint[1]},${tint[2]})`, sparkle: layer === 2 && R() < 0.35 });
  }
  return out;
})();

/* Calm sky is the default: sparse, near-monochrome stars; lines, colour and
   labels appear only where the pointer or the prompt lights them.
   ?sky=v1 shows the earlier, busier night sky for comparison. */
const CALM = !/[?&]sky=v1/.test(location.search);
const calmCache = new Map();
/* A star's resting look: its topic colour washed almost to white. */
function calmSprites(rgb) {
  const k = rgb.join(",");
  if (!calmCache.has(k)) calmCache.set(k, sprites(mix(rgb, [228, 234, 252], 0.78)));
  return calmCache.get(k);
}

/* a resting daylight star: graphite with a trace of its topic tone */
const inkRestCache = new Map();
function inkRest(deep) { const k = deep.join(); if (!inkRestCache.has(k)) inkRestCache.set(k, inkSprites(mix(deep, INK, 0.72))); return inkRestCache.get(k); }

/* Daylight: a star chart printed on paper. Stars are ink dots (normal
   compositing; additive light is invisible on white), lit stars take a
   deeper, readable tone of their topic colour. */
const INK = [30, 34, 68];
/* a sky colour → its readable daylight tone (same order as PALETTE) */
function deepTone(rgb) {
  const k = PALETTE.findIndex(p => p.rgb[0] === rgb[0] && p.rgb[1] === rgb[1] && p.rgb[2] === rgb[2]);
  if (k >= 0) return INL_PAL.light[k];
  if (rgb.join() === STRAY_RGB.join()) return INL_STRAY.light;
  return mix(rgb, INK, 0.55);
}
const inkCache = new Map();
/* same shape as sprites(): visible core radius matches the night core, so
   callers keep their sizes and only swap the sprite set + composite op */
function inkSprites(rgb) {
  const key = rgb.join(",");
  if (inkCache.has(key)) return inkCache.get(key);
  const core = radialSprite(64, [[0, rgba(rgb, 1)], [0.22, rgba(rgb, 1)], [0.31, rgba(rgb, 0.55)], [0.38, rgba(rgb, 0)], [1, rgba(rgb, 0)]]);
  const gs = []; for (let k = 0; k <= 10; k++) { const o = k / 10; gs.push([o, rgba(rgb, 0.3 * Math.exp(-o * o * 6) * (1 - o))]); }
  const glow = radialSprite(128, gs);
  const ns = []; for (let k = 0; k <= 10; k++) { const o = k / 10; ns.push([o, rgba(rgb, 0.12 * Math.exp(-o * o * 4) * (1 - o * o))]); }
  const neb = radialSprite(256, ns);
  // a chart marker: a fine hairline cross, strongest near the star
  const S = 256, sc = makeCanvas(S, S), sx = sc.getContext("2d"), h = S / 2;
  for (const horiz of [true, false]) {
    const gr = horiz ? sx.createLinearGradient(0, h, S, h) : sx.createLinearGradient(h, 0, h, S);
    gr.addColorStop(0, rgba(rgb, 0)); gr.addColorStop(0.4, rgba(rgb, 0.18)); gr.addColorStop(0.5, rgba(rgb, 0.7)); gr.addColorStop(0.6, rgba(rgb, 0.18)); gr.addColorStop(1, rgba(rgb, 0));
    sx.fillStyle = gr;
    if (horiz) sx.fillRect(0, h - 1, S, 2); else sx.fillRect(h - 1, 0, 2, S);
  }
  const out = { glow, core, neb, spike: sc, line: rgba(rgb, 1), rgb };
  inkCache.set(key, out); return out;
}
/* the sprite set for the current theme; rgb is the night (sky) colour */
function themeSprites(rgb) { return isLight() ? inkSprites(deepTone(rgb)) : sprites(rgb); }
const themeBlend = () => isLight() ? "source-over" : "lighter";

/* ?motion=reduce previews the calm state without changing OS settings */
const FORCE_CALM = /[?&]motion=reduce/.test(location.search);
const REDUCED = FORCE_CALM ? { matches: true, addEventListener() {} } : window.matchMedia("(prefers-reduced-motion: reduce)");
if (FORCE_CALM) document.addEventListener("DOMContentLoaded", () => {
  const css = [];
  for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) if (r.media && /reduced-motion/.test(r.media.mediaText)) { const extra = r.media.mediaText.replace(/\(prefers-reduced-motion:\s*reduce\)\s*(and)?/, "").trim(); css.push(extra ? `@media ${extra} { ${[...r.cssRules].map(x => x.cssText).join("")} }` : [...r.cssRules].map(x => x.cssText).join("")); } } catch {} }
  const st = document.createElement("style"); st.textContent = css.join("\n"); document.head.appendChild(st);
  setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
});

const DeepSky = (() => {
  const canvas = document.getElementById("deep-sky");
  const ctx = canvas.getContext("2d");
  let lastW = 0, lastH = 0, lastTheme = "";
  function paint(force) {
    const W = window.innerWidth, H = Math.max(window.innerHeight, lastH * (lastW === window.innerWidth ? 1 : 0));
    const theme = isLight() ? "light" : "dark";
    if (!force && theme === lastTheme && W === lastW && Math.abs(H - lastH) < 120) return;     // ignore phone URL-bar wobble
    lastW = W; lastH = H; lastTheme = theme;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.height = H + "px";
    const b = ctx; b.setTransform(DPR, 0, 0, DPR, 0, 0);
    const D = Math.max(W, H);
    // a wide, soft ellipse of colour (no hard edges)
    const wash = (x, y, rx, ry, stops) => {
      b.save(); b.translate(x, y); b.scale(rx / ry, 1);
      const g = b.createRadialGradient(0, 0, 0, 0, 0, ry);
      stops.forEach(([o, c]) => g.addColorStop(o, c));
      b.fillStyle = g; b.fillRect(-ry, -ry, ry * 2, ry * 2); b.restore();
    };
    if (CALM && isLight()) {
      // daylight: warm paper, a faint cool morning tint at the top, a few ink specks
      const lg = b.createLinearGradient(0, 0, 0, H);
      lg.addColorStop(0, "#eef0f6"); lg.addColorStop(0.42, "#f4f3f1"); lg.addColorStop(1, "#f6f5f1");
      b.fillStyle = lg; b.fillRect(0, 0, W, H);
      wash(W * 0.34, -H * 0.04, W * 0.62, H * 0.42, [[0, "rgba(176,190,240,0.26)"], [0.55, "rgba(186,196,238,0.08)"], [1, "rgba(190,200,240,0)"]]);
      wash(W * 0.72, -H * 0.02, W * 0.5, H * 0.36, [[0, "rgba(204,184,240,0.2)"], [0.55, "rgba(206,190,240,0.06)"], [1, "rgba(206,190,240,0)"]]);
      b.fillStyle = "rgb(40,44,80)";
      const nc = Math.round(0.06 * SKY_DUST.length * clamp(W * H / (1440 * 900), 0.35, 1.2));
      for (let k = 0; k < nc; k++) {
        const d = SKY_DUST[k], sz = Math.min(d.s, 1);
        b.globalAlpha = 0.05 + d.b * 0.12; b.fillRect(d.u * W - sz / 2, d.v * H - sz / 2, sz, sz);
      }
      b.globalAlpha = 1;
      return;
    }
    if (CALM) {
      // deep midnight indigo, one soft aurora in the headline's hues — nothing competes with it
      const lgc = b.createLinearGradient(0, 0, 0, H);
      lgc.addColorStop(0, "#0b1030"); lgc.addColorStop(0.5, "#070a1c"); lgc.addColorStop(1, "#05060f");
      b.fillStyle = lgc; b.fillRect(0, 0, W, H);
      b.globalCompositeOperation = "lighter";
      wash(W * 0.3, -H * 0.02, W * 0.42, H * 0.34, [[0, "rgba(40,190,140,0.19)"], [0.5, "rgba(30,150,120,0.06)"], [1, "rgba(30,150,120,0)"]]);
      wash(W * 0.52, H * 0.02, W * 0.46, H * 0.3, [[0, "rgba(40,170,215,0.15)"], [0.5, "rgba(34,140,200,0.04)"], [1, "rgba(34,140,200,0)"]]);
      wash(W * 0.74, -H * 0.03, W * 0.42, H * 0.34, [[0, "rgba(140,110,240,0.2)"], [0.5, "rgba(120,96,220,0.065)"], [1, "rgba(120,96,220,0)"]]);
      b.fillStyle = "rgb(214,222,245)";
      const nc = Math.round(0.2 * SKY_DUST.length * clamp(W * H / (1440 * 900), 0.35, 1.2));
      for (let k = 0; k < nc; k++) {
        const d = SKY_DUST[k], sz = Math.min(d.s, 1.1);
        b.globalAlpha = d.b * 0.7; b.fillRect(d.u * W - sz / 2, d.v * H - sz / 2, sz, sz);
      }
      b.globalAlpha = 1; b.globalCompositeOperation = "source-over";
      return;
    }
    // background — the starfield's paintBackground()
    const lg = b.createLinearGradient(0, 0, W * 0.3, H);
    lg.addColorStop(0, "#0c1533"); lg.addColorStop(0.45, "#070b1d"); lg.addColorStop(1, "#03040a");
    b.fillStyle = lg; b.fillRect(0, 0, W, H);
    const soft = (x, y, r, col, a) => { const gr = b.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0)); b.fillStyle = gr; b.fillRect(0, 0, W, H); };
    soft(W * 0.72, H * 0.18, D * 0.55, [40, 62, 140], 0.22);
    soft(W * 0.18, H * 0.85, D * 0.45, [70, 40, 110], 0.12);
    b.save(); b.translate(W / 2, H * 0.52); b.rotate(Math.atan2(-0.42 * H, W)); b.scale(1, 0.16);
    const bg2 = b.createRadialGradient(0, 0, 0, 0, 0, D * 0.7); bg2.addColorStop(0, "rgba(120,140,210,0.07)"); bg2.addColorStop(1, "rgba(120,140,210,0)");
    b.fillStyle = bg2; b.fillRect(-D, -D * 3, D * 2, D * 6); b.restore();
    const vg = b.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,6,0.55)");
    b.fillStyle = vg; b.fillRect(0, 0, W, H);
    // static dust
    b.globalCompositeOperation = "lighter";
    const n = Math.round(0.5 * SKY_DUST.length * clamp(W * H / (1440 * 900), 0.35, 1.2));
    for (let k = 0; k < n; k++) {
      const d = SKY_DUST[k], x = d.u * W, y = d.v * H;
      if (d.sparkle) { b.globalAlpha = d.b * 0.5; const s = d.s * 4.5; b.drawImage(NEUTRAL.glow, x - s, y - s, s * 2, s * 2); }
      b.globalAlpha = d.b; b.fillStyle = d.col; b.fillRect(x - d.s / 2, y - d.s / 2, d.s, d.s);
    }
    b.globalAlpha = 1; b.globalCompositeOperation = "source-over";
  }
  return { paint };
})();

/* ---------------------------------------------------------------------
   3. Hero constellation — the Night renderer, made to respond to the
      pointer and to give its memories to the composer.
   --------------------------------------------------------------------- */
const HeroSky = (() => {
  const canvas = document.getElementById("hero-sky");
  const ctx = canvas.getContext("2d");
  const nebCanvas = makeCanvas(4, 4), nebCtx = nebCanvas.getContext("2d");
  const NEB_SCALE = 0.25, CAM_DIST = 3.6;
  const data = memoryDataset();
  const scene = buildScene(data);
  const n = scene.n;
  const prox = new Float32Array(n);
  const taken = new Map();        // idx -> time taken
  const flare = new Map();        // idx -> time of flare
  let W = 1, H = 1, DPR = 1, viewK = 1, ax = 1;
  const cam = { yaw: 0.35, pitch: -0.22, zoom: 1, py: 0, pp: 0 };
  const mouse = { x: -9999, y: -9999, tx: 0, ty: 0, on: false };
  let exclude = [];               // rects (canvas coords) labels avoid
  let hoverIdx = -1, tapIdx = -1, tapUntil = 0;
  let running = false, raf = 0, last = 0, t = 0, visible = true;
  const fps = { frames: 0, since: 0, value: 0, worst: 0 };

  // twinkling foreground dust with parallax (the deep sky below is static)
  const DUST = SKY_DUST.filter(d => d.layer > 0).slice(0, 320);

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    nebCanvas.width = Math.max(4, Math.round(W * NEB_SCALE)); nebCanvas.height = Math.max(4, Math.round(H * NEB_SCALE));
    viewK = clamp(Math.sqrt(Math.min(W, H) / 820), 0.74, 1.12);
    ax = clamp((W / H) / 1.05, 1, 1.75);
    cam.zoom = W < 600 ? 1.08 : 1.22;
    requestDraw();
  }
  function setExclusions(rects) { exclude = rects; }

  function fitUnit() { return Math.min((W * 0.44) / scene.fitXZ, (H * 0.42) / (scene.fitY + 0.18 * scene.fitXZ)); }
  let T = null;
  function project() {
    const { P, px, py, ps, pd } = scene;
    const yaw = cam.yaw + cam.py, pitch = cam.pitch + cam.pp;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const unit = fitUnit() * cam.zoom, ox = W / 2, oy = H * (W < 600 ? 0.5 : 0.47);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const s = CAM_DIST / (CAM_DIST + z2);
      px[i] = ox + x1 * s * unit * ax; py[i] = oy + y2 * s * unit; ps[i] = s; pd[i] = clamp((1.25 - z2) / 2.5, 0, 1);
    }
    scene.order.sort((a, b) => pd[a] - pd[b]);
    T = { cy, sy, cp, sp, unit, ox, oy };
  }
  function projectPoint(x, y, z) {
    const x1 = x * T.cy + z * T.sy, z1 = -x * T.sy + z * T.cy;
    const y2 = y * T.cp - z1 * T.sp, z2 = y * T.sp + z1 * T.cp;
    const s = CAM_DIST / (CAM_DIST + z2);
    return [T.ox + x1 * s * T.unit * ax, T.oy + y2 * s * T.unit, s, clamp((1.25 - z2) / 2.5, 0, 1)];
  }
  function linkCtrl(x0, y0, x1, y1, phase) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0;
    const k = (phase < 0.5 ? -1 : 1) * (0.07 + phase * 0.05);
    return [mx - dy * k, my + dx * k];
  }
  function bez(x0, y0, cx, cy, x1, y1, tt) { const u = 1 - tt; return [u * u * x0 + 2 * u * tt * cx + tt * tt * x1, u * u * y0 + 2 * u * tt * cy + tt * tt * y1]; }

  function frame(now) {
    raf = 0;
    const dt = last ? clamp((now - last) / 1000, 0, 0.05) : 0.016; last = now;
    const still = REDUCED.matches;
    if (!still) {
      t += dt;
      cam.yaw += 0.022 * dt;
      const k = 1 - Math.exp(-dt * 2.2);
      cam.py = lerp(cam.py, mouse.tx * 0.16, k);
      cam.pp = lerp(cam.pp, mouse.ty * 0.08, k);
    }
    draw(now, still);
    // fps meter (exposed for the perf report)
    fps.frames++; if (!fps.since) fps.since = now;
    if (dt > fps.worst) fps.worst = dt;
    if (now - fps.since > 1000) { fps.value = Math.round(fps.frames * 1000 / (now - fps.since)); fps.frames = 0; fps.since = now; }
    if (running && !still) raf = requestAnimationFrame(frame);
    else last = 0;
  }
  function requestDraw() { if (!raf) raf = requestAnimationFrame(frame); }

  function draw(now, still) {
    project();
    const { stars, links, px, py, ps, pd, order } = scene;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    // pointer proximity: a lantern that lights nearby memories
    const R = W < 600 ? 120 : 175;
    let near = -1, nearD = 1e9;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(px[i] - mouse.x, py[i] - mouse.y);
      const p = mouse.on ? Math.max(0, 1 - d / R) : 0;
      prox[i] = lerp(prox[i], p * p, still ? 1 : 0.22);
      const hitR = Math.max(16, stars[i].r * 3);
      if (mouse.on && d < hitR && d < nearD) { nearD = d; near = i; }
    }
    hoverIdx = near;
    const ink = CALM && isLight();                         // daylight star chart
    const blend = ink ? "source-over" : "lighter";

    // --- foreground dust (parallax) ---
    ctx.globalCompositeOperation = "lighter";
    const offX = (cam.yaw + cam.py) * W, offY = (cam.pitch + cam.pp) * H;
    const PAR = [0.05, 0.13, 0.28];
    const dustN = CALM ? 0 : Math.round(DUST.length * clamp(W * H / (1440 * 900), 0.4, 1));
    for (let k = 0; k < dustN; k++) {
      const d = DUST[k], par = PAR[d.layer];
      let x = (d.u * W - offX * par) % W; if (x < 0) x += W;
      let y = (d.v * H - offY * par) % H; if (y < 0) y += H;
      let a = d.b * 0.8;
      if (d.tw && !still) a *= 1 + 0.45 * Math.sin(t * d.f + d.ph);
      if (a <= 0.01) continue;
      if (d.sparkle) { ctx.globalAlpha = clamp(a * 0.5, 0, 1); const s = d.s * 4.5; ctx.drawImage(NEUTRAL.glow, x - s, y - s, s * 2, s * 2); }
      ctx.globalAlpha = clamp(a, 0, 1); ctx.fillStyle = d.col; ctx.fillRect(x - d.s / 2, y - d.s / 2, d.s, d.s);
    }

    // --- nebulae (low-res buffer, upscaled) ---
    nebCtx.setTransform(1, 0, 0, 1, 0, 0);
    nebCtx.globalCompositeOperation = "source-over"; nebCtx.clearRect(0, 0, nebCanvas.width, nebCanvas.height);
    nebCtx.globalCompositeOperation = "lighter";
    const sx = nebCanvas.width / W, sy2 = nebCanvas.height / H;
    for (const b of CALM ? [] : scene.blobs) {
      const [x, y, s, dep] = projectPoint(b.x, b.y, b.z);
      const r = Math.min(b.rad * s * T.unit * Math.sqrt(ax), Math.min(W, H) * 0.42);
      nebCtx.globalAlpha = clamp(b.a * 0.2 * (0.55 + 0.45 * dep), 0, 1);
      nebCtx.drawImage(sprites(b.rgb).neb, (x - r) * sx, (y - r) * sy2, 2 * r * sx, 2 * r * sy2);
    }
    ctx.globalCompositeOperation = blend; ctx.globalAlpha = 1;
    if (!CALM) ctx.drawImage(nebCanvas, 0, 0, W, H);

    // --- glimmers: unformed light (pending logs) ---
    for (const gm of CALM ? [] : scene.glimmers) {
      const [x, y, s, dep] = projectPoint(gm.x, gm.y, gm.z);
      const life = still ? 0.6 : 0.5 + 0.5 * Math.sin((t / gm.period) * TAU + gm.phase);
      const a = 0.22 * life * life * (0.5 + 0.5 * dep);
      if (a < 0.01) continue;
      const r = (5 + 5 * life) * s;
      ctx.globalAlpha = a; ctx.drawImage(sprites(gm.rgb).glow, x - r, y - r, 2 * r, 2 * r);
    }

    // --- constellation lines ---
    ctx.lineCap = "round";
    const nLinkScale = clamp(1.25 - Math.log10(Math.max(links.length, 1)) * 0.22, 0.6, 1);
    for (const l of links) {
      const a = l.s, b = l.t, sa = stars[a], sb = stars[b];
      const lit = Math.max(prox[a], prox[b]) + ((taken.has(a) && taken.has(b)) ? 0.9 : 0);
      const depthA = 0.35 + 0.65 * (pd[a] + pd[b]) / 2;
      const alpha = ink
        ? (0.05 + 0.5 * Math.min(lit, 1.2)) * depthA        // graphite hairline at rest
        : CALM
        ? (0.022 + 0.42 * Math.min(lit, 1.2)) * depthA       // a whisper at rest, drawn in when lit
        : (0.07 + 0.13 * l.w) * nLinkScale * depthA * (1 + 3.2 * lit);
      if (alpha < 0.012) continue;
      const x0 = px[a], y0 = py[a], x1 = px[b], y1 = py[b];
      const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.strokeStyle = ink
        ? (lit < 0.15 || sa.comm !== sb.comm ? "rgb(40,44,78)" : inkSprites(scene.clusters[sa.comm].inl.light).line)
        : CALM && lit < 0.15 ? "rgb(178,190,224)" : sa.comm === sb.comm ? sprites(scene.clusters[sa.comm].rgb).line : "rgb(176,190,228)";
      ctx.lineWidth = (ink ? 0.5 + 0.25 * l.w : 0.55 + 0.35 * l.w) + lit * 0.4;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1); ctx.stroke();
    }

    // --- light pulses: along lit links, and a rare ambient one ---
    if (!still) {
      for (const l of links) {
        const lit = Math.max(prox[l.s], prox[l.t]);
        if (lit < 0.25) continue;
        const from = prox[l.s] >= prox[l.t] ? l.s : l.t;
        const x0 = px[l.s], y0 = py[l.s], x1 = px[l.t], y1 = py[l.t];
        const [cx, cy] = linkCtrl(x0, y0, x1, y1, l.phase);
        const ph = (t * 0.55 + l.phase) % 1, tt = from === l.s ? ph : 1 - ph;
        const [x, y] = bez(x0, y0, cx, cy, x1, y1, tt);
        const a = Math.sin(Math.PI * ph) * lit;
        if (ink) { ctx.globalAlpha = a * 0.9; ctx.drawImage(inkSprites(scene.clusters[stars[from].comm].inl.light).core, x - 4, y - 4, 8, 8); }
        else { ctx.globalAlpha = a; ctx.drawImage(sprites(scene.clusters[stars[from].comm].rgb).glow, x - 7, y - 7, 14, 14); }
      }
      const period = 3.4, round = Math.floor(t / period), ph = (t % period) / 1.8;
      if (!CALM && ph < 1 && links.length) {
        const l = links[hash32("pulse" + round, 4) % links.length];
        const [cx, cy] = linkCtrl(px[l.s], py[l.s], px[l.t], py[l.t], l.phase);
        const [x, y] = bez(px[l.s], py[l.s], cx, cy, px[l.t], py[l.t], ph);
        ctx.globalAlpha = Math.sin(Math.PI * ph) * 0.45; ctx.drawImage(sprites(scene.clusters[stars[l.s].comm].rgb).glow, x - 5, y - 5, 10, 10);
      }
    }

    // --- stars (far → near) ---
    ctx.globalCompositeOperation = blend;
    for (let o = 0; o < order.length; o++) {
      const i = order[o], st = stars[i], dep = pd[i], s = ps[i];
      let tw = 1;
      if (!still) tw = 1 + (0.16 + 0.16 * (1 - st.m)) * (Math.sin(t * st.freq + st.phase) * 0.65 + Math.sin(t * st.freq2 + st.phase2) * 0.35);
      const fl = flare.has(i) ? Math.max(0, 1 - (now - flare.get(i)) / 1400) : 0;
      if (flare.has(i) && fl <= 0) flare.delete(i);
      const boost = prox[i] + (taken.has(i) ? 0.55 : 0) + fl * 1.6;
      // at rest a calm star is pale; its topic colour shows once it is lit
      const cl = scene.clusters[st.comm];
      const spr = ink ? (boost < 0.2 ? inkRest(cl.inl.light) : inkSprites(cl.inl.light))
        : CALM && boost < 0.2 ? calmSprites(cl.rgb) : sprites(cl.rgb);
      const r = Math.max(0.55, st.r * s * viewK * Math.sqrt(cam.zoom) * (0.8 + 0.2 * dep)) * (1 + 0.45 * Math.min(boost, 1.4));
      const a = ink
        ? clamp((0.3 + 0.55 * st.bright) * (0.4 + 0.6 * dep) * (0.92 + 0.08 * tw) * (1 + 0.8 * boost), 0, 1)
        : clamp(st.bright * (0.42 + 0.58 * dep) * tw * (1 + 1.1 * boost), 0, 1.4);
      const x = px[i], y = py[i];
      const m = Math.max(st.m, Math.min(1, boost * 0.8));
      if (ink ? boost > 0.2 : m > (CALM ? 0.78 : 0.5)) {
        const g = r * (3.4 + 3.6 * m) * (1.15 - 0.3 * dep) * (CALM ? 0.6 : 1);
        ctx.globalAlpha = clamp(a * (m - 0.45) * (CALM ? 0.9 : 1.5), 0, 1);
        ctx.drawImage(spr.glow, x - g, y - g, g * 2, g * 2);
      }
      if ((st.spike && !CALM) || fl > 0) {
        const L = r * 9.5 * (0.85 + 0.15 * tw) * (1 + fl);
        ctx.globalAlpha = clamp(a * 0.55 + fl * 0.4, 0, 1);
        ctx.drawImage(spr.spike, x - L, y - L, L * 2, L * 2);
      }
      const c = r * (ink ? 1.9 : 2.3) * (1.1 - 0.15 * dep);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.drawImage(spr.core, x - c, y - c, c * 2, c * 2);
    }

    // --- reticles: taken memories and the one under the pointer ---
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = ink ? "rgba(26,30,60,1)" : "rgba(225,233,255,1)"; ctx.lineWidth = ink ? 0.9 : 0.8;
    const ring = (idx, alpha, ticks) => {
      const r = Math.max(7, stars[idx].r * ps[idx] * viewK * 2.2 + 6);
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(px[idx], py[idx], r, 0, TAU); ctx.stroke();
      if (ticks) {
        ctx.beginPath();
        for (let q = 0; q < 4; q++) { const an = q * Math.PI / 2 + (still ? 0 : t * 0.4); ctx.moveTo(px[idx] + Math.cos(an) * (r + 3), py[idx] + Math.sin(an) * (r + 3)); ctx.lineTo(px[idx] + Math.cos(an) * (r + 7), py[idx] + Math.sin(an) * (r + 7)); }
        ctx.stroke();
      }
    };
    for (const idx of taken.keys()) ring(idx, ink ? 0.7 : 0.6, true);
    const lab = hoverIdx >= 0 ? hoverIdx : (now < tapUntil ? tapIdx : -1);
    if (lab >= 0 && !taken.has(lab)) ring(lab, ink ? 0.5 : 0.4, false);

    drawLabels(lab, ink);
    ctx.globalAlpha = 1;
  }

  function drawLabels(focus, ink) {
    const { stars, px, py, ps } = scene;
    const want = [];
    if (focus >= 0) want.push([focus, 0]);
    for (const i of taken.keys()) want.push([i, 1]);
    const lit = [];
    for (let i = 0; i < n; i++) if (prox[i] > 0.3) lit.push(i);
    lit.sort((a, b) => prox[b] - prox[a]).slice(0, W < 600 ? 2 : 4).forEach(i => want.push([i, 2]));
    if (!CALM) [...scene.labelSet].sort((a, b) => stars[a].rank - stars[b].rank).forEach(i => want.push([i, 3]));
    const placed = [], done = new Set();
    ctx.textBaseline = "middle";
    for (const [i, tier] of want) {
      if (done.has(i)) continue;
      const x = px[i], y = py[i];
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const r = stars[i].r * ps[i] * viewK * 1.6 + 8;
      const e = stars[i].e;
      const fs = tier === 0 ? 12.5 : tier === 3 ? 11 : 11.5;
      ctx.font = `${tier <= 1 ? 600 : 500} ${fs}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      let text = e.title; const max = tier === 0 ? 44 : 30;
      if (text.length > max) text = text.slice(0, max - 1) + "…";
      const tw = ctx.measureText(text).width;
      const sub = tier === 0 ? `Memory · ${e.topic} · importance ${e.score}` : null;
      const bh = sub ? fs + 16 : fs + 2;
      const cands = [[x + r, y - bh / 2], [x - r - tw, y - bh / 2], [x - tw / 2, y - r - bh], [x - tw / 2, y + r]];
      let spot = null;
      for (const [lx, ly] of cands) {
        const rect = [lx - 3, ly - 3, lx + tw + 3, ly + bh + 3];
        if (rect[0] < 8 || rect[2] > W - 8 || rect[1] < 64 || rect[3] > H - 30) continue;
        const hit = p => !(rect[2] < p[0] || rect[0] > p[2] || rect[3] < p[1] || rect[1] > p[3]);
        if (placed.some(hit) || exclude.some(hit)) continue;
        spot = [lx, ly, rect]; break;
      }
      if (!spot) continue;
      placed.push(spot[2]); done.add(i);
      const a = tier === 0 ? 0.96 : tier === 1 ? 0.9 : tier === 2 ? 0.75 * prox[i] + 0.2 : 0.5;
      if (ink) {
        // dark ink with a paper halo
        ctx.globalAlpha = Math.min(1, a + 0.04); ctx.lineJoin = "round"; ctx.lineWidth = 4; ctx.strokeStyle = "rgba(246,245,241,0.92)";
        ctx.fillStyle = tier === 3 ? "rgb(70,76,104)" : "rgb(22,25,46)";
        ctx.strokeText(text, spot[0], spot[1] + (fs + 2) / 2); ctx.fillText(text, spot[0], spot[1] + (fs + 2) / 2);
        if (sub) {
          ctx.font = `500 10.5px Inter, -apple-system, sans-serif`; ctx.globalAlpha = 0.9;
          ctx.fillStyle = rgba(scene.clusters[stars[i].comm].inl.light, 1);
          ctx.strokeText(sub, spot[0], spot[1] + fs + 10); ctx.fillText(sub, spot[0], spot[1] + fs + 10);
        }
        continue;
      }
      ctx.globalAlpha = a; ctx.shadowColor = "rgba(2,4,12,0.9)"; ctx.shadowBlur = 6;
      ctx.fillStyle = tier === 3 ? "rgb(206,218,250)" : "rgb(238,242,255)";
      ctx.fillText(text, spot[0], spot[1] + (fs + 2) / 2);
      if (sub) {
        ctx.font = `400 10.5px Inter, -apple-system, sans-serif`; ctx.globalAlpha = 0.62;
        ctx.fillStyle = rgba(mix(scene.clusters[stars[i].comm].rgb, [255, 255, 255], 0.3), 1);
        ctx.fillText(sub, spot[0], spot[1] + fs + 10);
      }
      ctx.shadowBlur = 0;
    }
  }

  /* pointer */
  function onMove(ev) {
    const r = canvas.getBoundingClientRect();
    mouse.x = ev.clientX - r.left; mouse.y = ev.clientY - r.top;
    mouse.on = ev.pointerType !== "touch";
    mouse.tx = clamp((mouse.x / W) * 2 - 1, -1, 1); mouse.ty = clamp((mouse.y / H) * 2 - 1, -1, 1);
    if (REDUCED.matches) requestDraw();
  }
  function onLeave() { mouse.on = false; mouse.x = mouse.y = -9999; if (REDUCED.matches) requestDraw(); }
  function onTap(ev) {
    if (ev.pointerType !== "touch") return;
    const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = 44;
    for (let i = 0; i < n; i++) { const d = Math.hypot(scene.px[i] - x, scene.py[i] - y); if (d < bd) { bd = d; best = i; } }
    if (best >= 0) { tapIdx = best; tapUntil = performance.now() + 2600; flare.set(best, performance.now()); requestDraw(); }
  }

  function setRunning(on) {
    running = on && visible && !document.hidden;
    if (running) requestDraw();
  }

  return {
    scene, data,
    init() {
      resize();
      const hero = document.getElementById("hero");
      hero.addEventListener("pointermove", onMove, { passive: true });
      hero.addEventListener("pointerleave", onLeave);
      hero.addEventListener("pointerdown", onTap, { passive: true });
      new IntersectionObserver(([en]) => { visible = en.isIntersecting; setRunning(true); }, { threshold: 0 }).observe(canvas);
      document.addEventListener("visibilitychange", () => setRunning(true));
      REDUCED.addEventListener("change", () => { setRunning(true); requestDraw(); });
      window.addEventListener("grove:theme", requestDraw);
      setRunning(true);
    },
    resize, setExclusions,
    match: text => matchMemories(text, data.entities),
    entity: i => data.entities[i],
    topicColor: i => { const cl = scene.clusters[scene.stars[i].comm]; return rgba(CALM && isLight() ? cl.inl.light : cl.rgb, 1); },
    redraw: requestDraw,
    /* viewport coordinates of a star right now */
    screenPos(i) { const r = canvas.getBoundingClientRect(); return [r.left + scene.px[i], r.top + scene.py[i]]; },
    take(i) { taken.set(i, performance.now()); flare.set(i, performance.now()); requestDraw(); },
    release(i) { taken.delete(i); requestDraw(); },
    releaseAll() { taken.clear(); requestDraw(); },
    get fps() { return fps; },
    /* dev: average CPU cost of one hero frame, in ms */
    bench(k = 120) { const t0 = performance.now(); for (let j = 0; j < k; j++) { t += 0.016; mouse.on = true; mouse.x = W * (0.3 + 0.4 * Math.sin(j / 9)); mouse.y = H * 0.4; draw(performance.now(), false); } ctx.getImageData(0, 0, 1, 1); mouse.on = false; return (performance.now() - t0) / k; },
  };
})();
