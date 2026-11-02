/* Grove site — interactions. Depends on sky-engine.js + sky.js. */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const still = () => REDUCED.matches;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const touchy = window.matchMedia("(hover: none)");
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const AGENTS = [
  ["Claude Code", "CC", "#c96442"], ["Codex", "CX", "#3d3d3a"], ["Gemini CLI", "GE", "#4f7be8"], ["GitHub Copilot", "GH", "#6e40c9"],
  ["Cursor Agent", "CU", "#2c2c2c"], ["Junie", "JU", "#1c9f68"], ["Trae CLI", "TR", "#d9503d"], ["Kimi", "KI", "#3b6ef5"],
  ["Qwen", "QW", "#6f55e8"], ["OpenCode", "OC", "#5d6b7a"],
];

/* real agent icons (copied from grove-web/public/agent-icon); monochrome
   ones get an ink/white filter per theme via .ag-ic.is-mono */
const AGENT_ICON = {
  "Claude Code": "claude-color", "Codex": "openai", "Gemini CLI": "gemini-color", "GitHub Copilot": "githubcopilot",
  "Cursor Agent": "cursor", "Junie": "junie-color", "Trae CLI": "trae-color", "Kimi": "kimi-color", "Qwen": "qwen-color",
  "OpenCode": "opencode", "Hermes": "hermes", "Kiro": "kiro", "OpenClaw": "openclaw-color",
};
const MONO_ICONS = new Set(["openai", "githubcopilot", "cursor", "opencode", "hermes"]);
const agentIconSrc = name => AGENT_ICON[name] ? `agent-icon/${AGENT_ICON[name]}.svg` : null;
function agentIcon(name) {
  const f = AGENT_ICON[name];
  return f ? `<img class="ag-ic${MONO_ICONS.has(f) ? " is-mono" : ""}" src="agent-icon/${f}.svg" alt="" width="16" height="16" decoding="async">` : "";
}
function setAgentIcon(el, name) {
  const f = AGENT_ICON[name]; if (!el || !f) return;
  el.classList.add("has-ic"); el.innerHTML = agentIcon(name);
}

/* =====================================================================
   Sky
   ===================================================================== */
DeepSky.paint();
HeroSky.init();
let resizeT = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { DeepSky.paint(); HeroSky.resize(); updateExclusions(); Graph.layout(); Org.layout(); onScroll(); }, 120);
});
window.addEventListener("grove:theme", () => DeepSky.paint(true));
function updateExclusions() {
  const c = $("#hero-sky").getBoundingClientRect();
  HeroSky.setExclusions($$("#hero [data-x]").filter(el => !el.hidden).map(el => {
    const r = el.getBoundingClientRect();
    return [r.left - c.left - 14, r.top - c.top - 10, r.right - c.left + 14, r.bottom - c.top + 10];
  }));
}
new ResizeObserver(updateExclusions).observe($(".hero-inner"));
document.fonts && document.fonts.ready.then(updateExclusions);

$$(".agents li:not(.is-byo)").forEach(li => { const name = li.firstChild.textContent.trim(); if (AGENT_ICON[name]) { li.classList.add("has-ic"); li.insertAdjacentHTML("afterbegin", agentIcon(name)); } });
$$("[data-agent-icon]").forEach(el => setAgentIcon(el, el.dataset.agentIcon));

/* =====================================================================
   Hero composer: typing pulls memories out of the sky
   ===================================================================== */
