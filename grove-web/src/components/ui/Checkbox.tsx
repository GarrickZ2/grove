import type { ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * House-style checkbox — a visually-hidden native input (keeps accessibility
 * + keyboard support) behind a custom box that uses the app's theme tokens,
 * so it never renders as an off-brand OS control. Use this instead of a bare
 * `<input type="checkbox">` anywhere the surrounding UI is themed.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={["flex items-center gap-2 cursor-pointer select-none", className ?? ""].join(" ")}
    >
      <span className="relative inline-flex items-center justify-center flex-shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="w-4 h-4 rounded-[5px] border border-[var(--color-border)] bg-[var(--color-bg)] transition-colors flex items-center justify-center peer-checked:bg-[var(--color-highlight)] peer-checked:border-[var(--color-highlight)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-highlight)]/40">
          {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
        </span>
      </span>
      {label}
    </label>
  );
}
