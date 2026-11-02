import { describe, expect, it } from "vitest";
import type { SkillSource } from "../../api";
import type { ExtensionArtifact, McpConnection } from "../../api/extensions";
import type { Plugin } from "../../api/plugins";
import type { CatalogRecord } from "../../components/Skills/useExtensionCatalog";
import {
  accessText, attentionText, contentSummary, filterRecords, groupRecords, identityHue, mcpEndpoint,
  recordsBySource, resolveSelection, sinceText, splitMcpTargets, versionText,
} from "./catalogModel";
import { parseAllowedTools, scopedInstallRecord } from "./useSkillDetail";
import { countInstallsByAgent } from "../../components/Skills/useSkillAgentActions";
import { sourceDisplayName } from "../../components/Skills/useSourceActions";

function artifact(patch: Partial<ExtensionArtifact> = {}): ExtensionArtifact {
  return {
    kind: "mcp", name: "server", description: "", version: "1.0.0", source: "src", repo_key: "rk", repo_path: "",
    relative_path: "", manifest: null, install_status: "installed", installed_agents: [], ...patch,
  };
}

function connection(status: McpConnection["status"]): McpConnection {
  return { url: "https://x", status, auth_type: "oauth", has_credentials: true, server_info: null, checked_at: null, expires_at: null, scopes: [], error: null };
}

const plugin = (patch: Partial<Plugin> = {}): Plugin => ({
  id: "pl", name: "Plug", version: "2.0.0", source: "local", local_path: "/p", created_at: "", updated_at: "", ...patch,
});

describe("groupRecords", () => {
  it("puts each record in one group, attention first", () => {
    const expired: CatalogRecord = { item: artifact({ name: "a", repo_key: "a", installed_agents: ["claude-acp"], mcp_connections: [connection("expired")] }) };
    const healthy: CatalogRecord = { item: artifact({ name: "b", repo_key: "b", installed_agents: ["claude-acp"], mcp_connections: [connection("authorized")] }) };
    const unbound: CatalogRecord = { item: artifact({ name: "c", repo_key: "c", installed_agents: [], mcp_connections: [connection("public")] }) };
    const available: CatalogRecord = { item: artifact({ kind: "skill", name: "d", repo_key: "d", install_status: "not_installed" }) };
    const broken: CatalogRecord = { item: artifact({ kind: "plugin", name: "e", repo_key: "e" }), plugin: plugin({ built: false }) };
    const groups = groupRecords([healthy, expired, available, unbound, broken]);
    expect(groups.attention.map((r) => r.item.name)).toEqual(["a", "c", "e"]);
    expect(groups.installed.map((r) => r.item.name)).toEqual(["b"]);
    expect(groups.available.map((r) => r.item.name)).toEqual(["d"]);
  });
});

describe("attentionText", () => {
  it("explains each attention reason", () => {
    expect(attentionText({ item: artifact({ mcp_connections: [connection("expired")] }) })).toBe("Token expired");
    expect(attentionText({ item: artifact({ mcp_connections: [connection("public")] }) })).toBe("Not available to any agent yet");
    expect(attentionText({ item: artifact({ kind: "plugin" }), plugin: plugin({ built: false, sdk_status: "outdated" }) })).toBe("Build required · SDK outdated");
  });
});

describe("filterRecords", () => {
  const records: CatalogRecord[] = [
    { item: artifact({ name: "github", description: "Issues and PRs" }) },
    { item: artifact({ kind: "skill", name: "pdf", source: "anthropic-skills" }) },
  ];
  it("filters by kind and query over name, description and source", () => {
    expect(filterRecords(records, "skill", "").map((r) => r.item.name)).toEqual(["pdf"]);
    expect(filterRecords(records, "all", "issues").map((r) => r.item.name)).toEqual(["github"]);
    expect(filterRecords(records, "all", "ANTHROPIC").map((r) => r.item.name)).toEqual(["pdf"]);
    expect(filterRecords(records, "mcp", "pdf")).toEqual([]);
  });
});

