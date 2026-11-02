import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/extensions";
import type { ExtensionArtifact, McpInstallation } from "../../api/extensions";
import { bindingRows, initialScope, missingRequiredField, runtimeFields, toggleId, useMcpAccess } from "./useMcpAccess";

vi.mock("../../api/extensions", () => ({
  installMcp: vi.fn(),
  listMcpInstallations: vi.fn(),
}));

const artifact: ExtensionArtifact = {
  kind: "mcp", name: "srv", description: "", version: "1", source: "s", repo_key: "rk", repo_path: "",
  relative_path: "", install_status: "installed", installed_agents: [],
  manifest: { remotes: [{ url: "https://x", headers: [{ name: "TOKEN", isRequired: true }] }] },
};

function binding(patch: Partial<McpInstallation>): McpInstallation {
  return { repo_key: "rk", repo_path: "", agent_id: "claude", scope: "global", project_path: "", runtime: { kind: "remote", index: 0 }, values: { TOKEN: "t" }, ...patch };
}

let container: HTMLDivElement;
let root: Root;
const latest: { access?: ReturnType<typeof useMcpAccess> } = {};
const current = () => latest.access!;

function Harness({ onSaved }: { onSaved?: () => void }) {
  const value = useMcpAccess({ artifact, projectPath: "/proj", onSaved });
  useEffect(() => { latest.access = value; });
  return null;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  vi.mocked(api.listMcpInstallations).mockResolvedValue([binding({}), binding({ agent_id: "codex", scope: "project", project_path: "/proj" }), binding({ repo_key: "other" })]);
  vi.mocked(api.installMcp).mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
});

describe("pure helpers", () => {
  it("reads the runtime's fields and finds a missing required one", () => {
    const fields = runtimeFields(artifact, { kind: "remote", index: 0 });
    expect(fields.map((field) => field.name)).toEqual(["TOKEN"]);
    expect(missingRequiredField({ agentIds: ["a"], values: {}, runtime: { kind: "remote", index: 0 } }, fields)).toBe("TOKEN");
    expect(missingRequiredField({ agentIds: [], values: {}, runtime: { kind: "remote", index: 0 } }, fields)).toBeNull();
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
  });
  it("lists every binding, other projects included", () => {
    const draft = (agentIds: string[]) => ({ agentIds, values: {}, runtime: { kind: "remote" as const, index: 0 } });
    const rows = bindingRows({ global: draft(["a"]), project: draft(["b"]), buddy: draft(["buddy:1"]) }, [binding({ agent_id: "c", scope: "project", project_path: "/other" })], "/proj");
    expect(rows.map((row) => `${row.scope}:${row.projectPath ?? ""}:${row.targetId}`)).toEqual(["global::a", "project:/proj:b", "project:/other:c", "buddy::buddy:1"]);
  });
  it("opens on the first scope that has bindings", () => {
    const draft = (agentIds: string[]) => ({ agentIds, values: {}, runtime: { kind: "remote" as const, index: 0 } });
    expect(initialScope({ global: draft([]), project: draft(["a"]), buddy: draft(["b"]) }, "/p")).toBe("project");
    expect(initialScope({ global: draft([]), project: draft(["a"]), buddy: draft(["b"]) }, null)).toBe("buddy");
    expect(initialScope({ global: draft([]), project: draft([]), buddy: draft([]) }, "/p")).toBe("global");
  });
});

describe("useMcpAccess", () => {
  it("loads per-scope selections for this artifact only", async () => {
    act(() => root.render(<Harness />));
    await flush();
    expect(current().loaded).toBe(true);
    expect(current().selected).toEqual(["claude"]);
    act(() => current().setScope("project"));
    expect(current().selected).toEqual(["codex"]);
    expect(current().elsewhere).toBe(0);
  });

  it("saves each toggle immediately with the scope's runtime and values", async () => {
    const onSaved = vi.fn();
    act(() => root.render(<Harness onSaved={onSaved} />));
    await flush();
    act(() => current().toggle("codex"));
    expect(current().selected).toEqual(["claude", "codex"]);
    await flush();
    expect(api.installMcp).toHaveBeenCalledWith({
      repo_key: "rk", repo_path: "", scope: "global", project_path: undefined,
      agent_ids: ["claude", "codex"], runtime: { kind: "remote", index: 0 }, values: { TOKEN: "t" },
    });
    expect(current().savedCount).toBe(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(current().saving).toBe(false);
  });

  it("refuses a toggle that would bind agents without required values", async () => {
    vi.mocked(api.listMcpInstallations).mockResolvedValue([]);
    act(() => root.render(<Harness />));
    await flush();
    act(() => current().toggle("claude"));
    expect(current().error).toMatch(/TOKEN is required/);
    expect(current().selected).toEqual([]);
    expect(api.installMcp).not.toHaveBeenCalled();
  });

  it("reports a failed save and resyncs from the server", async () => {
    vi.mocked(api.installMcp).mockRejectedValueOnce(new Error("nope"));
    act(() => root.render(<Harness />));
    await flush();
    act(() => current().toggle("claude"));
    await flush();
    expect(current().error).toBe("nope");
    expect(api.listMcpInstallations).toHaveBeenCalledTimes(2);
    expect(current().selected).toEqual(["claude"]);
  });
});
