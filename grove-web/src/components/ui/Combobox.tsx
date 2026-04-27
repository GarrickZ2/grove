import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check } from "lucide-react";

export interface ComboboxOption {
  id: string;
  label: string;
  value: string;
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
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
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
}: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Initialize custom mode from initial props (lazy state initializer)
  const [isCustomMode, setIsCustomMode] = useState(() => !!(value && !options.find((opt) => opt.value === value)));
  const [customValue, setCustomValue] = useState(() => (value && !options.find((opt) => opt.value === value)) ? value : "");
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
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
      const preferredMaxHeight = 240;
      const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const availableAbove = rect.top - gap - viewportPadding;
      const opensUp = availableBelow < preferredMaxHeight && availableAbove > availableBelow;
      const maxHeight = Math.max(
        96,
        Math.min(preferredMaxHeight, opensUp ? availableAbove : availableBelow)
      );

      setDropdownPosition({
        top: opensUp ? rect.top - gap - maxHeight : rect.bottom + gap,
        left: rect.left,
        width: rect.width,
        maxHeight,
      });
    }
  }, []);

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

  // Render dropdown using portal
  const renderDropdown = () => {
    if (!isOpen || isCustomMode || !dropdownPosition) return null;

    return createPortal(
      <AnimatePresence>
        <motion.div
          ref={dropdownRef}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.15 }}
          style={{
            position: "fixed",
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            zIndex: 9999,
          }}
          className="py-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-y-auto"
        >
          {allOptions.map((option) => (
            <button
              key={option.id}
              onClick={() => handleSelect(option)}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors
                ${option.value === value
                  ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                }
                ${option.id === "custom" ? "border-t border-[var(--color-border)] mt-1 pt-2" : ""}`}
            >
              <span>{option.label}</span>
              {option.value === value && option.id !== "custom" && (
                <Check className="w-4 h-4" />
              )}
            </button>
          ))}
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
              className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-highlight)] rounded-lg
                text-[var(--color-text)] placeholder-[var(--color-text-muted)] text-sm
                focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]
                transition-all duration-200"
            />
            <button
              disabled={disabled}
              onClick={() => {
                setIsCustomMode(false);
                setIsOpen(true);
              }}
              className="px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)]
                transition-all duration-200"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            ref={triggerRef}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            disabled={disabled}
            className={`w-full flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] border rounded-lg
              text-sm transition-all duration-200
              ${disabled ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-60" : ""}
              ${isOpen
                ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
                : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
              }`}
          >
            <span className={selectedOption || isCustomValue ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
              {displayValue}
            </span>
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
            </motion.div>
          </button>
        )}

        {/* Dropdown rendered via portal */}
        {renderDropdown()}
      </div>
    </div>
  );
}
