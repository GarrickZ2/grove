import type { InstallMethod, MarketplaceResponse } from "../../api/marketplace";

export interface MissingRuntime {
  name: string;
  installLabel: string;
  url: string;
  /** Installed Agents that can't start without it. */
  agents: string[];
}

const RUNTIMES = [
  { method: "npx", available: "npx_available", name: "Node.js", installLabel: "Install Node.js", url: "https://nodejs.org/" },
  { method: "uvx", available: "uvx_available", name: "uv", installLabel: "Install uv", url: "https://docs.astral.sh/uv/getting-started/installation/" },
] as const satisfies readonly { method: InstallMethod; available: keyof MarketplaceResponse; name: string; installLabel: string; url: string }[];

/** Runtimes that visible installed Agents launch through and this machine doesn't have. */
export function missingRuntimes(data: MarketplaceResponse): MissingRuntime[] {
  return RUNTIMES.flatMap(({ method, available, name, installLabel, url }) => {
    if (data[available]) return [];
    const agents = data.agents
      .filter((agent) => agent.installed && !agent.installed.hidden && agent.installed.selected_install_method === method)
      .map((agent) => agent.name);
    return agents.length > 0 ? [{ name, installLabel, url, agents }] : [];
  });
}
