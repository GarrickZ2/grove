import { createElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Box, Brain, Check, ChevronDown, ChevronRight, Loader2, Search, ShieldCheck, SlidersHorizontal, Sparkle, UserRound } from "lucide-react";
import { OrbitComposerSheet } from "./OrbitSheet";
import { useEscapeScope } from "../../../../keyboard/useEscapeScope";
import { Toggle } from "../../../../orbit/ui/Toggle";
import { isRiskyMode, shortSettingLabel } from "./composerStatus";
import { usePopPlacement } from "./usePopPlacement";

export interface SetupFieldOption {
  value: string;
  label: string;
  description?: string | null;
  group?: string;
  icon?: ReactNode;
}

/** One select-style setting in the setup menu (Agent, Model, Mode, Effort, other options). */
export interface SetupField {
  id: string;
  kind: "agent" | "model" | "mode" | "thinking" | "option";
  label: string;
  options: SetupFieldOption[];
  value: string;
  loading?: boolean;
  onSelect: (value: string) => void;
}

/** A boolean session option: a toggle right in its menu row. */
export interface SetupToggle {
  id: string;
  label: string;
  description?: string | null;
  value: boolean;
  loading?: boolean;
  onToggle: (value: boolean) => void;
}

interface OrbitSetupChipProps {
  agentLabel: string;
  agentIcon?: ReactNode;
  /** Icon component (keeps props stable for memo); used when `agentIcon` is absent. */
  agentIconType?: ComponentType<{ size?: number; className?: string }> | null;
  fields: SetupField[];
  toggles?: SetupToggle[];
  disabled?: boolean;
  /** Shown in the menu when there's nothing to configure. */
  emptyNote?: string;
  /** Phone: the menu opens as a bottom sheet (rows, then options sliding in). */
  sheet?: boolean;
}

const FIELD_ICON = { agent: UserRound, model: Box, mode: ShieldCheck, thinking: Brain, option: SlidersHorizontal } as const;
const SEARCH_MIN = 9;
/** Hover a row this long before its submenu opens, so a diagonal move to an open submenu doesn't switch it. */
const HOVER_OPEN_MS = 110;
const SUBMENU_WIDTH = 280;
const EDGE = 8;
/** Level-1 rows: setting rows, and the toggle inside a boolean row. */
const ROW_SELECTOR = "button[data-row], [data-row] > button";

function selectedLabel(field: SetupField | undefined): string | null {
  if (!field) return null;
  return field.options.find((option) => option.value === field.value)?.label ?? null;
}

/** The area a popover can actually show in: the viewport cut by any clipping ancestor. */
function visibleBounds(element: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    if (style.overflowX !== "visible") { bounds.left = Math.max(bounds.left, rect.left); bounds.right = Math.min(bounds.right, rect.right); }
    if (style.overflowY !== "visible") { bounds.top = Math.max(bounds.top, rect.top); bounds.bottom = Math.min(bounds.bottom, rect.bottom); }
  }
  return bounds;
}

/** Attribute selector for a level-1 row (ids are config option ids, so quote them). */
function rowSelector(id: string): string {
  return `[data-row="${id.replace(/["\\]/g, "\\$&")}"]`;
}

function focusables(container: HTMLElement | null, selector: string): HTMLElement[] {
  return container ? Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((element) => !(element as HTMLButtonElement).disabled) : [];
}

/** Move focus within `items` by `delta`, wrapping. */
function moveFocus(items: HTMLElement[], delta: number): void {
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
  items[next].focus();
}

/**
 * "<Agent> · <Model> · <Mode>" chip. Opens a macOS-style two-level menu: one
 * row per setting with its current value, each opening its options in a
 * side submenu. Full keyboard: ↑/↓, →/Enter opens, ←/Esc goes back.
 */
