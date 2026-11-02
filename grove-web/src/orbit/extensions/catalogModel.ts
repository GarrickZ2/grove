import type { SkillSource } from "../../api";
import type { ExtensionArtifact, McpConnection } from "../../api/extensions";
import { connectionPresentation, needsMcpAgentSetup } from "../../components/Skills/mcpManagementState";
import { pluginAttentionReasons } from "../../components/Skills/pluginAttention";
import { MCP_ATTENTION_STATUSES, recordNeedsAttention, type CatalogRecord } from "../../components/Skills/useExtensionCatalog";
import { agoText } from "../ui/format";

/** "3h ago" since an ISO timestamp, or "Never". */
export function sinceText(iso: string | null | undefined, now: number): string {
  if (!iso) return "Never";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "Never" : agoText(at, now);
}

export type KindFilter = "all" | ExtensionArtifact["kind"];

export const KIND_LABEL: Record<ExtensionArtifact["kind"], string> = { mcp: "MCP", skill: "Skill", plugin: "Plugin" };
export const KIND_NOUN: Record<KindFilter, string> = { all: "extensions", mcp: "MCP servers", skill: "skills", plugin: "plugins" };

export interface CatalogGroups {
  attention: CatalogRecord[];
  installed: CatalogRecord[];
  available: CatalogRecord[];
}

export function filterRecords(records: CatalogRecord[], kind: KindFilter, search: string): CatalogRecord[] {
  const query = search.trim().toLowerCase();
  return records.filter(({ item }) => {
    if (kind !== "all" && item.kind !== kind) return false;
    return !query
      || item.name.toLowerCase().includes(query)
      || (typeof item.manifest?.name === "string" && item.manifest.name.toLowerCase().includes(query))
      || item.description.toLowerCase().includes(query)
      || item.source.toLowerCase().includes(query);
  });
}

export function isInstalledRecord({ item, plugin }: CatalogRecord): boolean {
  return !!plugin || item.install_status !== "not_installed";
}

/** Attention first (it blocks agents), then what's installed, then what a
 *  source offers but nothing uses yet. Each record lands in exactly one group. */
export function groupRecords(records: CatalogRecord[]): CatalogGroups {
  const groups: CatalogGroups = { attention: [], installed: [], available: [] };
  for (const record of records) {
    if (recordNeedsAttention(record)) groups.attention.push(record);
    else if (isInstalledRecord(record)) groups.installed.push(record);
    else groups.available.push(record);
  }
  return groups;
}

/** The connection that explains the record's state: a failing one if any. */
export function primaryConnection(item: ExtensionArtifact): McpConnection | null {
  return item.mcp_connections?.find((value) => (MCP_ATTENTION_STATUSES as readonly string[]).includes(value.status))
    ?? item.mcp_connections?.[0]
    ?? null;
}

/** Why a record is in "Needs attention", in the same words as Workbench. */
export function attentionText({ item, plugin }: CatalogRecord): string {
  const reasons = pluginAttentionReasons(plugin);
  if (reasons.length > 0) return reasons.join(" · ");
  const connection = primaryConnection(item);
  if (connection && (MCP_ATTENTION_STATUSES as readonly string[]).includes(connection.status)) {
    return connectionPresentation(connection).label;
  }
  if (needsMcpAgentSetup(item)) return "Not available to any agent yet";
  return "";
}

/** MCP bindings mix ACP agent ids with `buddy:<id>` targets. */
export function splitMcpTargets(ids: string[]): { agents: string[]; buddies: string[] } {
  const agents: string[] = [];
  const buddies: string[] = [];
  for (const id of ids) (id.startsWith("buddy:") ? buddies : agents).push(id);
  return { agents, buddies };
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Who can use it, for the list subtitle. */
export function accessText({ item, plugin }: CatalogRecord): string {
  if (item.kind === "plugin") {
    if (plugin?.source === "dev") return "Development";
    return plugin || item.install_status === "installed" ? "Installed" : "Not installed";
  }
  if (item.kind === "mcp") {
    const { agents, buddies } = splitMcpTargets(item.installed_agents);
    if (agents.length === 0 && buddies.length === 0) return "No agents";
    const buddyText = buddies.length === 1 ? "1 Buddy" : `${buddies.length} Buddies`;
    return [agents.length ? plural(agents.length, "agent") : "", buddies.length ? buddyText : ""].filter(Boolean).join(" · ");
  }
  const count = item.installed_agents.length;
  return count === 0 ? "Not installed" : `${plural(count, "agent")}${item.install_status === "partial" ? " · partial" : ""}`;
}

export function versionText(item: ExtensionArtifact, plugin?: CatalogRecord["plugin"]): string | null {
  const version = plugin?.version || item.version;
  return version && version !== "unknown" ? `v${version}` : null;
}

export interface McpEndpoint {
  kind: "remote" | "package";
  label: string;
}

/** First declared runtime: a remote URL or a package (registry · identifier). */
export function mcpEndpoint(item: ExtensionArtifact): McpEndpoint | null {
  const manifest = item.manifest ?? {};
  const remotes = Array.isArray(manifest.remotes) ? (manifest.remotes as Record<string, unknown>[]) : [];
  const packages = Array.isArray(manifest.packages) ? (manifest.packages as Record<string, unknown>[]) : [];
  if (remotes[0] && typeof remotes[0].url === "string") return { kind: "remote", label: remotes[0].url };
  if (packages[0]) {
    const registry = typeof packages[0].registryType === "string" ? packages[0].registryType : "package";
    const identifier = typeof packages[0].identifier === "string" ? packages[0].identifier : "";
    return { kind: "package", label: identifier ? `${registry} · ${identifier}` : registry };
  }
  return null;
}

/** Keep the current selection while it's visible; otherwise the first row. */
export function resolveSelection<T>(ordered: T[], key: string | null, keyOf: (entry: T) => string): T | null {
  if (ordered.length === 0) return null;
  return ordered.find((record) => keyOf(record) === key) ?? ordered[0];
}

/** Catalog records grouped by the source that provides them. */
export function recordsBySource(records: CatalogRecord[]): Map<string, CatalogRecord[]> {
  const map = new Map<string, CatalogRecord[]>();
  for (const record of records) {
    const list = map.get(record.item.source);
    if (list) list.push(record);
    else map.set(record.item.source, [record]);
  }
  return map;
}

const HUES: Array<[string, string]> = [
  ["#f9a8d4", "#9d174d"], ["#93c5fd", "#1e40af"], ["#86efac", "#166534"], ["#fdba74", "#c2410c"],
  ["#c4b5fd", "#5b21b6"], ["#5eead4", "#0f766e"], ["#fcd34d", "#b45309"], ["#a5b4fc", "#4338ca"],
];

/** Stable identity tint from the name: decoration only, carries no data. */
export function identityHue(name: string): { from: string; to: string } {
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  const [from, to] = HUES[hash % HUES.length];
  return { from, to };
}

/** What a source contributed, e.g. "2 skills · 1 MCP server". */
export function contentSummary(source: SkillSource): string {
  const parts: string[] = [];
  if (source.skill_count) parts.push(`${source.skill_count} skill${source.skill_count === 1 ? "" : "s"}`);
  if (source.plugin_count) parts.push(`${source.plugin_count} plugin${source.plugin_count === 1 ? "" : "s"}`);
  if (source.mcp_count) parts.push(`${source.mcp_count} MCP server${source.mcp_count === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Nothing found yet";
}
