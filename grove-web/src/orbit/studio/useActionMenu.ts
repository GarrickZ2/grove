import { useCallback, useState } from "react";
import type { MenuAnchor } from "./studioView";

/** Menu open state for one item: `fromButton` (a "⋯" button) or `fromPoint` (a right-click). */
export function useActionMenu() {
  const [at, setAt] = useState<MenuAnchor | null>(null);
  const close = useCallback(() => setAt(null), []);
  const fromButton = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAt({ x: rect.right, y: rect.bottom + 4, alignEnd: true, flipY: rect.top - 4 });
  }, []);
  const fromPoint = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  return { at, close, fromButton, fromPoint, open: at !== null };
}
