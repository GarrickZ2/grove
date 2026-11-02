import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchPluginNavigation,
  isPluginFrameShown,
  performPluginNavigation,
  PLUGIN_NAVIGATE_EVENT,
  resolvePluginNavigation,
  type PluginNavigateDetail,
} from "./pluginNavigation";

const withPage = { id: "demo", contributes: { sidebar: { title: "Demo" } } } as never;
const panelOnly = { id: "demo", contributes: { panel: { title: "Demo" } } } as never;

describe("resolvePluginNavigation", () => {
  it("opens only the requesting plugin's own page", () => {
    expect(resolvePluginNavigation(withPage, { to: "plugin-page" })).toEqual({
      ok: true,
      target: { kind: "plugin-page", pluginId: "demo", pageId: "plugin:demo" },
    });
    // A plugin naming someone else is ignored: the id comes from the frame.
    expect(resolvePluginNavigation(withPage, { to: "plugin-page", pluginId: "other", page: "plugin:other" })).toMatchObject({
      ok: true,
      target: { pluginId: "demo", pageId: "plugin:demo" },
    });
  });

  it("rejects plugin-page for a plugin without a page", () => {
    expect(resolvePluginNavigation(panelOnly, { to: "plugin-page" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("accepts settings with no section, a page id, or a legacy section id", () => {
    expect(resolvePluginNavigation(panelOnly, { to: "settings" })).toEqual({ ok: true, target: { kind: "settings", section: null } });
    expect(resolvePluginNavigation(panelOnly, { to: "settings", section: "appearance" })).toEqual({ ok: true, target: { kind: "settings", section: "appearance" } });
    expect(resolvePluginNavigation(panelOnly, { to: "settings", section: "terminal" })).toEqual({ ok: true, target: { kind: "settings", section: "terminal" } });
  });

  it("rejects unknown sections and targets, URLs included", () => {
    for (const section of ["plugins", "toString", "__proto__", 3, "#settings-agents"]) {
      expect(resolvePluginNavigation(panelOnly, { to: "settings", section })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
    for (const to of ["https://evil.example", "plugin:other", "dashboard", undefined, 1]) {
      expect(resolvePluginNavigation(withPage, { to })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
  });
});

describe("dispatchPluginNavigation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports unavailable when no shell handles it", () => {
    expect(dispatchPluginNavigation({ kind: "settings", section: null })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("returns the shell's outcome", () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<PluginNavigateDetail>).detail;
      if (detail.target.kind === "settings") detail.handled = true;
      else detail.error = { code: "not_found", message: "gone" };
    };
    window.addEventListener(PLUGIN_NAVIGATE_EVENT, listener);
    try {
      expect(dispatchPluginNavigation({ kind: "settings", section: null })).toEqual({ ok: true });
      expect(dispatchPluginNavigation({ kind: "plugin-page", pluginId: "x", pageId: "plugin:x" })).toEqual({ ok: false, error: { code: "not_found", message: "gone" } });
    } finally {
      window.removeEventListener(PLUGIN_NAVIGATE_EVENT, listener);
    }
  });
});

describe("performPluginNavigation", () => {
  const setup = (orbit: boolean, pagePlugins = [withPage]) => {
    const setActiveItem = vi.fn();
    const openSettingsSection = vi.fn();
    const run = (target: PluginNavigateDetail["target"]) => {
      const detail: PluginNavigateDetail = { target, handled: false };
      performPluginNavigation(detail, { pagePlugins, orbit, setActiveItem, openSettingsSection });
      return detail;
    };
    return { setActiveItem, openSettingsSection, run };
  };

  it("opens an installed plugin page", () => {
    const { setActiveItem, run } = setup(true);
    expect(run({ kind: "plugin-page", pluginId: "demo", pageId: "plugin:demo" }).handled).toBe(true);
    expect(setActiveItem).toHaveBeenCalledWith("plugin:demo");
  });

  it("refuses a page that is no longer installed", () => {
    const { setActiveItem, run } = setup(true, []);
    const detail = run({ kind: "plugin-page", pluginId: "demo", pageId: "plugin:demo" });
    expect(detail.handled).toBe(false);
    expect(detail.error?.code).toBe("not_found");
    expect(setActiveItem).not.toHaveBeenCalled();
  });

  it("opens the Orbit settings section", () => {
    const { setActiveItem, openSettingsSection, run } = setup(true);
    expect(run({ kind: "settings", section: "appearance" }).handled).toBe(true);
    expect(setActiveItem).toHaveBeenCalledWith("settings");
    expect(openSettingsSection).toHaveBeenCalledWith("appearance");
  });

  it("opens Workbench settings at the top", () => {
    const { setActiveItem, openSettingsSection, run } = setup(false);
    expect(run({ kind: "settings", section: "appearance" }).handled).toBe(true);
    expect(setActiveItem).toHaveBeenCalledWith("settings");
    expect(openSettingsSection).not.toHaveBeenCalled();
  });
});

describe("isPluginFrameShown", () => {
  it("is false for a missing, detached or invisible frame", () => {
    expect(isPluginFrameShown(null)).toBe(false);
    const iframe = document.createElement("iframe");
    expect(isPluginFrameShown(iframe)).toBe(false);
    document.body.appendChild(iframe);
    try {
      expect(isPluginFrameShown(iframe)).toBe(true);
      Object.defineProperty(iframe, "checkVisibility", { value: () => false, configurable: true });
      expect(isPluginFrameShown(iframe)).toBe(false);
    } finally {
      iframe.remove();
    }
  });
});
