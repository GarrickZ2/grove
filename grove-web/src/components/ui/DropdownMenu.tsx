import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MoreHorizontal } from "lucide-react";

interface DropdownItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
}

interface DropdownMenuProps {
  items: DropdownItem[];
  trigger?: React.ReactNode;
  align?: "left" | "right";
}

export function DropdownMenu({ items, trigger, align = "right" }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const getVariantClass = (variant: DropdownItem["variant"]) => {
    switch (variant) {
      case "warning":
        return "text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10";
      case "danger":
        return "text-[var(--color-error)] hover:bg-[var(--color-error)]/10";
      default:
        return "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
    }
  };

  return (
    <div ref={menuRef} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        {trigger || <MoreHorizontal className="w-4 h-4" />}
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`absolute z-50 mt-1 min-w-[140px] py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    if (!item.disabled) {
                      item.onClick();
                      setIsOpen(false);
                    }
                  }}
                  disabled={item.disabled}
                  className={`
                    w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors
                    ${getVariantClass(item.variant)}
                    ${item.disabled ? "opacity-50 cursor-not-allowed" : ""}
                  `}
                >
                  {Icon && <Icon className="w-4 h-4" />}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
