import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, FolderOpen, GitBranch, Plus, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { Button, Combobox, DialogShell, DrawerShell } from "../ui";
import { SkillDetailPanel } from "./SkillDetailPanel";
import { PluginDetailDialog } from "../Config/PluginDetailDialog";
import { createManagedMcp, exploreExtensions, installCatalogPlugin, installMcp } from "../../api/extensions";
import { listInstalledAgentConfigs, type InstalledAgentConfig } from "../../api/marketplace";
import { listPlugins, type Plugin } from "../../api/plugins";
import type { AgentDef, ExtensionArtifact, InstalledSkill, SkillSource } from "../../api";
import {
  ExtensionTypeIcon,
  StatusBadge,
  TableEmpty,
  TableFrame,
} from "./ExtensionTable";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { AgentIcon } from "./AgentIcon";
import { ExtensionIdentityIcon } from "./ExtensionIdentityIcon";
import { resolveInstalledPlugin } from "./installedPlugin";
import { useIsMobile } from "../../hooks/useIsMobile";

type InstallationFilter = "installed" | "partial" | "not_installed";
type CatalogView = "all" | "installed" | "available" | "development" | "attention";

interface CatalogRecord {
  item: ExtensionArtifact;
  plugin?: Plugin;
}

interface Props {
  agents: AgentDef[];
  sources: SkillSource[];
  installed: InstalledSkill[];
  projectPath: string | null;
  refreshToken: number;
  onInstalled: () => Promise<void>;
}