const Composer = (() => {
  const form = $("#composer"), prompt = $("#prompt"), chipsEl = $("#chips"), send = $("#send");
  const suggest = $("#suggest"), run = $("#run"), steps = $("#run-steps");
  const chips = new Map();             // star index -> chip element
  const dismissed = new Set();
  let agentIdx = 0, running = false, timers = [], matchT = 0, typing = 0;

  function grow() { prompt.style.height = "auto"; prompt.style.height = Math.min(prompt.scrollHeight, 120) + "px"; }
  function schedule() { clearTimeout(matchT); matchT = setTimeout(sync, 150); }

  function sync() {
    if (!prompt.value.trim()) dismissed.clear();
    const ranked = HeroSky.match(prompt.value);
    const max = window.innerWidth < 640 ? 3 : 4;
    const want = ranked.filter(i => !dismissed.has(i)).slice(0, max);
    for (const i of [...chips.keys()]) if (!want.includes(i)) removeChip(i);
    let delay = 0;
    for (const i of want) if (!chips.has(i)) { addChip(i, delay); delay += 140; }
  }

  function addChip(i, delay) {
    const e = HeroSky.entity(i), color = HeroSky.topicColor(i);
    const el = document.createElement("span");
    el.className = "ctx-chip"; el.style.setProperty("--c", color);
    el.innerHTML = `<i class="cd" aria-hidden="true"></i><span class="ct">${esc(e.title)}</span><button type="button" aria-label="Remove ${esc(e.title)}"><svg class="ic"><use href="#i-x"/></svg></button>`;
    el.querySelector("button").addEventListener("click", () => { dismissed.add(i); removeChip(i); prompt.focus(); });
    chipsEl.appendChild(el);
    chips.set(i, el);
    if (still()) { HeroSky.take(i); el.classList.add("is-in"); return; }
    setTimeout(() => {
      if (chips.get(i) !== el) return;
      HeroSky.take(i);
      const d = el.querySelector(".cd").getBoundingClientRect();
      fly(HeroSky.screenPos(i), [d.left + d.width / 2, d.top + d.height / 2], color).then(() => {
        if (chips.get(i) !== el) return;
        el.classList.add("is-in");
        burst(d.left + d.width / 2, d.top + d.height / 2, color);
      });
    }, delay);
  }
  function removeChip(i) {
    const el = chips.get(i); if (!el) return;
    chips.delete(i); HeroSky.release(i);
    el.classList.add("is-out"); el.classList.remove("is-in");
    setTimeout(() => el.remove(), 220);
  }

  function fly([x0, y0], [x1, y1], c) {
    return new Promise(res => {
      const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy);
      const cx = (x0 + x1) / 2 - dy * 0.22 * Math.sign(dx || 1), cy = Math.min(y0, y1) - Math.min(140, dist * 0.25);
      const kf = [], tk = [];
      for (let k = 0; k <= 18; k++) {
        const t = k / 18, u = 1 - t;
        const x = u * u * x0 + 2 * u * t * cx + t * t * x1, y = u * u * y0 + 2 * u * t * cy + t * t * y1;
        const tx = 2 * u * (cx - x0) + 2 * t * (x1 - cx), ty = 2 * u * (cy - y0) + 2 * t * (y1 - cy);
        const ang = Math.atan2(ty, tx) * 180 / Math.PI;
        kf.push({ transform: `translate(${x}px,${y}px) scale(${1.5 - t * 0.8})`, opacity: t < 0.08 ? t / 0.08 : 1 });
        tk.push({ transform: `translate(${x}px,${y}px) rotate(${ang}deg) scaleX(${0.3 + Math.sin(Math.PI * t) * 0.9})`, opacity: Math.sin(Math.PI * Math.min(1, t * 1.1)) });
      }
      const dur = clamp(560 + dist * 0.55, 700, 1150);
      const opts = { duration: dur, easing: "cubic-bezier(.55,0,.25,1)", fill: "both" };
      const els = [0, 1, 2].map(k => {
        const el = document.createElement("i");
        el.className = "comet" + (k ? " ghost" : ""); el.style.setProperty("--c", c);
        document.body.appendChild(el);
        const a = el.animate(kf.map(f => ({ ...f, opacity: f.opacity * (k ? 0.5 - k * 0.15 : 1) })), { ...opts, delay: k * 40 });
        return [el, a];
      });
      const tail = document.createElement("i");
      tail.className = "comet-tail"; tail.style.setProperty("--c", c); document.body.appendChild(tail);
      els.push([tail, tail.animate(tk, opts)]);
      els[0][1].onfinish = () => { res(); };
      els[2][1].onfinish = () => els.forEach(([el]) => el.remove());
    });
  }
  function burst(x, y, c) {
    const b = document.createElement("i");
    b.className = "burst"; b.style.left = x + "px"; b.style.top = y + "px"; b.style.setProperty("--c", c);
    document.body.appendChild(b); setTimeout(() => b.remove(), 600);
  }

  /* agent picker */
  const pick = $("#agent-pick");
  function setAgent(k) {
    agentIdx = k; const [name, , color] = AGENTS[k];
    $("#agent-name").textContent = name;
    setAgentIcon(pick.querySelector(".mono-dot"), name);
    pick.setAttribute("aria-label", `Agent: ${name}. Click to switch agent`);
  }
  pick.addEventListener("click", () => setAgent((agentIdx + 1) % AGENTS.length));
  setAgent(0);

  /* submit → the agent picks it up */
  function later(ms, fn) { timers.push(setTimeout(fn, still() ? 0 : ms)); }
  function step(icon, cls, html) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="rs-ic ${cls}"><svg class="ic"><use href="#${icon}"/></svg></span><div>${html}</div>`;
    steps.appendChild(li); updateExclusions();
    return li;
  }
  function start() {
    if (running) return;
    const text = prompt.value.trim();
    if (!text) { form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake"); prompt.focus(); return; }
    clearTimeout(matchT); sync();
    running = true;
    const [name, mono, color] = AGENTS[agentIdx];
    form.classList.add("is-running"); send.dataset.icon = "spin"; send.setAttribute("aria-label", "Agent is working");
    prompt.readOnly = true;
    suggest.classList.add("is-hidden"); suggest.hidden = true;
    $("#run-agent").textContent = name; $("#run-mono").textContent = mono; $("#run-mono").style.setProperty("--m", color); setAgentIcon($("#run-mono"), name);
    $("#run-state").textContent = "picked it up";
    steps.innerHTML = ""; run.hidden = false; updateExclusions();
    const mems = [...chips.keys()].map(i => HeroSky.entity(i));
    const slug = (tokenize(text).slice(0, 3).join("-") || "new-task").slice(0, 28);
    later(350, () => step("i-mem", "is-mem", mems.length
      ? `Read ${mems.length} ${mems.length === 1 ? "memory" : "memories"}<small>${mems.map(m => esc(m.title)).join(" · ")}</small>`
      : `Searched memory<small>Nothing matched, so it starts from the prompt alone</small>`));
    later(1150, () => step("i-merge", "is-git", `Created task <code>${esc(slug)}</code><small>Its own git worktree and terminal session</small>`));
    later(2000, () => { step("i-sparkle", "", `<span class="shimmer">Working…</span><small>Progress would stream in here as the agent works</small>`); $("#run-state").textContent = "working"; });
  }
  function reset(focus = true) {
    timers.forEach(clearTimeout); timers = []; clearInterval(typing);
    running = false;
    form.classList.remove("is-running"); send.dataset.icon = "arrow"; send.setAttribute("aria-label", "Send to agent");
    prompt.readOnly = false; prompt.value = ""; grow();
    for (const i of [...chips.keys()]) removeChip(i);
    HeroSky.releaseAll(); dismissed.clear();
    run.hidden = true; suggest.hidden = false; requestAnimationFrame(() => suggest.classList.remove("is-hidden"));
    updateExclusions();
    if (focus) prompt.focus();
  }
  form.addEventListener("submit", e => { e.preventDefault(); start(); });
  prompt.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); start(); } });
  prompt.addEventListener("input", () => { grow(); schedule(); });
  $("#run-reset").addEventListener("click", () => reset());

  /* suggestions: type them out (tap-to-fill on touch) */
  function typeOut(text) {
    if (running) reset(false);
    clearInterval(typing);
    prompt.value = ""; grow();
    if (!touchy.matches) prompt.focus();
    if (still()) { prompt.value = text; grow(); sync(); return; }
    let k = 0;
    typing = setInterval(() => {
      k++; prompt.value = text.slice(0, k); grow();
      if (text[k - 1] === " " || k === text.length) sync();
      if (k >= text.length) clearInterval(typing);
    }, 30);
  }
  $$("#suggest button").forEach(b => b.addEventListener("click", () => typeOut(b.dataset.q)));
  return { reset };
})();

/* =====================================================================
   Scroll-pinned acts
   ===================================================================== */
const ACTS = {};
const acts = $$(".act").map(el => ({ el, key: el.dataset.act, step: -1, poke: -1, p: 0, forced: null }));
function stepFor(p) { return p < 0.22 ? 0 : p < 0.47 ? 1 : p < 0.72 ? 2 : 3; }
function setStep(a, st) {
  if (st === a.step) return;
  const prev = a.step; a.step = st;
  a.el.dataset.step = st;
  $$(".act-steps li", a.el).forEach((li, k) => { li.classList.toggle("is-done", k < st); li.classList.toggle("is-on", k === st); li.querySelector("button").setAttribute("aria-current", k === st ? "step" : "false"); });
  ACTS[a.key]?.step?.(st, prev, a);
}
let ticking = false;
function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
function update() {
  ticking = false;
  const vh = window.innerHeight;
  for (const a of acts) {
    const r = a.el.getBoundingClientRect();
    if (still()) { a.p = 1; setStep(a, a.forced ?? 3); ACTS[a.key]?.progress?.(a.forced != null ? (a.forced + 0.6) / 4 : 1, a); continue; }
    if (r.bottom < -vh * 0.5 || r.top > vh * 1.5) continue;
    a.p = clamp(-r.top / Math.max(1, r.height - vh), 0, 1);
    if (a.p < 0.01) a.poke = -1;
    setStep(a, Math.max(stepFor(a.p), a.poke));
    ACTS[a.key]?.progress?.(a.p, a);
  }
  Nav.update();
}
window.addEventListener("scroll", onScroll, { passive: true });
REDUCED.addEventListener("change", () => { acts.forEach(a => a.step = -1); onScroll(); });
function poke(a, st) { a.poke = Math.max(a.poke, st); setStep(a, Math.max(stepFor(a.p), a.poke)); ACTS[a.key]?.progress?.(a.p, a); }
acts.forEach(a => {
  $$(".act-steps button", a.el).forEach(b => b.addEventListener("click", () => {
    const go = +b.dataset.go;
    if (still()) { a.forced = go; a.step = -1; update(); return; }
    a.poke = -1;
    const top = a.el.getBoundingClientRect().top + window.scrollY;
    const at = [0.08, 0.34, 0.6, 0.86][go];
    window.scrollTo({ top: top + at * (a.el.offsetHeight - window.innerHeight), behavior: "smooth" });
  }));
});
/* pause CSS animations of anything offscreen */
const offIO = new IntersectionObserver(ents => ents.forEach(en => en.target.classList.toggle("is-off", !en.isIntersecting)), { rootMargin: "100px" });
$$(".hero, .model, .act, .graph-win, .anywhere").forEach(el => offIO.observe(el));

/* ---------- Act 1 · Capture ---------- */
ACTS.capture = (() => {
  const a = acts.find(x => x.key === "capture");
  const demo = $("#cap-demo"), win = $("#studio-win"), card = $("#fc-pdf"), list = $("#cap-files"), count = $("#cap-count");
  let userFiles = 0;
  function recount() {
    const n = 2 + (a.step >= 2 ? 1 : 0) + (a.step >= 3 ? 1 : 0) + userFiles;
    count.textContent = `${n} files`;
  }
  /* drag the PDF in by hand */
  let drag = null;
  card.addEventListener("pointerdown", e => {
    if (a.step >= 2) return;
    const r = card.getBoundingClientRect(), d = demo.getBoundingClientRect();
    drag = { id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, d, moved: false };
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.moved = true; card.classList.add("is-dragging");
    card.style.left = (e.clientX - drag.d.left - drag.ox) + "px"; card.style.top = (e.clientY - drag.d.top - drag.oy) + "px";
    const w = win.getBoundingClientRect();
    demo.classList.toggle("is-over", e.clientX > w.left && e.clientX < w.right && e.clientY > w.top && e.clientY < w.bottom);
  });
  const end = e => {
    if (!drag) return;
    const moved = drag.moved, over = demo.classList.contains("is-over");
    drag = null; card.classList.remove("is-dragging"); demo.classList.remove("is-over");
    card.style.left = card.style.top = "";
    if (over || !moved) poke(a, 2);
  };
  card.addEventListener("pointerup", end); card.addEventListener("pointercancel", () => { drag = null; card.classList.remove("is-dragging"); card.style.left = card.style.top = ""; demo.classList.remove("is-over"); });
  card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); poke(a, 2); } });
  /* drop a real file on the window: only its name and size are read */
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  demo.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); demo.classList.add("is-over"); });
  demo.addEventListener("dragleave", e => { if (!demo.contains(e.relatedTarget)) demo.classList.remove("is-over"); });
  demo.addEventListener("drop", e => {
    if (!hasFiles(e)) return; e.preventDefault(); demo.classList.remove("is-over");
    [...e.dataTransfer.files].slice(0, 3).forEach(f => {
      const li = document.createElement("li");
      li.className = "file is-user";
      const kb = f.size > 1e6 ? (f.size / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(f.size / 1e3)) + " KB";
      li.innerHTML = `<span class="f-ic"><svg class="ic"><use href="#i-file"/></svg></span><span class="f-name"><b></b><small>input/</small></span><span class="f-meta">${kb} · you</span>`;
      li.querySelector("b").textContent = f.name;
      list.prepend(li); userFiles++;
      requestAnimationFrame(() => requestAnimationFrame(() => li.classList.add("is-in")));
    });
    demo.classList.add("has-user"); recount();
  });
  window.addEventListener("dragover", e => { if (hasFiles(e) && !demo.contains(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; } });
  window.addEventListener("drop", e => { if (hasFiles(e) && !demo.contains(e.target)) e.preventDefault(); });
  return { step: recount };
})();

/* ---------- Act 2 · Organize: logs condense into stars ---------- */
const Org = (() => {
  const a = acts.find(x => x.key === "organize");
  const demo = $("#org-demo"), canvas = $("#org-sky"), ctx = canvas.getContext("2d");
  const logsEl = $("#org-logs"), entsEl = $("#org-ents"), card = $("#ent-card");
  const PAD = 40;
  const ENTS = [
    { x: .24, y: .3, rgb: [255, 203, 125], title: "Prices are stored in integer cents", topic: "Payments", kind: "decision", score: 90, how: "updated", desc: "Store and compute every amount in integer cents; format only at the edge. Stripe expects minor units." },
    { x: .74, y: .24, rgb: [255, 159, 182], title: "Brand voice: plain, warm", topic: "Brand voice", kind: "principle", score: 88, how: "updated", desc: "Plain and warm, no exclamation marks. Prefer “Get started” to “Let’s go!”." },
    { x: .5, y: .62, rgb: [148, 185, 255], title: "Refresh tokens rotate on every use", topic: "Auth", kind: "decision", score: 84, how: "created", desc: "Rotate the refresh token on every use; a reused token revokes its whole family." },
  ];
  const OLD = [{ x: .08, y: .5, e: 0 }, { x: .36, y: .12, e: 0 }, { x: .92, y: .44, e: 1 }, { x: .6, y: .08, e: 1 }, { x: .3, y: .8, e: 2 }, { x: .72, y: .84, e: 2 }];
  const LINKS = [[0, 2], [1, 2]];          // new ↔ new relations
  const LOGS = [
    [0, "Correction: amounts were floats. Switched to integer cents.", "checkout-redesign", .02, .04],
    [1, "Copy review: drop the exclamation marks.", "onboarding-copy", .55, .0],
    [2, "Bug: a replayed refresh token was accepted.", "refresh-tokens", .3, .42],
    [0, "Decided: never round prices on the client.", "pricing-page", .0, .6],
    [1, "Kept “Get started” over “Let’s go!”", "onboarding-copy", .66, .42],
    [2, "Fix: rotate on use, revoke the family on reuse.", "refresh-tokens", .22, .82],
    [0, "Lesson: Stripe expects minor units.", "checkout-redesign", .18, .2],
    [1, "PM: the tone should feel calm, not hyped.", "pricing-page", .8, .06],
    [2, "Test added for token reuse.", "refresh-tokens", .58, .78],
  ];
  const R = rng(77);
  const BG = Array.from({ length: 110 }, () => ({ x: R(), y: R(), s: 0.5 + R() * 1.1, b: 0.25 + R() * 0.5, ph: R() * TAU, f: 0.6 + R() * 1.8 }));
  let W = 1, H = 1, DPR = 1, logs = [], dp = 0, target = 0, visible = false, raf = 0, last = 0, t = 0;

  LOGS.forEach(([c, text, task]) => {
    const el = document.createElement("div");
    el.className = "log";
    el.innerHTML = `<small>Note · ${esc(task)}</small>${esc(text)}`;
    logsEl.appendChild(el);
    logs.push({ el, c, w: 0, h: 0 });
  });
  ENTS.forEach((e, k) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ent";
    b.setAttribute("aria-label", `Memory: ${e.title}`);
    b.innerHTML = `<span class="ent-lab">${esc(e.title)}<small>${e.how} · 3 notes</small></span>`;
    const show = () => {
      card.innerHTML = `<b>${esc(e.title)}</b><p>${esc(e.desc)}</p><div class="ent-tags"><span>topic: ${esc(e.topic)}</span><span>kind: ${e.kind}</span><span class="imp">importance ${e.score}</span><span>${e.how} from 3 notes</span></div>`;
      card.hidden = false;
      const left = clamp(e.x * W - 125, 0, W - 250), top = e.y * H > H * 0.5 ? e.y * H - 150 : e.y * H + 54;
      card.style.left = left + "px"; card.style.top = top + "px";
    };
    const hide = () => { card.hidden = true; };
    b.addEventListener("pointerenter", show); b.addEventListener("pointerleave", hide);
    b.addEventListener("focus", show); b.addEventListener("blur", hide);
    b.addEventListener("click", show);
    entsEl.appendChild(b); e.btn = b;
  });

  function tint() { logs.forEach(l => l.el.style.setProperty("--c", rgba(isLight() ? deepTone(ENTS[l.c].rgb) : ENTS[l.c].rgb, 1))); }
  tint();
  window.addEventListener("grove:theme", () => { tint(); kick(); });
  function layout() {
    const r = demo.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round((W + PAD * 2) * DPR); canvas.height = Math.round((H + PAD * 2) * DPR);
    logs.forEach((l, k) => {
      l.w = l.el.offsetWidth; l.h = l.el.offsetHeight;
      const [, , , fx, fy] = LOGS[k];
      l.x = clamp(fx * W, 0, W - l.w); l.y = clamp(fy * H, 0, H - l.h - (W < 600 ? 90 : 0));
    });
    ENTS.forEach(e => { e.btn.style.left = e.x * W + "px"; e.btn.style.top = e.y * H + "px"; });
    kick();
  }

  function render(now) {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now;
    const calm = still();
    if (!calm) t += dt;
    if (calm) dp = target;
    else { const d = target - dp; dp += Math.sign(d) * Math.min(Math.abs(d), Math.max(Math.abs(d) * dt * 4, dt * 0.32)); }
    const p = dp;
    const cond = ease(smooth(0.42, 0.64, p)), ign = smooth(0.55, 0.7, p), lnk = smooth(0.66, 0.82, p);

    // logs: appear, then fly to their entity and shrink to light
    logs.forEach((l, k) => {
      const app = smooth(0.02 + k * 0.022, 0.07 + k * 0.022, p);
      const e = ENTS[l.c];
      const tx = lerp(l.x, e.x * W - l.w / 2, cond), ty = lerp(l.y, e.y * H - l.h / 2, cond);
      const s = lerp(1, 0.35, cond) * (0.92 + 0.08 * app);
      l.el.style.opacity = (app * (1 - smooth(0.08, 0.5, cond))).toFixed(3);
      l.el.style.transform = `translate(${tx.toFixed(1)}px,${(ty + (1 - app) * 10).toFixed(1)}px) scale(${s.toFixed(3)})`;
      l.cx = tx + l.w / 2; l.cy = ty + l.h / 2;
    });

    // canvas
    ctx.setTransform(DPR, 0, 0, DPR, PAD * DPR, PAD * DPR);
    ctx.clearRect(-PAD, -PAD, W + PAD * 2, H + PAD * 2);
    const ink = isLight(), spritesFor = themeSprites;
    ctx.globalCompositeOperation = themeBlend();
    for (const s of BG) {
      const a = s.b * (calm ? 1 : 1 + 0.4 * Math.sin(t * s.f + s.ph)) * (ink ? 0.22 : 1);
      ctx.globalAlpha = clamp(a, 0, 1); ctx.fillStyle = ink ? "#282c50" : "#dfe6ff"; ctx.fillRect(s.x * W - s.s / 2, s.y * H - s.s / 2, s.s, s.s);
    }
    // existing memory: dim stars with faint lines to their entity
    for (const o of OLD) {
      const e = ENTS[o.e], spr = spritesFor(e.rgb);
      const ox = o.x * W, oy = o.y * H;
      ctx.globalAlpha = 0.08 + 0.32 * lnk; ctx.strokeStyle = spr.line; ctx.lineWidth = 0.8;
      if (lnk > 0) { ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(lerp(ox, e.x * W, lnk), lerp(oy, e.y * H, lnk)); ctx.stroke(); }
      ctx.globalAlpha = 0.55; const c = 7; ctx.drawImage(spr.core, ox - c, oy - c, c * 2, c * 2);
    }
    // new relations between new entities
    for (const [i, j] of LINKS) {
      const A = ENTS[i], B = ENTS[j]; if (lnk <= 0) continue;
      ctx.globalAlpha = (ink ? 0.4 : 0.45) * lnk; ctx.strokeStyle = ink ? "rgb(40,44,78)" : "rgb(190,205,245)"; ctx.lineWidth = 1;
      const x0 = A.x * W, y0 = A.y * H, x1 = B.x * W, y1 = B.y * H;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(lerp(x0, x1, lnk), lerp(y0, y1, lnk)); ctx.stroke();
    }
    // light streaming in from the condensing logs
    if (cond > 0 && cond < 1) {
      logs.forEach(l => {
        if (!l.w) return;
        const spr = spritesFor(ENTS[l.c].rgb);
        const a = smooth(0.04, 0.35, cond) * (1 - smooth(0.88, 1, cond)), r = 14 + 10 * cond;
        const e = ENTS[l.c], ex = e.x * W, ey = e.y * H;
        // a short tail pointing back along the path
        const bx = l.cx + (l.cx - ex) * 0.08, by = l.cy + (l.cy - ey) * 0.08;
        ctx.globalAlpha = a * 0.5; ctx.strokeStyle = spr.line; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(l.cx, l.cy); ctx.stroke();
        ctx.globalAlpha = a; ctx.drawImage(spr.glow, l.cx - r, l.cy - r, r * 2, r * 2);
        ctx.globalAlpha = a; const c = 6; ctx.drawImage(spr.core, l.cx - c, l.cy - c, c * 2, c * 2);
      });
    }
    // the new stars
    ENTS.forEach(e => {
      if (ign <= 0 && cond <= 0) return;
      const spr = spritesFor(e.rgb), x = e.x * W, y = e.y * H;
      const pre = cond * 0.35, flare = Math.sin(Math.PI * ign) * 0.9;
      const tw = calm ? 1 : 1 + 0.08 * Math.sin(t * 1.7 + e.x * 9);
      const m = Math.max(pre, ign) * tw;
      const nr = 120 + 60 * ign;
      ctx.globalAlpha = 0.2 * Math.max(pre, ign); ctx.drawImage(spr.neb, x - nr, y - nr * 0.8, nr * 2, nr * 1.6);
      const g = (30 + 40 * m + 36 * flare);
      ctx.globalAlpha = clamp(0.55 * m + 0.4 * flare, 0, 1); ctx.drawImage(spr.glow, x - g, y - g, g * 2, g * 2);
      const L = 40 + 60 * flare + 20 * ign;
      ctx.globalAlpha = clamp(0.5 * ign + 0.3 * flare, 0, 1); ctx.drawImage(spr.spike, x - L, y - L, L * 2, L * 2);
      const c = 8 + 9 * m;
      ctx.globalAlpha = clamp(m, 0, 1); ctx.drawImage(spr.core, x - c, y - c, c * 2, c * 2);
    });
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";

    // DOM states
    const labels = p > 0.74;
    ENTS.forEach(e => e.btn.classList.toggle("is-on", labels));
    if (!labels) card.hidden = true;
    Run.set(p);
    if (visible && !calm) raf = requestAnimationFrame(render);
    else last = 0;
  }
  function kick() { if (!raf) raf = requestAnimationFrame(render); }
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) kick(); }, { rootMargin: "80px" }).observe(demo);

  const Run = (() => {
    const win = $("#run-win"), state = $("#rw-state"), fill = $("#rw-fill"), sum = $("#rw-sum");
    let lastKey = "";
    return { set(p) {
      win.classList.toggle("is-on", p > 0.04);
      fill.style.width = (smooth(0.24, 0.72, p) * 100).toFixed(1) + "%";
      const shown = logs.filter((l, k) => p > 0.04 + k * 0.022).length;
      const key = p < 0.24 ? "w" + shown : p < 0.5 ? "r" : p < 0.74 ? "c" : "d";
      if (key === lastKey) return; lastKey = key;
      if (key[0] === "w") { state.textContent = "Collecting"; sum.innerHTML = `<b>${shown}</b> pending ${shown === 1 ? "note" : "notes"} from 4 tasks`; }
      else if (key === "r") { state.textContent = "Reviewing…"; sum.innerHTML = `Reviewing <b>9</b> pending notes`; }
      else if (key === "c") { state.textContent = "Reconciling…"; sum.innerHTML = `Merging notes into memories`; }
      else { state.textContent = "Done"; sum.innerHTML = `<b>9</b> notes → <b>2</b> updated · <b>1</b> created · <b>3</b> linked`; }
    } };
  })();

  $("#org-replay").addEventListener("click", () => { dp = 0; a.poke = 3; setStep(a, 3); target = 1; kick(); });
  return {
    layout,
    progress(p) { target = a.poke >= 3 ? 1 : p; kick(); },
  };
})();
ACTS.organize = { progress: p => Org.progress(p) };

/* ---------- Act 3 · Inject ---------- */
ACTS.inject = (() => {
  const demo = $("#inj-demo");
  $$("#inject .seg button").forEach(b => b.addEventListener("click", () => {
    $$("#inject .seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    demo.dataset.lane = b.dataset.lane;
  }));
  return {};
})();

/* ---------- Act 4 · Negotiate ---------- */
ACTS.negotiate = (() => {
  const a = acts.find(x => x.key === "negotiate");
  const demo = $("#neg-demo"), count = $("#neg-count");
  let fixT = 0, mergeT = 0;
  $$("[data-poke]", demo).forEach(b => b.addEventListener("click", () => {
    const n = +b.dataset.poke;
    if (n === 3) { demo.classList.add("is-merged"); return; }
    poke(a, n);
  }));
  return { step(st) {
    clearTimeout(fixT); clearTimeout(mergeT);
    if (st < 2) demo.classList.remove("is-fixing", "is-fixed");
    else if (!demo.classList.contains("is-fixed")) {
      demo.classList.add("is-fixing");
      fixT = setTimeout(() => { demo.classList.remove("is-fixing"); demo.classList.add("is-fixed"); count.textContent = "0 open"; }, still() ? 0 : 1300);
    }
    if (st < 3) demo.classList.remove("is-merged");
    else mergeT = setTimeout(() => demo.classList.add("is-merged"), still() ? 0 : 900);
    count.textContent = st === 0 ? "Agent asks" : st === 1 ? "2 open" : demo.classList.contains("is-fixed") ? "0 open" : "Fixing";
  } };
})();

/* =====================================================================
   Agent Graph
   ===================================================================== */
const Graph = (() => {
  const stage = $("#g-stage"), svg = $("#g-edges"), labelsEl = $("#g-labels"), nodesEl = $("#g-nodes"), bar = $("#g-bar");
  const NODES = [
    { id: "plan", name: "Planner", agent: "Claude Code", m: "CC", c: "#c96442", x: .09, y: .48 },
    { id: "spec", name: "Spec writer", agent: "Gemini CLI", m: "GE", c: "#4f7be8", x: .3, y: .13 },
    { id: "api", name: "API coder", agent: "Codex", m: "CX", c: "#3d3d3a", x: .37, y: .46 },
    { id: "ui", name: "UI coder", agent: "Cursor Agent", m: "CU", c: "#2c2c2c", x: .3, y: .82 },
    { id: "mig", name: "Migrations", agent: "OpenCode", m: "OC", c: "#5d6b7a", x: .62, y: .14 },
    { id: "rev", name: "Adversarial reviewer", agent: "Custom agent", m: "AR", c: "#8a5a44", x: .63, y: .54 },
    { id: "test", name: "Tester", agent: "Qwen", m: "QW", c: "#6f55e8", x: .89, y: .3 },
    { id: "i18n", name: "Copy & i18n", agent: "Junie", m: "JU", c: "#1c9f68", x: .58, y: .88 },
    { id: "docs", name: "Release notes", agent: "Kimi", m: "KI", c: "#3b6ef5", x: .88, y: .9 },
  ];
  const EDGES = [
    ["plan", "spec", "ask · edge cases"], ["plan", "api", "spawn · token rotation"], ["plan", "ui", "spawn · checkout UI"],
    ["api", "mig", "spawn · schema change"], ["api", "rev", "review diff"], ["ui", "rev", "review diff"],
    ["rev", "test", "run the suite"], ["ui", "i18n", "copy strings"], ["plan", "docs", "release notes"],
  ];
  const byId = Object.fromEntries(NODES.map(n => [n.id, n]));
  const INIT = { nodes: { plan: "work", spec: "done", api: "work", ui: "work" }, edges: { "plan>spec": "done", "plan>api": "fly", "plan>ui": "fly" } };
  // a script of hand-offs; each beat changes a few states
  const BEATS = [
    ["Codex spawned OpenCode · schema change", { mig: "work" }, { "api>mig": "fly" }],
    ["Cursor Agent sent Junie the copy strings", { i18n: "work" }, { "ui>i18n": "fly" }],
    ["Codex asked the reviewer for a review", { mig: "done", rev: "work" }, { "api>mig": "done", "api>rev": "wait" }],
    ["Cursor Agent queued its diff for review", {}, { "ui>rev": "wait" }],
    ["Reviewer replied to Codex · 2 issues", { i18n: "done" }, { "ui>i18n": "done", "api>rev": "done" }, { "api>rev": "reply · 2 issues" }],
    ["Reviewer handed the suite to the tester", { test: "work" }, { "rev>test": "fly" }],
    ["Tester needs you · permission to run pnpm test", { test: "ask" }, { "rev>test": "wait" }],
    ["You allowed it · tests running", { test: "work" }, {}],
    ["Tests passed · reviewer approved both diffs", { test: "done", rev: "done" }, { "rev>test": "done", "ui>rev": "done" }],
    ["Planner asked Kimi for release notes", { docs: "work", api: "done", ui: "done" }, { "plan>docs": "fly", "plan>api": "done", "plan>ui": "done" }],
    ["Release notes drafted · ready to merge", { docs: "done", plan: "done" }, { "plan>docs": "done" }],
  ];
  let ns = {}, es = {}, lab = {}, beat = -1, timer = 0, visible = false, sel = null, lastMsg = "Planner spawned two coders";
  const nodeEls = {}, edgeEls = {}, labelEls = {};
  const STATE_TXT = { work: "Working", ask: "Needs you", done: "Done", idle: "Not running" };

  NODES.forEach(n => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "gn";
    b.innerHTML = `<span class="av"><span class="ring"></span>${AGENT_ICON[n.agent] ? `<span class="mono has-ic">${agentIcon(n.agent)}</span>` : `<span class="mono" style="--m:${n.c}">${n.m}</span>`}<span class="badge"></span></span><span class="gn-lab"><b>${esc(n.name)}</b><small>${esc(n.agent)}</small></span>`;
    b.addEventListener("click", () => { sel = sel === n.id ? null : n.id; paint(); });
    nodesEl.appendChild(b); nodeEls[n.id] = b;
  });
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = `<defs>${["fly", "wait", "done", "idle"].map(s => `<marker id="mk-${s}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" class="mk-${s}"/></marker>`).join("")}</defs>`;
  const st = document.createElement("style");
  st.textContent = `.mk-fly{fill:#059669}.mk-wait{fill:#d97706}.mk-done{fill:rgb(var(--p-ink-rgb) / .3)}.mk-idle{fill:rgb(var(--p-ink-rgb) / .15)}`;
  svg.appendChild(st);
  EDGES.forEach(([f, t, l]) => {
    const k = `${f}>${t}`;
    const p = document.createElementNS(NS, "path"); p.setAttribute("class", "e"); svg.appendChild(p); edgeEls[k] = p;
    const d = document.createElement("span"); d.className = "el"; d.textContent = l; labelsEl.appendChild(d); labelEls[k] = d;
  });

  function reset() {
    ns = Object.fromEntries(NODES.map(n => [n.id, INIT.nodes[n.id] || "idle"]));
    es = Object.fromEntries(EDGES.map(([f, t]) => [`${f}>${t}`, INIT.edges[`${f}>${t}`] || "idle"]));
    lab = Object.fromEntries(EDGES.map(([f, t, l]) => [`${f}>${t}`, l]));
    beat = -1; lastMsg = "Planner spawned two coders";
  }
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight, portrait = W < 640;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const pos = n => portrait ? [(0.1 + n.y * 0.8) * W, (0.06 + n.x * 0.82) * H] : [(0.04 + n.x * 0.92) * W, (0.1 + n.y * 0.74) * H];
    NODES.forEach(n => { [n.px, n.py] = pos(n); nodeEls[n.id].style.left = n.px + "px"; nodeEls[n.id].style.top = n.py + "px"; });
    EDGES.forEach(([f, t], i) => {
      const A = byId[f], B = byId[t], k = `${f}>${t}`;
      const dx = B.px - A.px, dy = B.py - A.py, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const r = portrait ? 24 : 30;
      const x0 = A.px + ux * r, y0 = A.py + uy * r, x1 = B.px - ux * (r + 4), y1 = B.py - uy * (r + 4);
      const bend = (i % 2 ? 1 : -1) * len * 0.12;
      const cx = (x0 + x1) / 2 - uy * bend, cy = (y0 + y1) / 2 + ux * bend;
      edgeEls[k].setAttribute("d", `M${x0.toFixed(1)} ${y0.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`);
      const mx = 0.25 * x0 + 0.5 * cx + 0.25 * x1, my = 0.25 * y0 + 0.5 * cy + 0.25 * y1;
      labelEls[k].style.left = mx + "px"; labelEls[k].style.top = my + "px";
    });
  }
  function paint() {
    const hot = sel ? new Set(EDGES.filter(([f, t]) => f === sel || t === sel).map(([f, t]) => `${f}>${t}`)) : null;
    const nb = sel ? new Set([sel, ...EDGES.filter(([f, t]) => f === sel || t === sel).flatMap(([f, t]) => [f, t])]) : null;
    NODES.forEach(n => {
      const el = nodeEls[n.id], s = ns[n.id];
      el.className = `gn is-${s}${sel === n.id ? " is-sel" : ""}${nb && !nb.has(n.id) ? " is-dim" : ""}`;
      el.querySelector(".av").className = `av is-${s}`;
      const badge = el.querySelector(".badge");
      badge.className = "badge" + (s === "ask" ? " b-ask" : s === "done" ? " b-done" : "");
      badge.innerHTML = s === "ask" ? "!" : s === "done" ? `<svg class="ic"><use href="#i-check"/></svg>` : "";
      badge.style.display = s === "ask" || s === "done" ? "" : "none";
      el.setAttribute("aria-label", `${n.name}, ${n.agent}: ${STATE_TXT[s]}`);
      el.setAttribute("aria-pressed", String(sel === n.id));
    });
    EDGES.forEach(([f, t]) => {
      const k = `${f}>${t}`, s = es[k], p = edgeEls[k], l = labelEls[k];
      p.setAttribute("class", `e is-${s}${hot && hot.has(k) ? " is-hot" : ""}${hot && !hot.has(k) ? " is-dim" : ""}`);
      p.setAttribute("marker-end", `url(#mk-${s})`);
      l.textContent = lab[k];
      l.className = `el is-${s}${hot && !hot.has(k) ? " is-dim" : ""}${(hot && hot.has(k)) || s === "fly" || s === "wait" ? " is-show" : ""}${s === "idle" && !(hot && hot.has(k)) ? " is-hidden" : ""}${hot && hot.has(k) ? " is-hotl" : ""}`;
    });
    if (sel) {
      const n = byId[sel], s = ns[sel];
      const out = EDGES.filter(([f]) => f === sel).length, inn = EDGES.filter(([, t]) => t === sel).length;
      bar.innerHTML = `<b>${esc(n.name)}</b><span>${esc(n.agent)}</span><span class="gb-st is-${s}">${STATE_TXT[s]}</span><span>${out} delegated · ${inn} incoming</span>`;
    } else bar.innerHTML = `<span class="gb-st is-work">Live</span><span>${esc(lastMsg)}</span>`;
  }
  function tick() {
    beat++;
    if (beat >= BEATS.length) { reset(); }
    else {
      const [msg, nset, eset, lset] = BEATS[beat];
      Object.assign(ns, nset); Object.assign(es, eset); if (lset) Object.assign(lab, lset);
      lastMsg = msg;
    }
    paint();
    schedule();
  }
  function schedule() { clearTimeout(timer); if (visible && !still()) timer = setTimeout(tick, beat >= BEATS.length - 1 ? 3600 : 2300); }
  reset();
  // a calm, readable mid-flight state for reduced motion
  if (still()) { for (let k = 0; k < 6; k++) { const [msg, a, b, c] = BEATS[k]; Object.assign(ns, a); Object.assign(es, b); if (c) Object.assign(lab, c); lastMsg = msg; } beat = 5; }
  layout(); paint();
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; schedule(); }, { threshold: 0.2 }).observe(stage);
  new ResizeObserver(layout).observe(stage);
  return { layout };
})();

