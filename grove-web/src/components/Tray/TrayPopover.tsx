/**
 * Menubar tray popover.
 *
 * The Rust side (src/tray/mod.rs) maintains an in-memory `EventStore` and
 * exposes Tauri commands to read it / mutate it. We poll `tray_get_events`
 * every 600ms because piping `app.emit("tray:events")` through to the JS
 * world would require pulling in `@tauri-apps/api`. Polling keeps the
 * dependency surface zero and 600ms latency is invisible at this rate
 * (permissions don't appear at >1Hz).
 */

import { useEffect, useMemo, useState } from "react";
import { Settings, ExternalLink, X, Search } from "lucide-react";

// ─── Types (mirror src/tray/mod.rs) ─────────────────────────────────────────

interface PermissionOption {
  option_id: string;
  name: string;
  /** "allow_once" | "allow_always" | "reject_once" | "reject_always" */
  kind: string;
}

interface PermissionEvent {
  id: string;
  project_id: string;
  task_id: string;
  chat_id: string;
  description: string;
  options: PermissionOption[];
  created_at: number;
}

interface RunningEvent {
  id: string;
  project_id: string;
  task_id: string;
  prompt: string | null;
  started_at: number;
}

interface DoneEvent {
  id: string;
  project_id: string;
  task_id: string;
  level: string | null;
  message: string | null;
  created_at: number;
}

interface EventSnapshot {
  permissions: PermissionEvent[];
  running: RunningEvent[];
  done: DoneEvent[];
}

type Filter = "all" | "permission" | "running" | "done";

// ─── Tauri bridge ───────────────────────────────────────────────────────────

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function getTauriInternals(): TauriInternals | null {
  const w = window as Window & { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = getTauriInternals();
  if (!tauri) throw new Error("not running inside Tauri");
  return (await tauri.invoke(cmd, args)) as T;
}

const EMPTY: EventSnapshot = { permissions: [], running: [], done: [] };

// ─── Utilities ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pickAllowOption(opts: PermissionOption[]): PermissionOption | null {
  return opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") ?? null;
}

function pickAlwaysOption(opts: PermissionOption[]): PermissionOption | null {
  return opts.find((o) => o.kind === "allow_always") ?? null;
}