export function ExtensionsExplore({ agents, sources, installed, projectPath, refreshToken, onInstalled }: Props) {
  const { isMobile } = useIsMobile();
  const [items, setItems] = useState<ExtensionArtifact[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [agentOptions, setAgentOptions] = useState<InstalledAgentConfig[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [sourceNames, setSourceNames] = useState<string[]>([]);
  const [installations, setInstallations] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [view, setView] = useState<CatalogView>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const tableBodyRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<{ source: string; name: string } | null>(null);
  const [selectedMcp, setSelectedMcp] = useState<ExtensionArtifact | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null);
  const [selectedPluginArtifact, setSelectedPluginArtifact] = useState<ExtensionArtifact | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
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

  useEffect(() => { void Promise.resolve().then(reload); }, [reload, refreshToken]);

  const records = useMemo<CatalogRecord[]>(() => items.map((item) => {
    const plugin = resolveInstalledPlugin(item, plugins);
    return { item, plugin };
  }), [items, plugins]);

  const sourcesByName = useMemo(() => new Map(sources.map((source) => [source.name, source])), [sources]);
  const matchesView = useCallback(({ item, plugin }: CatalogRecord, target: CatalogView) => {
    if (target === "all") return true;
    if (target === "installed") return item.install_status !== "not_installed";
    if (target === "available") return item.install_status === "not_installed";
    if (target === "development") return plugin?.source === "dev" || sourcesByName.get(item.source)?.management_mode === "development";
    return !!plugin && (plugin.exists === false || plugin.built === false || plugin.runtime?.available === false || plugin.sdk_status === "outdated" || plugin.sdk_status === "missing");
  }, [sourcesByName]);

  const views = useMemo(() => ([
    { id: "all" as const, label: "All extensions", count: records.length },
    { id: "installed" as const, label: "Installed", count: records.filter((record) => matchesView(record, "installed")).length },
    { id: "available" as const, label: "Available", count: records.filter((record) => matchesView(record, "available")).length },
    { id: "development" as const, label: "Development", count: records.filter((record) => matchesView(record, "development")).length },
    { id: "attention" as const, label: "Needs attention", count: records.filter((record) => matchesView(record, "attention")).length },
  ]), [matchesView, records]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return records.filter((record) => {
      const { item } = record;
      if (!matchesView(record, view)) return false;
      if (kinds.length > 0 && !kinds.includes(item.kind)) return false;
      if (sourceNames.length > 0 && !sourceNames.includes(item.source)) return false;
      if (installations.length > 0 && !installations.includes(item.install_status)) return false;
      if (agentIds.length > 0 && !item.installed_agents.some((id) => agentIds.includes(id))) return false;
      return !query
        || item.name.toLowerCase().includes(query)
        || item.description.toLowerCase().includes(query)
        || item.source.toLowerCase().includes(query);
    });
  }, [agentIds, installations, kinds, matchesView, records, search, sourceNames, view]);

  useEffect(() => {
    const node = tableBodyRef.current;
    if (!node) return;
    const updatePageSize = () => setPageSize(isMobile ? 10 : Math.max(1, Math.floor(node.clientHeight / 64)));
    updatePageSize();
    const observer = new ResizeObserver(updatePageSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobile]);

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = visible.slice((safePage - 1) * pageSize, safePage * pageSize);
  const rangeStart = visible.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, visible.length);

  const installPlugin = async (item: ExtensionArtifact) => {
    const key = `${item.repo_key}/${item.repo_path}`;
    setBusyKey(key);
    try { await installCatalogPlugin(item.repo_key, item.repo_path); await reload(); }
    finally { setBusyKey(null); }
  };

  const openRecord = ({ item, plugin }: CatalogRecord) => {
    if (item.kind === "skill") {
      setSelectedSkill({ source: item.source, name: item.name });
      return;
    }
    if (item.kind === "plugin") {
      if (plugin) setSelectedPlugin(plugin);
      else setSelectedPluginArtifact(item);
      return;
    }
    setSelectedMcp(item);
  };

  const updateFilter = (setter: (values: string[]) => void) => (values: string[]) => { setter(values); setPage(1); };
  const activeFilterCount = kinds.length + sourceNames.length + installations.length + agentIds.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search by name or description"
            className="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] pl-9 pr-3 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-highlight)]" />
        </div>
        <button type="button" onClick={() => setShowMobileFilters((current) => !current)} className={`inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm sm:hidden ${activeFilterCount > 0 ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}><SlidersHorizontal className="h-4 w-4" />Filters{activeFilterCount > 0 && <span className="rounded-full bg-[var(--color-highlight)] px-1.5 py-0.5 text-[10px] text-white">{activeFilterCount}</span>}</button>
        <div className={`${showMobileFilters ? "col-span-2 grid" : "hidden"} grid-cols-2 gap-2 sm:flex sm:items-center`}>
        <MultiSelectFilter label="Type" selected={kinds} onChange={updateFilter(setKinds)} options={[
          { value: "skill", label: "Skills", icon: <ExtensionTypeIcon kind="skill" compact />, count: records.filter(({ item }) => item.kind === "skill").length },
          { value: "plugin", label: "Plugins", icon: <ExtensionTypeIcon kind="plugin" compact />, count: records.filter(({ item }) => item.kind === "plugin").length },
          { value: "mcp", label: "MCP Servers", icon: <ExtensionTypeIcon kind="mcp" compact />, count: records.filter(({ item }) => item.kind === "mcp").length },
        ]} />
        <MultiSelectFilter label="Source" selected={sourceNames} onChange={updateFilter(setSourceNames)} options={sources.map((source) => ({ value: source.name, label: sourceDisplayLabel(source.name), description: source.url, icon: source.source_type === "git" ? <GitBranch className="h-4 w-4 text-[var(--color-info)]" /> : <FolderOpen className="h-4 w-4 text-[var(--color-warning)]" />, count: source.skill_count + source.plugin_count + source.mcp_count }))} />
        <MultiSelectFilter label="Installation" selected={installations} onChange={updateFilter(setInstallations)} options={[
          { value: "installed", label: "Installed" },
          { value: "partial", label: "Partially installed" },
          { value: "not_installed", label: "Not installed" },
        ] satisfies Array<{ value: InstallationFilter; label: string }>} />
        <MultiSelectFilter label="Agent" selected={agentIds} onChange={updateFilter(setAgentIds)} options={agents.map((agent) => ({ value: agent.id, label: agent.display_name, description: agent.id, icon: <AgentIcon iconId={agent.icon_id} size={18} /> }))} />
        </div>
        <span className="ml-auto hidden whitespace-nowrap text-xs tabular-nums text-[var(--color-text-muted)] sm:inline">{visible.length.toLocaleString()} results</span>
      </div>

      {activeFilterCount > 0 && <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs"><span className="mr-1 text-[var(--color-text-muted)]">Filtered by</span>{[
        ...kinds.map((value) => ({ key: `kind:${value}`, label: value === "mcp" ? "MCP" : `${value[0].toUpperCase()}${value.slice(1)}`, clear: () => updateFilter(setKinds)(kinds.filter((item) => item !== value)) })),
        ...sourceNames.map((value) => ({ key: `source:${value}`, label: sourceDisplayLabel(value), clear: () => updateFilter(setSourceNames)(sourceNames.filter((item) => item !== value)) })),
        ...installations.map((value) => ({ key: `installation:${value}`, label: value === "not_installed" ? "Not installed" : value === "partial" ? "Partially installed" : "Installed", clear: () => updateFilter(setInstallations)(installations.filter((item) => item !== value)) })),
        ...agentIds.map((value) => ({ key: `agent:${value}`, label: agents.find((agent) => agent.id === value)?.display_name ?? value, clear: () => updateFilter(setAgentIds)(agentIds.filter((item) => item !== value)) })),
      ].map((filter) => <button key={filter.key} type="button" onClick={filter.clear} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-secondary)] px-2 py-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">{filter.label}<X className="h-3 w-3" /></button>)}<button type="button" onClick={() => { setKinds([]); setSourceNames([]); setInstallations([]); setAgentIds([]); setPage(1); }} className="ml-1 text-[var(--color-highlight)] hover:underline">Clear all</button></div>}

      {error && <div className="mb-3 flex items-center gap-2 rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/8 px-3 py-2 text-sm text-[var(--color-error)]"><AlertTriangle className="h-4 w-4" /><span className="flex-1">{error}</span><Button variant="ghost" size="sm" onClick={() => void reload()}>Retry</Button></div>}

      <div className="mb-3 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">{views.map((item) => <button key={item.id} type="button" onClick={() => { setView(item.id); setPage(1); }} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium ${view === item.id ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]"}`}>{item.label} <span className="ml-1 tabular-nums opacity-70">{item.count}</span></button>)}</div>

      <TableFrame facets={<CatalogViewRail views={views} active={view} onChange={(next) => { setView(next); setPage(1); }} />}>
        <CatalogHeader />
        <div ref={tableBodyRef} className="min-h-0 flex-1 overflow-visible md:overflow-hidden">
          {loading ? <CatalogSkeleton /> : pageItems.length === 0 ? <TableEmpty title="No extensions found" description="Try another search or clear a filter." /> : pageItems.map((record) => {
            const key = `${record.item.kind}/${record.item.repo_key}/${record.item.repo_path}`;
            return <CatalogRow key={key} record={record} onOpen={() => openRecord(record)} />;
          })}
        </div>
        {pageCount > 1 && <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
          <span className="tabular-nums">{rangeStart}–{rangeEnd} of {visible.length.toLocaleString()}</span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Previous page" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-[var(--color-border)] p-1.5 hover:bg-[var(--color-bg-secondary)] disabled:opacity-35"><ChevronLeft className="h-4 w-4" /></button>
            <span className="min-w-14 text-center tabular-nums">{safePage} / {pageCount}</span>
            <button type="button" aria-label="Next page" disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} className="rounded-lg border border-[var(--color-border)] p-1.5 hover:bg-[var(--color-bg-secondary)] disabled:opacity-35"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>}
      </TableFrame>

      <SkillDetailPanel selectedSkill={selectedSkill} agents={agents} installed={installed} projectPath={projectPath}
        onClose={() => setSelectedSkill(null)} onInstalled={async () => { await onInstalled(); await reload(); }} />
      {selectedMcp && <McpInstallDialog artifact={selectedMcp} agents={agentOptions} projectPath={projectPath}
        onClose={() => setSelectedMcp(null)} onSaved={async () => { setSelectedMcp(null); await reload(); }} />}
      {selectedPlugin && <PluginDetailDialog plugin={selectedPlugin} onClose={() => setSelectedPlugin(null)} onDeleted={async () => { setSelectedPlugin(null); await onInstalled(); await reload(); }} />}
      {selectedPluginArtifact && <PluginArtifactDrawer item={selectedPluginArtifact} busy={busyKey === `${selectedPluginArtifact.repo_key}/${selectedPluginArtifact.repo_path}`} onClose={() => setSelectedPluginArtifact(null)} onInstall={async () => { await installPlugin(selectedPluginArtifact); setSelectedPluginArtifact(null); }} />}
    </div>
  );
}

