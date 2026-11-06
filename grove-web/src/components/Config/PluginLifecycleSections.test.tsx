import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, PluginUpdate } from "../../api/plugins";

const api = vi.hoisted(() => ({
  getPluginRuntime: vi.fn(),
  controlPluginRuntime: vi.fn(),
  applyPluginUpdate: vi.fn(),
  discardPluginUpdate: vi.fn(),
}));
vi.mock("../../api/plugins", () => api);

const { PluginRuntimeSection } = await import("./PluginRuntime");
const { PluginUpdateSection } = await import("./PluginUpdate");

const runtime = (over: Partial<PluginRuntime> = {}): PluginRuntime => ({
  state: "running",
  detail: "Listening on 8787",
  pid: 42,
  restarts: 2,
  startedAt: 1,
  lastError: "process exited with code 3",
  logs: ["hello"],
  ...over,
});

const update: PluginUpdate = {
  from: "1.0.0",
  to: "2.0.0",
  digest: "d2",
  review: null,
  changes: {
    permissions_added: ["sessions:write"],
    permissions_removed: [],
    contributions_added: ["mcp"],
    contributions_changed: [],
    contributions_removed: [],
    files: { added: 1, removed: 0, changed: 3 },
  },
};

let container: HTMLDivElement;
let root: Root;

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const mount = async (element: ReactElement) => {
  act(() => root.render(element));
  await settle();
};
const button = (name: string | RegExp): HTMLButtonElement => {
  const found = [...container.querySelectorAll("button")].find((item) =>
    typeof name === "string" ? item.textContent === name : name.test(item.textContent ?? ""));
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const click = async (target: HTMLButtonElement) => {
  act(() => target.click());
  await settle();
};
const alertText = () => container.querySelector("[role=alert]")?.textContent;

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
  vi.clearAllMocks();
});

describe("PluginRuntimeSection", () => {
  it("shows the process's state, error and logs", async () => {
    api.getPluginRuntime.mockResolvedValue(runtime());
    await mount(<PluginRuntimeSection pluginId="p" service />);
    const text = container.textContent;
    for (const expected of [
      "Running", "Listening on 8787", "PID 42", "2 restarts",
      "process exited with code 3", "hello", "Stays running while Grove is open",
    ]) expect(text).toContain(expected);
  });

  it("stops a running process and then offers to start it", async () => {
    api.getPluginRuntime.mockResolvedValue(runtime());
    api.controlPluginRuntime.mockResolvedValue(runtime({ state: "stopped", pid: null }));
    await mount(<PluginRuntimeSection pluginId="p" service={false} />);
    await click(button(/Stop/));
    expect(api.controlPluginRuntime).toHaveBeenCalledWith("p", "stop");
    expect(button(/Start/)).toBeTruthy();
  });

  it("offers no start while another window runs it", async () => {
    api.getPluginRuntime.mockResolvedValue(runtime({ state: "elsewhere", pid: null }));
    await mount(<PluginRuntimeSection pluginId="p" service />);
    expect(button(/Start/).disabled).toBe(true);
  });

  it("reports a failed action", async () => {
    api.getPluginRuntime.mockResolvedValue(runtime({ state: "failed", pid: null }));
    api.controlPluginRuntime.mockRejectedValue(new Error("no node"));
    await mount(<PluginRuntimeSection pluginId="p" service />);
    await click(button(/Start/));
    expect(alertText()).toBe("no node");
  });
});

describe("PluginUpdateSection", () => {
  it("lists what changes and applies the digest the user saw", async () => {
    api.applyPluginUpdate.mockResolvedValue({ ok: true });
    const done = vi.fn();
    await mount(<PluginUpdateSection pluginId="p" update={update} onDone={done} />);
    for (const expected of ["sessions:write", "mcp", "3 changed, 1 added, 0 removed files."]) {
      expect(container.textContent).toContain(expected);
    }
    await click(button("Update to v2.0.0"));
    expect(api.applyPluginUpdate).toHaveBeenCalledWith("p", "d2");
    expect(done).toHaveBeenCalled();
  });

  it("can keep the current version", async () => {
    api.discardPluginUpdate.mockResolvedValue({ ok: true });
    await mount(<PluginUpdateSection pluginId="p" update={update} onDone={vi.fn()} />);
    await click(button("Keep current version"));
    expect(api.discardPluginUpdate).toHaveBeenCalledWith("p");
    expect(api.applyPluginUpdate).not.toHaveBeenCalled();
  });

  it("explains a rollback and stays open", async () => {
    api.applyPluginUpdate.mockRejectedValue(new Error("update rolled back: code 9"));
    const done = vi.fn();
    await mount(<PluginUpdateSection pluginId="p" update={update} onDone={done} />);
    await click(button("Update to v2.0.0"));
    expect(alertText()).toBe("update rolled back: code 9");
    expect(done).not.toHaveBeenCalled();
  });
});
