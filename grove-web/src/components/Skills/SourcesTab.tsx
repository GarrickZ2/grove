import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Edit3, FolderOpen, GitBranch, Link2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Button, DialogShell } from "../ui";
import { ConfirmDialog } from "../Dialogs";
import { AddSourceDialog } from "./AddSourceDialog";
import { TableEmpty, TableFrame } from "./ExtensionTable";
import { deleteSource as apiDeleteSource, syncAllSources, syncSource } from "../../api";
import type { SkillSource } from "../../api";
import { useCommand } from "../../keyboard";
import { MultiSelectFilter } from "./MultiSelectFilter";

interface SourcesTabProps {
  sources: SkillSource[];
  onRefresh: () => Promise<void>;
}

function isPluginSource(source: SkillSource) {
  return source.name.startsWith("plugin:");
}

function sourceDisplayName(source: SkillSource) {
  if (!isPluginSource(source)) return source.name;
  const parts = source.url.replace(/\/+$/, "").split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : source.name;
}

export function SourcesTab({ sources, onRefresh }: SourcesTabProps) {
  const [search, setSearch] = useState("");
  const [sourceTypes, setSourceTypes] = useState<string[]>([]);
  const [modes, setModes] = useState<string[]>([]);
  const [editSource, setEditSource] = useState<SkillSource | null>(null);
  const [selectedSource, setSelectedSource] = useState<SkillSource | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<SkillSource | null>(null);
  const [syncingName, setSyncingName] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sources.filter((source) => {
      if (sourceTypes.length > 0 && !sourceTypes.includes(source.source_type)) return false;
      if (modes.length > 0 && !modes.includes(source.management_mode)) return false;
      return !query
        || sourceDisplayName(source).toLowerCase().includes(query)
        || source.url.toLowerCase().includes(query);
    });
  }, [modes, search, sourceTypes, sources]);

  const syncOne = async (name: string) => {
    setError(null);
    setSyncingName(name);
    try {
      await syncSource(name);
      await onRefresh();
      setSelectedSource(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync source.");
    } finally {
      setSyncingName(null);
    }
  };

  const syncAll = async () => {
    setError(null);
    setSyncingAll(true);
    try {
      await syncAllSources();
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync sources.");
    } finally {
      setSyncingAll(false);
    }
  };

  const removeSource = async () => {
    if (!deleteConfirm) return;
    const name = deleteConfirm.name;
    setDeleteConfirm(null);
    if (selectedSource?.name === name) setSelectedSource(null);
    await apiDeleteSource(name);
    await onRefresh();
  };

  useCommand("skills.source.syncAll", () => { void syncAll(); }, { enabled: () => sources.length > 0 && !syncingAll }, [sources.length, syncingAll]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative basis-full min-w-0 flex-1 sm:basis-auto">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sources" className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-9 pr-3 text-sm outline-none focus:border-[var(--color-highlight)]" />
        </div>
        <MultiSelectFilter label="Type" selected={sourceTypes} onChange={setSourceTypes} options={[{ value: "git", label: "Git repositories", count: sources.filter((source) => source.source_type === "git").length }, { value: "local", label: "Local folders", count: sources.filter((source) => source.source_type === "local").length }]} />
        <MultiSelectFilter label="Connection" selected={modes} onChange={setModes} options={[{ value: "managed", label: "Managed by Grove" }, { value: "referenced", label: "Linked folder" }, { value: "development", label: "Development" }]} />
        <span className="ml-auto hidden text-xs tabular-nums text-[var(--color-text-muted)] sm:inline">{visible.length} source{visible.length === 1 ? "" : "s"}</span>
        <Button variant="secondary" size="sm" onClick={() => void syncAll()} disabled={syncingAll || sources.length === 0}><RefreshCw className={`h-3.5 w-3.5 sm:mr-1.5 ${syncingAll ? "animate-spin" : ""}`} /><span className="hidden sm:inline">Sync sources</span></Button>
      </div>

      {error && <div className="mb-3 rounded-lg bg-[var(--color-error)]/8 px-3 py-2 text-xs text-[var(--color-error)]">{error}</div>}

      <TableFrame>
        <div className="hidden shrink-0 grid-cols-[minmax(320px,1.6fr)_minmax(220px,1fr)_150px_105px_24px] items-center gap-5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] md:grid"><span>Source</span><span>Discovered</span><span>Connection</span><span>Synced</span><span /></div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? <TableEmpty title="No sources found" description="Try another search, type, or mode." /> : visible.map((source) => (
            <button key={source.name} type="button" onClick={() => setSelectedSource(source)} className="group relative grid min-h-16 w-full grid-cols-1 items-center gap-2 border-b border-[var(--color-border)] px-4 py-4 text-left transition-colors last:border-0 hover:bg-[var(--color-bg-secondary)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-highlight)] md:grid-cols-[minmax(320px,1.6fr)_minmax(220px,1fr)_150px_105px_24px] md:gap-5 md:px-5 md:py-2.5">
              <div className="flex min-w-0 items-center gap-3"><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${source.source_type === "git" ? "bg-[var(--color-info)]/10 text-[var(--color-info)]" : "bg-[var(--color-warning)]/10 text-[var(--color-warning)]"}`}>{source.source_type === "git" ? <GitBranch className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}</span><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-[var(--color-text)]">{sourceDisplayName(source)}</span><span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{source.source_type}</span></div><div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{source.url}{source.subpath ? `/${source.subpath}` : ""}</div></div></div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 md:contents">
                <ContentSummary source={source} />
                <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)] md:rounded-md md:bg-[var(--color-bg-secondary)] md:px-2 md:py-1"><Link2 className="h-3 w-3" />{formatMode(source.management_mode)}</span>
                <span className="text-xs font-medium text-[var(--color-text-muted)] md:text-[var(--color-text-secondary)]">{formatRelativeTime(source.last_synced, now)}</span>
              </div>
              <ChevronRight className="absolute right-4 top-5 h-4 w-4 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 md:static" />
            </button>
          ))}
        </div>
      </TableFrame>

      <DialogShell isOpen={!!selectedSource} onClose={() => setSelectedSource(null)} maxWidth="max-w-xl">
        {selectedSource && <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"><div className="flex items-start justify-between border-b border-[var(--color-border)] px-4 py-4 sm:px-6 sm:py-5"><div className="flex min-w-0 items-center gap-3"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selectedSource.source_type === "git" ? "bg-[var(--color-info)]/10 text-[var(--color-info)]" : "bg-[var(--color-warning)]/10 text-[var(--color-warning)]"}`}>{selectedSource.source_type === "git" ? <GitBranch className="h-5 w-5" /> : <FolderOpen className="h-5 w-5" />}</span><div className="min-w-0"><h2 className="truncate text-lg font-semibold">{sourceDisplayName(selectedSource)}</h2><p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{selectedSource.source_type === "git" ? "Git repository" : "Local folder"} · {formatMode(selectedSource.management_mode)}</p></div></div><button type="button" onClick={() => setSelectedSource(null)} className="rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]"><X className="h-4 w-4" /></button></div><div className="px-4 py-4 sm:px-6 sm:py-5"><DetailSection label="Location"><p className="break-all rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2.5 font-mono text-xs text-[var(--color-text-secondary)]">{selectedSource.url}{selectedSource.subpath ? `/${selectedSource.subpath}` : ""}</p></DetailSection><DetailSection label="Discovered content"><div className="grid grid-cols-3 gap-2 sm:gap-3"><Count label="Skills" value={selectedSource.skill_count} /><Count label="Plugins" value={selectedSource.plugin_count} /><Count label="MCP Servers" value={selectedSource.mcp_count} /></div></DetailSection><div className="flex items-center justify-between pt-4 text-sm"><span className="text-[var(--color-text-muted)]">Last synced</span><span className="font-medium text-[var(--color-text-secondary)]">{formatRelativeTime(selectedSource.last_synced, now)}</span></div></div><div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-4 py-3 sm:px-6 sm:py-4"><Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(selectedSource)} disabled={isPluginSource(selectedSource)}><Trash2 className="mr-1.5 h-4 w-4" />Remove</Button><div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => { setEditSource(selectedSource); setSelectedSource(null); }}><Edit3 className="mr-1.5 h-4 w-4" />Edit</Button><Button variant="primary" size="sm" onClick={() => void syncOne(selectedSource.name)} disabled={syncingName === selectedSource.name}><RefreshCw className={`mr-1.5 h-4 w-4 ${syncingName === selectedSource.name ? "animate-spin" : ""}`} />Sync</Button></div></div></div>}
      </DialogShell>

      <AddSourceDialog isOpen={!!editSource} editingSource={editSource} onClose={() => setEditSource(null)} onSaved={async () => { setEditSource(null); await onRefresh(); }} />
      <ConfirmDialog isOpen={!!deleteConfirm} title="Remove source" message={deleteConfirm ? `Remove ${sourceDisplayName(deleteConfirm)}? Referenced and development files remain on disk.` : ""} confirmLabel="Remove" cancelLabel="Cancel" variant="danger" onConfirm={() => void removeSource()} onCancel={() => setDeleteConfirm(null)} />
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="border-b border-[var(--color-border)] py-5 first:pt-0 last:border-0"><h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{label}</h3>{children}</section>;
}

function Count({ label, value }: { label: string; value: number }) {
  return <div className="min-w-0 rounded-xl border border-[var(--color-border)] px-2.5 py-3 sm:px-4"><div className="text-xl font-semibold tabular-nums">{value}</div><div className="mt-1 truncate text-[10px] text-[var(--color-text-muted)] sm:text-xs">{label}</div></div>;
}

function ContentSummary({ source }: { source: SkillSource }) {
  const entries = [["Skills", source.skill_count, "text-emerald-700 dark:text-emerald-300 md:bg-emerald-500/10"], ["Plugins", source.plugin_count, "text-violet-700 dark:text-violet-300 md:bg-violet-500/10"], ["MCP", source.mcp_count, "text-sky-700 dark:text-sky-300 md:bg-sky-500/10"]] as const;
  const present = entries.filter(([, count]) => count > 0);
  if (present.length === 0) return <span className="text-xs text-[var(--color-text-muted)]">No extensions found</span>;
  return <div className="flex flex-wrap gap-1.5">{present.map(([label, count, className]) => <span key={label} className={`text-xs font-medium md:rounded-md md:px-2 md:py-1 ${className}`}>{count} {label}</span>)}</div>;
}

function formatMode(mode: SkillSource["management_mode"]) {
  if (mode === "managed") return "Managed by Grove";
  if (mode === "referenced") return "Linked folder";
  return "Development";
}

function formatRelativeTime(iso: string | null, now: number) {
  if (!iso) return "Never";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