function deployment(item: ExtensionArtifact, plugin?: Plugin): { label: string; tone: "success" | "warning" | "info" | "neutral" } {
  if (item.kind === "plugin") {
    if (plugin?.source === "dev") return { label: "Development", tone: "info" };
    return plugin || item.install_status === "installed" ? { label: "Installed", tone: "success" } : { label: "Not installed", tone: "neutral" };
  }
  const count = item.installed_agents.length;
  if (count > 0) return { label: `${count} ${item.kind === "mcp" ? "binding" : "install"}${count === 1 ? "" : "s"}`, tone: item.install_status === "partial" ? "warning" : item.kind === "mcp" ? "info" : "success" };
  return { label: item.kind === "mcp" ? "Not configured" : "Not installed", tone: "neutral" };
}

function CatalogHeader() {
  return <div className="hidden shrink-0 grid-cols-[minmax(360px,1fr)_150px_28px] items-center gap-5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] md:grid lg:grid-cols-[minmax(420px,1fr)_minmax(220px,320px)_150px_28px]">
    <span>Extension</span><span className="hidden lg:block">Source</span><span>Installation</span><span />
  </div>;
}

function CatalogRow({ record, onOpen }: { record: CatalogRecord; onOpen: () => void }) {
  const { item, plugin } = record;
  const deployed = deployment(item, plugin);
  return <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} className="group relative grid min-h-28 cursor-pointer grid-cols-1 gap-3 border-b border-[var(--color-border)] px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-[var(--color-bg-secondary)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-highlight)] md:h-16 md:min-h-0 md:grid-cols-[minmax(360px,1fr)_150px_28px] md:items-center md:gap-5 md:px-5 md:py-2 lg:grid-cols-[minmax(420px,1fr)_minmax(220px,320px)_150px_28px]">
    <div className="flex min-w-0 items-start gap-3 md:items-center"><ExtensionIdentityIcon kind={item.kind} name={item.name} manifest={item.manifest} plugin={plugin} /><div className="min-w-0 flex-1 pr-6 md:pr-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><span className="max-w-full truncate text-sm font-semibold text-[var(--color-text)]">{item.name}</span><TypeLabel kind={item.kind} />{item.version && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">v{item.version}</span>}</div><p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-[var(--color-text-muted)] md:mt-0.5 md:truncate">{item.description || "No description provided"}</p><p className="mt-1 max-w-full truncate font-mono text-[10px] text-[var(--color-text-muted)] lg:hidden">{item.source}{item.relative_path ? ` · ${item.relative_path}` : ""}</p></div></div>
    <div className="hidden min-w-0 lg:block"><div className="truncate text-sm font-medium text-[var(--color-text)]">{sourceDisplayLabel(item.source, plugin)}</div><div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{item.relative_path || item.repo_path || plugin?.local_path}</div></div>
    <div className="ml-12 md:ml-0"><StatusBadge label={deployed.label} tone={deployed.tone} /></div>
    <ChevronRight className="absolute right-4 top-5 h-4 w-4 text-[var(--color-text-muted)] opacity-60 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 md:static" />
  </div>;
}

