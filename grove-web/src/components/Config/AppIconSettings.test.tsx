import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppIconSettings } from "./AppIconSettings";
import { ThemeProvider, useTheme } from "../../context/ThemeContext";
import type { ThemeConfig } from "../../api/config";
import { APP_APPEARANCE_CHANGED_EVENT, APP_ICON_DESIGNS } from "../../data/appIcons";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("../../api/client", () => ({ apiClient: api }));

describe("application icon preferences", () => {
  let host: HTMLDivElement;
  let root: Root;
  let favicon: HTMLLinkElement;
  let saved: ThemeConfig;
  let current: ReturnType<typeof useTheme>;
  let systemChange: ((event: { matches: boolean }) => void) | undefined;
  function Harness() {
    current = useTheme();
    return <AppIconSettings />;
  }
  const render = async () => act(async () => root.render(<ThemeProvider><Harness /></ThemeProvider>));
  const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label)!;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: (_: string, callback: typeof systemChange) => { systemChange = callback; },
      removeEventListener: () => {},
    }));
    saved = { name: "dark", mode: "auto", light_theme: "light", dark_theme: "dark", custom_themes: [], app_icon: "classic" };
    api.get.mockResolvedValue({ theme: saved });
    api.patch.mockImplementation(async (_: string, patch: { theme: Partial<ThemeConfig> }) => {
      saved = { ...saved, ...patch.theme };
      return { theme: saved };
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    document.head.appendChild(favicon);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    favicon.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows one compact preview per design and saves a selection to the backend", async () => {
    await render();
    expect(host.querySelectorAll('button[aria-label$="application icon"]')).toHaveLength(APP_ICON_DESIGNS.length);
    expect(host.querySelectorAll('button[aria-label$="application icon"] img')).toHaveLength(APP_ICON_DESIGNS.length);
    await act(async () => button("Moss application icon").click());
    expect(api.patch).toHaveBeenCalledWith("/api/v1/config", { theme: { app_icon: "moss" } });
    expect(current.appIcon).toBe("moss");
    expect(favicon.getAttribute("href")).toBe("/app-icons/moss-light.svg");
  });

  it("restores saved preferences on remount", async () => {
    saved = { ...saved, mode: "dark", app_icon: "terrarium" };
    api.get.mockResolvedValue({ theme: saved });
    await render();
    expect(button("Terrarium application icon").getAttribute("aria-pressed")).toBe("true");
    expect(favicon.getAttribute("href")).toBe("/app-icons/terrarium-dark.svg");
    await act(async () => root.render(null));
    await render();
    expect(current.appIcon).toBe("terrarium");
  });

  it("automatically follows the resolved interface theme without separate appearance controls", async () => {
    await render();
    await act(async () => button("Orbit application icon").click());
    expect(host.querySelector('[aria-label="Application icon appearance"]')).toBeNull();
    act(() => systemChange?.({ matches: true }));
    expect(favicon.getAttribute("href")).toBe("/app-icons/orbit-dark.svg");
    expect([...host.querySelectorAll("img")].every((image) => image.getAttribute("src")?.endsWith("-dark.svg"))).toBe(true);
    await act(async () => current.setAppearance({ mode: "light" }));
    expect(favicon.getAttribute("href")).toBe("/app-icons/orbit-light.svg");
    expect([...host.querySelectorAll("img")].every((image) => image.getAttribute("src")?.endsWith("-light.svg"))).toBe(true);
  });

  it("leaves the current icon selected when saving fails", async () => {
    await render();
    api.patch.mockRejectedValueOnce({ message: "Server unavailable" });
    await act(async () => button("Prism application icon").click());
    expect(current.appIcon).toBe("classic");
    expect(button("Classic application icon").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Server unavailable");
  });

  it("blocks overlapping saves and ignores an older focus refresh after saving", async () => {
    await render();
    let refresh!: (value: unknown) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => { refresh = resolve; }));
    act(() => window.dispatchEvent(new Event("focus")));
    let save!: (value: unknown) => void;
    api.patch.mockReturnValueOnce(new Promise((resolve) => { save = resolve; }));
    act(() => button("Canopy application icon").click());
    expect(button("Pixel Grove application icon").disabled).toBe(true);
    expect(host.querySelectorAll("button:disabled")).toHaveLength(APP_ICON_DESIGNS.length);
    await act(async () => save({ theme: { ...saved, app_icon: "canopy" } }));
    await act(async () => refresh({ theme: saved }));
    expect(current.appIcon).toBe("canopy");
  });

  it("refreshes from server events and safely falls back for unknown stored icons", async () => {
    await render();
    api.get.mockResolvedValueOnce({ theme: { ...saved, mode: "dark", app_icon: "pixel" } });
    await act(async () => window.dispatchEvent(new Event(APP_APPEARANCE_CHANGED_EVENT)));
    expect(current.appIcon).toBe("pixel");
    expect(favicon.getAttribute("href")).toBe("/app-icons/pixel-dark.svg");
    api.get.mockResolvedValueOnce({ theme: { ...saved, app_icon: "missing-style", app_icon_mode: "unknown" } });
    await act(async () => window.dispatchEvent(new Event(APP_APPEARANCE_CHANGED_EVENT)));
    expect(current.appIcon).toBe("classic");
    expect(favicon.getAttribute("href")).toBe("/favicon-light.svg");
  });
});
