import { motion } from "framer-motion";

interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label?: string;
  description?: string;
}

export function Toggle({ enabled, onChange, label, description }: ToggleProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        {label && <div className="font-medium text-[var(--color-text)] text-sm">{label}</div>}
        {description && (
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{description}</div>
        )}
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[var(--color-highlight)] focus:ring-offset-2 focus:ring-offset-[var(--color-bg)]
          ${enabled ? "bg-[var(--color-highlight)]" : "bg-[var(--color-border)]"}`}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm
            ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
