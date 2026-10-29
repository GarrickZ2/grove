import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Box, Brain, ChevronDown, ChevronLeft, ChevronRight, Loader2, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEscapeScope } from "../../../keyboard/useEscapeScope";
import { PickerMenu } from "../../ui/PickerMenu";
import type { SessionConfigOption, SessionConfigSelectValue } from "../../../api/tasks";
import { configCategoryMatches, configDropdownValues } from "./sessionConfigOptions";

// Session config menus for the chat composer footer, shared with Orbit's New page.

export type ChatDropdownOption = {
  label: string;
  value: string;
  description?: string | null;
  group?: string;
};

export const SessionSettingsMenu = ({
  ref,
  options,
  open,
  disabled,
  pendingConfigIds,
  onToggle,
  onSelect,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  options: SessionConfigOption[];
  open: boolean;
  disabled: boolean;
  pendingConfigIds: Set<string>;
  onToggle: () => void;
  onSelect: (option: SessionConfigOption, value: string | boolean) => void;
}) => {
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    bottom: number;
    maxHeight: number;
  } | null>(null);
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  useEscapeScope(open, () => {
    if (activeOptionId) { setActiveOptionId(null); setSearchQuery(""); }
    else onToggle();
  });
  const searchInputRef = useRef<HTMLInputElement>(null);

  const activeOption = useMemo(
    () =>
      options.find(
        (option) => option.id === activeOptionId && option.type === "select",
      ),
    [activeOptionId, options],
  );
  const activeValues = activeOption ? configDropdownValues(activeOption) : [];
  const enableSearch = activeValues.length > 5;
  const normalizedSearchQuery = searchQuery.toLowerCase();
  const filteredValues = normalizedSearchQuery
    ? activeValues.filter((value) =>
        value.name.toLowerCase().includes(normalizedSearchQuery),
      )
    : activeValues;

  useEffect(() => {
    if (!activeOption || !enableSearch) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [activeOption, enableSearch]);

  const positionMenu = useCallback((trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    const viewportMargin = 8;
    const menuGap = 4;
    const menuWidth = 320;
    setMenuAnchor({
      left: Math.min(
        Math.max(viewportMargin, rect.right - menuWidth),
        window.innerWidth - menuWidth - viewportMargin,
      ),
      bottom: window.innerHeight - rect.top + menuGap,
      maxHeight: Math.max(
        120,
        Math.min(320, rect.top - menuGap - viewportMargin),
      ),
    });
  }, []);

  const iconForOption = (option: SessionConfigOption) => {
    if (configCategoryMatches(option, "model")) return <Box className="h-3.5 w-3.5" />;
    if (configCategoryMatches(option, "mode")) return <ShieldCheck className="h-3.5 w-3.5" />;
    if (configCategoryMatches(option, "thought_level")) return <Brain className="h-3.5 w-3.5" />;
    return <SlidersHorizontal className="h-3.5 w-3.5" />;
  };

  const renderValue = (
    option: SessionConfigOption,
    value: SessionConfigSelectValue,
  ) => (
    <button
      key={value.value}
      type="button"
      disabled={pendingConfigIds.has(option.id)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onSelect(option, value.value);
        setActiveOptionId(null);
        setSearchQuery("");
      }}
      className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-1 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
    >
      <span aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-xs text-[var(--color-text)]">{value.name}</span>
        {value.description && (
          <span className="mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">
            {value.description}
          </span>
        )}
      </span>
      {option.currentValue === value.value && (
        <span className="mt-0.5 justify-self-end text-xs text-[var(--color-highlight)]">✓</span>
      )}
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(event) => {
          if (!open) {
            positionMenu(event.currentTarget);
            setActiveOptionId(null);
            setSearchQuery("");
          }
          onToggle();
        }}
        disabled={disabled}
        title="Session settings"
        aria-label="Session settings"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-bg)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && !disabled && menuAnchor && typeof document !== "undefined" &&
        createPortal(
        <div
          data-session-settings-menu
          className="fixed z-[1000] flex w-80 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
          style={{
            left: menuAnchor.left,
            bottom: menuAnchor.bottom,
            maxHeight: menuAnchor.maxHeight,
            overflowAnchor: "none",
          }}
        >
          {activeOption ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2 py-2">
                <button
                  type="button"
                  aria-label="Back to session settings"
                  onClick={() => {
                    setActiveOptionId(null);
                    setSearchQuery("");
                  }}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-[var(--color-text-muted)]">
                  {iconForOption(activeOption)}
                </span>
                <span className="min-w-0 truncate text-xs font-medium text-[var(--color-text)]">
                  {activeOption.name}
                </span>
              </div>
              {enableSearch && (
                <div className="shrink-0 border-b border-[var(--color-border)] p-2">
                  <div className="flex items-center gap-1.5 rounded-md bg-[var(--color-bg-secondary)] px-2 py-1.5">
                    <Search className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder={`Search ${activeOption.name.toLowerCase()}...`}
                      className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                    />
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {filteredValues.map((value, index) => (
                  <Fragment key={value.value}>
                    {value.group &&
                      filteredValues[index - 1]?.group !== value.group && (
                        <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                          {value.group}
                        </div>
                      )}
                    {renderValue(activeOption, value)}
                  </Fragment>
                ))}
                {filteredValues.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">
                    No matches
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {options.map((option) => {
              const currentValue =
                option.type === "select"
                  ? configDropdownValues(option).find(
                      (value) => value.value === option.currentValue,
                    )?.name ?? String(option.currentValue)
                  : null;
              return (
            <div key={option.id} className="border-b border-[var(--color-border)] px-1 py-1 last:border-b-0">
              {option.type === "boolean" ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={option.currentValue}
                  disabled={pendingConfigIds.has(option.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(option, !option.currentValue)}
                  className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-2 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                >
                  <span className="text-[var(--color-text-muted)]">
                    {iconForOption(option)}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{option.name}</span>
                    {option.description && (
                      <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <span
                    className={`relative inline-block h-4 w-7 justify-self-end rounded-full transition-colors ${
                      option.currentValue
                        ? "bg-[var(--color-highlight)]"
                        : "bg-[var(--color-bg-tertiary)]"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                        option.currentValue ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={pendingConfigIds.has(option.id)}
                    onClick={() => {
                      setActiveOptionId(option.id);
                      setSearchQuery("");
                    }}
                    className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-2 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                  >
                    <span className="text-[var(--color-text-muted)]">
                      {iconForOption(option)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-[var(--color-text)]">
                        {option.name}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                    <span className="flex max-w-32 items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                      <span className="truncate">{currentValue}</span>
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    </span>
                  </button>
                </>
              )}
            </div>
              );
            })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

/** Reusable dropdown selector for bottom toolbar */
export const DropdownSelect = ({
  ref,
  label,
  icon,
  options,
  value,
  open,
  disabled = false,
  loading = false,
  placement = "up-right",
  onToggle,
  onSelect,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  label: string;
  icon?: ReactNode;
  options: ChatDropdownOption[];
  value: string;
  open: boolean;
  disabled?: boolean;
  loading?: boolean;
  placement?: "up-left" | "up-right";
  onToggle: () => void;
  onSelect: (value: string) => void;
}) => {
  useEscapeScope(open, onToggle);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="inline-flex h-7 items-center gap-1 rounded-full bg-[var(--color-bg)] px-2.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
        <span className="chatbox-dropdown-label opacity-70">{label}</span>
        <span className="max-w-40 truncate text-[var(--color-text)]">
          {options.find((o) => o.value === value)?.label ?? "Default"}
        </span>
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>
      {open && !disabled && (
        <PickerMenu
          items={options.map((option) => ({ id: option.value, label: option.label, description: option.description, group: option.group }))}
          selectedId={value}
          onSelect={onSelect}
          placement={placement}
          onEscape={onToggle}
        />
      )}
    </div>
  );
};