function CatalogViewRail({ views, active, onChange }: { views: Array<{ id: CatalogView; label: string; count: number }>; active: CatalogView; onChange: (view: CatalogView) => void }) {
  return <aside className="hidden w-44 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 px-3 py-3 lg:block"><div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Views</div><div className="space-y-0.5">{views.map((item) => <button key={item.id} type="button" onClick={() => onChange(item.id)} className={`relative flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${active === item.id ? "bg-[var(--color-bg)] font-medium text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]/70 hover:text-[var(--color-text)]"}`}>{active === item.id && <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-[var(--color-highlight)]" />}<span className="truncate">{item.label}</span><span className="ml-2 text-xs tabular-nums text-[var(--color-text-muted)]">{item.count}</span></button>)}</div></aside>;
}

function CatalogSkeleton() {
  return <div>{Array.from({ length: 7 }).map((_, index) => <div key={index} className="grid min-h-28 animate-pulse grid-cols-1 gap-3 border-b border-[var(--color-border)] px-4 py-4 md:h-16 md:min-h-0 md:grid-cols-[minmax(360px,1fr)_150px_28px] md:items-center md:gap-5 md:px-5 md:py-2 lg:grid-cols-[minmax(420px,1fr)_minmax(220px,320px)_150px_28px]"><div className="flex items-start gap-3"><div className="h-9 w-9 shrink-0 rounded-lg bg-[var(--color-bg-secondary)]" /><div className="min-w-0 flex-1 space-y-2"><div className="h-3 w-36 max-w-full rounded bg-[var(--color-bg-secondary)]" /><div className="h-2.5 w-full rounded bg-[var(--color-bg-secondary)]" /><div className="h-2.5 w-2/3 rounded bg-[var(--color-bg-secondary)]" /></div></div><div className="hidden h-3 w-28 rounded bg-[var(--color-bg-secondary)] lg:block" /><div className="ml-12 h-6 w-24 rounded-full bg-[var(--color-bg-secondary)] md:ml-0" /></div>)}</div>;
}

function TypeLabel({ kind }: { kind: ExtensionArtifact["kind"] }) {
  const style = kind === "skill" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : kind === "plugin" ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${style}`}>{kind === "mcp" ? "MCP" : kind[0].toUpperCase() + kind.slice(1)}</span>;
}

function sourceDisplayLabel(source: string, plugin?: Plugin) {
  if (!source.startsWith("plugin:")) return source;
  if (plugin?.source === "dev") return "Local development";
  return "Installed plugin";
}

function PluginArtifactDrawer({ item, busy, onClose, onInstall }: { item: ExtensionArtifact; busy: boolean; onClose: () => void; onInstall: () => void }) {
  const contributes = Object.keys((item.manifest?.contributes ?? {}) as Record<string, unknown>);
  const permissions = Array.isArray(item.manifest?.permissions) ? item.manifest.permissions as string[] : [];
  return <DrawerShell isOpen onClose={onClose}><div className="flex h-full flex-col"><div className="flex items-start justify-between border-b border-[var(--color-border)] px-5 py-4"><div className="flex items-center gap-3"><ExtensionIdentityIcon kind="plugin" name={item.name} manifest={item.manifest} /><div><h2 className="text-base font-semibold">{item.name}</h2><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Plugin · {item.version ? `v${item.version}` : "Unversioned"}</p></div></div><button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]"><X className="h-4 w-4" /></button></div><div className="flex-1 overflow-y-auto px-5 py-5"><p className="text-sm leading-6 text-[var(--color-text-muted)]">{item.description || "Grove application extension"}</p><section className="mt-5 border-t border-[var(--color-border)] pt-4"><h3 className="text-sm font-semibold">Source</h3><p className="mt-2 text-sm">{item.source}</p><p className="mt-1 break-all font-mono text-xs text-[var(--color-text-muted)]">{item.repo_path}</p></section><section className="mt-5 border-t border-[var(--color-border)] pt-4"><h3 className="text-sm font-semibold">Capabilities</h3><p className="mt-2 text-sm text-[var(--color-text-muted)]">{contributes.length > 0 ? contributes.join(", ") : "No contributions declared"}</p></section><section className="mt-5 border-t border-[var(--color-border)] pt-4"><h3 className="text-sm font-semibold">Permissions</h3><p className="mt-2 text-sm text-[var(--color-text-muted)]">{permissions.length > 0 ? permissions.join(", ") : "No permissions requested"}</p></section></div><div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-5 py-4"><span className="text-xs text-[var(--color-text-muted)]">Not installed</span><Button variant="primary" onClick={onInstall} disabled={busy}><Download className="mr-1.5 h-4 w-4" />{busy ? "Installing…" : "Install Plugin"}</Button></div></div></DrawerShell>;
}

function McpInstallDialog({ artifact, agents, projectPath, onClose, onSaved }: { artifact: ExtensionArtifact; agents: InstalledAgentConfig[]; projectPath: string | null; onClose: () => void; onSaved: () => void }) {
  const manifest = artifact.manifest ?? {};
  const remotes = Array.isArray(manifest.remotes) ? manifest.remotes as Record<string, unknown>[] : [];
  const packages = Array.isArray(manifest.packages) ? manifest.packages as Record<string, unknown>[] : [];
  const variants = [...remotes.map((value, index) => ({ kind: "remote" as const, index, label: `${String(value.type ?? "HTTP")} · ${String(value.url ?? "")}`, value })), ...packages.map((value, index) => ({ kind: "package" as const, index, label: `${String(value.registryType ?? "package")} · ${String(value.identifier ?? "")}`, value }))];
  const [variantIndex, setVariantIndex] = useState(0);
  const [selectedAgents, setSelectedAgents] = useState<string[]>(artifact.installed_agents);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const variant = variants[variantIndex];
  const definitions = variant?.kind === "remote"
    ? (Array.isArray(variant.value.headers) ? variant.value.headers : [])
    : (Array.isArray(variant?.value.environmentVariables) ? variant.value.environmentVariables : []);
  return <DrawerShell isOpen onClose={onClose} width="w-full sm:w-[640px]"><div className="flex h-full flex-col">
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4"><div className="flex min-w-0 items-center gap-3"><ExtensionIdentityIcon kind="mcp" name={artifact.name} manifest={artifact.manifest} /><div className="min-w-0"><h2 className="truncate text-base font-semibold">{artifact.name}</h2><p className="mt-1 text-xs text-[var(--color-text-muted)]">Configure runtime and Agent bindings</p></div></div><button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"><X className="h-4 w-4" /></button></div>
    <div className="flex-1 overflow-y-auto px-5 py-4">
    <label className="mb-1 block text-xs font-medium">Runtime</label><div className="mb-4"><Combobox allowCustom={false} value={String(variantIndex)} onChange={(value) => setVariantIndex(Number(value))} options={variants.map((option, index) => ({ id: `${option.kind}-${option.index}`, value: String(index), label: option.label }))} /></div>
    {definitions.map((definition, index) => { const value = definition as Record<string, unknown>; const name = String(value.name ?? `value-${index}`); return <label key={name} className="mb-3 block text-xs"><span className="mb-1 block">{name}{value.isRequired === true && " *"}</span><input type={value.isSecret === true ? "password" : "text"} value={values[name] ?? ""} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value }))} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm" /></label>; })}
    <div className="mb-4"><span className="mb-2 block text-xs font-medium">ACP Agents</span><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{agents.map((agent) => <label key={agent.id} className="flex items-center gap-2 rounded border border-[var(--color-border)] p-2 text-xs"><input type="checkbox" checked={selectedAgents.includes(agent.id)} onChange={() => setSelectedAgents((old) => old.includes(agent.id) ? old.filter((id) => id !== agent.id) : [...old, agent.id])} />{agent.name}</label>)}</div></div>
    <div className="mb-5 flex gap-3 text-xs"><label><input type="radio" checked={scope === "global"} onChange={() => setScope("global")} /> Global</label><label className={!projectPath ? "opacity-40" : ""}><input type="radio" disabled={!projectPath} checked={scope === "project"} onChange={() => setScope("project")} /> Current Project</label></div>
    </div>
    <div className="flex justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-5 py-4"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving || !variant} onClick={async () => { if (!variant) return; setSaving(true); try { await installMcp({ repo_key: artifact.repo_key, repo_path: artifact.repo_path, scope, project_path: scope === "project" ? projectPath ?? undefined : undefined, agent_ids: selectedAgents, runtime: { kind: variant.kind, index: variant.index }, values }); onSaved(); } finally { setSaving(false); } }}>{saving ? "Saving..." : selectedAgents.length === 0 ? "Remove bindings" : "Save"}</Button></div>
  </div></DrawerShell>;
}

export function AddMcpDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  type RuntimeType = "remote" | "npm" | "pypi" | "oci";
  type Variable = { name: string; required: boolean; secret: boolean };
  const schema = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [runtimeType, setRuntimeType] = useState<RuntimeType>("remote");
  const [location, setLocation] = useState("");
  const [runtimeVersion, setRuntimeVersion] = useState("");
  const [variables, setVariables] = useState<Variable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const buildManifest = (): Record<string, unknown> => {
    const base: Record<string, unknown> = { $schema: schema, name: name.trim(), description: description.trim(), version: version.trim() || "1.0.0" };
    const definitions = variables.filter((item) => item.name.trim()).map((item) => ({ name: item.name.trim(), isRequired: item.required, isSecret: item.secret }));
    if (runtimeType === "remote") {
      base.remotes = [{ type: "streamable-http", url: location.trim(), ...(definitions.length > 0 ? { headers: definitions } : {}) }];
    } else {
      base.packages = [{ registryType: runtimeType, identifier: location.trim(), ...(runtimeVersion.trim() ? { version: runtimeVersion.trim() } : {}), ...(definitions.length > 0 ? { environmentVariables: definitions } : {}) }];
    }
    return base;
  };

  const create = async () => {
    setError(null);
    if (!name.trim()) { setError("Name is required."); return; }
    if (!location.trim()) { setError(runtimeType === "remote" ? "Server URL is required." : "Package name is required."); return; }
    const manifest = buildManifest();
    setSaving(true);
    try { await createManagedMcp(manifest); onCreated(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Failed to create MCP"); }
    finally { setSaving(false); }
  };

  const inputClass = "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-highlight)]";
  return <DialogShell isOpen onClose={onClose} maxWidth="max-w-3xl">
    <div className="max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-2xl">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div><h2 className="text-lg font-semibold">Add MCP Server</h2><p className="mt-1 text-xs text-[var(--color-text-muted)]">Configure a managed MCP server. Grove saves it as a standard server.json.</p></div>
      </div>

      <div className="space-y-5">
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Server</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-xs"><span className="mb-1 block font-medium">Name *</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="io.company/server-name" className={inputClass} /></label>
            <label className="text-xs"><span className="mb-1 block font-medium">Version</span><input value={version} onChange={(event) => setVersion(event.target.value)} className={inputClass} /></label>
            <label className="col-span-2 text-xs"><span className="mb-1 block font-medium">Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this MCP server provides" className={inputClass} /></label>
          </div>
        </section>

        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Runtime</h3>
          <div className="mb-3 flex gap-1 rounded-lg bg-[var(--color-bg-secondary)] p-1">{(["remote", "npm", "pypi", "oci"] as RuntimeType[]).map((type) => <button key={type} type="button" onClick={() => setRuntimeType(type)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${runtimeType === type ? "bg-[var(--color-highlight)] text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{type === "remote" ? "Remote HTTP" : type === "pypi" ? "PyPI" : type.toUpperCase()}</button>)}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={`text-xs ${runtimeType === "remote" ? "col-span-2" : ""}`}><span className="mb-1 block font-medium">{runtimeType === "remote" ? "Server URL *" : "Package name *"}</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder={runtimeType === "remote" ? "https://example.com/mcp" : runtimeType === "npm" ? "@company/mcp-server" : "package-name"} className={inputClass} /></label>
            {runtimeType !== "remote" && <label className="text-xs"><span className="mb-1 block font-medium">Package version</span><input value={runtimeVersion} onChange={(event) => setRuntimeVersion(event.target.value)} placeholder="latest" className={inputClass} /></label>}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">{runtimeType === "remote" ? "Headers" : "Environment Variables"}</h3><p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">Declare values users provide when binding this server to an Agent.</p></div><Button variant="secondary" size="sm" onClick={() => setVariables((old) => [...old, { name: "", required: true, secret: false }])}><Plus className="mr-1 h-3.5 w-3.5" />Add row</Button></div>
          {variables.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--color-border)] py-5 text-center text-xs text-[var(--color-text-muted)]">No {runtimeType === "remote" ? "headers" : "environment variables"} required.</div> : <div className="overflow-hidden rounded-lg border border-[var(--color-border)]"><div className="grid grid-cols-[1fr_90px_80px_36px] gap-2 bg-[var(--color-bg-secondary)] px-3 py-2 text-[10px] font-medium uppercase text-[var(--color-text-muted)]"><span>Name</span><span>Required</span><span>Secret</span><span /></div>{variables.map((variable, index) => <div key={index} className="grid grid-cols-[1fr_90px_80px_36px] items-center gap-2 border-t border-[var(--color-border)] px-3 py-2"><input value={variable.name} onChange={(event) => setVariables((old) => old.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} placeholder={runtimeType === "remote" ? "Authorization" : "API_TOKEN"} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs" /><input type="checkbox" checked={variable.required} onChange={(event) => setVariables((old) => old.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} /><input type="checkbox" checked={variable.secret} onChange={(event) => setVariables((old) => old.map((item, itemIndex) => itemIndex === index ? { ...item, secret: event.target.checked } : item))} /><button type="button" onClick={() => setVariables((old) => old.filter((_, itemIndex) => itemIndex !== index))} className="text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><Trash2 className="h-4 w-4" /></button></div>)}</div>}
        </section>
      </div>

      {error && <p className="mt-3 text-xs text-[var(--color-error)]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving} onClick={() => void create()}>{saving ? "Creating..." : "Create Server"}</Button></div>
    </div>
  </DialogShell>;
}
