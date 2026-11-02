import { Fragment, type KeyboardEvent, type RefObject } from "react";
import { motion } from "framer-motion";
import { SELECTION_SPRING, SearchField } from "../ui";
import {
  moveCursor,
  type SettingsPageDef,
  type SettingsPageId,
  type SettingsSearchHit,
} from "./settingsModel";

/** Row height of a sub-section link; the rail indicator steps by this. */
const SUB_HEIGHT = 26;

interface SettingsNavProps {
  pages: SettingsPageDef[];
  hits: SettingsSearchHit[];
  activePage: SettingsPageId;
  activeSub: string | undefined;
  attention: ReadonlySet<SettingsPageId>;
  query: string;
  onQueryChange: (query: string) => void;
  cursor: number;
  onCursorChange: (cursor: number) => void;
  onSelect: (pageId: SettingsPageId, subId?: string) => void;
  onJump: (subId: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Expand the active page's sub-sections (only useful when its content scrolls). */
  showSubs: boolean;
}

export function SettingsNav({
  pages,
  hits,
  activePage,
  activeSub,
  attention,
  query,
  onQueryChange,
  cursor,
  onCursorChange,
  onSelect,
  onJump,
  searchRef,
  showSubs,
}: SettingsNavProps) {
  const searching = query.trim() !== "";
  const byId = new Map(pages.map((page) => [page.id, page]));
  const cursorHit = searching ? hits[cursor] : undefined;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.key === "Enter") {
      if (cursorHit) onSelect(cursorHit.pageId, cursorHit.subId);
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : -1;
    if (searching) {
      onCursorChange(moveCursor(cursor, delta, hits.length));
      return;
    }
    // Without a query the arrows walk the pages directly.
    const index = pages.findIndex((page) => page.id === activePage);
    onSelect(pages[moveCursor(index, delta, pages.length)].id);
  };

  const visiblePages = hits.flatMap((hit) => byId.get(hit.pageId) ?? []);
  return (
    <nav className="ost-nav" aria-label="Settings sections">
      <div className="ost-nav-title">Settings</div>
      <SearchField
        className="ost-search"
        inputRef={searchRef}
        label="Search settings"
        aria-controls="ost-nav-list"
        aria-activedescendant={cursorHit ? `ost-nav-${cursorHit.pageId}` : undefined}
        value={query}
        onChange={onQueryChange}
        onKeyDown={handleKeyDown}
        trailing={<span className="ost-kbd" aria-hidden="true">/</span>}
      />
      <div className="ost-nlist" id="ost-nav-list">
        {visiblePages.map((page, index) => {
          const showSeparator = index > 0 && visiblePages[index - 1].group !== page.group;
          const active = page.id === activePage;
          const open = showSubs && active && page.subs.length > 0;
          const subIndex = Math.max(0, page.subs.findIndex((sub) => sub.id === activeSub));
          const Icon = page.icon;
          return (
            <Fragment key={page.id}>
              {showSeparator ? <div className="ost-sep" role="separator" /> : null}
              <button
                type="button"
                id={`ost-nav-${page.id}`}
                aria-current={active ? "page" : undefined}
                className={`ost-nitem${active ? " is-active" : ""}${cursorHit?.pageId === page.id ? " is-cursor" : ""}`}
                onClick={() => onSelect(page.id)}
              >
                {active ? <motion.span layoutId="ost-nav-pill" className="ost-pill" transition={SELECTION_SPRING} /> : null}
                <Icon className="ost-nitem-icon" aria-hidden="true" />
                <span className="ost-nitem-label">{page.title}</span>
                {attention.has(page.id) ? <span className="ost-attn" role="img" aria-label="Needs setup" /> : null}
              </button>
              {page.subs.length > 0 ? (
                <div className={`ost-subs${open ? " is-open" : ""}`} aria-hidden={!open}>
                  <div className="ost-subs-clip">
                    <div className="ost-subs-in">
                      <span className="ost-rail" style={{ transform: `translateY(${subIndex * SUB_HEIGHT}px)` }} />
                      {page.subs.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          tabIndex={open ? 0 : -1}
                          className={`ost-sub${open && sub.id === activeSub ? " is-on" : ""}`}
                          onClick={() => onJump(sub.id)}
                        >
                          {sub.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {hits.length === 0 ? <p className="ost-nav-empty">No settings match “{query.trim()}”.</p> : null}
      </div>
    </nav>
  );
}
