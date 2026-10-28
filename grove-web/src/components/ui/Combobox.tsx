import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check, LoaderCircle, Search } from "lucide-react";

export interface ComboboxOption {
  id: string;
  label: string;
  value: string;
  description?: string;
  icon?: ReactNode;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowCustom?: boolean;
  customPlaceholder?: string;
  label?: string;
  disabled?: boolean;
  size?: "default" | "compact";
  searchable?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  clearSearchOnSelect?: boolean;
  dropdownMinWidth?: number;
  dropdownMaxHeight?: number;
  triggerClassName?: string;
}

interface DropdownPosition {
  top: number | null;
  bottom: number | null;
  left: number;
  width: number;
  maxHeight: number;
  opensUp: boolean;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select...",
  allowCustom = true,
  customPlaceholder = "Enter custom value...",
  label,
  disabled = false,
  size = "default",
  searchable = false,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  emptyText = "No options found",
  loading = false,
  hasMore = false,
  onLoadMore,
  clearSearchOnSelect = true,
  dropdownMinWidth,
  dropdownMaxHeight = 240,
  triggerClassName = "",
}: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Initialize custom mode from initial props (lazy state initializer)
  const [isCustomMode, setIsCustomMode] = useState(() => allowCustom && !!(value && !options.find((opt) => opt.value === value)));
  const [customValue, setCustomValue] = useState(() => (value && !options.find((opt) => opt.value === value)) ? value : "");
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const [localSearch, setLocalSearch] = useState("");
  useEscapeScope(isOpen, () => setIsOpen(false));
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Check if current value matches any option
  const selectedOption = options.find((opt) => opt.value === value);
  const isCustomValue = value && !selectedOption;

  // Calculate dropdown position (fixed positioning, viewport-relative)
  const updateDropdownPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const gap = 4;
      const viewportPadding = 8;
      const preferredMaxHeight = dropdownMaxHeight;
      const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const availableAbove = rect.top - gap - viewportPadding;
      const minimumUsefulHeight = Math.min(240, preferredMaxHeight);
      const opensUp = availableBelow < minimumUsefulHeight && availableAbove > availableBelow;
      const width = Math.min(Math.max(rect.width, dropdownMinWidth ?? 0), window.innerWidth - viewportPadding * 2);
      const left = Math.min(rect.left, window.innerWidth - viewportPadding - width);
      const maxHeight = Math.max(
        96,
        Math.min(preferredMaxHeight, opensUp ? availableAbove : availableBelow)
      );

      setDropdownPosition({
        top: opensUp ? null : rect.bottom + gap,
        bottom: opensUp ? window.innerHeight - rect.top + gap : null,
        left: Math.max(viewportPadding, left),
        width,
        maxHeight,
        opensUp,
      });
    }
  }, [dropdownMaxHeight, dropdownMinWidth]);

  // Update position when opening
  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      window.addEventListener("scroll", updateDropdownPosition, true);
      window.addEventListener("resize", updateDropdownPosition);
      return () => {
        window.removeEventListener("scroll", updateDropdownPosition, true);
        window.removeEventListener("resize", updateDropdownPosition);
      };
    }
  }, [isOpen, updateDropdownPosition]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus input when entering custom mode
  useEffect(() => {
    if (isCustomMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCustomMode]);

  const handleSelect = (option: ComboboxOption) => {
    if (disabled) return;
    if (option.id === "custom") {
      setIsCustomMode(true);
      setCustomValue("");
      setIsOpen(false);
    } else {
      setIsCustomMode(false);
      onChange(option.value);
      if (clearSearchOnSelect) {
        setLocalSearch("");
        onSearchChange?.("");
      }
      setIsOpen(false);
    }
  };

  const handleCustomSubmit = () => {
    if (customValue.trim()) {
      onChange(customValue.trim());
      setIsOpen(false);
    }
  };

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCustomSubmit();
    } else if (e.key === "Escape") {
      setIsCustomMode(false);
      setIsOpen(false);
    }
  };

  const displayValue = isCustomMode
    ? customValue || customPlaceholder
    : selectedOption?.label || (isCustomValue ? value : placeholder);

  const allOptions = allowCustom
    ? [...options, { id: "custom", label: "Custom...", value: "" }]
    : options;
  const effectiveSearch = searchValue ?? localSearch;
  const visibleOptions = searchable && !onSearchChange && effectiveSearch
    ? allOptions.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(effectiveSearch.toLowerCase()))
    : allOptions;

  // Render dropdown using portal
  const renderDropdown = () => {
    if (!isOpen || isCustomMode || !dropdownPosition) return null;

    return createPortal(
      <AnimatePresence>
        <motion.div
          ref={dropdownRef}
          initial={{ opacity: 0, y: dropdownPosition.opensUp ? 8 : -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: dropdownPosition.opensUp ? 8 : -8 }}
          transition={{ duration: 0.15 }}
          style={{
            position: "fixed",
            top: dropdownPosition.top ?? undefined,
            bottom: dropdownPosition.bottom ?? undefined,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            zIndex: 9999,
          }}
          className="flex flex-col bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden"
        >
          {searchable && (
            <div className="shrink-0 border-b border-[var(--color-border)] p-2">
              <div className="flex h-9 items-center gap-2 rounded-lg bg-[var(--color-bg)] px-2.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                <input
                  autoFocus
                  value={effectiveSearch}
                  onChange={(event) => {
                    setLocalSearch(event.target.value);
                    onSearchChange?.(event.target.value);
                  }}
                  onKeyDown={(event) => { if (event.key === "Escape") setIsOpen(false); }}
                  placeholder={searchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                />
              </div>
            </div>
          )}
          <div
            className="min-h-0 flex-1 overflow-y-auto py-1"
            onScroll={(event) => {
              const target = event.currentTarget;
              if (hasMore && !loading && target.scrollHeight - target.scrollTop - target.clientHeight < 48) onLoadMore?.();
            }}
          >
            {visibleOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => handleSelect(option)}
                className={`w-full flex items-center justify-between gap-3 text-left transition-colors ${size === "compact" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"}
                  ${option.value === value
                    ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                    : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                  }
                  ${option.id === "custom" ? "border-t border-[var(--color-border)] mt-1 pt-2" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {option.icon && <span className="shrink-0">{option.icon}</span>}
                  <span className="min-w-0">
                    <span className="block truncate">{option.label}</span>
                    {option.description && <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">{option.description}</span>}
                  </span>
                </span>
                {option.value === value && option.id !== "custom" && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
            {!loading && visibleOptions.length === 0 && <p className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">{emptyText}</p>}
            {loading && <div className="flex items-center justify-center gap-2 px-3 py-3 text-xs text-[var(--color-text-muted)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading...</div>}
            {hasMore && !loading && <button type="button" onClick={onLoadMore} className="w-full px-3 py-2 text-xs font-medium text-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)]">Load more</button>}
          </div>
        </motion.div>
      </AnimatePresence>,
      document.body
    );
  };

  return (
    <div className="w-full" ref={containerRef}>
      {label && (
        <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        {/* Trigger button or custom input */}
        {isCustomMode ? (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              onKeyDown={handleCustomKeyDown}
              onBlur={handleCustomSubmit}
              placeholder={customPlaceholder}
              disabled={disabled}
              className={`flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-highlight)] rounded-lg
                text-[var(--color-text)] placeholder-[var(--color-text-muted)]
                focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]
                transition-all duration-200 ${size === "compact" ? "min-w-0 px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"} ${triggerClassName}`}
            />
            <button
              disabled={disabled}
              onClick={() => {
                setIsCustomMode(false);
                setIsOpen(true);
              }}
              className={`${size === "compact" ? "px-2 py-1.5" : "px-3 py-2"} bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)]
                transition-all duration-200`}
            >
              <ChevronDown className={size === "compact" ? "h-3.5 w-3.5" : "h-4 w-4"} />
            </button>
          </div>
        ) : (
          <button
            ref={triggerRef}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            disabled={disabled}
            className={`w-full flex items-center justify-between bg-[var(--color-bg-secondary)] border rounded-lg
              transition-all duration-200 ${size === "compact" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"}
              ${disabled ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-60" : ""}
              ${isOpen
                ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
                : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
              } ${triggerClassName}`}
          >
            <span className={`flex min-w-0 items-center gap-2 ${selectedOption || isCustomValue ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
              {selectedOption?.icon && <span className="shrink-0">{selectedOption.icon}</span>}
              <span className="min-w-0 truncate">{displayValue}</span>
            </span>
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown className={`${size === "compact" ? "h-3.5 w-3.5" : "h-4 w-4"} flex-shrink-0 text-[var(--color-text-muted)]`} />
            </motion.div>
          </button>
        )}

        {/* Dropdown rendered via portal */}
        {renderDropdown()}
      </div>
    </div>
  );
}
