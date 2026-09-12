import { Puzzle, Server, Wrench } from "lucide-react";
import type { ReactNode } from "react";

export function TableFrame({
  facets,
  children,
}: {
  facets?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-visible rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm md:overflow-hidden">
      {facets}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const STATUS_CLASSES: Record<StatusTone, string> = {
  success: "bg-[var(--color-success)]/12 text-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]/14 text-[var(--color-warning)]",
  danger: "bg-[var(--color-error)]/12 text-[var(--color-error)]",
  info: "bg-[var(--color-info)]/12 text-[var(--color-info)]",
  neutral: "bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]",
};

export function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: StatusTone;
}) {
  return (
    <span
      className={`inline-flex w-fit max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[tone]}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ExtensionTypeIcon({ kind, name, compact = false }: { kind: "skill" | "plugin" | "mcp"; name?: string; compact?: boolean }) {
  const box = compact ? "h-7 w-7 rounded-lg" : "h-10 w-10 rounded-xl";
  const glyph = compact ? "h-3.5 w-3.5" : "h-[18px] w-[18px]";
  if (kind === "skill") {
    return (
      <span className={`flex shrink-0 items-center justify-center bg-emerald-500/14 text-emerald-600 dark:text-emerald-400 ${box}`}>
        {name ? <span className="text-xs font-bold uppercase tracking-tight">{initials(name)}</span> : <Wrench className={glyph} />}
      </span>
    );
  }
  if (kind === "plugin") {
    return (
      <span className={`flex shrink-0 items-center justify-center bg-violet-500/14 text-violet-600 dark:text-violet-400 ${box}`}>
        <Puzzle className={glyph} />
      </span>
    );
  }
  return (
    <span className={`flex shrink-0 items-center justify-center bg-sky-500/14 text-sky-600 dark:text-sky-400 ${box}`}>
      <Server className={glyph} />
    </span>
  );
}

function initials(name: string) {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`;
  return name.slice(0, 2);
}

export function TableEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16 text-center">
      <div className="max-w-sm">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-[var(--color-text-muted)]">{description}</p>
      </div>
    </div>
  );
}
