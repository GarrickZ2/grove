/**
 * Agent marketplace API client.
 *
 * Endpoints mirror src/api/handlers/marketplace.rs. All shapes are kept in
 * sync with the Rust serde-derived structs — when adding a field there, add
 * it here too (the frontend will silently ignore unknown fields but old code
 * may rely on absent fields).
 */

import { apiClient } from "./client";

export type InstallMethod = "npx" | "binary" | "uvx" | "external";
export type InstallStatus = "installing" | "installed" | "failed";
export type InstallState =
  | "auto-detected"
  | "grove-installed"
  | "installing"
  | "install-failed"
  | "not-installed";

export interface Installation {
  method: InstallMethod;
  version: string;
  install_path: string | null;
  status: InstallStatus;
  failure_reason: string | null;
  /** RFC3339 timestamp. */
  installed_at: string;
}

export interface InstalledAgentView {
  installations: Installation[];
  selected_install_method: InstallMethod;
  args_override: string[];
  env_override: Record<string, string>;
  hidden: boolean;
}

/** Concrete executable grove would spawn for this agent. */
export interface BinaryView {
  /** Head command (`traecli`, `claude`, ...). */
  command: string;
  /** Absolute path from PATH lookup. Null if the binary was on PATH at
   *  probe time but disappeared by the time we resolved it. */
  path: string | null;
  /** Version string for grove-installed channels (npx/binary/uvx). For
   *  auto-detected External installs this is always empty by design —
   *  probing `--version` per detected binary was too slow on the
   *  Marketplace hot path. */
  version: string | null;
}

export interface MarketplaceAgent {
  id: string;
  name: string;
  description: string;
  /** Latest version from registry; null for synthetic Trae/TraeX. */
  version: string | null;
  repository: string | null;
  website: string | null;
  authors: string[];
  license: string | null;
  /** CDN icon URL (registry-provided) or grove-served asset URL for synthetic agents. */
  icon_url: string | null;
  /** Install methods exposed by the registry distribution. */
  available_install_methods: InstallMethod[];
  /** True if this agent's registry entry declares a terminal_launch
   *  config — picking External will spawn it via PTY. */
  supports_terminal_launch: boolean;
  install_state: InstallState;
  installed: InstalledAgentView | null;
  binary: BinaryView | null;
}

export interface MarketplaceResponse {
  agents: MarketplaceAgent[];
  registry_fetched_at: string | null;
  registry_stale: boolean;
  /** Curated agent ids (kept for backward compatibility — backend now seeds
   *  curated agents into `installed_agents` so they show up in Installed
   *  tab naturally). */
  curated: string[];
}

export interface PatchAgentRequest {
  selected_install_method?: InstallMethod;
  args_override?: string[];
  env_override?: Record<string, string>;
  hidden?: boolean;
}

export async function listMarketplace(): Promise<MarketplaceResponse> {
  return apiClient.get<MarketplaceResponse>("/api/v1/agents/marketplace");
}

export async function refreshRegistry(): Promise<MarketplaceResponse> {
  return apiClient.post<unknown, MarketplaceResponse>(
    "/api/v1/agents/marketplace/refresh",
    {},
  );
}

/** Install ONE channel for an agent. The same agent may be installed via
 *  multiple methods — installing one channel does not remove others. */
export async function installAgent(
  id: string,
  method: InstallMethod,
): Promise<{ agent: InstalledAgentView }> {
  return apiClient.post<{ method: InstallMethod }, { agent: InstalledAgentView }>(
    `/api/v1/agents/marketplace/${encodeURIComponent(id)}/install`,
    { method },
  );
}

/** Uninstall ONE channel by method. Backend deletes the whole agent row
 *  when the last remaining channel is removed. */
export async function uninstallAgent(
  id: string,
  method: InstallMethod,
): Promise<void> {
  await apiClient.delete<void>(
    `/api/v1/agents/marketplace/${encodeURIComponent(id)}/install?method=${encodeURIComponent(method)}`,
  );
}

export async function patchAgent(
  id: string,
  body: PatchAgentRequest,
): Promise<InstalledAgentView> {
  return apiClient.patch<PatchAgentRequest, InstalledAgentView>(
    `/api/v1/agents/marketplace/${encodeURIComponent(id)}`,
    body,
  );
}
