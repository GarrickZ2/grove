import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number } | null;
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState<{ x: number; y: number } | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  // Get actionable (non-divider, non-disabled) item indices
  const actionableIndices = items
    .map((item, i) => (!item.divider && !item.disabled ? i : -1))
    .filter((i) => i !== -1);

  // Reset focus when menu opens/closes
  useEffect(() => {
    if (position) {
      setFocusedIndex(-1);
    }
  }, [position]);

  // Adjust position to keep menu within viewport
  useEffect(() => {
    if (!position) {
      setAdjusted(null);
      return;
    }
    // Start with the mouse position, adjust after render
    setAdjusted(position);
  }, [position]);

  // After render, check bounds and adjust
  useEffect(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = position;
    if (x + rect.width > vw) x = vw - rect.width - 8;
    if (y + rect.height > vh) y = vh - rect.height - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    if (x !== adjusted?.x || y !== adjusted?.y) {
      setAdjusted({ x, y });
    }
  });

  // Close on click outside
  useEffect(() => {
    if (!position) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [position, onClose]);

  const moveFocus = useCallback((direction: 1 | -1) => {
    if (actionableIndices.length === 0) return;
    setFocusedIndex((prev) => {
      const currentPos = actionableIndices.indexOf(prev);
      let nextPos: number;
      if (currentPos === -1) {
        nextPos = direction === 1 ? 0 : actionableIndices.length - 1;
      } else {
        nextPos = (currentPos + direction + actionableIndices.length) % actionableIndices.length;
      }
      return actionableIndices[nextPos];
    });
  }, [actionableIndices]);

  const activateItem = useCallback(() => {
    if (focusedIndex >= 0 && focusedIndex < items.length) {
      const item = items[focusedIndex];
      if (!item.divider && !item.disabled) {
        item.onClick();
        onClose();
      }
    }
  }, [focusedIndex, items, onClose]);

  // Keyboard navigation: Escape, arrows, j/k, Enter
  useEffect(() => {
    if (!position) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "ArrowDown":
        case "j":
          e.preventDefault();
          e.stopPropagation();
          moveFocus(1);
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          e.stopPropagation();
          moveFocus(-1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          e.stopPropagation();
          activateItem();
          break;
      }
    };
    // Use capture phase to intercept before useHotkeys
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [position, onClose, moveFocus, activateItem]);

  // Close on scroll
  useEffect(() => {
    if (!position) return;
    const handleScroll = () => onClose();
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [position, onClose]);

  const getVariantClass = (variant: ContextMenuItem["variant"], isFocused: boolean) => {
    const focusBg = isFocused ? "bg-[var(--color-bg-tertiary)]" : "";
    switch (variant) {
      case "warning":
        return `text-[var(--color-warning)] ${isFocused ? "bg-[var(--color-warning)]/10" : "hover:bg-[var(--color-warning)]/10"}`;
      case "danger":
        return `text-[var(--color-error)] ${isFocused ? "bg-[var(--color-error)]/10" : "hover:bg-[var(--color-error)]/10"}`;
      default:
        return `text-[var(--color-text)] ${focusBg || "hover:bg-[var(--color-bg-tertiary)]"}`;
    }
  };

  const pos = adjusted || position;

  return createPortal(
    <AnimatePresence>
      {position && pos && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.12 }}
          style={{ top: pos.y, left: pos.x }}
          className="fixed z-[9999] min-w-[160px] py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
          data-hotkeys-dialog
        >
          {items.map((item, index) => {
            if (item.divider) {
              return (
                <div
                  key={item.id}
                  className="my-1 border-t border-[var(--color-border)]"
                />
              );
            }
            const Icon = item.icon;
            const isFocused = index === focusedIndex;
            return (
              <button
                key={item.id}
                onClick={() => {
                  if (!item.disabled) {
                    item.onClick();
                    onClose();
                  }
                }}
                onMouseEnter={() => setFocusedIndex(index)}
                disabled={item.disabled}
                className={`
                  w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors
                  ${getVariantClass(item.variant, isFocused)}
                  ${item.disabled ? "opacity-50 cursor-not-allowed" : "cursor-default"}
                `}
              >
                {Icon && <Icon className="w-4 h-4" />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
