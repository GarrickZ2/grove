import { useEffect, useRef } from "react";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

interface PreviewSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  total: number;
  /** 0-indexed; -1 when there are no matches */
  current: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Optional positioning override. Default: top-right of nearest positioned ancestor. */
  className?: string;
}

export function PreviewSearchBar({
  query,
  onQueryChange,
  total,
  current,
  onNext,
  onPrev,
  onClose,
  className,
}: PreviewSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEscapeScope(true, onClose);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const positionClass = className ?? "absolute right-3 top-3 z-[60]";

  return (
    <div
      data-grove-search-bar="true"
      className={`${positionClass} flex items-center gap-1 rounded-lg border px-1.5 py-1 shadow-lg`}
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-border)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Search className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-text-muted)" }} />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Find"
        spellCheck={false}
        className="w-44 bg-transparent px-1 text-[12px] outline-none"
        style={{ color: "var(--color-text)" }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
            return;
          }
        }}
      />
      <span
        className="px-1 text-[10px] tabular-nums"
        style={{ color: total === 0 && query ? "var(--color-error)" : "var(--color-text-muted)", minWidth: 32, textAlign: "right" }}
      >
        {query ? (total === 0 ? "0" : `${current + 1}/${total}`) : ""}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={total === 0}
        className="rounded-md p-1 disabled:opacity-30"
        style={{ color: "var(--color-text-muted)" }}
        title="Previous (Shift+Enter)"
        onMouseEnter={(e) => { if (total > 0) e.currentTarget.style.background = "var(--color-bg-tertiary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={total === 0}
        className="rounded-md p-1 disabled:opacity-30"
        style={{ color: "var(--color-text-muted)" }}
        title="Next (Enter)"
        onMouseEnter={(e) => { if (total > 0) e.currentTarget.style.background = "var(--color-bg-tertiary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md p-1"
        style={{ color: "var(--color-text-muted)" }}
        title="Close (Esc)"
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
