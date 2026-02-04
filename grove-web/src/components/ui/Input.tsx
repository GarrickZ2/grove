import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className = "", ...props }: InputProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
          {label}
        </label>
      )}
      <input
        className={`w-full px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
          text-[var(--color-text)] placeholder-[var(--color-text-muted)] text-sm
          focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
          transition-all duration-200
          ${error ? "border-[var(--color-error)]" : ""}
          ${className}`}
        {...props}
      />
      {error && <p className="mt-1.5 text-sm text-[var(--color-error)]">{error}</p>}
    </div>
  );
}
