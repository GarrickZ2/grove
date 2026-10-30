import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

interface DropdownItem {
  id: string;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  children?: DropdownItem[];
  onOpen?: () => void;
  keepOpenOnClick?: boolean;
  wideChildren?: boolean;
  listAction?: boolean;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
  dividerBefore?: boolean;
}

interface DropdownMenuProps {
  items: DropdownItem[];
  trigger?: React.ReactNode;
  align?: "left" | "right";
  triggerClassName?: string;
  ariaLabel?: string;
  /** Match the compact, viewport-aware New Session picker surface. */
  portal?: boolean;
  compact?: boolean;
  size?: "default" | "small";
  /** Portal menus can open below the trigger and flip above when needed. */
  placement?: "side" | "bottom";
  appearance?: "default" | "orbit";
}

export function DropdownMenu({
  items,
  trigger,
  align = "right",
  triggerClassName,
  ariaLabel = "More actions",
  portal = false,
  compact = false,
  size = "default",
  placement = "side",
  appearance = "default",
}: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null);
  const [portalAnchor, setPortalAnchor] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeSubmenu = items.find(
    (item) => item.id === activeSubmenuId && item.children?.length,
  );
  const visibleItems = activeSubmenu?.children ?? items;
  const submenuIsWide = !!activeSubmenu?.wideChildren;
  const small = size === "small";
  const menuWidth = submenuIsWide ? 360 : small ? 128 : appearance === "orbit" ? 160 : 192;
  // Orbit's action list should open at its natural height. Reserve room for
  // the outer padding/border while keeping oversized submenus bounded.
  const menuMaxHeight = appearance === "orbit" && !activeSubmenu
    ? Math.max(0, (window.visualViewport?.height ?? window.innerHeight) - 28)
    : submenuIsWide ? 420 : 256;

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setActiveSubmenuId(null);
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [closeMenu, isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (activeSubmenuId) {
          setActiveSubmenuId(null);
        } else {
          closeMenu();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [activeSubmenuId, closeMenu, isOpen]);

  useEffect(() => {
    if (!isOpen || !portal) return;
    const handleResize = () => closeMenu();
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    window.visualViewport?.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("scroll", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
      window.visualViewport?.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("scroll", handleResize);
    };
  }, [closeMenu, isOpen, portal]);

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

  const updatePortalAnchor = useCallback((width: number, maxHeight: number) => {
    if (portal && triggerRef.current) {
      const viewportMargin = 8;
      const rect = triggerRef.current.getBoundingClientRect();
      if (placement === "bottom") {
        const viewport = window.visualViewport;
        const viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
        const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
        const height = Math.min(
          menuRef.current?.offsetHeight ?? visibleItems.length * (small ? 24 : 32) + 8,
          maxHeight,
        );
        const gap = 4;
        const below = viewportBottom - viewportMargin - rect.bottom - gap;
        const above = rect.top - gap - viewportTop - viewportMargin;
        const top = below >= height || below >= above ? rect.bottom + gap : rect.top - height - gap;
        setPortalAnchor({
          top: Math.max(viewportTop + viewportMargin, Math.min(top, viewportBottom - height - viewportMargin)),
          left: Math.max(viewportLeft + viewportMargin, Math.min(
            align === "right" ? rect.right - width : rect.left,
            viewportRight - width - viewportMargin,
          )),
        });
        return;
      }
      setPortalAnchor({
        top: Math.max(
          viewportMargin,
          Math.min(
            rect.top,
            window.innerHeight - maxHeight - viewportMargin,
          ),
        ),
        left: Math.max(
          viewportMargin,
          Math.min(
            rect.right + viewportMargin,
            window.innerWidth - width - viewportMargin,
          ),
        ),
      });
    }
  }, [align, placement, portal, small, visibleItems.length]);

  const openMenu = () => {
    updatePortalAnchor(menuWidth, menuMaxHeight);
    setIsOpen(true);
  };

  useLayoutEffect(() => {
    if (!isOpen || !portal) return;
    updatePortalAnchor(menuWidth, menuMaxHeight);
  }, [activeSubmenuId, isOpen, menuMaxHeight, menuWidth, portal, updatePortalAnchor]);

  // Orbit cards are padded and rounded: full-bleed rules become inset dividers.
  const orbit = appearance === "orbit";
  const renderItem = (item: DropdownItem) => {
    const Icon = item.icon;
    const hasChildren = !!item.children?.length;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => {
          if (item.disabled) return;
          if (hasChildren) {
            item.onOpen?.();
            setActiveSubmenuId(item.id);
          } else {
            item.onClick?.();
            if (!item.keepOpenOnClick) closeMenu();
          }
        }}
        disabled={item.disabled}
        className={`w-full flex items-center text-left transition-colors focus:outline-none ${
          item.listAction
            ? `justify-center ${orbit ? "" : "border-t border-[var(--color-border)]"} px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]`
            : small
            ? "gap-1.5 px-2 py-1 text-xs leading-4"
            : compact
            ? "gap-2 px-2.5 py-1.5 text-[12.5px]"
            : item.description
              ? "gap-2.5 px-3 py-2 text-sm"
              : "gap-2 px-3 py-1.5 text-sm"
        } ${item.listAction ? "" : getVariantClass(item.variant)} ${
          item.disabled ? "cursor-not-allowed opacity-50" : ""
        }`}
      >
        {Icon && (
          <span className={`dropdown-item-icon flex shrink-0 items-center justify-center ${small ? "h-3 w-3" : "h-4 w-4"}`}>
            <Icon className={small ? "h-3 w-3" : compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </span>
        )}
        <span className={item.listAction ? "min-w-0" : "min-w-0 flex-1"}>
          <span className="block truncate">{item.label}</span>
          {item.description && (
            <span className="mt-0.5 block truncate text-xs font-normal text-[var(--color-text-muted)]">
              {item.description}
            </span>
          )}
        </span>
        {hasChildren && <ChevronRight className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />}
      </button>
    );
  };

  const menuItems = (
    <div style={{ maxHeight: menuMaxHeight }} className="flex min-h-0 flex-col overflow-hidden">
      {activeSubmenu && (
        <button
          type="button"
          onClick={() => setActiveSubmenuId(null)}
          className={`flex w-full shrink-0 items-center ${orbit ? "" : "border-b border-[var(--color-border)]"} text-left font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] ${compact ? "gap-2 px-2.5 py-1.5 text-[12.5px]" : "gap-2 px-3 py-1.5 text-sm"}`}
        >
          <ChevronLeft className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>{activeSubmenu.label}</span>
        </button>
      )}
      {activeSubmenu && orbit && <div className="orbit-menu-divider" />}
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${small ? "py-0.5" : "py-1"}`} onWheel={(event) => event.stopPropagation()}>
        {visibleItems.map((item) => <Fragment key={item.id}>{(item.dividerBefore || (orbit && item.listAction)) && <div className="orbit-menu-divider" />}{renderItem(item)}</Fragment>)}
      </div>
    </div>
  );

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) closeMenu();
          else openMenu();
        }}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        className={
          triggerClassName ??
          "flex items-center justify-center p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        }
      >
        {trigger || <MoreHorizontal className="w-4 h-4" />}
      </button>

      {/* Dropdown */}
      {!portal && (
        <AnimatePresence>
          {isOpen && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`absolute z-50 mt-1 ${submenuIsWide ? "w-[360px]" : activeSubmenu ? "min-w-[220px]" : small ? "w-32" : "min-w-[140px]"} max-h-[420px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {menuItems}
          </motion.div>
          )}
        </AnimatePresence>
      )}
      {portal &&
        isOpen &&
        portalAnchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: portalAnchor.top,
              left: portalAnchor.left,
              width: menuWidth,
              maxHeight: menuMaxHeight,
              zIndex: 1000,
            }}
            className={`overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] ${small ? "rounded-md shadow-md" : "rounded-lg shadow-lg"} ${appearance === "orbit" ? "orbit-action-menu" : ""}`}
          >
            {menuItems}
          </div>,
          document.body,
        )}
    </div>
  );
}
