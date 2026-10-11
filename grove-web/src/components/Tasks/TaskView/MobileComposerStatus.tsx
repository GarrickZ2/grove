import type { ComponentType } from "react";
import { BookOpen, Brain, CircleAlert, Database, ListPlus, ListTodo, MessageSquarePlus } from "lucide-react";
import { contextHealthColor, quotaBatteryIcon, quotaHealthColor } from "./quotaColors";

export type MobileComposerPanel = "pending" | "todo" | "quota" | "context" | "memory" | "plan" | "previewComments";

export const mobileComposerPanelTitles: Record<MobileComposerPanel, string> = {
  pending: "Pending messages",
  todo: "Todo",
  quota: "Agent quota",
  context: "Context usage",
  memory: "Read memory",
  plan: "Plan",
  previewComments: "Preview comments",
};

interface MobileComposerStatusProps {
  pendingCount: number;
  failedCount: number;
  completedTodos: number;
  totalTodos: number;
  quotaPercent: number | null;
  quotaOutdated: boolean;
  contextPercent: number | null;
  memoryCount: number;
  hasPlan: boolean;
  commentCount: number;
  activePanel: MobileComposerPanel | null;
  disabled: boolean;
  onOpen: (panel: MobileComposerPanel) => void;
}

interface StatusItem {
  panel: MobileComposerPanel;
  Icon: ComponentType<{ className?: string }>;
  label: string;
  detail: string;
  color?: string;
}

/** Compact status controls shown inside the expanded phone composer. */
export function MobileComposerStatus({
  pendingCount, failedCount, completedTodos, totalTodos, quotaPercent,
  quotaOutdated, contextPercent, memoryCount, hasPlan, commentCount,
  activePanel, disabled, onOpen,
}: MobileComposerStatusProps) {
  const QuotaIcon = quotaBatteryIcon(quotaPercent ?? 0);
  const items: StatusItem[] = [
    ...(pendingCount > 0 ? [{ panel: "pending" as const, Icon: failedCount > 0 ? CircleAlert : ListPlus, label: `Pending ${pendingCount}`, detail: `${pendingCount} pending messages${failedCount > 0 ? `, ${failedCount} failed to send` : ""}`, color: failedCount > 0 ? "var(--color-error)" : undefined }] : []),
    ...(totalTodos > 0 ? [{ panel: "todo" as const, Icon: ListTodo, label: `Todo ${completedTodos}/${totalTodos}`, detail: `${completedTodos} of ${totalTodos} todos completed` }] : []),
    ...(quotaPercent !== null ? [{ panel: "quota" as const, Icon: QuotaIcon, label: `${quotaPercent}%`, detail: `Agent quota: ${quotaPercent}% remaining${quotaOutdated ? ". Data may be outdated" : ""}`, color: quotaHealthColor(quotaPercent) }] : []),
    ...(contextPercent !== null ? [{ panel: "context" as const, Icon: Brain, label: `${contextPercent}%`, detail: `Context window: ${contextPercent}% used`, color: contextHealthColor(contextPercent) }] : []),
    ...(memoryCount > 0 ? [{ panel: "memory" as const, Icon: Database, label: `Memory ${memoryCount}`, detail: `${memoryCount} memories read by the agent` }] : []),
    ...(hasPlan ? [{ panel: "plan" as const, Icon: BookOpen, label: "Plan", detail: "View the agent's plan" }] : []),
    ...(commentCount > 0 ? [{ panel: "previewComments" as const, Icon: MessageSquarePlus, label: `Comments ${commentCount}`, detail: `${commentCount} preview comments` }] : []),
  ];
  if (items.length === 0) return null;

  return (
    <div className="mobile-composer-status pointer-events-auto relative mx-auto mb-1 w-full max-w-[920px]">
      <div className="mobile-composer-status-scroll flex items-center gap-1 overflow-x-auto overscroll-x-contain" aria-label="Session status">
        {items.map(({ panel, Icon, label, detail, color }) => (
          <button
            key={panel}
            type="button"
            disabled={disabled}
            aria-label={detail}
            aria-haspopup="dialog"
            aria-expanded={activePanel === panel}
            onClick={() => onOpen(panel)}
            className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium tabular-nums transition-colors disabled:opacity-45 ${activePanel === panel ? "bg-[color-mix(in_srgb,var(--color-highlight)_12%,var(--color-bg))]" : "bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)]"}`}
            style={{ color: color ?? "var(--color-text-muted)" }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
