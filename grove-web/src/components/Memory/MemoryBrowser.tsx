import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight, CircleAlert, FileText, Trash2, X } from "lucide-react";
import type { MemoryEntity, MemoryEntityDocument, MemoryRelation, MemoryLog } from "../../api/memory";
import { memorySource, type MemorySource } from "./memorySource";
import { useIsMobile } from "../../hooks/useIsMobile";
import { DialogShell } from "../ui/DialogShell";
import { ConfirmDialog } from "../Dialogs";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { MemoryGraph } from "./MemoryGraph";
import { memoryCategoryColor } from "./MemoryGraphPalette";
import { SearchBar, Score, TagList, InlineNotice, CenteredLoading, EmptyPage } from "./MemoryPrimitives";
import { errorMessage, formatNumber, formatDate, relativeDate, plural, humanize, shortId } from "./memoryFormat";
export function MemoriesTab({ projectId, refreshTick, onChanged, compact = false, source = memorySource }: { compact?: boolean; source?: MemorySource; projectId: string; refreshTick: number; onChanged: () => void }) {
  const { isMobile } = useIsMobile();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<MemoryEntity[]>([]);
  const [allRelations, setAllRelations] = useState<MemoryRelation[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [view, setView] = useState<"graph" | "list">(() => compact || isMobile ? "list" : "graph");
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryEntityDocument | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [relatedNames, setRelatedNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntityDocument | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [entityPage, relationPage] = await Promise.all([
        source.listMemoryEntities(projectId, submitted, undefined, 100),
        source.listMemoryRelations(projectId, undefined, 100),
      ]);
      setItems(entityPage.items);
      setAllRelations(relationPage.items);
      setHasMore(Boolean(entityPage.next_cursor || relationPage.next_cursor));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }, [projectId, submitted, source]);

  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshTick]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSubmitted(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (!selectedId) {
        setDetail(null);
        setRelations([]);
        setRelatedNames({});
        return;
      }
      setDetail(null);
      setDetailError(null);
      try {
        const [document, relationPage] = await Promise.all([
          source.getMemoryEntity(projectId, selectedId),
          source.listMemoryRelations(projectId, selectedId),
        ]);
        if (!active) return;
        setDetail(document);
        setRelations(relationPage.items);
        const known = new Map(items.map((entity) => [entity.entity_id, entity.title]));
        const relatedIds = [...new Set(relationPage.items.map((relation) => relation.source_entity_id === selectedId ? relation.target_entity_id : relation.source_entity_id))].slice(0, 6);
        const missing = relatedIds.filter((id) => !known.has(id));
        const loaded = await Promise.all(missing.map((id) => source.getMemoryEntity(projectId, id).catch(() => null)));
        if (!active) return;
        loaded.forEach((entity) => { if (entity) known.set(entity.entity_id, entity.title); });
        setRelatedNames(Object.fromEntries(known));
      } catch (reason) {
        if (active) setDetailError(errorMessage(reason));
      }
    });
    return () => { active = false; };
  }, [items, projectId, selectedId, detailRetry, source]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of items) {
      for (const key of new Set(entity.tags.map((tag) => tag.key))) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [items]);
  const categoryColors = useMemo(() => {
    const names = categories.map(([name]) => name);
    return new Map(names.map((name) => [name, memoryCategoryColor(name, names)]));
  }, [categories]);
  const visibleItems = category
    ? items.filter((entity) => entity.tags.some((tag) => tag.key === category))
    : items;
  const resultSummary = submitted
    ? `${formatNumber(items.length)}${hasMore ? "+" : ""} matching ${plural(items.length, "memory", "memories")}`
    : hasMore
      ? `Showing the ${formatNumber(items.length)} strongest memories`
      : `${formatNumber(items.length)} ${plural(items.length, "memory", "memories")}`;

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await source.deleteMemoryEntity(projectId, deleteTarget.entity_id);
      setItems((current) => current.filter((entity) => entity.entity_id !== deleteTarget.entity_id));
      setAllRelations((current) => current.filter((relation) => relation.source_entity_id !== deleteTarget.entity_id && relation.target_entity_id !== deleteTarget.entity_id));
      setSelectedId(null);
      setDeleteTarget(null);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={compact ? "buddy-memory-browser" : "flex min-h-0 flex-col sm:h-full"}>
      <div hidden={compact && !!selectedId}>
      <div className={`${compact ? "buddy-memory-search " : ""}grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 pb-3 sm:grid-cols-[minmax(320px,680px)_auto_1fr] sm:gap-3 sm:pb-4`}>
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <SearchBar value={query} onChange={setQuery} onSubmit={() => setSubmitted(query.trim())} placeholder="Search memories, descriptions, or tags" />
        </div>
        <div hidden={compact} className="inline-flex justify-self-start items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1">
          <button
            type="button"
            title="Relation graph"
            onClick={() => setView("graph")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${view === "graph" ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          >
            Graph
          </button>
          <button
            type="button"
            title="Memory list"
            onClick={() => setView("list")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${view === "list" ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          >
            List
          </button>
        </div>
        <p className="min-w-0 truncate justify-self-end text-xs text-[var(--color-text-muted)]">{resultSummary}</p>
      </div>

      {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
      {!loading && items.length === 0 ? (
        <EmptyPage title="No memories yet" description={submitted ? "No memories match this search." : "Run Memory organization to turn short-term logs into durable Markdown memories."} />
      ) : (
        <div className="flex min-h-[440px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] sm:flex-1 sm:flex-row">
          <aside hidden={compact} className="flex w-full flex-shrink-0 gap-2 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 p-3 [scrollbar-width:none] sm:block sm:w-60 sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-4 [&::-webkit-scrollbar]:hidden">
            <p className="hidden px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)] sm:block">Tag category</p>
            <button
              type="button"
              onClick={() => setCategory(null)}
              className={`flex flex-shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition-colors sm:w-full ${category === null ? "bg-[var(--color-bg-secondary)] text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/70 hover:text-[var(--color-text)]"}`}
            >
              <span>All memories</span>
              <span className="text-[10px] tabular-nums">{items.length}</span>
            </button>
            <div className="flex gap-2 sm:mt-1 sm:block sm:space-y-0.5">
              {categories.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setCategory(name)}
                  className={`flex flex-shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors sm:w-full ${category === name ? "bg-[var(--color-bg-secondary)] text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/70 hover:text-[var(--color-text)]"}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: categoryColors.get(name) }} />
                  <span className="truncate flex-1 text-left">{humanize(name)}</span>
                  <span className="text-[10px] tabular-nums">{count}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
              {view === "graph" ? (
                <MemoryGraph
                  entities={visibleItems}
                  relations={allRelations}
                  onOpen={setSelectedId}
                  categoryColors={categoryColors}
                  activeCategory={category}
                  summary={`${items.length === 1 ? "Showing 1 memory" : `Showing ${formatNumber(visibleItems.length)} of the ${formatNumber(items.length)} strongest memories`}${submitted ? " · search covers the full snapshot" : ""}`}
                />
              ) : (
                <MemoryEntityList compact={compact} entities={visibleItems} onOpen={setSelectedId} />
              )}
            </div>
          </section>
        </div>
      )}
      {loading && <div className="absolute inset-0 pointer-events-none"><CenteredLoading compact /></div>}
      </div>
      <MemoryDocumentDialog inline={compact}
        isOpen={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        detail={detail}
        error={detailError}
        onRetry={() => setDetailRetry((count) => count + 1)}
        relations={relations}
        relatedNames={relatedNames}
        onOpen={setSelectedId}
        onDelete={setDeleteTarget}
      />
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title="Delete Memory"
        message={<>Delete <strong className="text-[var(--color-text)]">{deleteTarget?.title}</strong>? Its Markdown document, snapshot, and related connections will be removed.</>}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        actionsDisabled={deleting}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
      />
    </div>
  );
}

export function MemoryEntityList({ entities, onOpen, compact = false }: { entities: MemoryEntity[]; onOpen: (entityId: string) => void; compact?: boolean }) {
  return (
    <div className={`h-full min-h-0 overflow-y-auto${compact ? " buddy-memory-list" : ""}`}>
      <div hidden={compact} className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_minmax(180px,0.42fr)_80px_120px] gap-4 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] md:grid">
        <span>Memory</span>
        <span>Tags</span>
        <span>Score</span>
        <span>Updated</span>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {entities.map((entity) => (
          <button
            key={entity.entity_id}
            type="button"
            onClick={() => onOpen(entity.entity_id)}
            className="block w-full px-4 py-3.5 text-left transition-colors hover:bg-[var(--color-bg-secondary)]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-highlight)] md:grid md:grid-cols-[minmax(0,1fr)_minmax(180px,0.42fr)_80px_120px] md:items-center md:gap-4 md:px-5"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[var(--color-text)]">{entity.title}</span>
              <span className="mt-1 block truncate text-xs text-[var(--color-text-muted)]">{entity.description}</span>
            </span>
            <span className="mt-2 flex min-w-0 flex-wrap gap-1.5 md:mt-0">
              {entity.tags.slice(0, 3).map((tag) => (
                <span key={`${tag.key}:${tag.value}`} className="max-w-full truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                  {!compact && tag.icon ? `${tag.icon} ` : ""}{humanize(tag.key)} · {tag.value}
                </span>
              ))}
            </span>
            <span className="mt-2 inline-flex text-xs font-medium tabular-nums text-[var(--color-text)] md:mt-0">Score {entity.score}</span>
            <span className="ml-3 mt-2 inline-flex text-xs text-[var(--color-text-muted)] md:ml-0 md:mt-0">{relativeDate(entity.updated_at)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MemoryDocumentDialog({ inline = false, isOpen, onClose, detail, error, onRetry, relations, relatedNames, onOpen, onDelete }: { inline?: boolean; isOpen: boolean; onClose: () => void; detail: MemoryEntityDocument | null; error: string | null; onRetry: () => void; relations: MemoryRelation[]; relatedNames: Record<string, string>; onOpen: (id: string) => void; onDelete: (detail: MemoryEntityDocument) => void }) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const content = (
      <div className="glass-overlay flex max-h-[min(88vh,920px)] min-h-[360px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_28px_80px_rgba(0,0,0,0.28)]">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"><FileText className="h-4 w-4" /></span>
            <div>
              <p className="text-xs font-semibold text-[var(--color-text)]">Memory document</p>
              <p className="text-[10px] text-[var(--color-text-muted)]">Durable project knowledge</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => { if (detail) onDelete(detail); }} disabled={!detail} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Delete Memory"><Trash2 className="h-4 w-4" /></button>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" aria-label="Close Memory document"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {error ? <div role="alert" className="mx-auto flex min-h-[360px] max-w-xl flex-col items-center justify-center gap-3 px-6 text-center"><CircleAlert className="h-6 w-6 text-[var(--color-error)]" /><p className="text-sm font-medium text-[var(--color-text)]">Could not open this Memory</p><p className="break-words text-sm text-[var(--color-text-muted)]">{error}</p><button type="button" onClick={onRetry} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)]">Try again</button></div> : !detail ? <div className="flex min-h-[360px] items-center justify-center"><CenteredLoading compact /></div> : <MemoryDetail detail={detail} relations={relations} relatedNames={relatedNames} onOpen={onOpen} />}
        </div>
      </div>
  );
  return inline ? isOpen ? <div className="buddy-memory-document">{content}</div> : null : <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-[min(1080px,calc(100vw-48px))]">{content}</DialogShell>;
}

export function MemoryDetail({ detail, relations, relatedNames, onOpen }: { detail: MemoryEntityDocument; relations: MemoryRelation[]; relatedNames: Record<string, string>; onOpen: (id: string) => void }) {
  return (
    <article className="bg-[var(--color-bg-secondary)]/20">
      <div className="p-6 md:p-9 border-b border-[var(--color-border)]">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-3xl font-semibold tracking-tight text-[var(--color-text)]">{detail.title}</h2><p className="text-xs text-[var(--color-text-muted)] mt-2">Updated {formatDate(detail.updated_at)}</p></div>
          <Score value={detail.score} />
        </div>
        {relations.length > 0 && (
          <div className="mt-7">
            <p className="text-xs text-[var(--color-text-muted)] mb-2">Related memories</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {relations.slice(0, 6).map((relation) => {
                const id = relation.source_entity_id === detail.entity_id ? relation.target_entity_id : relation.source_entity_id;
                return <button key={relation.id} onClick={() => onOpen(id)} className="text-left rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 hover:border-[var(--color-highlight)]/60 transition-colors"><span className="block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{relation.relation_type}</span><span className="block text-sm font-medium text-[var(--color-text)] mt-0.5 truncate">{relatedNames[id] ?? id}</span></button>;
              })}
            </div>
          </div>
        )}
        <p className="mt-7 text-base leading-relaxed text-[var(--color-text)]">{detail.description}</p>
        <TagList tags={detail.tags} />
      </div>
      <div className="p-6 md:p-9"><MarkdownRenderer content={detail.body || "_This memory has no body yet._"} renderMode="document" /></div>
    </article>
  );
}

export function LogRow({ log, selected, onSelectedChange, onDelete }: { log: MemoryLog; selected: boolean; onSelectedChange: (selected: boolean) => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const sourceLabel = log.task_id === "_studio_memory_migration"
    ? "Legacy Studio import"
    : `Task ${shortId(log.task_id)}`;
  return (
    <div className={`group flex w-full items-start gap-2 rounded-xl border px-3 py-3 transition-colors hover:bg-[var(--color-bg-secondary)]/35 ${selected ? "border-[var(--color-highlight)]/55 bg-[var(--color-highlight)]/4" : "border-[var(--color-border)]"}`}>
      <label className="mt-1 flex h-7 w-6 flex-shrink-0 cursor-pointer items-center justify-center" aria-label={`Select ${log.title}`}>
        <input type="checkbox" checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-highlight)]" />
      </label>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="flex min-w-0 flex-1 gap-3 text-left">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)]">
          <Activity className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">{log.title}</h3>
            <span className="flex-shrink-0 text-[10px] text-[var(--color-text-muted)]">{formatDate(log.created_at)}</span>
          </div>
          <p className={`mt-1 text-sm leading-relaxed text-[var(--color-text-muted)] ${expanded ? "whitespace-pre-wrap" : "line-clamp-1"}`}>{log.description}</p>
          <div className={`mt-2 flex items-center gap-1.5 ${expanded ? "flex-wrap" : "overflow-hidden"}`}>
            {log.tags.map((tag) => <span key={tag} className="flex-shrink-0 rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">#{tag}</span>)}
            <span className="flex-shrink-0 text-[10px] text-[var(--color-text-muted)]">{sourceLabel}{log.agent ? ` · ${log.agent}` : ""}</span>
          </div>
        </div>
        <span className="mt-1 flex-shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      <button type="button" onClick={onDelete} className="mt-0.5 rounded-lg p-2 text-[var(--color-text-muted)] opacity-0 transition-all hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete ${log.title}`}><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}
