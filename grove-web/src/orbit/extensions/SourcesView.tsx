import { useMemo, useState } from "react";
import { ChevronRight, Edit3, FolderOpen, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import type { SkillSource } from "../../api";
import { AddSourceDialog } from "../../components/Skills/AddSourceDialog";
import { ConfirmDialog } from "../../components/Dialogs";
import { catalogRecordKey, type CatalogRecord } from "../../components/Skills/useExtensionCatalog";
import { formatMode, isPluginSource, sourceDisplayName, useSourceActions } from "../../components/Skills/useSourceActions";
import { useCommand } from "../../keyboard";
import { Button, Card, EmptyState, SearchField, StatusDot } from "../ui";
import { ExtIcon } from "./parts";
import { usePhoneSplit } from "./usePhoneSplit";
import { KIND_LABEL, accessText, contentSummary, recordsBySource, resolveSelection, sinceText, versionText } from "./catalogModel";

interface SourcesViewProps {
  sources: SkillSource[];
  /** Catalog records, for what each source provides. */
  records: CatalogRecord[];
  recordsLoading: boolean;
  now: number;
  onRefresh: () => Promise<void>;
  onAddSource: () => void;
  /** Jump to a provided item in the Catalog. */
  onOpenRecord: (key: string) => void;
}

const sourceKey = (source: SkillSource) => source.name;

/** Master / detail like Catalog: sources on the left, the selected source's
 *  location, state and the extensions it provides on the right. */
export function SourcesView({ sources, records, recordsLoading, now, onRefresh, onAddSource, onOpenRecord }: SourcesViewProps) {
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const phoneSplit = usePhoneSplit();
  const [editSource, setEditSource] = useState<SkillSource | null>(null);
  const [removing, setRemoving] = useState<SkillSource | null>(null);
  // Bumped per finished sync so the "Synced" text flashes once.
  const [flash, setFlash] = useState<{ name: string | "*"; seq: number } | null>(null);
  const actions = useSourceActions(onRefresh);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sources.filter((source) => !query || sourceDisplayName(source).toLowerCase().includes(query) || source.url.toLowerCase().includes(query));
  }, [search, sources]);
  const selected = resolveSelection(visible, selectedName, sourceKey);
  const provided = useMemo(() => recordsBySource(records), [records]);

  const syncAll = async () => {
    if (await actions.syncAll()) setFlash((current) => ({ name: "*", seq: (current?.seq ?? 0) + 1 }));
  };
  const syncOne = async (name: string) => {
    if (await actions.syncOne(name)) setFlash((current) => ({ name, seq: (current?.seq ?? 0) + 1 }));
  };
  const flashed = (name: string) => !!flash && (flash.name === "*" || flash.name === name);

  useCommand("skills.source.syncAll", () => { void syncAll(); }, { enabled: () => sources.length > 0 && !actions.syncingAll }, [sources.length, actions.syncingAll]);

  return (
    <Card className={`${phoneSplit.split} oui-rise`} style={{ animationDelay: "60ms" }} aria-label="Sources">
      <div className="oex-master">
        <div className="oex-mtools oex-mtools-row">
          <SearchField value={search} onChange={setSearch} label="Search sources" />
          <Button variant="secondary" size="sm" disabled={actions.syncingAll || sources.length === 0} onClick={() => void syncAll()}>
            <RefreshCw className={actions.syncingAll ? "oui-spin" : undefined} />Sync all
          </Button>
        </div>
        {actions.error ? <p className="oex-err oex-ptools-err" role="alert">{actions.error}</p> : null}
        <div className="oui-card-list oui-scroll">
          {visible.length === 0 ? (
            <EmptyState
              title={sources.length ? "No sources match" : "No sources yet"}
              action={sources.length ? <Button variant="secondary" size="sm" onClick={() => setSearch("")}>Clear search</Button> : <Button variant="secondary" size="sm" onClick={onAddSource}>Add source</Button>}
            >
              {sources.length ? "Try another name or path." : "A source is a Git repo or a folder. Grove scans it for skills, plugins and MCP servers."}
            </EmptyState>
          ) : visible.map((source, index) => {
            const isSelected = selected?.name === source.name;
            return (
              <button
                key={source.name}
                type="button"
                className={`oex-ext${isSelected ? " is-sel" : ""}`}
                aria-current={isSelected || undefined}
                style={{ animationDelay: `${Math.min(index, 12) * 30 + 60}ms` }}
                onClick={() => { setSelectedName(source.name); phoneSplit.open(); }}
              >
                <SourceIcon source={source} />
                <span className="oex-ecopy">
                  <b><span className="oui-truncate">{sourceDisplayName(source)}</span>{source.has_remote_updates ? <span className="oex-badge">Update</span> : null}</b>
                  <small>{contentSummary(source)} · <span key={flashed(source.name) ? flash?.seq : "idle"} className={flashed(source.name) ? "oex-flash" : undefined}>{sinceText(source.last_synced, now)}</span></small>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="oex-detail">
        {phoneSplit.back("Sources")}
        {selected ? (
          <SourceDetail
            key={selected.name}
            source={selected}
            items={provided.get(selected.name) ?? []}
            itemsLoading={recordsLoading}
            now={now}
            syncing={actions.syncingAll || actions.syncingName === selected.name}
            flash={flashed(selected.name) ? flash?.seq ?? 0 : 0}
            onSync={() => void syncOne(selected.name)}
            onEdit={() => setEditSource(selected)}
            onRemove={() => setRemoving(selected)}
            onOpenRecord={onOpenRecord}
          />
        ) : (
          <EmptyState>{sources.length ? "Nothing matches the search." : "Sources you add show up here, with everything Grove found inside them."}</EmptyState>
        )}
      </div>

      <AddSourceDialog isOpen={!!editSource} editingSource={editSource} onClose={() => setEditSource(null)} onSaved={async () => { setEditSource(null); await onRefresh(); }} />
      <ConfirmDialog
        isOpen={!!removing}
        title="Remove source"
        message={removing ? `Remove ${sourceDisplayName(removing)}? Referenced and development files remain on disk.` : ""}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => { const name = removing?.name; setRemoving(null); if (name) void actions.remove(name); }}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}

function SourceIcon({ source, large = false }: { source: SkillSource; large?: boolean }) {
  return (
    <span className={`oex-sic is-${source.source_type}${large ? " is-lg" : ""}`} aria-hidden="true">
      {source.source_type === "git" ? <GitBranch /> : <FolderOpen />}
    </span>
  );
}

function SourceDetail({ source, items, itemsLoading, now, syncing, flash, onSync, onEdit, onRemove, onOpenRecord }: {
  source: SkillSource;
  items: CatalogRecord[];
  itemsLoading: boolean;
  now: number;
  syncing: boolean;
  flash: number;
  onSync: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onOpenRecord: (key: string) => void;
}) {
  const location = `${source.url}${source.subpath ? `/${source.subpath}` : ""}`;
  const plugin = isPluginSource(source);
  const total = source.skill_count + source.plugin_count + source.mcp_count;
  return (
    <>
      <div className="oex-dbody oui-scroll">
        <div className="oex-dsec oex-ident">
          <SourceIcon source={source} large />
          <div className="oex-ident-copy">
            <h2><span className="oui-truncate" title={source.name}>{sourceDisplayName(source)}</span></h2>
            <p className="oui-truncate">{source.source_type === "git" ? "Git repository" : "Local folder"} · {formatMode(source.management_mode)}</p>
          </div>
        </div>
        <div className="oex-dsec">
          {source.has_remote_updates ? (
            <div className="oex-alert" role="status">
              <RefreshCw aria-hidden="true" />
              <div><b>Update available</b><span>The remote has commits Grove hasn’t pulled yet.</span></div>
              <Button variant="primary" size="sm" disabled={syncing} onClick={onSync}>Sync now</Button>
            </div>
          ) : (
            <div className="oex-okline">
              <StatusDot tone={source.last_synced ? "live" : "off"} ring={Boolean(source.last_synced)} />
              <span key={flash} className={flash ? "oex-flash" : undefined}>{source.last_synced ? `Synced ${sinceText(source.last_synced, now)}` : "Never synced"}</span>
            </div>
          )}
        </div>

        <div className="oex-dsec">
          <div className="oex-shead"><h3>Location</h3></div>
          <div className="oex-conn">
            {source.source_type === "git" ? <GitBranch aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
            <span className="oui-mono oui-truncate" title={location}>{location}</span>
          </div>
        </div>

        <div className="oex-dsec">
          <div className="oex-meta" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <div><span>Skills</span><b className="oui-tnum">{source.skill_count}</b></div>
            <div><span>Plugins</span><b className="oui-tnum">{source.plugin_count}</b></div>
            <div><span>MCP servers</span><b className="oui-tnum">{source.mcp_count}</b></div>
          </div>
        </div>

        <div className="oex-dsec">
          <div className="oex-shead"><h3>Provides · {total}</h3></div>
          {itemsLoading && items.length === 0 ? (
            <div className="oex-md-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /></div>
          ) : items.length === 0 ? (
            <p className="oex-hint">Grove found nothing in this source yet. Sync it after adding skills, plugins or MCP servers.</p>
          ) : (
            <div className="oex-uses">
              {items.map((record, index) => {
                const { item, plugin: installed } = record;
                return (
                  <button key={catalogRecordKey(record)} type="button" className="oex-use oex-use-link" style={{ animationDelay: `${Math.min(index, 10) * 25}ms` }} onClick={() => onOpenRecord(catalogRecordKey(record))}>
                    <ExtIcon kind={item.kind} name={item.name} manifest={item.manifest} plugin={installed} />
                    <span className="oex-use-name oui-truncate">{installed?.name || item.name}<span className="oex-type">{KIND_LABEL[item.kind]}</span></span>
                    <span className="oex-use-where oui-truncate">{[versionText(item, installed), accessText(record)].filter(Boolean).join(" · ")}</span>
                    <ChevronRight className="oex-use-chev" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="oex-dfoot">
        <span className="oex-dfoot-note" />
        <Button variant="ghost" size="sm" danger disabled={plugin} title={plugin ? "Plugin sources are removed with the plugin" : undefined} onClick={onRemove}><Trash2 />Remove</Button>
        <Button variant="secondary" size="sm" onClick={onEdit}><Edit3 />Edit</Button>
        <Button variant="primary" size="sm" disabled={syncing} onClick={onSync}><RefreshCw className={syncing ? "oui-spin" : undefined} />Sync</Button>
      </div>
    </>
  );
}
