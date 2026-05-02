import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { perfRecorder } from "./recorder";
import type { PerfEventKind, PerfSnapshot } from "./types";

type Tab = "timeline" | "memory" | "renders" | "network" | "backend";

interface BackendRouteStat {
  route: string;
  count: number;
  samples_in_window: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  last_status: number;
}

interface SpanRecord {
  id: number;
  parent_id: number | null;
  name: string;
  start_us: number;
  duration_us: number;
  fields: Record<string, string>;
}

interface TraceRecord {
  trace_id: number;
  root_name: string;
  started_at_ms: number;
  total_us: number;
  spans: SpanRecord[];
}

interface TraceListEntry {
  trace_id: number;
  started_at_ms: number;
  total_us: number;
  span_count: number;
}
type KindFilter = "all" | PerfEventKind;

function useSnapshot(): PerfSnapshot {
  return useSyncExternalStore(
    (cb) => perfRecorder.subscribe(cb),
    () => perfRecorder.snapshot(),
  );
}

const KIND_COLORS: Record<PerfEventKind, string> = {
  longtask: "#ef4444",
  event: "#f59e0b",
  "react-render": "#8b5cf6",
  mark: "#3b82f6",
  measure: "#06b6d4",
  fetch: "#10b981",
  ws: "#14b8a6",
  memory: "#6b7280",
};

