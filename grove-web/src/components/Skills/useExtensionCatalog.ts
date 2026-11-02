import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentCatalogRevision } from "../../hooks/useAgentCatalogRevision";
import { exploreExtensions, installCatalogPlugin } from "../../api/extensions";
import { listInstalledAgentConfigs, type InstalledAgentConfig } from "../../api/marketplace";
import { listPlugins, type Plugin } from "../../api/plugins";
import type { ExtensionArtifact, SkillSource } from "../../api";
import { resolveInstalledPlugin } from "./installedPlugin";
import { pluginAttentionReasons } from "./pluginAttention";
import { needsMcpAgentSetup } from "./mcpManagementState";

export type CatalogView = "all" | "installed" | "available" | "development" | "attention";

export interface CatalogRecord {
  item: ExtensionArtifact;
  plugin?: Plugin;
}

export const MCP_ATTENTION_STATUSES = ["auth_required", "expired", "error"] as const;

/** Same conditions as the "Needs attention" view. */
export function recordNeedsAttention({ item, plugin }: CatalogRecord): boolean {
  return needsMcpAgentSetup(item)
    || !!item.mcp_connections?.some((connection) => (MCP_ATTENTION_STATUSES as readonly string[]).includes(connection.status))
    || pluginAttentionReasons(plugin).length > 0;
}

export function catalogRecordKey({ item }: CatalogRecord): string {
  return `${item.kind}/${item.repo_key}/${item.repo_path}`;
}

/** Catalog artifacts + the installed plugins and ACP agents they resolve
 *  against. Shared by the Workbench and Orbit Extensions pages. */
export function useExtensionCatalog({ sources, refreshToken }: { sources: SkillSource[]; refreshToken: number }) {
  const catalogRevision = useAgentCatalogRevision();
  const [items, setItems] = useState<ExtensionArtifact[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [agentOptions, setAgentOptions] = useState<InstalledAgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /** `silent` refreshes in place (no loading state), e.g. after an inline save. */
  const reload = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    setError(null);
    try {
      const [artifacts, installedAgents, installedPlugins] = await Promise.all([
        exploreExtensions(),
        listInstalledAgentConfigs(),
        listPlugins(),
      ]);
      setItems(artifacts);
      setAgentOptions(installedAgents);
      setPlugins(installedPlugins);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load extensions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => reload()); }, [reload, refreshToken, catalogRevision]);

  const records = useMemo<CatalogRecord[]>(() => items.map((item) => {
    const plugin = resolveInstalledPlugin(item, plugins);
    return { item, plugin };
  }), [items, plugins]);

  const sourcesByName = useMemo(() => new Map(sources.map((source) => [source.name, source])), [sources]);
  const matchesView = useCallback((record: CatalogRecord, target: CatalogView) => {
    const { item, plugin } = record;
    if (target === "all") return true;
    if (target === "installed") return item.install_status !== "not_installed";
    if (target === "available") return item.install_status === "not_installed";
    if (target === "development") return plugin?.source === "dev" || sourcesByName.get(item.source)?.management_mode === "development";
    return recordNeedsAttention(record);
  }, [sourcesByName]);

  const installPlugin = useCallback(async (item: ExtensionArtifact) => {
    const key = `${item.repo_key}/${item.repo_path}`;
    setBusyKey(key);
    try { await installCatalogPlugin(item.repo_key, item.repo_path); await reload(); }
    finally { setBusyKey(null); }
  }, [reload]);

  return { items, plugins, agentOptions, loading, error, reload, records, sourcesByName, matchesView, installPlugin, busyKey };
}
