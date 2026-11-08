import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberBootIcon, rememberBootTheme, syncThemeColor, withBootTheme } from "./bootTheme";

const script = readFileSync(resolve(process.cwd(), "public/boot-theme.js"), "utf8");
const boot = () => new Function(script)();
const root = document.documentElement;

function clearTheme() {
  root.removeAttribute("style");
  delete root.dataset.theme;
}

describe("boot theme", () => {
  beforeEach(() => {
    localStorage.clear();
    clearTheme();
    history.replaceState(null, "", "/");
  });
  afterEach(clearTheme);

  function applyLight() {
    root.style.setProperty("--color-bg", "#fafafa");
    root.dataset.theme = "light";
  }

  it("paints the browser's chrome with the theme, from first paint on", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#0a0a0b";
    document.head.append(meta);
    try {
      syncThemeColor("#fafafa");
      expect(meta.content).toBe("#fafafa");

      applyLight();
      rememberBootTheme();
      meta.content = "#0a0a0b";
      boot();
      expect(meta.content).toBe("#fafafa");
    } finally {
      meta.remove();
    }
  });

  it("repaints the remembered theme on the next load", () => {
    applyLight();
    rememberBootTheme();
    clearTheme();
    boot();
    expect(root.style.getPropertyValue("--color-bg")).toBe("#fafafa");
    expect(root.dataset.theme).toBe("light");
  });

  it("links the remembered installed-app icon before the app loads", () => {
    document.head.innerHTML = '<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.json">';
    rememberBootIcon("orbit-dark");
    boot();
    expect(document.querySelector("link[rel='apple-touch-icon']")?.getAttribute("href")).toBe("/app-icons/pwa/orbit-dark.png");
    expect(document.querySelector("link[rel='manifest']")?.getAttribute("href")).toBe("/app-icons/pwa/orbit-dark.webmanifest");
    localStorage.setItem("grove:boot-icon", "../../evil");
    document.head.innerHTML = '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    boot();
    expect(document.querySelector("link[rel='apple-touch-icon']")?.getAttribute("href")).toBe("/apple-touch-icon.png");
    document.head.innerHTML = "";
  });

  it("carries the theme across origins and leaves the URL clean", () => {
    applyLight();
    const hash = withBootTheme("http://localhost:3900").split("http://localhost:3900")[1];
    clearTheme();
    history.replaceState(null, "", `/${hash}`);
    boot();
    expect(root.style.getPropertyValue("--color-bg")).toBe("#fafafa");
    expect(location.hash).toBe("");
    clearTheme();
    boot();
    expect(root.dataset.theme).toBe("light");
  });

  it("takes only colors from a URL", () => {
    const payload = JSON.stringify({ light: true, vars: { "--color-bg": "url(http://evil/x)", "--other": "#000" } });
    history.replaceState(null, "", `/#grove-boot=${encodeURIComponent(payload)}`);
    boot();
    expect(root.style.getPropertyValue("--color-bg")).toBe("");
    expect(root.style.getPropertyValue("--other")).toBe("");
  });
});
