import { Sparkles, Laptop, Code } from "lucide-react";
import { agentOptions } from "../../data/agents";
import type { SessionBinding } from "./types";
import { SESSION_STATUS_META, sessionTimingLabel } from "./utils";

interface AgentBadgeProps {
  agentId?: string;
  tintVar: string;
  size?: number;
}

function AgentBadge({ agentId, tintVar, size = 22 }: AgentBadgeProps) {
  const meta = agentId ? agentOptions.find((a) => a.id === agentId) : undefined;
  const Icon = meta?.icon;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${tintVar} 14%, transparent)`,
      }}
      title={meta?.label ?? "Agent session"}
    >
      {Icon ? (
        <Icon size={Math.round(size * 0.58)} />
      ) : (
        <Sparkles className="text-[var(--color-text-muted)]" style={{ width: size * 0.58, height: size * 0.58 }} />
      )}
    </span>
  );
}

interface SessionRowProps {
  session: SessionBinding;
  compact?: boolean;
}

/**
 * Single inline session row for a Board card. Visual model borrowed from the
 * menubar Tray:
 *  - `working`  → highlight tone, agent badge, prompt preview, optional plan
 *                 progress strip, elapsed time
 *  - `idle`     → muted-warning tone, smaller row, elapsed time
 *  - `failed`   → error tone
 *  - `done`     → minimal row, duration
 */
export function SessionRow({ session, compact }: SessionRowProps) {
  const meta = SESSION_STATUS_META[session.status];
  const time = sessionTimingLabel({
    status: session.status,
    elapsedSeconds: session.elapsedSeconds,
    durationSeconds: session.durationSeconds,
  });
  const TaskIcon = session.taskKind === "local" ? Laptop : Code;

  if (session.status === "done" || (compact && session.status === "idle")) {
    return (
      <div
        className="flex items-center gap-2 px-1.5 py-1 rounded-md"
        style={{
          background: `color-mix(in srgb, ${meta.tintVar} 4%, transparent)`,
        }}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
        <span className={`text-[10.5px] font-medium uppercase tracking-wider ${meta.text}`}>
          {meta.label}
        </span>
        <span className="text-[10.5px] text-[var(--color-text-muted)] truncate flex-1 min-w-0">
          {session.preview ?? session.taskName}
        </span>
        {time && (
          <span className="font-mono text-[10px] text-[var(--color-text-muted)] flex-shrink-0">
            {time}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border px-1.5 py-1.5"
      style={{
        background: `color-mix(in srgb, ${meta.tintVar} 5%, transparent)`,
        borderColor: `color-mix(in srgb, ${meta.tintVar} 22%, transparent)`,
      }}
    >
      <div className="flex items-center gap-2">
        <AgentBadge agentId={session.agentId} tintVar={meta.tintVar} size={20} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${meta.text}`}>
              {meta.label}
            </span>
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--color-text-muted)] min-w-0">
              <TaskIcon className="w-2.5 h-2.5 flex-shrink-0" />
              <span className="truncate">{session.taskName}</span>
            </span>
          </div>
          {session.preview && (
            <div className="text-[11px] text-[var(--color-text)] truncate leading-snug mt-0.5">
              {session.preview}
            </div>
          )}
        </div>
        {time && (
          <span className={`font-mono text-[10px] flex-shrink-0 ${session.status === "working" ? meta.text : "text-[var(--color-text-muted)]"}`}>
            {time}
          </span>
        )}
      </div>

      {session.status === "working" && (
        <ProgressStrip
          completed={session.todoCompleted}
          total={session.todoTotal}
          tintVar={meta.tintVar}
        />
      )}
    </div>
  );
}

interface ProgressStripProps {
  completed?: number;
  total?: number;
  tintVar: string;
}

function ProgressStrip({ completed, total, tintVar }: ProgressStripProps) {
  const hasPlan = total != null && total > 0;
  const pct = hasPlan ? Math.min(100, Math.round(((completed ?? 0) / total) * 100)) : 0;

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <div
        className="relative h-[2px] flex-1 overflow-hidden"
        style={{ background: `color-mix(in srgb, ${tintVar} 15%, transparent)` }}
      >
        {hasPlan && (
          <div
            className="absolute left-0 top-0 h-full transition-[width] duration-300"
            style={{ width: `${pct}%`, background: tintVar }}
          />
        )}
        {(!hasPlan || pct < 100) && (
          <div
            className="absolute top-0 h-full overflow-hidden"
            style={{ left: hasPlan ? `${pct}%` : 0, right: 0 }}
          >
            <div
              className="h-full w-1/3 animate-[trayRunPulse_1.6s_ease-in-out_infinite]"
              style={{ background: tintVar }}
            />
          </div>
        )}
      </div>
      {hasPlan && (
        <span className="font-mono text-[9.5px] text-[var(--color-text-muted)]">
          {completed ?? 0}/{total}
        </span>
      )}
    </div>
  );
}
