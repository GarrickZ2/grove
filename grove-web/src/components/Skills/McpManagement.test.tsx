import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddMcpDialog, McpManagementDrawer } from "./McpManagement";
import { McpConnectionSection } from "./McpConnectionViews";
import { useMcpConnection } from "./useMcpConnection";
import * as api from "../../api/extensions";
import { openExternalUrl } from "../../utils/openExternal";
import type { McpConnection, ExtensionArtifact } from "../../api/extensions";
import {
  listInstalledAgentConfigs,
  type InstalledAgentConfig,
} from "../../api/marketplace";

vi.mock("../../api/extensions", () => ({
  getMcpConnection: vi.fn(),
  probeMcp: vi.fn(),
  probeMcpPackage: vi.fn(),
  getMcpPackageProbe: vi.fn(),
  cancelMcpPackageProbe: vi.fn(),
  authorizeMcp: vi.fn(),
  getMcpAuthFlow: vi.fn(),
  cancelMcpAuth: vi.fn(),
  finishMcpAuth: vi.fn(),
  disconnectMcp: vi.fn(),
  createManagedMcp: vi.fn(),
  updateMcpDisplayName: vi.fn(),
  installMcp: vi.fn(),
  listMcpInstallations: vi.fn(),
}));
vi.mock("../../api/marketplace", () => ({
  listInstalledAgentConfigs: vi.fn(),
}));
vi.mock("../../utils/openExternal", () => ({ openExternalUrl: vi.fn() }));
vi.mock("./ExtensionIdentityIcon", () => ({
  ExtensionIdentityIcon: () => null,
}));
vi.mock("./AgentIcon", () => ({ AgentIcon: () => null }));
vi.mock("../Dialogs/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    onConfirm,
    onCancel,
    confirmLabel,
    cancelLabel,
  }: {
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmLabel: string;
    cancelLabel: string;
  }) =>
    isOpen ? (
      <div role="alertdialog">
        <h2>{title}</h2>
        <p>{message}</p>
        <button onClick={onCancel}>{cancelLabel}</button>
        <button onClick={onConfirm}>{confirmLabel}</button>
      </div>
    ) : null,
}));
vi.mock("../ui", async () => ({
  Button: (await import("../ui/Button")).Button,
  DialogShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Combobox: () => null,
}));

