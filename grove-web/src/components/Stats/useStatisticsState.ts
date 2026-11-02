/**
 * Statistics page state shared by Workbench (ProjectStatsPage) and Orbit:
 * scope, range, bucket, metric and unit, plus the fetched response.
 *
 * Project scope without a selected project fetches Global; callers render
 * the "select a project" state from `scope` themselves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getGlobalStatistics,
  getProjectStatistics,
  type Bucket,
  type StatisticsResponse,
} from "../../api/statistics";
import { computeAverageRates } from "./components/pricing";
import {
  ALLOWED_BUCKETS,
  DEFAULT_BUCKET,
  RANGE_SECS,
  type MetricType,
  type RangeId,
  type Scope,
  type Unit,
} from "./statsModel";

export function useStatisticsState(projectId: string | undefined, initialScope?: Scope) {
  const [scope, setScope] = useState<Scope>(
    initialScope ?? (projectId ? "project" : "global"),
  );
  const [range, setRange] = useState<RangeId>("7d");
  const [bucket, setBucket] = useState<Bucket>(DEFAULT_BUCKET["7d"]);
  const [metricType, setMetricType] = useState<MetricType>("total");
  const [unit, setUnit] = useState<Unit>("token");
  const [data, setData] = useState<StatisticsResponse | null>(null);
  // The window and bucket `data` was fetched for; lags the controls while a
  // new request is in flight.
  const [dataWindow, setDataWindow] = useState<{ from: number; to: number; bucket: Bucket } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may land; a slow older one is dropped.
  const requestSeq = useRef(0);

  // Derived: if user picked Project but no project is loaded, fall back to
  // Global for fetching purposes. We render the empty state separately.
  const effectiveScope: Scope =
    scope === "project" && !projectId ? "global" : scope;

  // Switching range can leave the current bucket invalid — collapse onto
  // a sensible default *for fetching*, while letting the UI stay in sync
  // via setRange's wrapper below.
  const setRangeAndCoerce = useCallback(
    (newRange: RangeId) => {
      setRange(newRange);
      if (!ALLOWED_BUCKETS[newRange].includes(bucket)) {
        setBucket(DEFAULT_BUCKET[newRange]);
      }
    },
    [bucket],
  );

  const allowedBuckets = useMemo(() => ALLOWED_BUCKETS[range], [range]);

  const currentModels = data?.current.models;
  const averageRates = useMemo(() => {
    return computeAverageRates(currentModels ?? []);
  }, [currentModels]);

  const fetchData = useCallback(async () => {
    if (effectiveScope === "project" && !projectId) {
      requestSeq.current++;
      setData(null);
      setDataWindow(null);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    const now = Math.floor(Date.now() / 1000);
    const from = now - RANGE_SECS[range];
    try {
      const resp =
        effectiveScope === "global"
          ? await getGlobalStatistics({ from, to: now, bucket })
          : await getProjectStatistics(projectId!, { from, to: now, bucket });
      if (seq === requestSeq.current) {
        setData(resp);
        setDataWindow({ from, to: now, bucket });
      }
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
      setDataWindow(null);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [effectiveScope, projectId, range, bucket]);

  useEffect(() => {
    // Fetching is an external-system call; setState inside the callback is
    // the canonical loading-state pattern. Lint exemption is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  return {
    scope,
    setScope,
    effectiveScope,
    range,
    setRange: setRangeAndCoerce,
    bucket,
    setBucket,
    allowedBuckets,
    metricType,
    setMetricType,
    unit,
    setUnit,
    data,
    dataWindow,
    loading,
    error,
    averageRates,
    refresh: fetchData,
  };
}

export type StatisticsState = ReturnType<typeof useStatisticsState>;
