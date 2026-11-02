import { useCallback, useState } from "react";
import { deleteSource as apiDeleteSource, syncAllSources, syncSource } from "../../api";
import type { SkillSource } from "../../api";

export function isPluginSource(source: SkillSource) {
  return source.name.startsWith("plugin:");
}

export function sourceDisplayName(source: SkillSource) {
  if (!isPluginSource(source)) return source.name;
  const parts = source.url.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 2] : source.name;
}

export function formatMode(mode: SkillSource["management_mode"]) {
  if (mode === "managed") return "Managed by Grove";
  if (mode === "referenced") return "Linked folder";
  return "Development";
}

export function formatRelativeTime(iso: string | null, now: number) {
  if (!iso) return "Never";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Sync / sync-all / remove for sources, with shared busy + error state. */
export function useSourceActions(onRefresh: () => Promise<void>) {
  const [syncingName, setSyncingName] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolves true when the sync succeeded. */
  const syncOne = useCallback(async (name: string) => {
    setError(null);
    setSyncingName(name);
    try {
      await syncSource(name);
      await onRefresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync source.");
      return false;
    } finally {
      setSyncingName(null);
    }
  }, [onRefresh]);

  const syncAll = useCallback(async () => {
    setError(null);
    setSyncingAll(true);
    try {
      await syncAllSources();
      await onRefresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync sources.");
      return false;
    } finally {
      setSyncingAll(false);
    }
  }, [onRefresh]);

  const remove = useCallback(async (name: string) => {
    await apiDeleteSource(name);
    await onRefresh();
  }, [onRefresh]);

  return { syncingName, syncingAll, error, syncOne, syncAll, remove };
}
