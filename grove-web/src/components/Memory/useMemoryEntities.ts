import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryEntity, MemoryEntityDocument, MemoryRelation } from "../../api/memory";
import { memoryCategoryColor } from "./MemoryGraphPalette";
import { errorMessage } from "./memoryFormat";
import { tagCategories } from "./memoryModel";
import { memorySource, type MemorySource } from "./memorySource";
import type { Page } from "../../api/memory";

/** The backend serves at most 100 per page; the star map is built for a few hundred memories. */
const PAGE_SIZE = 100;
export const MAX_GRAPH_MEMORIES = 600;
export const MAX_GRAPH_LINKS = 2000;

/** Follow cursors until `max` items are loaded or the list ends. */
export async function collectPages<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, max: number): Promise<{ items: T[]; hasMore: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && items.length < max);
  return { items: items.slice(0, max), hasMore: Boolean(cursor) || items.length > max };
}

/** Durable memories: search, tag category filter, relations, the open document, and deletion. */
export function useMemoryEntities({ projectId, refreshTick, onChanged, source = memorySource }: { projectId: string; refreshTick: number; onChanged: () => void; source?: MemorySource }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<MemoryEntity[]>([]);
  const [allRelations, setAllRelations] = useState<MemoryRelation[]>([]);
  const [hasMore, setHasMore] = useState(false);
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
        collectPages((cursor) => source.listMemoryEntities(projectId, submitted, cursor, PAGE_SIZE), MAX_GRAPH_MEMORIES),
        collectPages((cursor) => source.listMemoryRelations(projectId, undefined, PAGE_SIZE, cursor), MAX_GRAPH_LINKS),
      ]);
      setItems(entityPage.items);
      setAllRelations(relationPage.items);
      setHasMore(entityPage.hasMore || relationPage.hasMore);
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

  const categories = useMemo(() => tagCategories(items), [items]);
  const categoryColors = useMemo(() => {
    const names = categories.map(([name]) => name);
    return new Map(names.map((name) => [name, memoryCategoryColor(name, names)]));
  }, [categories]);
  const visibleItems = category
    ? items.filter((entity) => entity.tags.some((tag) => tag.key === category))
    : items;

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

  const retryDetail = useCallback(() => setDetailRetry((count) => count + 1), []);

  return {
    query, setQuery, submitted, setSubmitted, items, allRelations, hasMore, category, setCategory, loading,
    selectedId, setSelectedId, detail, detailError, retryDetail, relations, relatedNames, error, setError,
    deleteTarget, setDeleteTarget, deleting, confirmDelete, categories, categoryColors, visibleItems,
  };
}

export type MemoryEntitiesState = ReturnType<typeof useMemoryEntities>;
