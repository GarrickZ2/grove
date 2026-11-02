import type React from "react";
import { motion, AnimatePresence } from "framer-motion";

interface NotifChannelProps {
  title: string;
  subtitle: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  showPermission: boolean;
  onShowPermissionChange: (v: boolean) => void;
  showDone: boolean;
  onShowDoneChange: (v: boolean) => void;
  showRunning?: boolean;
  onShowRunningChange?: (v: boolean) => void;
  note?: string;
  /** Optional slot rendered inside the expanded body, below the toggles
   *  (e.g. a shortcut recorder for the menubar channel). */
  extraControl?: React.ReactNode;
}

export function NotifChannel({
  title,
  subtitle,
  enabled,
  onEnabledChange,
  showPermission,
  onShowPermissionChange,
  showDone,
  onShowDoneChange,
  showRunning,
  onShowRunningChange,
  note,
  extraControl,
}: NotifChannelProps) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{subtitle}</div>
        </div>
        <ToggleSwitch checked={enabled} onChange={onEnabledChange} />
      </div>
      <AnimatePresence initial={false}>
        {enabled ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] pt-3">
              <CategoryToggle
                label="Permission required"
                description="Pending tool-call approvals"
                accent="var(--color-warning)"
                checked={showPermission}
                onChange={onShowPermissionChange}
              />
              <CategoryToggle
                label="Turn completed"
                description="Hooks fired by finished agent turns"
                accent="var(--color-highlight)"
                checked={showDone}
                onChange={onShowDoneChange}
              />
              {showRunning !== undefined && onShowRunningChange && (
                <CategoryToggle
                  label="Running session"
                  description="Tasks actively processing a prompt"
                  accent="var(--color-info)"
                  checked={showRunning}
                  onChange={onShowRunningChange}
                />
              )}
            </div>
            {extraControl ? (
              <div className="mt-3 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] pt-3">
                {extraControl}
              </div>
            ) : null}
            {note ? (
              <div className="mt-3 text-[11px] italic text-[var(--color-text-muted)]">{note}</div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CategoryToggle({
  label,
  description,
  accent,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  accent: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="flex items-center gap-2.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
        />
        <div>
          <div className="text-[13px] text-[var(--color-text)]">{label}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">{description}</div>
        </div>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} />
    </div>
  );
}

export function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative h-[20px] w-[34px] rounded-full border transition-all"
      style={{
        background: checked ? "color-mix(in srgb, var(--color-highlight) 70%, transparent)" : "var(--color-bg-tertiary)",
        borderColor: checked ? "var(--color-highlight)" : "var(--color-border)",
      }}
    >
      <motion.span
        className="absolute top-[1px] block h-[16px] w-[16px] rounded-full"
        animate={{ left: checked ? 15 : 1, background: checked ? "#ffffff" : "var(--color-text-muted)" }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
    </button>
  );
}
