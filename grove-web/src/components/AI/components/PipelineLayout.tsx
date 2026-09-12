import type { ElementType, ReactNode } from "react";
import { SettingsFitFrame } from "./SettingsFitFrame";

export interface SettingsModeItem {
  id: string;
  label: string;
  icon: ElementType;
  count?: number;
}

export function SettingsModeSwitch({
  items,
  activeId,
  onChange,
}: {
  items: SettingsModeItem[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-xl bg-[var(--color-bg-secondary)] p-1">
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-pressed={active}
            className={`inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors sm:min-w-28 sm:flex-none ${
              active
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <Icon className={`h-4 w-4 ${active ? "text-[var(--color-highlight)]" : ""}`} />
            {item.label}
            {typeof item.count === "number" && (
              <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsToggle({ enabled, onToggle, disabled = false, label }: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={label}
      aria-pressed={enabled}
      className={`inline-flex h-7 min-w-12 items-center rounded-full border px-1 transition-colors ${
        disabled
          ? "cursor-not-allowed justify-start border-[var(--color-border)] bg-[var(--color-bg-secondary)] opacity-45"
          : enabled
            ? "justify-end border-[var(--color-highlight)]/50 bg-[var(--color-highlight)]/15"
            : "justify-start border-[var(--color-border)] bg-[var(--color-bg)]"
      }`}
    >
      <span className={`h-5 w-5 rounded-full ${enabled ? "bg-[var(--color-highlight)]" : "bg-[var(--color-text-muted)]/50"}`} />
    </button>
  );
}

export function PipelineSection({
  step,
  title,
  icon: Icon,
  enabled,
  onToggle,
  toggleDisabled = false,
  hideHeader = false,
  className = "",
  contentClassName = "",
  fitContent = true,
  children,
}: {
  step: string;
  title: string;
  icon: ElementType;
  enabled?: boolean;
  onToggle?: () => void;
  toggleDisabled?: boolean;
  hideHeader?: boolean;
  className?: string;
  contentClassName?: string;
  fitContent?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] ${className}`}>
      {!hideHeader && <div className="border-b border-[var(--color-border)] px-5 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]">
              <Icon className="h-5 w-5" />
            </div>
            <div>
              {step && <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-highlight)]">{step}</div>}
              <h2 className={step ? "mt-1 text-base font-semibold text-[var(--color-text)]" : "text-base font-semibold text-[var(--color-text)]"}>{title}</h2>
            </div>
          </div>
          {typeof enabled === "boolean" && onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              disabled={toggleDisabled}
              aria-pressed={enabled}
              className={`inline-flex h-7 min-w-12 items-center rounded-full border px-1 transition-colors ${
                toggleDisabled
                  ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)] opacity-45"
                  : enabled
                    ? "justify-end border-[var(--color-highlight)]/50 bg-[var(--color-highlight)]/15"
                    : "justify-start border-[var(--color-border)] bg-[var(--color-bg)]"
              }`}
            >
              <div
                className={`h-5 w-5 rounded-full ${
                  enabled ? "bg-[var(--color-highlight)]" : "bg-[var(--color-text-muted)]/50"
                }`}
              />
            </button>
          ) : null}
        </div>
      </div>}
      <div className="min-h-0 flex-1 overflow-visible md:overflow-hidden">
        {fitContent ? (
          <SettingsFitFrame>
            <div className={`space-y-6 px-5 py-5 sm:px-6 ${contentClassName}`}>{children}</div>
          </SettingsFitFrame>
        ) : (
          <div className={`h-full min-h-0 px-5 py-5 sm:px-6 ${contentClassName}`}>{children}</div>
        )}
      </div>
    </section>
  );
}

export function FieldGroup({
  title,
  hint,
  inlineHint = false,
  className = "",
  children,
}: {
  title: string;
  hint?: string;
  inlineHint?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`space-y-3 ${className}`}>
      <div className={inlineHint ? "flex flex-wrap items-baseline gap-x-3 gap-y-1" : ""}>
        <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
        {hint ? (
          <div
            className={inlineHint
              ? "text-xs leading-5 text-[var(--color-text-muted)]"
              : "mt-1 text-xs leading-5 text-[var(--color-text-muted)]"}
          >
            {hint}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
