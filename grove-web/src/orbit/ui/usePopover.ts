import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeScope } from "../../keyboard/useEscapeScope";

/** Open state for a button-anchored popover: closes on Escape or a pointer-down outside `rootRef`. */
export function usePopover<T extends HTMLElement = HTMLSpanElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<T>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  useEscapeScope(open, close);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return { open, setOpen, close, toggle, rootRef };
}
