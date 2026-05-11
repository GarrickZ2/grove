import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Search } from "lucide-react";

export interface RichPickerItem {
  id: string;
  /** Visual leading element (typically a colored icon square or avatar). */
  visual: React.ReactNode;
  label: string;
  sublabel?: string;
  /** Optional searchable string in addition to label / sublabel. */
  searchExtras?: string;
}

interface RichPickerProps {
  items: RichPickerItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  placeholder?: string;
  searchable?: boolean;
  /** Allow clearing the selection. Shown as a "(none)" row when true. */
  clearable?: boolean;
  clearLabel?: string;
  clearVisual?: React.ReactNode;
  disabled?: boolean;
  triggerClass?: string;
}

/**
 * Dropdown picker that renders rich rows (icon + label + sublabel) — the same
 * idiom as Grove's ProjectSelector. Portals the popover so it escapes any
 * clipping ancestors (drawers, dialogs).
 */
export function RichPicker({
  items,
  selectedId,
  onSelect,
  placeholder = "Select...",
  searchable,
  clearable,
  clearLabel = "Unassigned",
  clearVisual,
  disabled,
  triggerClass,
}: RichPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((it) =>
      [it.label, it.sublabel, it.searchExtras]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q))
    );
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    setOpen((v) => !v);
  }

  const selected = items.find((it) => it.id === selectedId) ?? null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={
          triggerClass ??
          "w-full flex items-center gap-2 px-2.5 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg hover:border-[var(--color-text-muted)]/40 focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60 transition-colors"
        }
      >
        {selected ? (
          <>
            <span className="flex-shrink-0">{selected.visual}</span>
            <span className="flex-1 min-w-0 text-left">
              <span className="block text-sm text-[var(--color-text)] truncate">{selected.label}</span>
              {selected.sublabel && (
                <span className="block text-[10.5px] text-[var(--color-text-muted)] truncate font-mono">
                  {selected.sublabel}
                </span>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="flex-shrink-0">{clearVisual ?? <span className="w-7 h-7" />}</span>
            <span className="flex-1 text-left text-sm text-[var(--color-text-muted)]">{placeholder}</span>
          </>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)] flex-shrink-0" />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={popoverRef}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12 }}
              className="fixed z-[10000] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden"
              style={{ top: pos.top, left: pos.left, width: Math.max(pos.width, 260) }}
            >
              {searchable && (
                <div className="relative border-b border-[var(--color-border)]">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter..."
                    className="w-full pl-8 pr-3 py-2 bg-transparent text-sm text-[var(--color-text)] focus:outline-none"
                  />
                </div>
              )}
              <div className="max-h-[280px] overflow-y-auto py-1">
                {clearable && (
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(null);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-secondary)] transition-colors ${
                      selectedId === null ? "bg-[var(--color-highlight)]/5" : ""
                    }`}
                  >
                    <span className="flex-shrink-0">
                      {clearVisual ?? <span className="w-7 h-7 inline-block" />}
                    </span>
                    <span className="flex-1 text-left text-sm text-[var(--color-text-muted)]">
                      {clearLabel}
                    </span>
                    {selectedId === null && (
                      <Check className="w-3.5 h-3.5 text-[var(--color-highlight)]" />
                    )}
                  </button>
                )}
                {filtered.length === 0 ? (
                  <div className="px-3 py-3 text-[11.5px] text-[var(--color-text-muted)] text-center">
                    No matches
                  </div>
                ) : (
                  filtered.map((it) => {
                    const isSel = it.id === selectedId;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => {
                          onSelect(it.id);
                          setOpen(false);
                          setQuery("");
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-[var(--color-bg-secondary)] transition-colors ${
                          isSel ? "bg-[var(--color-highlight)]/5" : ""
                        }`}
                      >
                        <span className="flex-shrink-0">{it.visual}</span>
                        <span className="flex-1 min-w-0 text-left">
                          <span className="block text-sm font-medium text-[var(--color-text)] truncate">
                            {it.label}
                          </span>
                          {it.sublabel && (
                            <span className="block text-[10.5px] text-[var(--color-text-muted)] truncate font-mono">
                              {it.sublabel}
                            </span>
                          )}
                        </span>
                        {isSel && (
                          <Check className="w-3.5 h-3.5 text-[var(--color-highlight)] flex-shrink-0" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}

interface ProjectIconSquareProps {
  color: { bg: string; fg: string };
  Icon: React.ElementType;
  size?: number;
}

export function ProjectIconSquare({ color, Icon, size = 28 }: ProjectIconSquareProps) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-md flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: color.bg }}
    >
      <Icon style={{ color: color.fg, width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}