const url = "https://provider.example/mcp";
const info = {
  name: "provider-mcp",
  title: "Provider",
  version: "3.2.0",
  description: "Detected description",
  website_url: null,
  icons: [],
};
function connection(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    url,
    status: "auth_required",
    auth_type: "oauth",
    has_credentials: false,
    server_info: null,
    checked_at: 1234,
    expires_at: null,
    scopes: [],
    error: null,
    ...overrides,
  };
}
const artifact: ExtensionArtifact = {
  kind: "mcp",
  name: "Provider",
  description: "",
  version: null,
  source: "managed",
  repo_key: "repo",
  repo_path: "",
  relative_path: "server.json",
  manifest: {
    remotes: [
      {
        url,
        headers: [{ name: "X-API-Key", isRequired: true, isSecret: true }],
      },
    ],
  },
  install_status: "installed",
  installed_agents: ["one", "two"],
};
const agents: InstalledAgentConfig[] = [
  {
    id: "one",
    name: "One",
    capability_snapshot: null,
    capability_updated_at: null,
  },
  {
    id: "two",
    name: "Two",
    capability_snapshot: null,
    capability_updated_at: null,
  },
];
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(listInstalledAgentConfigs).mockResolvedValue(agents);
  vi.mocked(api.createManagedMcp).mockResolvedValue({
    ok: true,
    source: "managed",
    repo_key: "new-repo",
    repo_path: "",
  });
  vi.mocked(api.installMcp).mockResolvedValue({ ok: true });
  vi.mocked(api.updateMcpDisplayName).mockResolvedValue({ ok: true });
  vi.mocked(api.getMcpConnection).mockResolvedValue(connection());
  vi.mocked(api.probeMcpPackage).mockResolvedValue({
    id: "package-check",
    status: "complete",
    server_info: info,
    tool_count: 2,
    checked_at: 1234,
    error: null,
  });
  vi.mocked(api.cancelMcpPackageProbe).mockResolvedValue({ ok: true });
  vi.mocked(api.cancelMcpAuth).mockResolvedValue({ ok: true });
  vi.mocked(api.listMcpInstallations).mockResolvedValue([
    {
      repo_key: "repo",
      repo_path: "",
      agent_id: "one",
      scope: "global",
      project_path: "",
      runtime: { kind: "remote", index: 0 },
      values: { "X-API-Key": "global-key" },
    },
    {
      repo_key: "repo",
      repo_path: "",
      agent_id: "two",
      scope: "project",
      project_path: "/project",
      runtime: { kind: "remote", index: 0 },
      values: { "X-API-Key": "project-key" },
    },
  ]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const buttons = (text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter(
    (item) => !item.closest(".hidden") && item.textContent?.trim() === text,
  );
const button = (text: string) => buttons(text).at(-1)!;
async function click(text: string) {
  await act(async () => button(text).click());
}
async function input(selector: string, value: string) {
  const field = Array.from(
    host.querySelectorAll<HTMLInputElement>(selector),
  ).find((item) => !item.closest(".hidden"))!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function selectAgent(name: string) {
  const label = Array.from(host.querySelectorAll("label")).find(
    (item) => !item.closest(".hidden") && item.textContent?.trim() === name,
  )!;
  await act(async () =>
    label.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
}

function Harness({ onChange }: { onChange?: (value: McpConnection) => void }) {
  const controller = useMcpConnection({ url, onChange });
  return (
    <McpConnectionSection
      controller={controller}
      url={url}
      onDisconnect={() => void controller.disconnect()}
    />
  );
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((callback) => {
    resolve = callback;
  });
  return { promise, resolve };
}

describe("MCP connection lifecycle", () => {
  it("keeps a pasted callback URL available when completion fails", async () => {
    vi.useFakeTimers();
    vi.mocked(api.authorizeMcp).mockResolvedValue({
      id: "paste-flow",
      status: "pending",
      authorization_url: "https://provider.example/auth",
      error: null,
    });
    vi.mocked(api.finishMcpAuth).mockRejectedValue(
      new Error("Callback could not be verified"),
    );
    await act(async () => root.render(<Harness />));
    await click("Authorize");
    const callback = "http://127.0.0.1:3333/callback?code=sample&state=sample";
    await input('input[placeholder^="http://127.0.0.1:"]', callback);
    await click("Complete sign-in");
    expect(
      host.querySelector<HTMLInputElement>(
        'input[placeholder^="http://127.0.0.1:"]',
      )?.value,
    ).toBe(callback);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Callback could not be verified",
    );
  });

  it("reads the saved grant if a browser callback completes just before cancellation", async () => {
    vi.mocked(api.authorizeMcp).mockResolvedValue({
      id: "cancel-race",
      status: "pending",
      authorization_url: "https://provider.example/auth",
      error: null,
    });
    const onChange = vi.fn();
    await act(async () => root.render(<Harness onChange={onChange} />));
    await click("Authorize");
    const saved = connection({
      status: "authorized",
      has_credentials: true,
      server_info: info,
    });
    vi.mocked(api.getMcpConnection).mockResolvedValue(saved);
    await click("Cancel sign-in");
    expect(onChange).toHaveBeenLastCalledWith(saved);
    expect(host.textContent).toContain("Reauthorize");
    expect(api.disconnectMcp).not.toHaveBeenCalled();
  });

  it("publishes delayed metadata after OAuth completion instead of losing it to effect cleanup", async () => {
    vi.useFakeTimers();
    const metadata = defer<McpConnection>();
    vi.mocked(api.authorizeMcp).mockResolvedValue({
      id: "flow",
      status: "pending",
      authorization_url: "https://provider.example/authorize",
      error: null,
    });
    vi.mocked(api.getMcpAuthFlow).mockResolvedValue({
      id: "flow",
      status: "complete",
      error: null,
    });
    vi.mocked(api.probeMcp).mockReturnValue(metadata.promise);
    const onChange = vi.fn();
    await act(async () => root.render(<Harness onChange={onChange} />));
    await click("Authorize");
    vi.mocked(api.getMcpConnection).mockResolvedValue(
      connection({ status: "authorized", has_credentials: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(api.probeMcp).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Finishing connection");
    const authorized = connection({
      status: "authorized",
      has_credentials: true,
      server_info: info,
    });
    await act(async () => {
      metadata.resolve(authorized);
      await metadata.promise;
    });
    expect(onChange).toHaveBeenLastCalledWith(authorized);
    expect(host.textContent).toContain("Reauthorize");
    expect(host.textContent).not.toContain("Finishing connection");
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://provider.example/authorize",
    );
  });

  it("cancels a sign-in that finishes registration after the page closes", async () => {
    const registration = defer<api.McpAuthFlow>();
    vi.mocked(api.authorizeMcp).mockReturnValue(registration.promise);
    await act(async () => root.render(<Harness />));
    await click("Authorize");
    await act(async () => root.render(<div />));
    await act(async () => {
      registration.resolve({
        id: "late-flow",
        status: "pending",
        authorization_url: "https://provider.example/auth",
        error: null,
      });
      await registration.promise;
    });
    expect(api.cancelMcpAuth).toHaveBeenCalledWith("late-flow");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("retries network failures without retaining an old error after success", async () => {
    vi.mocked(api.probeMcp)
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValueOnce(
        connection({ status: "public", auth_type: "none" }),
      );
    await act(async () => root.render(<Harness />));
    await click("Check connection");
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "Connection unavailable",
    );
    await click("Check connection");
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(host.textContent).toContain("Server connection verified");
  });
});

describe("MCP add and management", () => {
  it("offers authorization when a saved grant is rejected instead of looping on Retry", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ has_credentials: true }),
    );
    vi.mocked(api.authorizeMcp).mockResolvedValue({
      id: "monarch-login",
      status: "pending",
      authorization_url: "https://provider.example/auth",
      error: null,
    });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await input("#mcp-location", url);
    await click("Connect");
    expect(buttons("Retry connection")).toHaveLength(0);
    expect(button("Authorize & continue").disabled).toBe(false);
    await click("Authorize & continue");
    expect(api.authorizeMcp).toHaveBeenCalledWith(
      url,
      undefined,
      undefined,
      undefined,
    );
  });

  it("switches from rejected saved credentials to Add server after Monarch authorization succeeds", async () => {
    vi.useFakeTimers();
    const connected = connection({
      status: "authorized",
      has_credentials: true,
      server_info: {
        ...info,
        name: "Monarch Money",
        title: null,
        version: "3.3.1",
      },
    });
    vi.mocked(api.probeMcp)
      .mockResolvedValueOnce(connection({ has_credentials: true }))
      .mockResolvedValueOnce(connected);
    vi.mocked(api.authorizeMcp).mockResolvedValue({
      id: "monarch-login",
      status: "pending",
      authorization_url: "https://provider.example/auth",
      error: null,
    });
    vi.mocked(api.getMcpAuthFlow).mockResolvedValue({
      id: "monarch-login",
      status: "complete",
      error: null,
    });
    vi.mocked(api.getMcpConnection).mockResolvedValue({
      ...connected,
      server_info: null,
    });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await input("#mcp-location", url);
    await click("Connect");
    await click("Authorize & continue");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(host.textContent).toContain("Monarch Money");
    expect(host.textContent).toContain("v3.3.1");
    expect(button("Add & enable").disabled).toBe(true);
    expect(host.textContent).toContain("Agent access");
    await selectAgent("One");
    expect(button("Add & enable").disabled).toBe(false);
    expect(buttons("Retry connection")).toHaveLength(0);
  });

  it("allows a connected server without optional metadata to be added without a Retry loop", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ status: "authorized", has_credentials: true }),
    );
    vi.mocked(api.createManagedMcp).mockResolvedValue({
      ok: true,
      source: "managed",
      repo_key: "new-repo",
      repo_path: "",
    });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await input("#mcp-location", url);
    await click("Connect");
    expect(buttons("Retry connection")).toHaveLength(0);
    await selectAgent("One");
    await click("Add & enable");
    expect(api.createManagedMcp).toHaveBeenCalledWith(
      expect.objectContaining({ name: "provider.example", version: "unknown" }),
    );
  });

  it("connects first and uses detected metadata in the saved manifest", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ status: "public", auth_type: "none", server_info: info }),
    );
    vi.mocked(api.createManagedMcp).mockResolvedValue({
      ok: true,
      source: "managed",
      repo_key: "new-repo",
      repo_path: "",
    });
    const onCreated = vi.fn();
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={onCreated} />),
    );
    expect(button("Connect").disabled).toBe(true);
    await input("#mcp-location", url);
    await click("Connect");
    expect(host.textContent).toContain("Detected description");
    expect(host.textContent).toContain("v3.2.0");
    await selectAgent("One");
    await click("Add & enable");
    expect(api.createManagedMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Provider",
        version: "3.2.0",
        description: "Detected description",
        remotes: [{ type: "streamable-http", url }],
      }),
    );
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        repo_key: "new-repo",
        repo_path: "",
        agent_ids: ["one"],
        scope: "global",
        runtime: { kind: "remote", index: 0 },
        values: {},
      }),
    );
    expect(host.textContent).toContain("Configured for 1 Agent");
    expect(host.textContent).toContain("reconnect an existing Agent");
    expect(onCreated).not.toHaveBeenCalled();
    await click("Done");
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("shows scope and Agent choices immediately after connecting and defaults to the current project", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ status: "public", auth_type: "none", server_info: info }),
    );
    await act(async () =>
      root.render(
        <AddMcpDialog
          projectPath="/project"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      ),
    );
    await input("#mcp-location", url);
    await click("Connect");
    expect(button("Current project").getAttribute("aria-pressed")).toBe("true");
    expect(button("Add & enable").disabled).toBe(true);
    expect(api.createManagedMcp).not.toHaveBeenCalled();
    await selectAgent("Two");
    await click("Add & enable");
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "project",
        project_path: "/project",
        agent_ids: ["two"],
      }),
    );
    expect(host.textContent).toContain("Configured for 1 Agent");
    expect(host.textContent).toContain("/project");
    expect(host.textContent).toContain("Two");
  });

  it("lets users select all-project scope and multiple Agents before finishing", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({
        status: "authorized",
        has_credentials: true,
        server_info: info,
      }),
    );
    await act(async () =>
      root.render(
        <AddMcpDialog
          projectPath="/project"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      ),
    );
    await input("#mcp-location", url);
    await click("Connect");
    await click("All projects");
    await selectAgent("One");
    await selectAgent("Two");
    await click("Add & enable");
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        project_path: undefined,
        agent_ids: ["one", "two"],
      }),
    );
    expect(host.textContent).toContain("Configured for 2 Agents");
    expect(host.textContent).toContain("All projects");
  });

  it("keeps the same created server when enabling fails and retries without duplicate creation", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ status: "public", auth_type: "none", server_info: info }),
    );
    vi.mocked(api.installMcp)
      .mockRejectedValueOnce(new Error("Could not save access"))
      .mockResolvedValueOnce({ ok: true });
    const onCreated = vi.fn();
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={onCreated} />),
    );
    await input("#mcp-location", url);
    await click("Connect");
    await selectAgent("One");
    await click("Add & enable");
    expect(host.textContent).toContain("Agent access could not be enabled");
    expect(host.textContent).not.toContain("MCP Server added");
    expect(onCreated).not.toHaveBeenCalled();
    expect(button("Change").disabled).toBe(true);
    await click("Retry enabling");
    expect(api.createManagedMcp).toHaveBeenCalledOnce();
    expect(api.installMcp).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("MCP Server added");
  });

  it("cannot finish without installed Agents and can recover an Agent-list error", async () => {
    vi.mocked(listInstalledAgentConfigs)
      .mockRejectedValueOnce(new Error("Agent list unavailable"))
      .mockResolvedValueOnce([]);
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ status: "public", auth_type: "none", server_info: info }),
    );
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await input("#mcp-location", url);
    await click("Connect");
    expect(button("Add & enable").disabled).toBe(true);
    await click("Retry loading Agents");
    expect(host.textContent).toContain("Install an ACP Agent before enabling");
    expect(button("Add & enable").disabled).toBe(true);
    expect(api.createManagedMcp).not.toHaveBeenCalled();
  });

  it("collects required credentials before enabling instead of hiding another setup step", async () => {
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({ status: "public", auth_type: "none", server_info: info }),
    );
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await input("#mcp-location", url);
    await click("Connect");
    await selectAgent("One");
    await act(async () =>
      Array.from(host.querySelectorAll("summary"))
        .find((item) => item.textContent === "Edit display details")!
        .click(),
    );
    await click("Add field");
    await input('[aria-label="Field 1 name"]', "X-API-Key");
    expect(button("Add & enable").disabled).toBe(true);
    await input('[aria-label="X-API-Key"]', "provided-key");
    await click("Add & enable");
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({ values: { "X-API-Key": "provided-key" } }),
    );
  });

  it("connects package servers first, reads their metadata and then enables selected Agents", async () => {
    const icons = [{ src: "https://provider.example/icon.png" }];
    vi.mocked(api.probeMcpPackage).mockResolvedValue({
      id: "npm-check",
      status: "complete",
      server_info: { ...info, icons },
      tool_count: 7,
      checked_at: 1234,
      error: null,
    });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await click("NPM");
    await input('input[placeholder="@company/mcp-server"]', "@company/server");
    expect(buttons("Add & enable")).toHaveLength(0);
    await click("Connect");
    expect(api.probeMcpPackage).toHaveBeenCalledWith({
      package: { registryType: "npm", identifier: "@company/server" },
      values: {},
    });
    expect(host.textContent).toContain("Provider");
    expect(host.textContent).toContain("v3.2.0");
    expect(host.textContent).toContain("7 tools");
    expect(button("Add & enable").disabled).toBe(true);
    await selectAgent("One");
    await click("Add & enable");
    expect(api.createManagedMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Provider",
        version: "3.2.0",
        description: "Detected description",
        icons,
        packages: [{ registryType: "npm", identifier: "@company/server" }],
      }),
    );
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: { kind: "package", index: 0 },
        agent_ids: ["one"],
      }),
    );
  });

  it.each([
    ["PyPI", "mcp-server-package", "pypi"],
    ["OCI", "ghcr.io/company/mcp-server", "oci"],
  ])(
    "uses the same connect-before-bind flow for %s",
    async (label, placeholder, registry) => {
      await act(async () =>
        root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
      );
      await click(label);
      await input(`input[placeholder="${placeholder}"]`, "company-server");
      await input('input[placeholder="Default"]', "2.0.0");
      await click("Connect");
      expect(api.probeMcpPackage).toHaveBeenCalledWith({
        package: {
          registryType: registry,
          identifier: "company-server",
          version: "2.0.0",
        },
        values: {},
      });
      await selectAgent("Two");
      await click("Add & enable");
      expect(api.createManagedMcp).toHaveBeenCalledWith(
        expect.objectContaining({
          version: "3.2.0",
          packages: [
            {
              registryType: registry,
              identifier: "company-server",
              version: "2.0.0",
            },
          ],
        }),
      );
    },
  );

  it("preserves package startup settings and environment credentials when a failed check is retried", async () => {
    vi.mocked(api.probeMcpPackage)
      .mockResolvedValueOnce({
        id: "failed-check",
        status: "failed",
        server_info: null,
        tool_count: null,
        checked_at: 1234,
        error: "Check the required environment variables",
      })
      .mockResolvedValueOnce({
        id: "good-check",
        status: "complete",
        server_info: info,
        tool_count: 1,
        checked_at: 1234,
        error: null,
      });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await click("NPM");
    await input('input[placeholder="@company/mcp-server"]', "@company/server");
    await act(async () =>
      Array.from(host.querySelectorAll("summary"))
        .find(
          (item) =>
            !item.closest(".hidden") && item.textContent === "Startup settings",
        )!
        .click(),
    );
    await click("Add field");
    await input('[aria-label="Field 1 name"]', "API_KEY");
    expect(button("Connect").disabled).toBe(true);
    await input('[aria-label="API_KEY"]', "provided-key");
    await click("Connect");
    expect(host.textContent).toContain(
      "Check the required environment variables",
    );
    expect(api.createManagedMcp).not.toHaveBeenCalled();
    await click("Retry connection");
    expect(api.probeMcpPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({ values: { API_KEY: "provided-key" } }),
    );
    await selectAgent("One");
    await click("Add & enable");
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({ values: { API_KEY: "provided-key" } }),
    );
  });

  it("polls package startup and cancels a late check when the dialog closes", async () => {
    vi.useFakeTimers();
    vi.mocked(api.probeMcpPackage).mockResolvedValue({
      id: "pending-package",
      status: "pending",
      server_info: null,
      tool_count: null,
      checked_at: null,
      error: null,
    });
    vi.mocked(api.getMcpPackageProbe).mockResolvedValue({
      id: "pending-package",
      status: "complete",
      server_info: info,
      tool_count: 3,
      checked_at: 1234,
      error: null,
    });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await click("NPM");
    await input('input[placeholder="@company/mcp-server"]', "@company/server");
    await click("Connect");
    expect(host.textContent).toContain("Starting and checking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(host.textContent).toContain("3 tools");
    await act(async () => root.render(<div />));
    expect(api.cancelMcpPackageProbe).toHaveBeenCalledWith("pending-package");
    const started = defer<api.McpPackageProbe>();
    vi.mocked(api.probeMcpPackage).mockReturnValue(started.promise);
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await click("NPM");
    await input('input[placeholder="@company/mcp-server"]', "@company/server");
    await click("Connect");
    await act(async () => root.render(<div />));
    await act(async () => {
      started.resolve({
        id: "late-package",
        status: "pending",
        server_info: null,
        tool_count: null,
        checked_at: null,
        error: null,
      });
      await started.promise;
    });
    expect(api.cancelMcpPackageProbe).toHaveBeenCalledWith("late-package");
  });

  it("requires a new connection check when package credentials change after success", async () => {
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await click("NPM");
    await input('input[placeholder="@company/mcp-server"]', "@company/server");
    await click("Connect");
    await selectAgent("One");
    expect(button("Add & enable").disabled).toBe(false);
    await act(async () =>
      Array.from(host.querySelectorAll("summary"))
        .find(
          (item) =>
            !item.closest(".hidden") && item.textContent === "Startup settings",
        )!
        .click(),
    );
    await click("Add field");
    await input('[aria-label="Field 1 name"]', "API_KEY");
    expect(buttons("Add & enable")).toHaveLength(0);
    expect(button("Retry connection").disabled).toBe(true);
    await input('[aria-label="API_KEY"]', "changed-key");
    await click("Retry connection");
    expect(api.probeMcpPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({ values: { API_KEY: "changed-key" } }),
    );
    expect(button("Add & enable").disabled).toBe(false);
    expect(api.createManagedMcp).not.toHaveBeenCalled();
  });

  it("cancels a running package check before changing its runtime", async () => {
    vi.useFakeTimers();
    vi.mocked(api.probeMcpPackage).mockResolvedValue({
      id: "running-package",
      status: "pending",
      server_info: null,
      tool_count: null,
      checked_at: null,
      error: null,
    });
    await act(async () =>
      root.render(<AddMcpDialog onClose={vi.fn()} onCreated={vi.fn()} />),
    );
    await click("NPM");
    await input('input[placeholder="@company/mcp-server"]', "@company/server");
    await click("Connect");
    await click("Change");
    expect(api.cancelMcpPackageProbe).toHaveBeenCalledWith("running-package");
    expect(button("NPM").disabled).toBe(false);
    await click("PyPI");
    expect(button("Connect").disabled).toBe(true);
    expect(host.textContent).not.toContain("Starting and checking");
  });

  it("checks existing package servers from management with the selected credentials", async () => {
    vi.mocked(api.listMcpInstallations).mockResolvedValue([]);
    vi.mocked(api.getMcpConnection).mockResolvedValue(connection());
    const local: ExtensionArtifact = {
      ...artifact,
      manifest: {
        packages: [
          {
            registryType: "npm",
            identifier: "@company/server",
            environmentVariables: [{ name: "API_KEY", isSecret: true }],
          },
        ],
      },
    };
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={local}
          agents={agents}
          projectPath="/project"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      ),
    );
    expect(api.probeMcpPackage).not.toHaveBeenCalled();
    await input('[aria-label="API_KEY"]', "provided-key");
    await click("Check connection");
    expect(api.probeMcpPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ API_KEY: "provided-key" }),
      }),
    );
    expect(host.textContent).toContain("Connection verified");
    expect(host.textContent).toContain("v3.2.0");
  });

  it("marks an authorized but unassigned server as requiring Agent setup in management", async () => {
    vi.mocked(api.listMcpInstallations).mockResolvedValue([]);
    vi.mocked(api.getMcpConnection).mockResolvedValue(
      connection({
        status: "authorized",
        has_credentials: true,
        server_info: info,
      }),
    );
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={artifact}
          agents={agents}
          projectPath="/project"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain("Not available to any Agent yet");
    await selectAgent("One");
    await input('[aria-label="X-API-Key"]', "key");
    await click("Save changes");
    expect(host.textContent).not.toContain("Not available to any Agent yet");
    expect(host.textContent).toContain("Reconnect existing Agents");
  });

  it("preserves drafts across scope switches and only saves the active scope", async () => {
    vi.mocked(api.installMcp).mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={artifact}
          agents={agents}
          projectPath="/project"
          onClose={onClose}
          onSaved={onSaved}
        />,
      ),
    );
    expect(button("Save changes").disabled).toBe(true);
    await act(async () =>
      host
        .querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]
        .click(),
    );
    await click("Current project");
    await input('[aria-label="X-API-Key"]', "edited-project-key");
    await click("All projects");
    expect(
      host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]
        .checked,
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="X-API-Key"]')?.value,
    ).toBe("global-key");
    await click("Save changes");
    expect(api.installMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        agent_ids: ["one", "two"],
        values: { "X-API-Key": "global-key" },
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Save changes").disabled).toBe(true);
    await click("Current project");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="X-API-Key"]')?.value,
    ).toBe("edited-project-key");
    await click("Done");
    expect(host.querySelector("[role=alertdialog]")?.textContent).toContain(
      "Discard unsaved changes",
    );
    expect(onClose).not.toHaveBeenCalled();
    await click("Keep editing");
    expect(host.querySelector("[role=alertdialog]")).toBeNull();
    await click("Done");
    await click("Discard changes");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses a confirmation for disconnect and preserves all Agent selections", async () => {
    vi.mocked(api.getMcpConnection).mockResolvedValue(
      connection({ status: "authorized", has_credentials: true }),
    );
    vi.mocked(api.disconnectMcp).mockResolvedValue({
      ok: true,
      warning: "Existing tokens may remain valid until expiry.",
    });
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={artifact}
          agents={agents}
          projectPath="/project"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      ),
    );
    await click("Cancel authorization");
    expect(api.disconnectMcp).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alertdialog]")?.textContent).toContain(
      "Agent bindings will stay",
    );
    await click("Cancel authorization");
    expect(api.disconnectMcp).toHaveBeenCalledWith(url);
    expect(
      host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0]
        .checked,
    ).toBe(true);
    expect(api.installMcp).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Authorization required");
    expect(host.textContent).toContain("Existing tokens may remain valid");
  });

  it("never enables saving after a failed binding load", async () => {
    vi.mocked(api.listMcpInstallations).mockRejectedValue(
      new Error("Network unavailable"),
    );
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={artifact}
          agents={agents}
          projectPath="/project"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      ),
    );
    expect(button("Save changes").disabled).toBe(true);
    expect(host.textContent).toContain("Retry loading Agents");
    await click("Done");
    expect(api.installMcp).not.toHaveBeenCalled();
  });

  it("saves a display-only alias without requiring Agent access and keeps it after a connection check", async () => {
    vi.mocked(api.listMcpInstallations).mockResolvedValue([]);
    vi.mocked(api.probeMcp).mockResolvedValue(
      connection({
        status: "public",
        auth_type: "none",
        server_info: { ...info, name: "mcp-streamable-http", title: null },
      }),
    );
    const onSaved = vi.fn();
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={{ ...artifact, name: "mcp-streamable-http" }}
          agents={agents}
          projectPath="/project"
          onClose={vi.fn()}
          onSaved={onSaved}
        />,
      ),
    );
    await input('section[aria-label="Display details"] input', " TradingView ");
    expect(button("Save changes").disabled).toBe(false);
    await click("Save changes");
    expect(api.updateMcpDisplayName).toHaveBeenCalledWith({
      repo_key: "repo",
      repo_path: "",
      display_name: "TradingView",
    });
    expect(api.installMcp).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(host.querySelector("h2")?.textContent).toBe("TradingView");
    await click("Check connection");
    expect(host.querySelector("h2")?.textContent).toBe("TradingView");
    expect(button("Save changes").disabled).toBe(true);
  });

  it("keeps a failed rename editable and warns before discarding it", async () => {
    vi.mocked(api.updateMcpDisplayName).mockRejectedValue(
      new Error("Could not save name"),
    );
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <McpManagementDrawer
          artifact={artifact}
          agents={agents}
          projectPath={null}
          onClose={onClose}
          onSaved={vi.fn()}
        />,
      ),
    );
    await input('section[aria-label="Display details"] input', "  ");
    expect(button("Save changes").disabled).toBe(true);
    await input('section[aria-label="Display details"] input', "My provider");
    await click("Save changes");
    expect(host.textContent).toContain("Could not save name");
    expect(host.querySelector("h2")?.textContent).toBe("Provider");
    expect(button("Save changes").disabled).toBe(false);
    await click("Done");
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "unsaved display name",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
