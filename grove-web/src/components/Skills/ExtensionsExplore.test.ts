import { describe, expect, it } from "vitest";
import type { ExtensionArtifact } from "../../api/extensions";
import type { Plugin } from "../../api/plugins";
import { needsMcpAgentSetup } from "./mcpManagementState";
import { resolveInstalledPlugin } from "./installedPlugin";
import { pluginAttentionReasons } from "./pluginAttention";

function plugin(id: string, name: string): Plugin {
  return {
    id,
    name,
    version: "1.0.0",
    source: "dev",
    local_path: `/plugins/${name}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function artifact(installedPluginId: string): ExtensionArtifact {
  return {
    kind: "plugin",
    name: "second",
    description: "",
    version: "2.0.0",
    source: "plugin:second",
    repo_key: "pl-second",
    repo_path: "",
    relative_path: "",
    manifest: null,
    install_status: "installed",
    installed_agents: [],
    installed_plugin_id: installedPluginId,
  };
}

describe("resolveInstalledPlugin", () => {
  it("uses the backend plugin id when catalog paths are empty", () => {
    const plugins = [
      plugin("pl-first", "first"),
      plugin("pl-second", "second"),
    ];

    expect(resolveInstalledPlugin(artifact("pl-second"), plugins)?.name).toBe(
      "second",
    );
  });
});

describe("plugin attention reasons", () => {
  it("explains each condition that puts a plugin in Needs attention", () => {
    const current = plugin("id", "demo");
    expect(pluginAttentionReasons(current)).toEqual([]);
    expect(pluginAttentionReasons({ ...current, sdk_status: "outdated" })).toEqual(["SDK outdated"]);
    expect(pluginAttentionReasons({ ...current, built: false, runtime: { command: "node", available: false }, sdk_status: "missing" })).toEqual([
      "Build required", "node unavailable", "SDK missing",
    ]);
    expect(pluginAttentionReasons({ ...current, exists: false, sdk_status: "missing" })).toEqual(["Plugin folder missing"]);
  });
});

describe("MCP Agent setup status", () => {
  it("requires setup for connected servers without Agents, but not for an enabled server", () => {
    const item: ExtensionArtifact = {
      ...artifact(""),
      kind: "mcp",
      installed_agents: [],
      mcp_connections: [
        {
          url: "https://provider.example/mcp",
          status: "authorized",
          auth_type: "oauth",
          has_credentials: true,
          server_info: null,
          checked_at: null,
          expires_at: null,
          scopes: [],
          error: null,
        },
      ],
    };
    expect(needsMcpAgentSetup(item)).toBe(true);
    expect(needsMcpAgentSetup({ ...item, installed_agents: ["one"] })).toBe(
      false,
    );
    expect(needsMcpAgentSetup({ ...item, mcp_connections: [] })).toBe(false);
  });
});
