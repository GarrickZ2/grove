import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { placeMenu, type MenuAnchor } from "./studioView";

export interface ActionItem {
  id: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Hairline above this item. */
  separated?: boolean;
}

/**
 * Compact action menu at a point (a tile's "⋯" button or a right-click).
 * Portaled and fixed, so lists that scroll or clip never cut it off. Closes
 * on pick, Escape, outside pointer-down, scroll or resize.
 */
export function ActionMenu({ at, items, label, onClose }: {
  at: MenuAnchor | null;
  items: ActionItem[];
  label: string;
  onClose: () => void;
}) {
  const open = at !== null;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEscapeScope(open, onClose);

  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPos(placeMenu(at, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open, onClose]);

  if (!at || typeof document === "undefined") return null;
  return createPortal(
    <div className="orbit-ui osd-menu-layer">
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="osd-menu"
        style={pos ? { left: pos.left, top: pos.top } : { left: at.x, top: at.y, visibility: "hidden" }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`osd-menu-item${item.danger ? " is-danger" : ""}${item.separated ? " is-sep" : ""}`}
              onClick={(event) => { event.stopPropagation(); onClose(); item.onSelect(); }}
            >
              <Icon aria-hidden="true" />{item.label}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
