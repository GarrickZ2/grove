import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
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
export function PickerMenu({ items, selectedId, onSelect, placement = "down-left", searchPlaceholder = "Search", onEscape }: PickerMenuProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchable = items.length > PICKER_SEARCH_THRESHOLD;
  const filtered = searchable && query
    ? items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    : items;

  useEffect(() => {
    if (searchable) requestAnimationFrame(() => inputRef.current?.focus());
  }, [searchable]);

  return (
    <div className={`picker-menu picker-menu--${placement}`}>
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
    </div>
  );
}