export function PerfPanel() {
  const snapshot = useSnapshot();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("timeline");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const recentLongTasks = useMemo(() => {
    const cutoff = now - 2000;
    return snapshot.events.filter(
      (e) => e.kind === "longtask" && e.ts >= cutoff,
    );
  }, [snapshot.events, now]);

  const dotColor = (() => {
    if (recentLongTasks.length === 0) return "#10b981";
    const worst = Math.max(...recentLongTasks.map((e) => e.duration));
    if (worst >= 100) return "#ef4444";
    return "#f59e0b";
  })();

  const heapMb = (() => {
    const last = snapshot.memory[snapshot.memory.length - 1];
    if (!last) return null;
    return (last.usedJSHeapSize / 1024 / 1024).toFixed(0);
  })();

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Perf monitor (Ctrl+Shift+P)"
        style={{
          position: "fixed",
          right: 8,
          bottom: 8,
          zIndex: 999999,
          background: "rgba(0,0,0,0.7)",
          color: "#fff",
          padding: "4px 8px",
          borderRadius: 999,
          fontSize: 11,
          fontFamily: "monospace",
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "1px solid rgba(255,255,255,0.15)",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dotColor,
            boxShadow: `0 0 6px ${dotColor}`,
          }}
        />
        <span>{snapshot.fps}fps</span>
        {heapMb !== null && <span>{heapMb}MB</span>}
        <span>{snapshot.events.length}ev</span>
      </button>

      {open && (
        <div
          style={{
            position: "fixed",
            right: 8,
            bottom: 36,
            width: 560,
            maxHeight: "70vh",
            zIndex: 999999,
            background: "#0b0e14",
            color: "#e6e6e6",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 8,
            display: "flex",
            flexDirection: "column",
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 10px",
              borderBottom: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            <div style={{ display: "flex", gap: 4 }}>
              {(["timeline", "memory", "renders", "network", "backend"] as Tab[]).map(
                (t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 4,
                      background: tab === t ? "#1f2937" : "transparent",
                      color: tab === t ? "#fff" : "#9ca3af",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 11,
                    }}
                  >
                    {t}
                  </button>
                ),
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={exportSnapshot} style={btnStyle}>
                export
              </button>
              <button onClick={() => perfRecorder.clear()} style={btnStyle}>
                clear
              </button>
              <button onClick={() => setOpen(false)} style={btnStyle}>
                ×
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
            {tab === "timeline" && (
              <TimelineTab
                snapshot={snapshot}
                kindFilter={kindFilter}
                setKindFilter={setKindFilter}
              />
            )}
            {tab === "memory" && <MemoryTab snapshot={snapshot} />}
            {tab === "renders" && <RendersTab snapshot={snapshot} />}
            {tab === "network" && <NetworkTab snapshot={snapshot} />}
            {tab === "backend" && <BackendTab open={open} />}
          </div>
        </div>
      )}
    </>
  );
}

function BackendTab({ open }: { open: boolean }) {
  const [stats, setStats] = useState<BackendRouteStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<TraceRecord | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/v1/perf/handler-stats");
        if (res.status === 404) {
          if (!cancelled) {
            setError("backend not built with --features perf-monitor");
            setStats(null);
          }
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { routes: BackendRouteStat[] };
        if (!cancelled) {
          setStats(data.routes);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open]);

  const reset = async () => {
    try {
      await fetch("/api/v1/perf/handler-stats/reset", { method: "POST" });
      setStats([]);
    } catch {
      // ignore
    }
  };

  if (error) {
    return (
      <div style={{ color: "#6b7280", lineHeight: 1.5 }}>
        {error}
        <pre style={{ marginTop: 8, color: "#9ca3af" }}>
          cargo run --features gui,perf-monitor -- gui
        </pre>
      </div>
    );
  }
  if (!stats) return <div style={{ color: "#6b7280" }}>loading…</div>;
  if (stats.length === 0) {
    return <div style={{ color: "#6b7280" }}>no backend requests yet</div>;
  }
  return (
    <div>
      <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "#9ca3af" }}>
          {stats.length} routes, sorted by P95 desc · click row for traces
        </span>
        <button onClick={reset} style={btnStyle}>
          reset
        </button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ color: "#9ca3af", textAlign: "left" }}>
            <th style={{ padding: "4px" }}>route</th>
            <th style={{ padding: "4px", textAlign: "right" }}>n</th>
            <th style={{ padding: "4px", textAlign: "right" }}>p50</th>
            <th style={{ padding: "4px", textAlign: "right" }}>p95</th>
            <th style={{ padding: "4px", textAlign: "right" }}>p99</th>
            <th style={{ padding: "4px", textAlign: "right" }}>max</th>
            <th style={{ padding: "4px", textAlign: "right" }}>status</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((r) => {
            const isErr = r.last_status >= 400;
            const isSlow = r.p95_ms >= 100;
            const isExpanded = expandedRoute === r.route;
            return (
              <Fragment key={r.route}>
                <tr
                  onClick={() =>
                    setExpandedRoute(isExpanded ? null : r.route)
                  }
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                    cursor: "pointer",
                    background: isExpanded ? "rgba(255,255,255,0.04)" : undefined,
                  }}
                >
                  <td
                    style={{
                      padding: "4px",
                      color: "#d1d5db",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {isExpanded ? "▾ " : "▸ "}
                    {r.route}
                  </td>
                  <td style={{ padding: "4px", textAlign: "right", color: "#9ca3af" }}>
                    {r.count}
                  </td>
                  <td style={{ padding: "4px", textAlign: "right" }}>
                    {r.p50_ms.toFixed(1)}
                  </td>
                  <td
                    style={{
                      padding: "4px",
                      textAlign: "right",
                      color: isSlow ? "#ef4444" : "#e6e6e6",
                    }}
                  >
                    {r.p95_ms.toFixed(1)}
                  </td>
                  <td style={{ padding: "4px", textAlign: "right" }}>
                    {r.p99_ms.toFixed(1)}
                  </td>
                  <td style={{ padding: "4px", textAlign: "right", color: "#f59e0b" }}>
                    {r.max_ms.toFixed(1)}
                  </td>
                  <td
                    style={{
                      padding: "4px",
                      textAlign: "right",
                      color: isErr ? "#ef4444" : "#10b981",
                    }}
                  >
                    {r.last_status}
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={7} style={{ padding: "4px 8px", background: "#0f1419" }}>
                      <TraceList route={r.route} onSelectTrace={setSelectedTrace} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {selectedTrace && (
        <TraceDetailModal
          trace={selectedTrace}
          onClose={() => setSelectedTrace(null)}
        />
      )}
    </div>
  );
}

function TraceList({
  route,
  onSelectTrace,
}: {
  route: string;
  onSelectTrace: (t: TraceRecord) => void;
}) {
  const [list, setList] = useState<TraceListEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/v1/perf/traces?route=${encodeURIComponent(route)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { traces: TraceListEntry[] };
        if (!cancelled) setList(data.traces);
      } catch {
        // ignore
      }
    };
    void load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [route]);

  const openTrace = async (id: number) => {
    try {
      const res = await fetch(`/api/v1/perf/traces/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as TraceRecord;
      onSelectTrace(data);
    } catch {
      // ignore
    }
  };

  if (!list) return <div style={{ color: "#6b7280", fontSize: 10 }}>loading…</div>;
  if (list.length === 0) {
    return (
      <div style={{ color: "#6b7280", fontSize: 10 }}>
        no traces — handler needs #[tracing::instrument]
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {list.map((t) => {
        const ms = t.total_us / 1000;
        return (
          <button
            key={t.trace_id}
            onClick={() => openTrace(t.trace_id)}
            style={{
              ...btnStyle,
              fontSize: 10,
              color: ms > 200 ? "#ef4444" : ms > 50 ? "#f59e0b" : "#10b981",
            }}
            title={`${t.span_count} spans · ${new Date(t.started_at_ms).toLocaleTimeString()}`}
          >
            {ms.toFixed(0)}ms
          </button>
        );
      })}
    </div>
  );
}

function TraceDetailModal({
  trace,
  onClose,
}: {
  trace: TraceRecord;
  onClose: () => void;
}) {
  const totalUs = Math.max(trace.total_us, 1);
  // Build child map
  const childrenOf = new Map<number | null, SpanRecord[]>();
  for (const s of trace.spans) {
    const parent = s.parent_id ?? null;
    const arr = childrenOf.get(parent) ?? [];
    arr.push(s);
    childrenOf.set(parent, arr);
  }
  const renderSpan = (s: SpanRecord, depth: number): React.ReactNode => {
    const left = (s.start_us / totalUs) * 100;
    const width = Math.max(0.5, (s.duration_us / totalUs) * 100);
    const fields = Object.entries(s.fields)
      .filter(([k]) => k !== "otel.name")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return (
      <div key={s.id}>
        <div
          style={{
            paddingLeft: depth * 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            padding: "2px 0",
          }}
        >
          <span style={{ width: 200, color: "#d1d5db" }}>
            {s.name}
            {fields && (
              <span style={{ color: "#6b7280", marginLeft: 6 }}>{fields}</span>
            )}
          </span>
          <div
            style={{
              flex: 1,
              position: "relative",
              height: 12,
              background: "#1f2937",
              borderRadius: 2,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: `${left}%`,
                width: `${width}%`,
                top: 0,
                bottom: 0,
                background: "#10b981",
                borderRadius: 2,
              }}
            />
          </div>
          <span style={{ width: 60, textAlign: "right", color: "#9ca3af" }}>
            {(s.duration_us / 1000).toFixed(1)}ms
          </span>
        </div>
        {(childrenOf.get(s.id) ?? []).map((c) => renderSpan(c, depth + 1))}
      </div>
    );
  };
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 1000000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 90vw)",
          maxHeight: "80vh",
          overflow: "auto",
          background: "#0b0e14",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 8,
          padding: 12,
          color: "#e6e6e6",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          <span>
            <strong>{trace.root_name}</strong> · {(trace.total_us / 1000).toFixed(1)}ms ·{" "}
            {trace.spans.length} spans
          </span>
          <button onClick={onClose} style={btnStyle}>
            ×
          </button>
        </div>
        {(childrenOf.get(null) ?? []).map((s) => renderSpan(s, 0))}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "2px 8px",
  background: "#1f2937",
  color: "#e6e6e6",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
};

function TimelineTab({
  snapshot,
  kindFilter,
  setKindFilter,
}: {
  snapshot: PerfSnapshot;
  kindFilter: KindFilter;
  setKindFilter: (k: KindFilter) => void;
}) {
  const filtered = useMemo(() => {
    const events =
      kindFilter === "all"
        ? // Hide memory from "all" — those samples drive the Memory tab and
          // would otherwise dominate the timeline. Filter chip below still
          // exposes them on demand.
          snapshot.events.filter((e) => e.kind !== "memory")
        : snapshot.events.filter((e) => e.kind === kindFilter);
    return events.slice().reverse();
  }, [snapshot.events, kindFilter]);

  const kinds: KindFilter[] = [
    "all",
    "longtask",
    "event",
    "react-render",
    "mark",
    "measure",
    "fetch",
    "ws",
    "memory",
  ];

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        {kinds.map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            style={{
              ...btnStyle,
              background: kindFilter === k ? "#374151" : "#1f2937",
              fontSize: 10,
            }}
          >
            {k}
          </button>
        ))}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {filtered.map((e, i) => (
            <tr
              key={i}
              style={{
                borderBottom: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <td style={{ padding: "2px 4px", color: "#6b7280", width: 60 }}>
                {(e.ts / 1000).toFixed(1)}s
              </td>
              <td style={{ padding: "2px 4px", width: 90 }}>
                <span
                  style={{
                    color: KIND_COLORS[e.kind],
                    fontWeight: 600,
                  }}
                >
                  {e.kind}
                </span>
              </td>
              <td style={{ padding: "2px 4px", color: "#d1d5db" }}>
                {e.name}
              </td>
              <td
                style={{
                  padding: "2px 4px",
                  textAlign: "right",
                  color: e.duration >= 50 ? "#ef4444" : "#9ca3af",
                  width: 70,
                }}
              >
                {e.duration > 0 ? `${e.duration.toFixed(1)}ms` : ""}
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "#6b7280", padding: 8 }}>
                no events
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function MemoryTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const samples = snapshot.memory;
  const cpuEvents = snapshot.events.filter((e) => e.kind === "memory");
  const lastCpu = cpuEvents[cpuEvents.length - 1];

  if (samples.length === 0 && cpuEvents.length === 0) {
    return (
      <div style={{ color: "#6b7280", lineHeight: 1.5 }}>
        no samples yet. RSS + CPU% require Grove to be started with{" "}
        <code style={{ background: "#1f2937", padding: "1px 4px" }}>
          --features perf-monitor
        </code>
        :
        <pre style={{ marginTop: 8, color: "#9ca3af" }}>
          cargo run --features gui,perf-monitor -- gui
        </pre>
      </div>
    );
  }

  const max = samples.length > 0 ? Math.max(...samples.map((s) => s.usedJSHeapSize)) : 0;
  const min = samples.length > 0 ? Math.min(...samples.map((s) => s.usedJSHeapSize)) : 0;
  const cpuMax = Math.max(100, ...cpuEvents.map((e) => e.duration));

  return (
    <div>
      <div style={{ marginBottom: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
        {lastCpu && (
          <span>
            cpu now: <strong style={{ color: "#10b981" }}>{lastCpu.duration.toFixed(1)}%</strong>
          </span>
        )}
        {samples.length > 0 && (
          <span>
            rss: min {(min / 1024 / 1024).toFixed(0)}MB · max{" "}
            {(max / 1024 / 1024).toFixed(0)}MB
          </span>
        )}
      </div>

      {samples.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
            RSS over last {samples.length * 5}s
          </div>
          <svg width="100%" height={80} style={{ background: "#111827" }}>
            <polyline
              fill="none"
              stroke="#10b981"
              strokeWidth={1.5}
              points={samples
                .map((s, i) => {
                  const x = (i / (samples.length - 1 || 1)) * 100;
                  const y = 100 - (s.usedJSHeapSize / (max || 1)) * 100;
                  return `${x}%,${y}%`;
                })
                .join(" ")}
            />
          </svg>
        </div>
      )}

      {cpuEvents.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
            CPU% over last {cpuEvents.length * 5}s (axis 0–{cpuMax.toFixed(0)}%)
          </div>
          <svg width="100%" height={80} style={{ background: "#111827" }}>
            <polyline
              fill="none"
              stroke="#f59e0b"
              strokeWidth={1.5}
              points={cpuEvents
                .map((e, i) => {
                  const x = (i / (cpuEvents.length - 1 || 1)) * 100;
                  const y = 100 - (e.duration / cpuMax) * 100;
                  return `${x}%,${y}%`;
                })
                .join(" ")}
            />
          </svg>
        </div>
      )}
    </div>
  );
}

function RendersTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const grouped = useMemo(() => {
    const m = new Map<string, { count: number; total: number; max: number }>();
    for (const e of snapshot.events) {
      if (e.kind !== "react-render") continue;
      const cur = m.get(e.name) ?? { count: 0, total: 0, max: 0 };
      cur.count += 1;
      cur.total += e.duration;
      cur.max = Math.max(cur.max, e.duration);
      m.set(e.name, cur);
    }
    return [...m.entries()]
      .map(([name, v]) => ({
        name,
        count: v.count,
        avg: v.total / v.count,
        max: v.max,
      }))
      .sort((a, b) => b.avg * b.count - a.avg * a.count);
  }, [snapshot.events]);

  if (grouped.length === 0) {
    return (
      <div style={{ color: "#6b7280" }}>
        no slow renders captured (threshold 8ms). wrap subtrees with
        &lt;OptionalPerfProfiler id="..."&gt; to enable.
      </div>
    );
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ color: "#9ca3af", textAlign: "left" }}>
          <th style={{ padding: "4px" }}>id</th>
          <th style={{ padding: "4px", textAlign: "right" }}>count</th>
          <th style={{ padding: "4px", textAlign: "right" }}>avg</th>
          <th style={{ padding: "4px", textAlign: "right" }}>max</th>
        </tr>
      </thead>
      <tbody>
        {grouped.map((r) => (
          <tr key={r.name} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <td style={{ padding: "4px" }}>{r.name}</td>
            <td style={{ padding: "4px", textAlign: "right" }}>{r.count}</td>
            <td style={{ padding: "4px", textAlign: "right" }}>
              {r.avg.toFixed(1)}ms
            </td>
            <td style={{ padding: "4px", textAlign: "right" }}>
              {r.max.toFixed(1)}ms
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NetworkTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const events = snapshot.events
    .filter((e) => e.kind === "fetch" || e.kind === "ws")
    .slice()
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 50);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {events.map((e, i) => (
          <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <td style={{ padding: "4px", width: 40, color: KIND_COLORS[e.kind] }}>
              {e.kind}
            </td>
            <td style={{ padding: "4px", color: "#d1d5db" }}>{e.name}</td>
            <td style={{ padding: "4px", textAlign: "right", width: 70 }}>
              {e.duration.toFixed(1)}ms
            </td>
          </tr>
        ))}
        {events.length === 0 && (
          <tr>
            <td colSpan={3} style={{ color: "#6b7280", padding: 8 }}>
              no network events
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function exportSnapshot() {
  const snap = perfRecorder.snapshot();
  const blob = new Blob([JSON.stringify(snap, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `grove-perf-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
