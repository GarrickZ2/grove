import type { GridLayout } from "./useBlitzGrid";
import { GRID_LAYOUTS } from "./useBlitzGrid";

const LABELS: Record<GridLayout, string> = {
  "1": "1",
  "2": "2",
  "2x2": "2×2",
  "3x2": "3×2",
};

interface GridLayoutToolbarProps {
  current: GridLayout;
  onChange: (next: GridLayout) => void;
}

export function GridLayoutToolbar({ current, onChange }: GridLayoutToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Grid layout"
      className="flex items-center gap-1 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
    >
      <span className="text-xs text-[var(--color-text-muted)] mr-2">Layout</span>
      {GRID_LAYOUTS.map((preset) => {
        const active = preset === current;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(preset)}
            className={[
              "px-2.5 py-1 text-xs rounded-md transition-all",
              active
                ? "bg-[var(--color-accent)] text-[var(--color-bg)] font-semibold"
                : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:brightness-125 hover:text-[var(--color-text)]",
            ].join(" ")}
          >
            {LABELS[preset]}
          </button>
        );
      })}
    </div>
  );
}