export const OrbitSetupChip = memo(function OrbitSetupChip({ agentLabel, agentIcon, agentIconType, fields, toggles = [], disabled = false, emptyNote, sheet = false }: OrbitSetupChipProps) {
  const [open, setOpen] = useState(false);
  /** The row whose submenu is open, and whether the keyboard opened it (it then takes focus). */
  const [sub, setSub] = useState<{ id: string; focus: boolean } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);

  const clearHover = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const close = useCallback((refocus: boolean) => {
    clearHover();
    setOpen(false);
    setSub(null);
    if (refocus) chipRef.current?.focus();
  }, []);
  const focusRow = (id: string) => menuRef.current?.querySelector<HTMLElement>(rowSelector(id))?.focus();
  const back = useCallback(() => {
    if (sub) {
      // Level-1 rows stay mounted, so focus can move before the submenu goes.
      menuRef.current?.querySelector<HTMLElement>(rowSelector(sub.id))?.focus();
      setSub(null);
    } else {
      close(true);
    }
  }, [sub, close]);
  useEscapeScope(open && !sheet, back);
  useEffect(() => {
    if (!open || sheet) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open, close, sheet]);
  useEffect(() => () => clearHover(), []);
  // The menu takes focus (not a row) so ↑/↓ work right away without a stray highlight.
  const focusFirstRowRef = useRef(false);
  useEffect(() => {
    if (!open || sheet) return;
    if (focusFirstRowRef.current) focusables(menuRef.current, ROW_SELECTOR)[0]?.focus();
    else menuRef.current?.focus({ preventScroll: true });
    focusFirstRowRef.current = false;
  }, [open, sheet]);

  // Only the direction matters here: the level-1 menu is short and never scrolls.
  const placement = usePopPlacement(rootRef, open && !sheet);
  const menuStyle = placement ? { top: placement.top, bottom: placement.bottom } : undefined;

  const model = fields.find((field) => field.kind === "model");
  const mode = fields.find((field) => field.kind === "mode");
  const modeLabel = selectedLabel(mode);
  const modelLabel = selectedLabel(model);
  const risky = !!mode && isRiskyMode({ value: mode.value, label: modeLabel ?? undefined });
  const loading = fields.some((field) => field.loading) || toggles.some((toggle) => toggle.loading);
  const summary = [agentLabel, modelLabel, modeLabel].filter(Boolean).join(" · ");
  const subField = sub ? fields.find((field) => field.id === sub.id) ?? null : null;

  const openSub = (id: string, focus: boolean) => {
    clearHover();
    setSub({ id, focus });
  };
  const hoverRow = (id: string | null) => {
    clearHover();
    if (sub?.id === id) return;
    hoverTimer.current = window.setTimeout(() => setSub(id ? { id, focus: false } : null), HOVER_OPEN_MS);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = focusables(menuRef.current, ROW_SELECTOR);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(rows, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    const id = (event.target as HTMLElement).dataset?.row;
    const field = id ? fields.find((candidate) => candidate.id === id) : undefined;
    if (field && (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openSub(field.id, true);
    }
  };

  return (
    <span ref={rootRef} className="oc-setup">
      <button
        ref={chipRef}
        type="button"
        className={`oc-setup-chip${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Session setup: ${summary}`}
        title={summary}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            focusFirstRowRef.current = true;
            setOpen(true);
          }
        }}
      >
        <span className="oc-setup-ag" aria-hidden="true">{agentIcon ?? (agentIconType ? createElement(agentIconType, { size: 11 }) : <Sparkle size={11} />)}</span>
        <span className="oc-setup-name">{agentLabel || "Agent"}</span>
        {modelLabel && <><i className="oc-setup-dot" aria-hidden="true" /><span className="oc-setup-dim is-model">{shortSettingLabel(modelLabel, "model")}</span></>}
        {modeLabel && <><i className="oc-setup-dot" aria-hidden="true" /><span className={risky ? "oc-setup-risk" : "oc-setup-dim"}>{shortSettingLabel(modeLabel, "mode")}</span></>}
        {loading ? <Loader2 className="oc-setup-caret animate-spin" size={12} /> : <ChevronDown className="oc-setup-caret" size={12} />}
      </button>
      {sheet && (
        <OrbitComposerSheet open={open} onClose={() => close(false)} onEscape={() => (sub ? setSub(null) : close(true))} label="Session setup">
          <SheetMenu fields={fields} toggles={toggles} disabled={disabled} emptyNote={emptyNote} subId={sub?.id ?? null}
            onOpen={(id) => setSub({ id, focus: false })} onBack={() => setSub(null)}
            onPick={(field, value) => { if (value !== field.value) field.onSelect(value); close(false); }} />
        </OrbitComposerSheet>
      )}
      {open && !sheet && (
        <div ref={menuRef} className="oc-menu" role="menu" aria-label="Session setup" tabIndex={-1} style={menuStyle} onKeyDown={onMenuKeyDown} onMouseLeave={() => hoverRow(sub?.id ?? null)}>
          {fields.length === 0 && toggles.length === 0 && <p className="oc-menu-note">{emptyNote ?? "This Agent has no session settings."}</p>}
          {fields.map((field) => {
            const Icon = FIELD_ICON[field.kind];
            const lockedOut = disabled && field.kind !== "agent";
            const expanded = sub?.id === field.id;
            return (
              <button
                key={field.id}
                type="button"
                role="menuitem"
                data-row={field.id}
                aria-haspopup="menu"
                aria-expanded={expanded}
                disabled={lockedOut}
                className={`oc-menu-row${expanded ? " is-open" : ""}`}
                onMouseEnter={(event) => { event.currentTarget.focus({ preventScroll: true }); hoverRow(field.id); }}
                onClick={() => (expanded ? setSub(null) : openSub(field.id, false))}
              >
                {field.kind === "agent" && (agentIcon || agentIconType)
                  ? <span className="oc-menu-ic oc-menu-agent" aria-hidden="true">{agentIcon ?? createElement(agentIconType!, { size: 14 })}</span>
                  : <Icon className="oc-menu-ic" size={14} aria-hidden="true" />}
                <span className="oc-menu-label">{field.label}</span>
                <span className="oc-menu-value">{selectedLabel(field) ?? "Default"}</span>
                {field.loading ? <Loader2 className="oc-menu-chev animate-spin" size={12} aria-label="Updating" /> : <ChevronRight className="oc-menu-chev" size={13} aria-hidden="true" />}
              </button>
            );
          })}
          {toggles.length > 0 && fields.length > 0 && <div className="oc-menu-sep" role="separator" />}
          {toggles.map((toggle) => (
            <div key={toggle.id} className="oc-menu-row is-toggle" onMouseEnter={() => hoverRow(null)} title={toggle.description ?? undefined}>
              <SlidersHorizontal className="oc-menu-ic" size={14} aria-hidden="true" />
              <span className="oc-menu-label">{toggle.label}</span>
              {toggle.loading && <Loader2 className="animate-spin" size={12} aria-label="Updating" />}
              <span data-row={toggle.id} className="oc-menu-toggle">
                <Toggle checked={toggle.value} label={toggle.label} disabled={disabled || toggle.loading} onChange={toggle.onToggle} />
              </span>
            </div>
          ))}
          {disabled && fields.some((field) => field.kind !== "agent") && <p className="oc-menu-note">Settings can change once the session is connected.</p>}
          {subField && (
            <SubMenu
              key={subField.id}
              field={subField}
              menuRef={menuRef}
              takeFocus={sub?.focus ?? false}
              onEnter={clearHover}
              onBack={() => { focusRow(subField.id); setSub(null); }}
              onPick={(value) => {
                if (value !== subField.value) subField.onSelect(value);
                close(true);
              }}
            />
          )}
        </div>
      )}
    </span>
  );
});

