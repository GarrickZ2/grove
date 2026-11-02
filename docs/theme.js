/* Grove site — colour theme: Light (default) · Dark · System.
   The inline script in <head> sets data-theme before first paint; this file
   wires the nav toggle, follows the OS live in System mode, and tells the
   canvases to repaint (window event "grove:theme"). */
"use strict";
(() => {
  const root = document.documentElement, KEY = "grove-theme";
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const V1 = /[?&]sky=v1/.test(location.search);       // the old night sky is dark-only
  const valid = m => m === "light" || m === "dark" || m === "system";
  let mode = valid(root.dataset.themeMode) ? root.dataset.themeMode : "light";
  const resolve = () => V1 ? "dark" : mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  const META = { light: "#f6f5f1", dark: "#0b1030" };

  function apply() {
    const t = resolve(), changed = root.dataset.theme !== t;
    root.dataset.theme = t; root.dataset.themeMode = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", META[t]);
    document.querySelectorAll("[data-theme-set]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themeSet === mode)));
    if (changed) window.dispatchEvent(new CustomEvent("grove:theme", { detail: { theme: t, mode } }));
  }
  function set(m) {
    if (!valid(m)) return;
    mode = m;
    try { localStorage.setItem(KEY, m); } catch {}
    apply();
  }
  mq.addEventListener("change", () => { if (mode === "system") apply(); });
  window.addEventListener("storage", e => { if (e.key === KEY && valid(e.newValue)) { mode = e.newValue; apply(); } });
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-theme-set]");
    if (b) set(b.dataset.themeSet);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
  window.GroveTheme = { get mode() { return mode; }, get theme() { return resolve(); }, set };
})();
const isLight = () => document.documentElement.dataset.theme !== "dark";
