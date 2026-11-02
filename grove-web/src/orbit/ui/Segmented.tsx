import type { CSSProperties } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Small muted count after the label (e.g. items in that view). */
  count?: number;
  disabled?: boolean;
  title?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `sm` sits in card heads and toolbars next to small buttons. */
  size?: "md" | "sm";
  /** Stretch to the container's width. */
  block?: boolean;
  className?: string;
}

/**
 * Segmented control. One thumb, positioned from the selected index (columns
 * are equal width), so it slides to the new option and can never sit on a
 * different option than the one that's checked.
 */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel, size = "md", block = false, className }: SegmentedProps<T>) {
  const index = options.findIndex((option) => option.value === value);
  const thumb = { width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${Math.max(0, index) * 100}%)` } as CSSProperties;
  return (
    <div
      className={`oui-seg${size === "sm" ? " is-sm" : ""}${block ? " is-block" : ""}${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {index >= 0 ? <span className="oui-seg-thumb" style={thumb} aria-hidden="true" /> : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.title}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={`oui-seg-btn${selected ? " is-sel" : ""}`}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? <small key={option.count} className="oui-seg-n">{option.count}</small> : null}
          </button>
        );
      })}
    </div>
  );
}