/* =====================================================================
   Anywhere: one window, five surfaces
   ===================================================================== */
(() => {
  const root = $("#anywhere"), frame = $("#any-frame"), desc = $("#any-desc"), tabs = $$("#anywhere [role=tab]");
  const MODES = ["web", "gui", "tui", "phone", "voice"];
  const DESC = {
    web: "The main surface: FlexLayout with 10 panel types, an IDE Layout mode, a ⌘K palette, and live D2, Mermaid and HTML preview.",
    gui: "The same Web IDE in a native Tauri window, with a system tray and OS notifications when an agent needs you.",
    tui: "The original keyboard-first surface. j/k to move, the full review workflow, no mouse required.",
    phone: "grove mobile prints a QR code. Scan it from your phone; every request is HMAC-SHA256 signed with the secret inside it.",
    voice: "Radio: hold to talk from your phone. The transcript lands in a Chat or Terminal slot, nine slots, each bound to a task.",
  };
  let idx = 0, timer = 0, visible = false, manual = false, hover = false;
  function set(k, focus) {
    idx = k; const m = MODES[k];
    frame.dataset.mode = m;
    tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(j === k)); t.tabIndex = j === k ? 0 : -1; });
    frame.setAttribute("aria-labelledby", tabs[k].id);
    desc.textContent = DESC[m];
    if (focus) tabs[k].focus();
    // restart the progress underline
    const t = tabs[k]; t.style.setProperty("--any-dur", "4.2s");
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    const paused = !visible || manual || hover || still();
    root.classList.toggle("is-paused", paused && !manual);
    root.classList.toggle("is-manual", manual || still());
    if (!paused) timer = setTimeout(() => set((idx + 1) % MODES.length), 4200);
  }
  tabs.forEach((t, k) => {
    t.addEventListener("click", () => { manual = true; set(k); });
    t.addEventListener("keydown", e => {
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (d) { e.preventDefault(); manual = true; set((idx + d + MODES.length) % MODES.length, true); }
    });
  });
  frame.addEventListener("pointerenter", () => { hover = true; schedule(); });
  frame.addEventListener("pointerleave", () => { hover = false; schedule(); });
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; schedule(); }, { threshold: 0.35 }).observe(root);
  set(0);
})();


