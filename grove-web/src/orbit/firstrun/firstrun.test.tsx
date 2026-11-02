import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/tauriShell", () => ({ isTauriShell: true }));
vi.mock("framer-motion", async (importOriginal) => ({
  ...await importOriginal<typeof import("framer-motion")>(),
  useReducedMotion: () => true,
}));

function stubStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
  return stored;
}

/** Fresh module state (the launch claim and prior-session snapshot are per page load). */
async function loadStorage() {
  vi.resetModules();
  return import("./storage");
}

describe("first-run once-only flags", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("claims the first launch once, and keeps the answer for a repeat render", async () => {
    const stored = stubStorage();
    const storage = await loadStorage();
    expect(storage.claimFirstLaunch()).toBe(true);
    expect(storage.claimFirstLaunch()).toBe(true);
    expect(stored.get(storage.LAUNCH_SEEN_KEY)).toBe("1");
    // Next page load: already seen.
    const next = await loadStorage();
    expect(next.claimFirstLaunch()).toBe(false);
  });

  it("never plays for an install that was already in use, and marks it seen", async () => {
    const stored = stubStorage({ "grove:navigation": "{}" });
    const storage = await loadStorage();
    expect(storage.claimFirstLaunch()).toBe(false);
    expect(stored.get(storage.LAUNCH_SEEN_KEY)).toBe("1");
  });

  it("remembers the interface for screens drawn before the config", async () => {
    stubStorage();
    const storage = await loadStorage();
    expect(storage.readCachedOrbit()).toBe(true);
    storage.writeCachedInterface("workbench");
    expect(storage.readCachedOrbit()).toBe(false);
    storage.writeCachedInterface("orbit");
    expect(storage.readCachedOrbit()).toBe(true);
    storage.writeCachedInterface("workbench");
    expect(storage.readCachedOrbit()).toBe(false);
  });
});

describe("first-turn hint model", () => {
  it("reads a finished turn only from the same task going Working → idle", async () => {
    const { turnFinished } = await import("./hintsModel");
    expect(turnFinished({ title: "A", working: true }, { title: "A", working: false })).toBe(true);
    expect(turnFinished({ title: "A", working: true }, { title: "B", working: false })).toBe(false);
    expect(turnFinished({ title: "A", working: false }, { title: "A", working: false })).toBe(false);
    expect(turnFinished({ title: "A", working: true }, null)).toBe(false);
  });

  it("anchors on data-orbit-tool, falling back to the toolbar label", async () => {
    const { findHintAnchor, TURN_HINTS } = await import("./hintsModel");
    const bar = document.createElement("div");
    bar.innerHTML = `<button class="ows-tb" data-orbit-tool="review" aria-label="Code Review"></button><button class="ows-tb" aria-label="Notes"></button>`;
    expect(findHintAnchor(bar, TURN_HINTS[0])?.dataset.orbitTool).toBe("review");
    expect(findHintAnchor(bar, TURN_HINTS[1])?.getAttribute("aria-label")).toBe("Notes");
    bar.querySelector<HTMLButtonElement>('[aria-label="Notes"]')!.disabled = true;
    expect(findHintAnchor(bar, TURN_HINTS[1])).toBeNull();
  });
});

