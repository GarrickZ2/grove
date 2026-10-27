import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { fitIslandPages } from "./islandLayout";

export interface IslandPage {
  id: string;
  label: string;
  icon: ReactNode;
}

export function IslandNavigation({ pages, activeId, onSelect }: {
  pages: IslandPage[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => setWidth(nav.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  const { visible, overflow } = fitIslandPages(pages, width, activeId);
  const showMore = moreOpen && overflow.length > 0;
  useLayoutEffect(() => {
    if (showMore) popupRef.current?.querySelector("button")?.focus();
  }, [showMore]);

  const select = (id: string) => {
    setMoreOpen(false);
    onSelect(id);
  };

  return (
    <div ref={navRef} className="relative flex-1 min-w-9" aria-label="Pages">
      <div className="flex items-center gap-1">
        {visible.map((page) => (
          <button
            key={page.id}
            onClick={() => select(page.id)}
            title={page.label}
            aria-label={page.label}
            aria-current={activeId === page.id ? "page" : undefined}
            className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${activeId === page.id ? "text-current" : "opacity-60 hover:opacity-100 hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]"}`}
          >
            {page.icon}
            {activeId === page.id && <span className="absolute bottom-0.5 left-2 right-2 h-0.5 rounded-full bg-current" />}
          </button>
        ))}
        {overflow.length > 0 && (
          <button
            ref={triggerRef}
            onClick={() => setMoreOpen((open) => !open)}
            title="More pages"
            aria-label="More pages"
            aria-haspopup="dialog"
            aria-expanded={showMore}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
      {showMore && (
        <div
          ref={popupRef}
          role="dialog"
          aria-label="More pages"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setMoreOpen(false);
              triggerRef.current?.focus();
            }
          }}
          className="absolute top-full right-0 z-10 mt-3 w-56 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-7rem)] overflow-y-auto overflow-x-hidden rounded-xl border border-[color-mix(in_oklab,currentColor_15%,transparent)] bg-[var(--color-bg-secondary)] p-1 shadow-xl"
        >
          {overflow.map((page) => (
            <button
              key={page.id}
              onClick={() => select(page.id)}
              title={page.label}
              aria-current={activeId === page.id ? "page" : undefined}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]"
            >
              <span className="shrink-0">{page.icon}</span>
              <span className="truncate">{page.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
