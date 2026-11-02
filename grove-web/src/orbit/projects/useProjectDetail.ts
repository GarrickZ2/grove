import { useEffect, useState } from "react";
import { getProject, getProjectStats, type ProjectResponse, type ProjectStatsResponse } from "../../api";
import { getProjectStatistics, type StatisticsResponse } from "../../api/statistics";
import type { Project } from "../../data/types";

export interface ProjectDetailData {
  /** Full project (tasks, local task, branch); null when it couldn't be loaded. */
  full: ProjectResponse | null;
  /** Task counts by status incl. archived (coding projects only). */
  stats: ProjectStatsResponse | null;
  /** Last 7 days of token usage, daily buckets. */
  usage: StatisticsResponse | null;
}

const WEEK = 7 * 24 * 3600;

/**
 * Loads what the detail card shows for one project: the full project, its
 * task stats (coding projects; the stats endpoint reads the repo on disk)
 * and the last 7 days of token usage. Each piece fails on its own.
 */
export function useProjectDetail(project: Project | null) {
  const [state, setState] = useState<{ key: string; data: ProjectDetailData } | null>(null);
  const id = project?.id ?? null;
  const studio = project?.projectType === "studio";
  const exists = project?.exists ?? false;
  // Re-fetch when the project's list entry changes (rename, task count, restore).
  const key = id ? `${id}:${project?.name}:${project?.taskCount ?? ""}:${project?.archived}` : null;

  useEffect(() => {
    if (!id || !key) return;
    let cancelled = false;
    const now = Math.floor(Date.now() / 1000);
    void Promise.all([
      getProject(id).catch(() => null),
      !studio && exists ? getProjectStats(id).catch(() => null) : Promise.resolve(null),
      getProjectStatistics(id, { from: now - WEEK, to: now, bucket: "daily" }).catch(() => null),
    ]).then(([full, stats, usage]) => {
      if (!cancelled) setState({ key, data: { full, stats, usage } });
    });
    return () => {
      cancelled = true;
    };
  }, [id, key, studio, exists]);

  const current = state && state.key === key ? state.data : null;
  // Keep showing the previous load while a refresh of the same project runs.
  const stale = !current && state && id && state.key.startsWith(`${id}:`) ? state.data : null;
  return { data: current ?? stale, loading: !current };
}