function SubMenu({ field, menuRef, takeFocus, onBack, onPick, onEnter }: {
  field: SetupField;
  menuRef: RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  takeFocus: boolean;
  onBack: () => void;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchable = field.options.length >= SEARCH_MIN;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? field.options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle)) : field.options;
  }, [field.options, query]);

  // Beside its row, on whichever side has room inside the visible area (the
  // chat panel clips its overflow); overlapping the menu when neither fits.
  useLayoutEffect(() => {
    const element = ref.current;
    const menu = menuRef.current;
    const row = menu?.querySelector<HTMLElement>(rowSelector(field.id));
    if (!element || !menu || !row) return;
    const bounds = visibleBounds(menu);
    const menuRect = menu.getBoundingClientRect();
    const width = Math.min(SUBMENU_WIDTH, bounds.right - bounds.left - EDGE * 2);
    element.style.width = `${width}px`;
    let x = menuRect.right + 4;
    if (x + width > bounds.right - EDGE) {
      x = menuRect.left - 4 - width;
      if (x < bounds.left + EDGE) x = Math.max(bounds.left + EDGE, bounds.right - EDGE - width);
    }
    element.style.left = `${x - menuRect.left}px`;
    element.style.right = "auto";
    element.style.maxHeight = `${Math.min(380, bounds.bottom - bounds.top - EDGE * 2)}px`;
    element.style.top = `${row.offsetTop - 5}px`;
    const rect = element.getBoundingClientRect();
    let shift = 0;
    if (rect.bottom > bounds.bottom - EDGE) shift = bounds.bottom - EDGE - rect.bottom;
    if (rect.top + shift < bounds.top + EDGE) shift = bounds.top + EDGE - rect.top;
    element.style.top = `${row.offsetTop - 5 + shift}px`;
  }, [field.id, menuRef]);

  useEffect(() => {
    const list = ref.current?.querySelector<HTMLElement>(".oc-sub-list");
    const selected = list?.querySelector<HTMLElement>('[aria-checked="true"]');
    // Keep the current option in view in a long list.
    if (list && selected) list.scrollTop = Math.max(0, selected.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2);
    if (!takeFocus) return;
    if (searchable) searchRef.current?.focus();
    else (selected ?? focusables(ref.current, "[data-option]")[0])?.focus();
  }, [takeFocus, searchable]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inSearch = event.target === searchRef.current;
    const options = focusables(ref.current, "[data-option]");
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (inSearch) (event.key === "ArrowDown" ? options[0] : options[options.length - 1])?.focus();
      else moveFocus(options, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "ArrowLeft" && (!inSearch || query === "")) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    // Escape inside the search box never reaches the shortcut scope, so step back here.
    if (event.key === "Escape" && inSearch) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    if (event.key === "Enter" && inSearch && visible[0]) {
      event.preventDefault();
      event.stopPropagation();
      onPick(visible[0].value);
      return;
    }
    // Keep the level-1 handler out of submenu keys.
    if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") event.stopPropagation();
  };

  return (
    <div ref={ref} className="oc-sub" role="menu" aria-label={field.label} onKeyDown={onKeyDown} onMouseEnter={onEnter}>
      {searchable && (
        <label className="oc-sub-search">
          <Search size={12} aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${field.label.toLowerCase()}`} aria-label={`Search ${field.label.toLowerCase()}`} />
        </label>
      )}
      <div className="oc-sub-list">
        {visible.map((option, index) => (
          <div key={option.value} role="none">
            {option.group && visible[index - 1]?.group !== option.group && <div className="oc-sub-group" role="presentation">{option.group}</div>}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === field.value}
              data-option={option.value}
              className="oc-sub-item"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
              onClick={() => onPick(option.value)}
              title={option.description ?? undefined}
            >
              {option.icon && <span className="oc-sub-ic">{option.icon}</span>}
              <span className="oc-sub-copy">
                <span className="oc-sub-name">{option.label}</span>
                {option.description && <span className="oc-sub-desc">{option.description}</span>}
              </span>
              <Check className="oc-sub-check" size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
        {visible.length === 0 && <p className="oc-menu-note">No matches</p>}
      </div>
    </div>
  );
}

/** Phone setup sheet: level 1 lists the settings; a setting's options slide in with a back button. */
function SheetMenu({ fields, toggles, disabled, emptyNote, subId, onOpen, onBack, onPick }: {
  fields: SetupField[];
  toggles: SetupToggle[];
  disabled: boolean;
  emptyNote?: string;
  subId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  onPick: (field: SetupField, value: string) => void;
}) {
  const field = subId ? fields.find((candidate) => candidate.id === subId) ?? null : null;
  const [query, setQuery] = useState("");
  const [shownId, setShownId] = useState(subId);
  if (shownId !== subId) {
    setShownId(subId);
    setQuery("");
  }
  if (field) {
    const needle = query.trim().toLowerCase();
    const visible = needle ? field.options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle)) : field.options;
    return (
      <div className="oc-sheet-menu is-level-2" key={field.id}>
        <div className="oc-sheet-head">
          <button type="button" className="oc-sheet-back" onClick={onBack} aria-label="Back to session setup"><ArrowLeft aria-hidden="true" /></button>
          <b>{field.label}</b>
        </div>
        {field.options.length >= SEARCH_MIN && (
          <label className="oc-sub-search oc-sheet-search">
            <Search size={14} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${field.label.toLowerCase()}`} aria-label={`Search ${field.label.toLowerCase()}`} />
          </label>
        )}
        <div className="oc-sheet-list" role="menu" aria-label={field.label}>
          {visible.map((option, index) => (
            <div key={option.value} role="none">
              {option.group && visible[index - 1]?.group !== option.group && <div className="oc-sub-group" role="presentation">{option.group}</div>}
              <button type="button" role="menuitemradio" aria-checked={option.value === field.value} data-option={option.value} className="oc-sub-item oc-sheet-item" onClick={() => onPick(field, option.value)}>
                {option.icon && <span className="oc-sub-ic">{option.icon}</span>}
                <span className="oc-sub-copy">
                  <span className="oc-sub-name">{option.label}</span>
                  {option.description && <span className="oc-sub-desc">{option.description}</span>}
                </span>
                <Check className="oc-sub-check" size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
          {visible.length === 0 && <p className="oc-menu-note">No matches</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="oc-sheet-menu is-level-1">
      <div className="oc-sheet-head"><b>Session setup</b></div>
      {fields.length === 0 && toggles.length === 0 && <p className="oc-menu-note">{emptyNote ?? "This Agent has no session settings."}</p>}
      <div className="oc-sheet-list" role="menu" aria-label="Session setup">
        {fields.map((candidate) => {
          const Icon = FIELD_ICON[candidate.kind];
          return (
            <button key={candidate.id} type="button" role="menuitem" data-row={candidate.id} aria-haspopup="menu" disabled={disabled && candidate.kind !== "agent"} className="oc-menu-row oc-sheet-item" onClick={() => onOpen(candidate.id)}>
              <Icon className="oc-menu-ic" size={16} aria-hidden="true" />
              <span className="oc-menu-label">{candidate.label}</span>
              <span className="oc-menu-value">{selectedLabel(candidate) ?? "Default"}</span>
              {candidate.loading ? <Loader2 className="oc-menu-chev animate-spin" size={14} aria-label="Updating" /> : <ChevronRight className="oc-menu-chev" size={15} aria-hidden="true" />}
            </button>
          );
        })}
        {toggles.length > 0 && fields.length > 0 && <div className="oc-menu-sep" role="separator" />}
        {toggles.map((toggle) => (
          <div key={toggle.id} className="oc-menu-row is-toggle oc-sheet-item">
            <SlidersHorizontal className="oc-menu-ic" size={16} aria-hidden="true" />
            <span className="oc-menu-label">{toggle.label}</span>
            {toggle.loading && <Loader2 className="animate-spin" size={14} aria-label="Updating" />}
            <span className="oc-menu-toggle"><Toggle checked={toggle.value} label={toggle.label} disabled={disabled || toggle.loading} onChange={toggle.onToggle} /></span>
          </div>
        ))}
      </div>
      {disabled && fields.some((candidate) => candidate.kind !== "agent") && <p className="oc-menu-note">Settings can change once the session is connected.</p>}
    </div>
  );
}