describe("access + version text", () => {
  it("counts agents and Buddies separately for MCP", () => {
    expect(splitMcpTargets(["buddy:1", "claude-acp", "codex-acp"])).toEqual({ agents: ["claude-acp", "codex-acp"], buddies: ["buddy:1"] });
    expect(accessText({ item: artifact({ installed_agents: ["buddy:1", "claude-acp", "codex-acp"] }) })).toBe("2 agents · 1 Buddy");
    expect(accessText({ item: artifact({ installed_agents: [] }) })).toBe("No agents");
  });
  it("describes skills and plugins", () => {
    expect(accessText({ item: artifact({ kind: "skill", installed_agents: ["claude-code"], install_status: "partial" }) })).toBe("1 agent · partial");
    expect(accessText({ item: artifact({ kind: "plugin", install_status: "not_installed" }) })).toBe("Not installed");
    expect(accessText({ item: artifact({ kind: "plugin" }), plugin: plugin({ source: "dev" }) })).toBe("Development");
  });
  it("hides unknown versions and prefers the installed plugin's", () => {
    expect(versionText(artifact({ version: "unknown" }))).toBeNull();
    expect(versionText(artifact({ version: "1.0.0" }), plugin())).toBe("v2.0.0");
  });
});

describe("mcpEndpoint", () => {
  it("reads the first remote, else the first package", () => {
    expect(mcpEndpoint(artifact({ manifest: { remotes: [{ url: "https://mcp.example.com" }] } }))).toEqual({ kind: "remote", label: "https://mcp.example.com" });
    expect(mcpEndpoint(artifact({ manifest: { packages: [{ registryType: "npm", identifier: "meitou-mcp" }] } }))).toEqual({ kind: "package", label: "npm · meitou-mcp" });
    expect(mcpEndpoint(artifact())).toBeNull();
  });
});

describe("resolveSelection", () => {
  const records: CatalogRecord[] = [{ item: artifact({ name: "a" }) }, { item: artifact({ name: "b" }) }];
  const key = (record: CatalogRecord) => record.item.name;
  it("keeps a visible selection and falls back to the first row", () => {
    expect(resolveSelection(records, "b", key)?.item.name).toBe("b");
    expect(resolveSelection(records, "gone", key)?.item.name).toBe("a");
    expect(resolveSelection([], "a", key)).toBeNull();
  });
});

describe("recordsBySource", () => {
  it("groups records by their source", () => {
    const map = recordsBySource([{ item: artifact({ name: "a", source: "x" }) }, { item: artifact({ name: "b", source: "y" }) }, { item: artifact({ name: "c", source: "x" }) }]);
    expect(map.get("x")?.map((r) => r.item.name)).toEqual(["a", "c"]);
    expect(map.get("y")?.length).toBe(1);
  });
});

describe("identityHue", () => {
  it("is stable per name", () => {
    expect(identityHue("github")).toEqual(identityHue("github"));
  });
});

describe("sources", () => {
  const source = (patch: Partial<SkillSource>): SkillSource => ({
    name: "s", source_type: "git", management_mode: "managed", url: "", subpath: null, repo_key: "", skill_count: 0, plugin_count: 0, mcp_count: 0, last_synced: null, has_remote_updates: false, ...patch,
  });
  it("summarises what a source contributed", () => {
    expect(contentSummary(source({ skill_count: 2, mcp_count: 1 }))).toBe("2 skills · 1 MCP server");
    expect(contentSummary(source({}))).toBe("Nothing found yet");
  });
  it("names plugin sources after their folder", () => {
    expect(sourceDisplayName(source({ name: "plugin:x", url: "/plugins/my-plugin/dist" }))).toBe("my-plugin");
  });
  it("formats sync times relative to now", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(sinceText(null, now)).toBe("Never");
    expect(sinceText("2026-11-01T09:00:00Z", now)).toBe("3h ago");
    expect(sinceText("2026-11-01T11:59:40Z", now)).toBe("just now");
  });
});

describe("skills", () => {
  it("parses allowed tools in both formats", () => {
    expect(parseAllowedTools("Read, Write")).toEqual(["Read", "Write"]);
    expect(parseAllowedTools("Read Bash(go test *) Write")).toEqual(["Read", "Bash(go test *)", "Write"]);
  });
  it("scopes installs to global and this project's bindings", () => {
    const installed = [{
      skill_name: "pdf", repo_key: "rk", source_name: "s", repo_path: "p", installed_at: "",
      agents: [
        { agent_id: "a", scope: "global" as const, symlink_path: "" },
        { agent_id: "b", scope: "project" as const, symlink_path: "", project_path: "/here" },
        { agent_id: "c", scope: "project" as const, symlink_path: "", project_path: "/elsewhere" },
      ],
    }];
    expect(scopedInstallRecord(installed, "rk", "p", "/here")?.agents.map((a) => a.agent_id)).toEqual(["a", "b"]);
    expect(scopedInstallRecord(installed, "rk", "other", "/here")).toBeNull();
    expect(countInstallsByAgent(installed).get("a")).toBe(1);
  });
});
