import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { usePopover } from "./usePopover";

export interface MenuItem {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  onSelect: () => void;
}

/** Button + frosted popover menu of described actions. Closes on outside click, Escape, or pick. */
export function PopoverMenu({ trigger, items, label, align = "end" }: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuItem[];
  label: string;
  /** Which trigger edge the menu lines up with. */
  align?: "start" | "end";
}) {
  const { open, close, toggle, rootRef } = usePopover();
  return (
    <span ref={rootRef} className="oui-pop-anchor">
      {trigger({ open, toggle })}
      {open ? (
        <div className={`oui-pop oui-menu${align === "start" ? " is-start" : ""}`} role="menu" aria-label={label}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" role="menuitem" className="oui-menu-item" onClick={() => { close(); item.onSelect(); }}>
                <span className="oui-menu-ic"><Icon aria-hidden="true" /></span>
                <span><b>{item.title}</b><span>{item.description}</span></span>
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