function pickDenyOption(opts: PermissionOption[]): PermissionOption | null {
  return opts.find((o) => o.kind === "reject_once") ?? opts.find((o) => o.kind === "reject_always") ?? null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TrayPopover() {
  const [snapshot, setSnapshot] = useState<EventSnapshot>(EMPTY);
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());

  // Poll snapshot
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await invoke<EventSnapshot>("tray_get_events");
        if (!cancelled) setSnapshot(s);
      } catch {
        // Silently retry — Tauri may not be ready in dev mode
      }
    };
    tick();
    const id = window.setInterval(tick, 600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Live ticker for elapsed time and relative timestamps
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const counts = useMemo(
    () => ({
      all: snapshot.permissions.length + snapshot.running.length + snapshot.done.length,
      permission: snapshot.permissions.length,
      running: snapshot.running.length,
      done: snapshot.done.length,
    }),
    [snapshot],
  );

  const showPerms = filter === "all" || filter === "permission";
  const showRunning = filter === "all" || filter === "running";
  const showDone = filter === "all" || filter === "done";

  const handleResolve = async (perm: PermissionEvent, opt: PermissionOption | null) => {
    if (!opt) return;
    try {
      await invoke<void>("tray_resolve_permission", {
        projectId: perm.project_id,
        taskId: perm.task_id,
        chatId: perm.chat_id,
        optionId: opt.option_id,
      });
    } catch (e) {
      console.error("[tray] resolve failed", e);
    }
  };

  const handleDismiss = async (category: string, id: string) => {
    try {
      await invoke<void>("tray_dismiss", { category, id });
    } catch (e) {
      console.error("[tray] dismiss failed", e);
    }
  };

  const handleOpenMain = async () => {
    try {
      await invoke<void>("tray_open_main");
    } catch (e) {
      console.error("[tray] open_main failed", e);
    }
  };

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
      style={{
        borderRadius: 14,
        border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
        boxShadow:
          "0 20px 60px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.25), inset 0 1px 0 color-mix(in srgb, white 6%, transparent)",
      }}
    >
      {/* ── Header ── */}
      <header className="flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-4 pt-3.5 pb-3">
        <div
          className="h-[18px] w-[18px] rounded-md relative"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--color-highlight) 90%, white 10%), color-mix(in srgb, var(--color-highlight) 60%, transparent))",
            boxShadow:
              "0 0 0 1px color-mix(in srgb, var(--color-highlight) 40%, transparent), 0 0 12px -2px color-mix(in srgb, var(--color-highlight) 60%, transparent), inset 0 1px 0 rgba(255,255,255,0.25)",
          }}
        />
        <div className="flex-1 leading-tight">
          <div className="text-[13px] font-semibold">Grove</div>
          <div className="font-mono text-[11px] text-[var(--color-text-muted)]">
            <b className="font-medium text-[var(--color-highlight)]">{counts.running}</b> running
            {counts.permission > 0 ? (
              <>
                {" · "}
                <span className="text-[var(--color-warning)]">{counts.permission} pending</span>
              </>
            ) : null}
          </div>
        </div>
        <button
          onClick={handleOpenMain}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Open Grove"
        >
          <ExternalLink size={14} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Notification settings (open Grove → Settings)"
          onClick={handleOpenMain}
        >
          <Settings size={14} />
        </button>
      </header>

      {/* ── Filter chips ── */}
      <div className="flex gap-1.5 overflow-x-auto border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-3.5 py-2.5">
        <FilterChip
          active={filter === "all"}
          label="All"
          count={counts.all}
          onClick={() => setFilter("all")}
        />
        <FilterChip
          active={filter === "permission"}
          label="Permission"
          count={counts.permission}
          accent="warning"
          onClick={() => setFilter("permission")}
        />
        <FilterChip
          active={filter === "running"}
          label="Running"
          count={counts.running}
          accent="running"
          onClick={() => setFilter("running")}
        />
        <FilterChip
          active={filter === "done"}
          label="Done"
          count={counts.done}
          accent="highlight"
          onClick={() => setFilter("done")}
        />
      </div>

      {/* ── Event stream ── */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {counts.all === 0 ? (
          <EmptyState />
        ) : (
          <>
            {showPerms &&
              snapshot.permissions.map((p) => (
                <PermissionCard
                  key={p.id}
                  event={p}
                  now={now}
                  onAllow={() => handleResolve(p, pickAllowOption(p.options))}
                  onAlways={() => handleResolve(p, pickAlwaysOption(p.options))}
                  onDeny={() => handleResolve(p, pickDenyOption(p.options))}
                />
              ))}
            {showRunning &&
              snapshot.running.map((r) => (
                <RunningCard key={r.id} event={r} now={now} onOpen={handleOpenMain} />
              ))}
            {showDone &&
              snapshot.done.map((d) => (
                <DoneCard
                  key={d.id}
                  event={d}
                  now={now}
                  onOpen={handleOpenMain}
                  onDismiss={() => handleDismiss("done", d.id)}
                />
              ))}
          </>
        )}
      </div>

      {/* ── Footer ── */}
      <button
        className="flex items-center gap-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-3.5 py-2.5 text-[var(--color-text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_3%,transparent)]"
        onClick={handleOpenMain}
      >
        <Search size={13} />
        <span className="flex-1 text-left text-[12px]">Open Grove to search & manage</span>
        <span className="rounded border border-b-2 border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
          ⌘ K
        </span>
      </button>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

interface FilterChipProps {
  active: boolean;
  label: string;
  count: number;
  accent?: "warning" | "highlight" | "running";
  onClick: () => void;
}

function FilterChip({ active, label, count, accent, onClick }: FilterChipProps) {
  const accentColor =
    accent === "warning"
      ? "var(--color-warning)"
      : accent === "highlight"
        ? "var(--color-highlight)"
        : accent === "running"
          ? "var(--color-info)"
          : "var(--color-text)";
  const style = active
    ? accent
      ? {
          color: accentColor,
          borderColor: `color-mix(in srgb, ${accentColor} 40%, transparent)`,
          background: `color-mix(in srgb, ${accentColor} 10%, transparent)`,
        }
      : {
          color: "var(--color-text)",
          background: "var(--color-bg-tertiary)",
          borderColor: "color-mix(in srgb, var(--color-border) 100%, var(--color-text) 30%)",
        }
    : {};
  return (
    <button
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--color-border)_70%,transparent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
      style={style}
    >
      {label}
      <span
        className="rounded-full px-1.5 font-mono text-[10px]"
        style={{
          background: active && accent
            ? `color-mix(in srgb, ${accentColor} 18%, transparent)`
            : "color-mix(in srgb, var(--color-text) 8%, transparent)",
        }}
      >
        {count}
      </span>
    </button>
  );
}