/* =====================================================================
   Buddy: a scripted conversation that plays while visible
   ===================================================================== */
(() => {
  const win = $("#buddy-win"), convo = $("#bw-convo"), status = $("#bw-status"), badge = $("#bw-badge");
  const capAv = $("#bw-cap-av"), headAv = $("#bw-head-av"), prev = $("#bw-cap-prev");
  let timers = [], visible = false, playing = false, card = null, waitResolve = null;
  const ICON = n => `<svg class="ic"><use href="#${n}"/></svg>`;
  function setState(st, text) {
    [capAv, headAv].forEach(a => a.className = a.className.replace(/is-\w+/, "is-" + st));
    status.textContent = text; status.className = st === "working" ? "is-work" : st === "waiting" ? "is-wait" : "";
    prev.textContent = st === "waiting" ? "Needs your approval" : text; prev.className = st === "waiting" ? "is-wait" : "";
    badge.hidden = st !== "waiting";
  }
  function add(html, cls) { const el = document.createElement("div"); el.className = cls; el.innerHTML = html; convo.appendChild(el); while (convo.children.length > 7) convo.firstElementChild.remove(); return el; }
  let actEl = null;
  function activity(text) { if (actEl) actEl.remove(); actEl = text ? add(`${ICON("i-sparkle")}<span class="shimmer">${text}</span>`, "bm-act") : null; }
  function dgState(st, label) {
    card.className = "dg" + (st === "wait" ? " is-wait" : "");
    card.querySelector(".dg-st").className = "dg-st is-" + st; card.querySelector(".dg-st").textContent = label;
  }
  function allow(how) {
    if (!card || !card.querySelector(".dg-ask")) return;
    card.querySelector(".dg-ask").outerHTML = `<p class="dg-res" style="color:var(--p-muted);font-size:12px">${ICON("i-check")} ${how}</p>`;
    if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
  }
  const SCRIPT = [
    [600, () => { setState("idle", "Keep releases on track"); add("Get the checkout fix ready for Tuesday’s release.", "bm-user"); }],
    [900, () => { setState("working", "Working"); activity("Looking through projects"); }],
    [1500, () => { activity(null); add("The fix is in atlas-web. I’ll hand the code change to a task agent and keep an eye on it.", "bm-ai"); activity("Handing off work"); }],
    [1300, () => {
      activity(null);
      card = add(`<div class="dg-top">${ICON("i-merge")}<b>Checkout fix</b><span class="dg-st is-run">Running</span></div><span class="dg-to">atlas-web · checkout-redesign · Codex</span>`, "dg");
    }],
    [2000, () => {
      setState("waiting", "Needs you");
      dgState("wait", "Needs you");
      const ask = document.createElement("div"); ask.className = "dg-ask";
      ask.innerHTML = `<p>A subagent needs you · run <code>pnpm test checkout</code></p><button type="button" class="b-ghost">Deny</button><button type="button" class="b-ink">Allow once</button>`;
      ask.querySelectorAll("button").forEach((b, k) => b.addEventListener("click", () => allow(k ? "Allowed once · Run command" : "Denied")));
      card.appendChild(ask);
    }, "wait"],
    [700, () => { setState("working", "Working"); dgState("run", "Running"); }],
    [2200, () => { dgState("done", "Done"); const r = document.createElement("p"); r.className = "dg-res"; r.textContent = "Tests pass. The diff is ready for your review."; card.appendChild(r); }],
    [1200, () => { add("Done. I also set up a routine to check release readiness every morning.", "bm-ai"); }],
    [700, () => { add(`${ICON("i-check")}Daily release check · 09:00`, "rt-chip"); setState("idle", "Keep releases on track"); }],
    [6000, () => { convo.innerHTML = ""; card = null; }],
  ];
  function run(k = 0) {
    if (!visible || still()) { playing = false; return; }
    playing = true;
    if (k >= SCRIPT.length) k = 0;
    const [ms, fn, kind] = SCRIPT[k];
    timers.push(setTimeout(() => {
      fn();
      if (kind === "wait") {
        waitResolve = () => run(k + 1);
        timers.push(setTimeout(() => allow("Allowed once · Run command"), 3200));
      } else run(k + 1);
    }, ms));
  }
  function stop() { timers.forEach(clearTimeout); timers = []; playing = false; }
  function staticState() {
    stop(); convo.innerHTML = ""; card = null;
    for (let k = 0; k < SCRIPT.length - 1; k++) { SCRIPT[k][1](); if (SCRIPT[k][2] === "wait") allow("Allowed once · Run command"); }
    activity(null);
  }
  new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (still()) { if (!convo.children.length) staticState(); return; }
    if (visible && !playing) { convo.innerHTML = ""; card = null; waitResolve = null; run(0); }
    if (!visible) stop();
  }, { threshold: 0.3 }).observe(win);
})();

