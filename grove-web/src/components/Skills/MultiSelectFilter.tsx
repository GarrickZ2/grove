import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export interface MultiSelectOption {
  value: string;
  label: string;
  description?: string;
  count?: number;
  icon?: ReactNode;
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = (value: string) => {
    onChange(selected.includes(value)
      ? selected.filter((candidate) => candidate !== value)
      : [...selected, value]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-9 min-w-0 items-center justify-between gap-3 rounded-lg border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)]/30 sm:min-w-[132px] ${
          selected.length > 0
            ? "border-[var(--color-highlight)]/45 bg-[var(--color-highlight)]/8 text-[var(--color-text)]"
            : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]/45"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{label}</span>
          {selected.length > 0 && <span className="rounded-full bg-[var(--color-highlight)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{selected.length}</span>}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div role="listbox" aria-multiselectable="true" className="fixed inset-x-3 bottom-3 z-50 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5 shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:mt-1.5 sm:w-64 sm:rounded-xl">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-semibold text-[var(--color-text)]">{label}</span>
            {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="h-3 w-3" />Clear</button>}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {options.map((option) => {
              const active = selected.includes(option.value);
              return (
                <button key={option.value} type="button" role="option" aria-selected={active} onClick={() => toggle(option.value)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--color-bg-secondary)]">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${active ? "border-[var(--color-highlight)] bg-[var(--color-highlight)] text-white" : "border-[var(--color-border)]"}`}>{active && <Check className="h-3 w-3" />}</span>
                  {option.icon && <span className="flex h-7 w-7 shrink-0 items-center justify-center">{option.icon}</span>}
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm text-[var(--color-text)]">{option.label}</span>{option.description && <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">{option.description}</span>}</span>
                  {option.count !== undefined && <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{option.count}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
