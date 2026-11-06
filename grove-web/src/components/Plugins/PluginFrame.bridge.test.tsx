import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitInterfaceContext } from "../../orbit/ui/interfaceContext";
import type { Plugin } from "../../api/plugins";

const theme = vi.hoisted(() => ({
  current: {
    id: "light-a", name: "Light", isLight: true, accentPalette: [],
    colors: { bg: "#fff", bgSecondary: "#fafafa", bgTertiary: "#f4f4f4", border: "#e5e5e5", text: "#111", textMuted: "#777", highlight: "#7c3aed", accent: "#0ea5e9", success: "#16a34a", warning: "#d97706", error: "#dc2626", info: "#2563eb" },
  },
}));
vi.mock("../../context", () => ({
  useProject: () => ({ selectedProject: { id: "p1", name: "Proj", projectType: "repo" }, projects: [] }),
  useTheme: () => ({ theme: theme.current }),
}));
vi.mock("../../api/client", () => ({
  machineUrl: (path: string) => path,
  apiClient: { get: vi.fn(async () => ({ contributes: { panel: { entry: "dist/index.html" } } })) },
  appendHmacToUrl: vi.fn(async (url: string) => url),
}));
vi.mock("./pluginAssetSession", () => ({
  ensurePluginAssetSession: vi.fn(async () => "tok"),
  getPluginAssetSessionGeneration: () => 0,
  subscribeToPluginAssetSessionChanges: () => () => {},
}));
vi.mock("./pluginTheme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pluginTheme")>();
  return { ...actual, readOrbitTokens: () => ({ "--o-bg": "#fff", "--o-radius": "8px" }) };
});

const { PluginFrame } = await import("./PluginFrame");
const { PLUGIN_NAVIGATE_EVENT } = await import("./pluginNavigation");
type PluginNavigateDetail = import("./pluginNavigation").PluginNavigateDetail;

const plugin = { id: "demo", name: "Demo", version: "1.0.0", source: "local", local_path: "/x", created_at: "", updated_at: "", contributes: { panel: { title: "Demo" } } } as Plugin;

describe("PluginFrame bridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (orbit: boolean) => {
    await act(async () => {
      root.render(<OrbitInterfaceContext.Provider value={orbit}><PluginFrame plugin={plugin} contribution="panel" taskId="t1" /></OrbitInterfaceContext.Provider>);
    });
    const iframe = container.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    return iframe;
  };

  const request = async (iframe: HTMLIFrameElement, method: string) => {
    const target = iframe.contentWindow!;
    const posted = vi.spyOn(target, "postMessage");
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { source: target, data: { type: "plugin-api:request", id: "r1", method, params: {} } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const reply = posted.mock.calls.map(([message]) => message as { type: string; id?: string; data?: unknown }).find((message) => message.type === "plugin-api:response" && message.id === "r1");
    posted.mockRestore();
    return reply?.data as Record<string, unknown>;
  };

  it("answers theme.get with the original fields plus interface and Orbit tokens", async () => {
    const iframe = await render(true);
    const data = await request(iframe, "theme.get");
    expect(data).toEqual({ id: "light-a", isLight: true, colors: theme.current.colors, interface: "orbit", tokens: { "--o-bg": "#fff", "--o-radius": "8px" } });
    expect((await request(iframe, "host.getInfo")).interface).toBe("orbit");
  });

  it("reports workbench outside Orbit and pushes grove:theme when the interface changes", async () => {
    const iframe = await render(false);
    expect((await request(iframe, "theme.get")).interface).toBe("workbench");
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("requestAnimationFrame", frame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // Switching interface remounts the Orbit chrome; spy on whichever window is live.
    const spy = vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get");
    const posted = vi.fn();
    spy.mockReturnValue({ postMessage: posted } as unknown as Window);
    await act(async () => {
      root.render(<OrbitInterfaceContext.Provider value={true}><PluginFrame plugin={plugin} contribution="panel" taskId="t1" /></OrbitInterfaceContext.Provider>);
    });
    spy.mockRestore();
    const pushes = posted.mock.calls.map(([message]) => message as { type: string; data?: { interface?: string; tokens?: unknown } }).filter((message) => message.type === "grove:theme");
    expect(pushes.at(-1)?.data).toMatchObject({ id: "light-a", interface: "orbit", tokens: { "--o-bg": "#fff" } });
  });

  it("routes host.navigate to the shell for this plugin only, and ignores other windows", async () => {
    const iframe = await render(true);
    const target = iframe.contentWindow!;
    const seen: PluginNavigateDetail[] = [];
    const shell = (event: Event) => {
      const detail = (event as CustomEvent<PluginNavigateDetail>).detail;
      seen.push(detail);
      detail.handled = true;
    };
    window.addEventListener(PLUGIN_NAVIGATE_EVENT, shell);
    const posted = vi.spyOn(target, "postMessage");
    const send = async (source: Window, id: string, params: Record<string, unknown>) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { source, data: { type: "plugin-api:request", id, method: "host.navigate", params } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return posted.mock.calls.map(([message]) => message as { type: string; id?: string; data?: unknown; error?: { code: string } }).find((message) => message.type === "plugin-api:response" && message.id === id);
    };
    try {
      // The plugin's own page (the frame's plugin has no sidebar page → not_found).
      expect((await send(target, "n1", { to: "plugin-page", pluginId: "other" }))?.error?.code).toBe("not_found");
      expect((await send(target, "n2", { to: "settings", section: "appearance" }))?.data).toEqual({ ok: true });
      expect((await send(target, "n3", { to: "https://example.com" }))?.error?.code).toBe("bad_request");
      // Another window can't drive the bridge.
      expect(await send(window, "n4", { to: "settings" })).toBeUndefined();
      expect(seen.map((detail) => detail.target)).toEqual([{ kind: "settings", section: "appearance" }]);
    } finally {
      posted.mockRestore();
      window.removeEventListener(PLUGIN_NAVIGATE_EVENT, shell);
    }
  });

  it("uses Orbit states for loading in Orbit", async () => {
    const { ensurePluginAssetSession } = await import("./pluginAssetSession");
    vi.mocked(ensurePluginAssetSession).mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      root.render(<OrbitInterfaceContext.Provider value={true}><PluginFrame plugin={plugin} contribution="panel" taskId="t1" /></OrbitInterfaceContext.Provider>);
    });
    expect(container.querySelector(".oplg-frame-host.orbit-ui")).not.toBeNull();
    expect(container.querySelector(".oplg-loading")?.textContent).toContain("Loading Demo");
  });
});