function CardShell({
  accent,
  children,
}: {
  accent: "warning" | "highlight" | "running";
  children: React.ReactNode;
}) {
  const accentVar =
    accent === "warning"
      ? "var(--color-warning)"
      : accent === "highlight"
        ? "var(--color-highlight)"
        : "var(--color-info)";
  return (
    <div
      className="group relative mx-1 my-1 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_50%,transparent)] px-3 py-2.5 pl-3.5 transition-all hover:border-[color-mix(in_srgb,var(--color-border)_90%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-bg)_30%,transparent)]"
    >
      <span
        className="pointer-events-none absolute top-3 bottom-3 left-0 w-[2px] rounded-r"
        style={{
          background: accentVar,
          boxShadow: `0 0 8px color-mix(in srgb, ${accentVar} 60%, transparent)`,
        }}
      />
      {children}
    </div>
  );
}

function CardHead({
  category,
  accent,
  target,
  time,
  pulse,
  onDismiss,
}: {
  category: string;
  accent: "warning" | "highlight" | "running";
  target: { project: string; task: string };
  time: string;
  pulse?: boolean;
  onDismiss?: () => void;
}) {
  const accentVar =
    accent === "warning"
      ? "var(--color-warning)"
      : accent === "highlight"
        ? "var(--color-highlight)"
        : "var(--color-info)";
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1.2px]"
        style={{
          color: accentVar,
          background: `color-mix(in srgb, ${accentVar} 14%, transparent)`,
        }}
      >
        <span
          className={`h-[5px] w-[5px] rounded-full ${pulse ? "animate-pulse" : ""}`}
          style={{
            background: accentVar,
            boxShadow: `0 0 6px ${accentVar}`,
          }}
        />
        {category}
      </span>
      <span
        className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-[var(--color-text)]"
        title={`${target.project}/${target.task}`}
      >
        <span className="text-[var(--color-text-muted)]">{target.project}</span>
        <span className="mx-0.5 text-[var(--color-text-muted)]">/</span>
        {target.task}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{time}</span>
      {onDismiss ? (
        <button
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <X size={11} strokeWidth={2.4} />
        </button>
      ) : null}
    </div>
  );
}

function PermissionCard({
  event,
  now,
  onAllow,
  onAlways,
  onDeny,
}: {
  event: PermissionEvent;
  now: number;
  onAllow: () => void;
  onAlways: () => void;
  onDeny: () => void;
}) {
  const allow = pickAllowOption(event.options);
  const always = pickAlwaysOption(event.options);
  const deny = pickDenyOption(event.options);
  return (
    <CardShell accent="warning">
      <CardHead
        category="Permission"
        accent="warning"
        target={{ project: event.project_id.slice(0, 8), task: event.task_id }}
        time={formatRelative(event.created_at, now)}
        pulse
      />
      <div
        className="mb-2.5 break-all rounded-md border border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_80%,transparent)] px-2 py-1.5 font-mono text-[11.5px] leading-snug text-[var(--color-text)]"
      >
        <span className="mr-1.5 text-[var(--color-warning)]">▸</span>
        {event.description || "(no description)"}
      </div>
      <div className="flex gap-1.5">
        {allow ? (
          <button
            onClick={onAllow}
            className="h-7 flex-1 rounded-md border text-[11.5px] font-semibold transition-all"
            style={{
              background: "var(--color-warning)",
              borderColor: "var(--color-warning)",
              color: "#2a1a04",
              boxShadow:
                "0 0 0 1px color-mix(in srgb, var(--color-warning) 40%, transparent), 0 4px 14px -4px color-mix(in srgb, var(--color-warning) 60%, transparent)",
            }}
          >
            Allow
          </button>
        ) : null}
        {always ? (
          <button
            onClick={onAlways}
            className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 text-[11.5px] font-medium text-[var(--color-text)] transition-colors hover:border-[color-mix(in_srgb,var(--color-border)_60%,var(--color-text)_20%)] hover:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_60%,var(--color-text)_6%)]"
          >
            Always
          </button>
        ) : null}
        {deny ? (
          <button
            onClick={onDeny}
            className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 text-[11.5px] font-medium text-[var(--color-text)] transition-colors hover:border-[color-mix(in_srgb,var(--color-error)_50%,var(--color-border))] hover:text-[var(--color-error)]"
          >
            Deny
          </button>
        ) : null}
      </div>
    </CardShell>
  );
}

