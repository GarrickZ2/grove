import { ShieldCheck, TerminalSquare } from "lucide-react";
import type { PluginReview as Review, PluginStatus } from "../../api/plugins";
import { reviewRisks, type Tone } from "./pluginReviewRisks";

const TONE_CLASS: Record<Tone, string> = {
  danger: "border-[var(--color-error)]/30 bg-[var(--color-error)]/6 text-[var(--color-error)]",
  warning: "border-[var(--color-warning)]/30 bg-[var(--color-warning)]/6 text-[var(--color-warning)]",
  neutral: "border-[var(--color-border)] text-[var(--color-text-secondary)]",
};

const STATUS_NOTICE: Record<Exclude<PluginStatus, "active">, string> = {
  pending: "This plugin is not running. Nothing below takes effect until you enable it.",
  changed: "This plugin now asks for more than you approved, so it has been paused until you review it again.",
};

export function PluginReviewSection({ review, status }: { review: Review | null | undefined; status: PluginStatus }) {
  if (!review) {
    return <p className="mt-2 text-sm text-[var(--color-text-muted)]">The plugin manifest could not be read.</p>;
  }
  const risks = reviewRisks(review);
  return (
    <div className="mt-3 space-y-2">
      {status !== "active" && (
        <p role="status" className="rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 px-3.5 py-2.5 text-sm text-[var(--color-text)]">
          {STATUS_NOTICE[status]}
        </p>
      )}
      {risks.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3.5 py-3 text-sm text-[var(--color-text-secondary)]">
          <ShieldCheck className="h-4 w-4 text-[var(--color-success)]" />
          No elevated capabilities.
        </div>
      ) : risks.map(({ id, tone, icon: Icon, title, details }) => (
        <div key={id} data-risk={id} className={`rounded-xl border px-3.5 py-3 ${TONE_CLASS[tone]}`}>
          <div className="flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4 shrink-0" />{title}</div>
          <ul className="mt-1.5 space-y-0.5 pl-6 text-xs text-[var(--color-text-secondary)]">
            {details.map((detail) => <li key={detail}>{detail}</li>)}
          </ul>
        </div>
      ))}
      {review.processes.map((process) => (
        <div key={process.kind} className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] px-3.5 py-2.5">
          <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-[var(--color-text-muted)]">
              Runs {process.kind === "mcp" ? "an MCP server" : "a backend"} · {process.sandboxed ? "sandboxed" : "not sandboxed"}
            </div>
            <code className="mt-0.5 block truncate text-xs text-[var(--color-text-secondary)]" title={[process.command, ...process.args].join(" ")}>
              {[process.command, ...process.args].join(" ")}
            </code>
          </div>
        </div>
      ))}
    </div>
  );
}
