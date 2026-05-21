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

export interface NpxDistribution {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface UvxDistribution {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BinaryTarget {
  archive: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DistributionView {
  npx?: NpxDistribution | null;
  uvx?: UvxDistribution | null;
  binary?: Record<string, BinaryTarget>;
}

export interface ProbeView {
  terminal_check: string | null;
  acp_check: string | null;
  acp_fallback: string | null;
  npx_package: string | null;
  results: Record<string, boolean>;
}

export interface TerminalProfileView {
  base_command: string;
  fresh_args: string[];
  resume_args: string[];
  resume_check_pattern: string;
}

export interface InstalledAgentView {
  version: string;
  install_method: InstallMethod;
  status: InstallStatus;
  failure_reason: string | null;
  args_override: string[];
  env_override: Record<string, string>;
  launch_mode: string;
  hidden: boolean;
}

export interface MarketplaceAgent {
  id: string;
  legacy_aliases: string[];
  name: string;
  description: string;
  icon_id: string | null;
  icon_url: string | null;
  version: string | null;
  repository: string | null;
  website: string | null;
  authors: string[];
  license: string | null;
  source: "registry" | "supplement-only";
  distribution: DistributionView | null;
  supported_launch_modes: string[];
  install_state: InstallState;
  probe: ProbeView;
  terminal_profile: TerminalProfileView | null;
  installed: InstalledAgentView | null;
  /** Effective launch mode from Config.agent_launch_modes — works for any
   *  agent, including auto-detected (no install row required). */
  launch_mode: string;
}

export interface MarketplaceResponse {
  agents: MarketplaceAgent[];
  registry_fetched_at: string | null;
  registry_stale: boolean;
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

export async function installAgent(
  id: string,
  method?: InstallMethod,
): Promise<{ agent: InstalledAgentView }> {
  return apiClient.post<{ method?: InstallMethod }, { agent: InstalledAgentView }>(
    `/api/v1/agents/marketplace/${encodeURIComponent(id)}/install`,
    method ? { method } : {},
  );
}

export async function uninstallAgent(id: string): Promise<void> {
  await apiClient.delete<void>(
    `/api/v1/agents/marketplace/${encodeURIComponent(id)}/install`,
  );
}

export interface PatchAgentRequest {
  args_override?: string[];
  env_override?: Record<string, string>;
  launch_mode?: string;
  hidden?: boolean;
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
