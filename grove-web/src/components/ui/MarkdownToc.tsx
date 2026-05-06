import { useEffect, useMemo, useState, type RefObject } from "react";

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

export function TocPanel({
  entries,
  scrollRoot,
  onEntryClick,
}: {
  entries: TocEntry[];
  scrollRoot?: RefObject<HTMLElement | null>;
  onEntryClick?: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const minLevel = useMemo(
    () => entries.reduce((m, e) => Math.min(m, e.level), 6),
    [entries],
  );

  useEffect(() => {
    const root = scrollRoot?.current;
    if (!root || entries.length === 0) return;
    // Resolve heading elements once per `entries` change. Streaming markdown
    // produces a fresh `entries` array when new headings appear, which
    // re-runs this effect — so cache invalidation tracks content growth.
    const resolveEls = () =>
      entries
        .map((e) => ({ id: e.id, el: root.querySelector<HTMLElement>(`[id="${CSS.escape(e.id)}"]`) }))
        .filter((x): x is { id: string; el: HTMLElement } => !!x.el);
    let resolved = resolveEls();
    let raf = 0;
    const update = () => {
      raf = 0;
      // Re-resolve if any expected element vanished (e.g. content swap).
      if (resolved.length !== entries.length) resolved = resolveEls();
      const threshold = root.getBoundingClientRect().top + 80;
      let current: string | null = resolved[0]?.id ?? entries[0]?.id ?? null;
      for (const { id, el } of resolved) {
        if (el.getBoundingClientRect().top <= threshold) current = id;
        else break;
      }
      setActiveId(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(root);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      root.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [entries, scrollRoot]);

  return (
    <aside
      className="hidden md:flex flex-col shrink-0 w-60 border-l overflow-hidden"
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-border)",
      }}
    >
      <div
        className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] shrink-0"
        style={{
          color: "var(--color-text-muted)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        On this page
      </div>
      <nav className="flex-1 overflow-y-auto py-2 px-1">
        {entries.map((entry) => {
          const isActive = entry.id === activeId;
          const indent = (entry.level - minLevel) * 12;
          return (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              className="block py-1 pr-3 text-[12px] leading-snug truncate transition-colors border-l-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)] focus-visible:ring-inset"
              style={{
                paddingLeft: `${indent + 12}px`,
                color: isActive ? "var(--color-highlight)" : "var(--color-text-muted)",
                borderLeftColor: isActive ? "var(--color-highlight)" : "transparent",
                fontWeight: isActive ? 500 : 400,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--color-text)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--color-text-muted)";
              }}
              onClick={(e) => {
                e.preventDefault();
                if (onEntryClick) onEntryClick(entry.id);
                else {
                  const el = document.getElementById(entry.id);
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
              title={entry.text}
            >
              {entry.text}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
