import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useIsMobile } from "../../hooks";

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
  const { isMobile, isTouchDevice } = useIsMobile();

  // On mobile/touch, render as Action Sheet
  if ((isMobile || isTouchDevice) && position) {
    return <ActionSheet items={items} isOpen={!!position} onClose={onClose} />;
  }

  return <DesktopContextMenu items={items} position={position} onClose={onClose} />;
}

// --- Action Sheet (mobile) ---
function ActionSheet({ items, isOpen, onClose }: { items: ContextMenuItem[]; isOpen: boolean; onClose: () => void }) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  const getVariantColor = (variant: ContextMenuItem["variant"]) => {
    switch (variant) {
      case "warning": return "text-[var(--color-warning)]";
      case "danger": return "text-[var(--color-error)]";
      default: return "text-[var(--color-text)]";
    }
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[9998] bg-black/50"
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-[9999] pb-[env(safe-area-inset-bottom)]"
          >
            <div className="bg-[var(--color-bg)] rounded-t-2xl border-t border-[var(--color-border)] shadow-xl">
              {/* Drag indicator */}
              <div className="flex justify-center pt-3 pb-2">
                <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
              </div>

              <div className="px-2 pb-3 max-h-[60vh] overflow-y-auto">
                {items.map((item) => {
                  if (item.divider) {
                    return <div key={item.id} className="my-1 border-t border-[var(--color-border)]" />;
                  }
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        if (!item.disabled) {
                          item.onClick();
                          onClose();
                        }
                      }}
                      disabled={item.disabled}
                      className={`
                        w-full flex items-center gap-3 px-4 py-3 text-sm rounded-lg transition-colors
                        ${getVariantColor(item.variant)}
                        ${item.disabled ? "opacity-50 cursor-not-allowed" : "active:bg-[var(--color-bg-tertiary)]"}
                      `}
                    >
                      {Icon && <Icon className="w-5 h-5" />}
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Cancel button */}
              <div className="px-2 pb-3">
                <button
                  onClick={onClose}
                  className="w-full py-3 text-sm font-medium text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)] rounded-lg active:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

// --- Desktop Context Menu ---
function DesktopContextMenu({ items, position, onClose }: ContextMenuProps) {
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
