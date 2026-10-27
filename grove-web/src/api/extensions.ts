import { apiClient } from "./client";
import { notifyPluginsChanged } from "./plugins";

export type ExtensionKind = "skill" | "plugin" | "mcp";

export interface ExtensionArtifact {
  kind: ExtensionKind;
  name: string;
  description: string;
  version: string | null;
  source: string;
  repo_key: string;
  repo_path: string;
  relative_path: string;
  manifest: Record<string, unknown> | null;
  install_status: "not_installed" | "installed" | "partial";
  installed_agents: string[];
  installed_plugin_id?: string;
  mcp_connections?: McpConnection[];
}

export interface McpServerInfo {
  name: string;
  title: string | null;
  version: string | null;
  description: string | null;
  website_url: string | null;
  icons: Record<string, unknown>[];
}

export interface McpConnection {
  url: string;
  status: "unchecked" | "public" | "authorized" | "auth_required" | "expired" | "error";
  auth_type: "none" | "oauth" | "manual";
  has_credentials: boolean;
  server_info: McpServerInfo | null;
  checked_at: number | null;
  expires_at: number | null;
  scopes: string[];
  error: string | null;
}

export interface McpAuthFlow {
  id: string;
  status: "pending" | "exchanging" | "complete" | "failed" | "cancelled" | "expired";
  authorization_url?: string;
  error: string | null;
}

export interface McpInstallation {
  repo_key: string;
  repo_path: string;
  agent_id: string;
  scope: "global" | "project";
  project_path: string;
  runtime: { kind: "remote" | "package"; index: number };
  values: Record<string, string>;
}

export const getMcpConnection = (url: string): Promise<McpConnection> => apiClient.post("/api/v1/extensions/mcp/connection", { url });
export const probeMcp = (url: string, headers: Record<string, string> = {}): Promise<McpConnection> => apiClient.post("/api/v1/extensions/mcp/probe", { url, headers });
export interface McpPackageProbe {
  id: string;
  status: "pending" | "complete" | "failed";
  server_info: McpServerInfo | null;
  tool_count: number | null;
  checked_at: number | null;
  error: string | null;
}
export interface McpPackageProbeInput {
  package: Record<string, unknown>;
  values: Record<string, string>;
}
export const probeMcpPackage = (input: McpPackageProbeInput): Promise<McpPackageProbe> => apiClient.post("/api/v1/extensions/mcp/package/probe", input);
export const getMcpPackageProbe = (id: string): Promise<McpPackageProbe> => apiClient.get(`/api/v1/extensions/mcp/package/probe/${encodeURIComponent(id)}`);
export const cancelMcpPackageProbe = (id: string): Promise<{ ok: boolean }> => apiClient.delete(`/api/v1/extensions/mcp/package/probe/${encodeURIComponent(id)}`);
export const authorizeMcp = (url: string, client_id?: string, client_secret?: string, callback_url?: string): Promise<McpAuthFlow> => apiClient.post("/api/v1/extensions/mcp/authorize", { url, client_id, client_secret, callback_url });
export const getMcpAuthFlow = (id: string): Promise<McpAuthFlow> => apiClient.get(`/api/v1/extensions/mcp/auth/${encodeURIComponent(id)}`);
export const cancelMcpAuth = (id: string): Promise<{ ok: boolean }> => apiClient.delete(`/api/v1/extensions/mcp/auth/${encodeURIComponent(id)}`);
export const finishMcpAuth = (id: string, callback_url: string): Promise<{ ok: boolean }> => apiClient.post(`/api/v1/extensions/mcp/auth/${encodeURIComponent(id)}/callback`, { callback_url });
export const disconnectMcp = (url: string): Promise<{ ok: boolean; warning: string | null }> => apiClient.post("/api/v1/extensions/mcp/disconnect", { url });
export const listMcpInstallations = (): Promise<McpInstallation[]> => apiClient.get("/api/v1/extensions/mcp/install");

export async function exploreExtensions(params?: { kind?: string; search?: string }): Promise<ExtensionArtifact[]> {
  const query = new URLSearchParams();
  if (params?.kind && params.kind !== "all") query.set("kind", params.kind);
  if (params?.search) query.set("search", params.search);
  return apiClient.get(`/api/v1/extensions/explore${query.size ? `?${query}` : ""}`);
}

export interface ManagedMcpServer {
  ok: boolean;
  source: string;
  repo_key: string;
  repo_path: string;
}

export async function createManagedMcp(manifest: Record<string, unknown>): Promise<ManagedMcpServer> {
  return apiClient.post("/api/v1/extensions/mcp", { manifest });
}

export async function installMcp(input: {
  repo_key: string;
  repo_path: string;
  scope: "global" | "project";
  project_path?: string;
  agent_ids: string[];
  runtime: { kind: "remote" | "package"; index: number };
  values: Record<string, string>;
}): Promise<{ ok: boolean }> {
  return apiClient.post("/api/v1/extensions/mcp/install", input);
}

export async function installCatalogPlugin(repo_key: string, repo_path: string): Promise<{ ok: boolean }> {
  const result = await apiClient.post<{ repo_key: string; repo_path: string }, { ok: boolean }>("/api/v1/extensions/plugin/install", { repo_key, repo_path });
  notifyPluginsChanged();
  return result;
}