function RunningCard({
  event,
  now,
  onOpen,
}: {
  event: RunningEvent;
  now: number;
  onOpen: () => void;
}) {
  const elapsed = formatDuration(now - event.started_at);
  return (
    <CardShell accent="running">
      <CardHead
        category="Running"
        accent="running"
        target={{ project: event.project_id.slice(0, 8), task: event.task_id }}
        time={elapsed}
        pulse
      />
      {event.prompt ? (
        <div
          className="mb-2.5 line-clamp-2 rounded-lg border border-[color-mix(in_srgb,var(--color-info)_22%,transparent)] bg-[color-mix(in_srgb,var(--color-info)_8%,transparent)] px-2.5 py-2 text-[12px] leading-snug text-[color-mix(in_srgb,var(--color-text)_92%,transparent)]"
        >
          {event.prompt}
        </div>
      ) : null}
      {/* indeterminate progress bar */}
      <div className="mb-2.5 flex items-center gap-2 font-mono text-[10.5px] text-[var(--color-text-muted)]">
        <span style={{ color: "var(--color-info)" }}>{elapsed}</span>
        <div className="relative h-[3px] flex-1 overflow-hidden rounded-sm bg-[color-mix(in_srgb,var(--color-bg)_80%,transparent)]">
          <div
            className="absolute inset-0 animate-[barSlide_1.6s_linear_infinite]"
            style={{
              background:
                "linear-gradient(90deg, transparent, var(--color-info), color-mix(in srgb, var(--color-info) 60%, white 30%), var(--color-info), transparent)",
              backgroundSize: "50% 100%",
              backgroundRepeat: "no-repeat",
            }}
          />
        </div>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onOpen}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 text-[11.5px] font-medium text-[var(--color-text)] transition-colors hover:border-[color-mix(in_srgb,var(--color-border)_60%,var(--color-text)_20%)] hover:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_60%,var(--color-text)_6%)]"
        >
          Open <ExternalLink size={11} className="opacity-60" />
        </button>
      </div>
    </CardShell>
  );
}

function DoneCard({
  event,
  now,
  onOpen,
  onDismiss,
}: {
  event: DoneEvent;
  now: number;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <CardShell accent="highlight">
      <CardHead
        category="Done"
        accent="highlight"
        target={{ project: event.project_id.slice(0, 8), task: event.task_id }}
        time={formatRelative(event.created_at, now)}
        onDismiss={onDismiss}
      />
      {event.message ? (
        <div className="mb-2.5 line-clamp-3 text-[12px] leading-snug text-[color-mix(in_srgb,var(--color-text)_88%,transparent)]">
          <span className="mr-1 text-[var(--color-text-muted)]">"</span>
          {event.message}
        </div>
      ) : (
        <div className="mb-2.5 text-[12px] italic text-[var(--color-text-muted)]">
          {event.level === "critical" ? "Critical hook fired." : event.level === "warn" ? "Warn hook fired." : "Notice hook fired."}
        </div>
      )}
      <div className="flex gap-1.5">
        <button
          onClick={onOpen}
          className="inline-flex h-7 items-center gap-1 rounded-md px-3 text-[11.5px] font-semibold transition-all"
          style={{
            background: "var(--color-highlight)",
            borderColor: "var(--color-highlight)",
            color: "#04221a",
            boxShadow:
              "0 0 0 1px color-mix(in srgb, var(--color-highlight) 40%, transparent), 0 4px 14px -4px color-mix(in srgb, var(--color-highlight) 60%, transparent)",
          }}
        >
          Open <ExternalLink size={11} className="opacity-60" />
        </button>
      </div>
    </CardShell>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center text-[var(--color-text-muted)]">
      <div
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl"
        style={{
          background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)",
          color: "var(--color-highlight)",
        }}
      >
        <span className="text-lg leading-none">✓</span>
      </div>
      <div className="mb-1 text-[13px] font-medium text-[var(--color-text)]">All clear</div>
      <div className="text-[11.5px]">No active sessions, permissions, or recent events.</div>
    </div>
  );
}