/* =====================================================================
   Workspace: real screenshots, one page at a time
   ===================================================================== */
(() => {
  const tabs = $$("#shots [role=tab]"), shots = $$("#shot-stage .shot"), stage = $("#shot-stage"), cap = $("#shot-cap");
  function show(k, focus) {
    tabs.forEach((t, j) => { const on = j === k; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; });
    shots.forEach((s, j) => s.classList.toggle("is-on", j === k));
    stage.setAttribute("aria-labelledby", tabs[k].id);
    cap.textContent = shots[k].dataset.cap;
    if (focus) tabs[k].focus();
  }
  tabs.forEach((t, k) => {
    t.addEventListener("click", () => show(k));
    t.addEventListener("keydown", e => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); show((k + d + tabs.length) % tabs.length, true); }
    });
  });
})();

/* =====================================================================
   Install
   ===================================================================== */
(() => {
  const CMDS = {
    brew: { note: "macOS", lines: [["brew tap GarrickZ2/grove && brew install grove"]] },
    sh: { note: "macOS · Linux · WSL", lines: [["curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh"], ["curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | GROVE_GUI=1 sh", "Linux with GUI (x86_64)"]] },
    ps: { note: "Windows · PowerShell", lines: [["irm https://raw.githubusercontent.com/GarrickZ2/grove/master/install.ps1 | iex"]] },
    cargo: { note: "Any platform with Rust", lines: [["cargo install grove-rs", "TUI + Web + MCP"], ["cargo install grove-rs --features gui", "+ native desktop GUI"]] },
  };
  const pre = $("#cmd-text"), note = $("#cmd-note"), tabs = $$(".cmd-tabs button");
  let raw = "";
  function show(k) {
    const c = CMDS[k];
    tabs.forEach(t => { const on = t.dataset.cmd === k; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; });
    note.textContent = c.note;
    pre.innerHTML = c.lines.map(([cmd, cmt]) => `${cmt ? `<span class="c"># ${esc(cmt)}</span>\n` : ""}<span class="p">$ </span>${esc(cmd)}`).join("\n\n");
    raw = c.lines[0][0];
    pre.dataset.raw = raw;
  }
  tabs.forEach((t, k) => {
    t.addEventListener("click", () => show(t.dataset.cmd));
    t.addEventListener("keydown", e => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { const n = tabs[(k + d + tabs.length) % tabs.length]; n.focus(); show(n.dataset.cmd); }
    });
  });
  show("brew");
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok; }
  }
  $$(".copy").forEach(b => b.addEventListener("click", async () => {
    const src = $(b.dataset.copy);
    const ok = await copyText(src.dataset.raw || src.textContent.trim());
    const lab = b.querySelector("span");
    b.classList.toggle("is-done", ok); lab.textContent = ok ? "Copied" : "Press ⌘C";
    setTimeout(() => { b.classList.remove("is-done"); lab.textContent = "Copy"; }, 1600);
  }));
})();

/* =====================================================================
   Nav
   ===================================================================== */
const Nav = (() => {
  const nav = $("#nav"), links = $$(".nav-links a");
  const secs = links.map(a => $(a.getAttribute("href")));
  return { update() {
    nav.classList.toggle("is-scrolled", window.scrollY > 24);
    const mid = window.innerHeight * 0.5;
    let on = -1;
    secs.forEach((s, k) => { const r = s.getBoundingClientRect(); if (r.top < mid && r.bottom > mid) on = k; });
    links.forEach((a, k) => a.classList.toggle("is-on", k === on));
  } };
})();

Org.layout();
updateExclusions();
update();
