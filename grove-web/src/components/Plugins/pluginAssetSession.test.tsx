import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, AUTH_CHANGED_EVENT } from "../../api/client";
import { ensurePluginAssetSession } from "./pluginAssetSession";
import { PluginFrame } from "./PluginFrame";
import { PluginIcon } from "./PluginIcon";
import type { Plugin } from "../../api/plugins";

vi.mock("../../api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn() },
  appendHmacToUrl: vi.fn(async (url: string) => url),
  AUTH_CHANGED_EVENT: "grove-auth-changed",
}));
vi.mock("../../context", () => {
  const theme = { id: "dark", isLight: false, colors: {} };
  return {
    useProject: () => ({ selectedProject: null, projects: [] }),
    useTheme: () => ({ theme }),
  };
});

const plugin: Plugin = {
  id: "plugin-a", name: "Plugin A", version: "1.0.0", source: "dev",
  local_path: "/plugin-a", created_at: "", updated_at: "", icon: "icon.png",
};

describe("plugin asset authorization lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    vi.mocked(apiClient.post).mockResolvedValue({ token: "current-token" });
    vi.mocked(apiClient.get).mockResolvedValue({ ui: { entry: "index.html" } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares concurrent handshakes but requests a new token on later mounts", async () => {
    const first = ensurePluginAssetSession(plugin.id);
    expect(ensurePluginAssetSession(plugin.id)).toBe(first);
    expect(await first).toBe("current-token");
    vi.mocked(apiClient.post).mockResolvedValue({ token: "restarted-server-token" });
    expect(await ensurePluginAssetSession(plugin.id)).toBe("restarted-server-token");
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a pending request after device authorization changes", async () => {
    let resolveOld!: (value: { token: string }) => void;
    let resolveNew!: (value: { token: string }) => void;
    vi.mocked(apiClient.post)
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve; }));
    const old = ensurePluginAssetSession(plugin.id);
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    const current = ensurePluginAssetSession(plugin.id);
    expect(current).not.toBe(old);
    resolveOld({ token: "old-device-token" });
    await old;
    expect(ensurePluginAssetSession(plugin.id)).toBe(current);
    resolveNew({ token: "new-device-token" });
    expect(await current).toBe("new-device-token");
  });

  it("retries a failed handshake", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error("offline"));
    await expect(ensurePluginAssetSession(plugin.id)).rejects.toThrow("offline");
    expect(await ensurePluginAssetSession(plugin.id)).toBe("current-token");
  });

  it("refreshes both the iframe and icon after a device login change", async () => {
    await act(async () => root.render(<><PluginIcon plugin={plugin} /><PluginFrame plugin={plugin} contribution="sidebar" /></>));
    expect(container.querySelector("iframe")!.src).toContain("/current-token/");
    expect(container.querySelector("img")!.src).toContain("/current-token/");
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    vi.mocked(apiClient.post).mockResolvedValue({ token: "new-device-token" });
    await act(async () => { window.dispatchEvent(new Event(AUTH_CHANGED_EVENT)); });
    expect(container.querySelector("iframe")!.src).toContain("/new-device-token/");
    expect(container.querySelector("img")!.src).toContain("/new-device-token/");
  });

  it("obtains a new capability when the plugin is reloaded after a server restart", async () => {
    await act(async () => root.render(<PluginFrame plugin={plugin} contribution="sidebar" />));
    vi.mocked(apiClient.post).mockResolvedValue({ token: "new-process-token" });
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Reload plugin (after rebuild)"]')!.click());
    expect(container.querySelector("iframe")!.src).toContain("/new-process-token/");
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  it("refreshes an invalid image capability instead of leaving a broken image", async () => {
    await act(async () => root.render(<PluginIcon plugin={plugin} />));
    vi.mocked(apiClient.post).mockResolvedValue({ token: "new-process-token" });
    await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(container.querySelector("img")!.src).toContain("/new-process-token/");
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  it("stops retrying an image when the renewed capability still fails", async () => {
    await act(async () => root.render(<PluginIcon plugin={plugin} />));
    await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(container.querySelector("img")).toBeNull();
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  it("allows retrying a frame handshake instead of remaining in Loading forever", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(<PluginFrame plugin={plugin} contribution="sidebar" />));
    expect(container.querySelector("iframe")).toBeNull();
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(container.querySelector("iframe")!.src).toContain("/current-token/");
  });
});
