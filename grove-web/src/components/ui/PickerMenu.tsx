import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { DialogLayerContext } from "./dialogLayerContext";
import { Check, Search } from "lucide-react";
import "./picker-menu.css";

/** Lists longer than this get a search field; shorter ones are scanned at a glance. */
export const PICKER_SEARCH_THRESHOLD = 10;

export interface PickerMenuItem {
  id: string;
  label: string;
  description?: string | null;
  /** Consecutive items with the same group share one header. */
  group?: string;
  icon?: ReactNode;
}

interface PickerMenuProps {
  /** Optional viewport anchor for menus inside scrollable dialogs. */
  anchorRef?: RefObject<HTMLElement | null>;
  menuRef?: RefObject<HTMLDivElement | null>;
  footer?: ReactNode;
  items: PickerMenuItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Where the menu opens relative to its (position: relative) parent. */
  placement?: "down-left" | "up-left" | "up-right";
  searchPlaceholder?: string;
  /** Escape inside the search field: clears the query first, then asks the owner to close. */
  onEscape?: () => void;
}

/**
 * The one dropdown list used by Orbit's selectors and the chat composer's
 * config pills, so they all look and behave the same.
 */
export function PickerMenu({ items, selectedId, onSelect, placement = "down-left", searchPlaceholder = "Search", onEscape, anchorRef, menuRef, footer }: PickerMenuProps) {
  const [query, setQuery] = useState("");
  const ownRef = useRef<HTMLDivElement>(null);
  const container = menuRef ?? ownRef;
  const layer = useContext(DialogLayerContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchable = items.length > PICKER_SEARCH_THRESHOLD;
  const filtered = searchable && query
    ? items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    : items;

  useEffect(() => {
    if (searchable) requestAnimationFrame(() => inputRef.current?.focus());
  }, [searchable]);

  useLayoutEffect(() => {
    if (!anchorRef) return;
    const position = () => {
      const anchor = anchorRef.current, menu = container.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8, gap = 4;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0, topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const below = Math.max(0, topEdge + height - rect.bottom - margin - gap);
      const above = Math.max(0, rect.top - topEdge - margin - gap);
      const desired = Math.min(320, menu.scrollHeight);
      const up = placement.startsWith("up") ? above >= desired || above > below : below < desired && above > below;
      const menuWidth = Math.min(320, Math.max(260, rect.width), width - margin * 2);
      Object.assign(menu.style, {
        position: "fixed", width: `${menuWidth}px`, minWidth: "0", maxWidth: `${width - margin * 2}px`,
        left: `${Math.max(leftEdge + margin, Math.min(placement === "up-right" ? rect.right - menuWidth : rect.left, leftEdge + width - margin - menuWidth))}px`, right: "auto",
        top: up ? "auto" : `${rect.bottom + gap}px`, bottom: up ? `${window.innerHeight - rect.top + gap}px` : "auto",
        maxHeight: `${Math.min(480, up ? above : below)}px`, zIndex: String(layer + 1),
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(position) : null;
    if (container.current) observer?.observe(container.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [anchorRef, container, placement, layer, footer]);

  const content = (
    <div ref={container} className={`picker-menu picker-menu--${placement}`}>
      {searchable && (
        <div className="picker-menu__search">
          <Search className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            placeholder={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (query) setQuery("");
              else onEscape?.();
            }}
          />
        </div>
      )}
      <div className="picker-menu__list">
        {filtered.map((item, index) => (
          <Fragment key={item.id}>
            {item.group && filtered[index - 1]?.group !== item.group && <div className="picker-menu__group">{item.group}</div>}
            <button type="button" className={`picker-menu__item${item.id === selectedId ? " is-selected" : ""}`} onClick={() => onSelect(item.id)}>
              {item.icon && <span className="picker-menu__icon">{item.icon}</span>}
              <span className="picker-menu__text">
                <span className="picker-menu__label">{item.label}</span>
                {item.description && <span className="picker-menu__description">{item.description}</span>}
              </span>
              {item.id === selectedId && <Check size={14} className="picker-menu__check" />}
            </button>
          </Fragment>
        ))}
        {filtered.length === 0 && <div className="picker-menu__empty">No matches</div>}
      </div>
      {footer && <div className="picker-menu__footer">{footer}</div>}
    </div>
  );
  return anchorRef ? createPortal(content, document.body) : content;
}