describe("first-run overlays", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Imported per test: other tests reset the module registry.
  async function renderWith(node: React.ReactNode, orbit = true) {
    const ctx = await import("../ui/interfaceContext");
    await act(async () => root.render(
      <ctx.OrbitInterfaceKnownContext.Provider value>
        <ctx.OrbitInterfaceContext.Provider value={orbit}>{node}</ctx.OrbitInterfaceContext.Provider>
      </ctx.OrbitInterfaceKnownContext.Provider>,
    ));
  }

  it("plays the launch once in Orbit, and Esc skips it", async () => {
    const stored = stubStorage();
    vi.resetModules();
    const { FirstLaunch } = await import("./FirstLaunch");
    const ctx = await import("../ui/interfaceContext");
    await act(async () => root.render(
      <ctx.OrbitInterfaceKnownContext.Provider value>
        <ctx.OrbitInterfaceContext.Provider value><FirstLaunch /></ctx.OrbitInterfaceContext.Provider>
      </ctx.OrbitInterfaceKnownContext.Provider>,
    ));
    expect(document.querySelector('[data-testid="first-launch"]')).not.toBeNull();
    expect(stored.get("grove:firstrun.launch")).toBe("1");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.querySelector(".ofl.is-leaving")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[data-testid="first-launch"]')).toBeNull();
  });

  it("does not play under Workbench, and leaves the flag for later", async () => {
    const stored = stubStorage();
    vi.resetModules();
    const { FirstLaunch } = await import("./FirstLaunch");
    const ctx = await import("../ui/interfaceContext");
    await act(async () => root.render(
      <ctx.OrbitInterfaceKnownContext.Provider value>
        <ctx.OrbitInterfaceContext.Provider value={false}><FirstLaunch /></ctx.OrbitInterfaceContext.Provider>
      </ctx.OrbitInterfaceKnownContext.Provider>,
    ));
    expect(document.querySelector('[data-testid="first-launch"]')).toBeNull();
    expect(stored.has("grove:firstrun.launch")).toBe(false);
  });

  it("shows the Review then Notes bubbles after a finished turn, once", async () => {
    const stored = stubStorage();
    const { FirstTurnHints } = await import("./FirstTurnHints");
    // jsdom has no layout: make the toolbar count as visible.
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const bar = document.createElement("div");
    bar.className = "ows-bar";
    bar.innerHTML = `<h1><span class="ows-bar-name">Fix tests</span></h1><span class="ows-state is-working"></span>
      <button class="ows-tb" data-orbit-tool="notes" aria-label="Notes"></button>
      <button class="ows-tb" data-orbit-tool="review" aria-label="Code Review"></button>`;
    document.body.appendChild(bar);

    await renderWith(<FirstTurnHints />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(document.querySelector(".oth-pop")).toBeNull();

    bar.querySelector(".ows-state")!.remove();
    act(() => { vi.advanceTimersByTime(800); });
    act(() => { vi.advanceTimersByTime(700); });
    const pop = document.querySelector(".oth-pop");
    expect(pop?.textContent).toContain("Review before you merge");
    expect(pop?.textContent).toContain("1 of 2");
    expect(stored.get("grove:firstrun.turn-hints")).toBe("1");

    const next = Array.from(document.querySelectorAll<HTMLButtonElement>(".oth-btn")).find((b) => b.textContent === "Next")!;
    act(() => { next.click(); });
    expect(document.querySelector(".oth-pop")?.textContent).toContain("Notes are context");
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>(".oth-btn")).find((b) => b.textContent === "Got it")!;
    act(() => { done.click(); });
    expect(document.querySelector(".oth-pop")).toBeNull();

    // Another finished turn: nothing more.
    bar.appendChild(Object.assign(document.createElement("span"), { className: "ows-state is-working" }));
    act(() => { vi.advanceTimersByTime(800); });
    bar.querySelector(".ows-state")!.remove();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(document.querySelector(".oth-pop")).toBeNull();
  });

  it("stays hidden once seen", async () => {
    stubStorage({ "grove:firstrun.turn-hints": "1" });
    const { FirstTurnHints } = await import("./FirstTurnHints");
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const bar = document.createElement("div");
    bar.className = "ows-bar";
    bar.innerHTML = `<span class="ows-state is-working"></span><button class="ows-tb" data-orbit-tool="review"></button>`;
    document.body.appendChild(bar);
    await renderWith(<FirstTurnHints />);
    act(() => { vi.advanceTimersByTime(800); });
    bar.querySelector(".ows-state")!.remove();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(document.querySelector(".oth-pop")).toBeNull();
  });
});
