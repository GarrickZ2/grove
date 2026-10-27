import { useEffect, useRef, type RefObject } from "react";

/** Keep keyboard navigation in the active MCP surface; nested shared
 * confirmation dialogs retain their own Escape/confirm bindings. */
export function useMcpDialogFocus(
  root: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  suspended = false,
  onCancelConfirmation?: () => void,
) {
  const latest = useRef({ onClose, suspended, onCancelConfirmation });
  useEffect(() => {
    latest.current = { onClose, suspended, onCancelConfirmation };
  }, [onClose, suspended, onCancelConfirmation]);
  useEffect(() => {
    if (!suspended) return;
    const previous = document.activeElement;
    const dialog = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      ),
    ).at(-1);
    if (dialog && !dialog.contains(root.current))
      dialog
        .querySelector<HTMLElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [suspended, root]);
  useEffect(() => {
    const previous = document.activeElement;
    const element = root.current;
    const visibleInputs = (scope: HTMLElement | null = element) =>
      Array.from(
        scope?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
        ) ?? [],
      ).filter(
        (node) =>
          node.getClientRects().length > 0 &&
          !node.closest("[hidden], .hidden"),
      );
    (
      element?.querySelector<HTMLElement>("[data-autofocus]") ??
      visibleInputs()[0]
    )?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      const nested = latest.current.suspended
        ? Array.from(
            document.querySelectorAll<HTMLElement>(
              '[role="dialog"][aria-modal="true"]',
            ),
          ).at(-1)
        : null;
      const scope = nested && !nested.contains(element) ? nested : element;
      // A menu or another modal rendered in a portal owns its own keys.
      if (
        !latest.current.suspended &&
        event.target instanceof Node &&
        event.target !== document.body &&
        event.target !== document.documentElement &&
        scope &&
        !scope.contains(event.target)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (latest.current.suspended) latest.current.onCancelConfirmation?.();
        else latest.current.onClose();
      } else if (event.key === "Tab") {
        const fields = visibleInputs(scope);
        const first = fields[0];
        const last = fields.at(-1);
        if (scope && !scope.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [root]);
}
