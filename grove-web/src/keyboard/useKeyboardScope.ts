import { useContext, useEffect } from "react";
import { InteractionContext } from "./InteractionContext";
import { keyboardManager } from "./KeyboardManager";

/**
 * Declare that this component owns a keyboard scope while mounted.
 * Pass `active=false` to skip the push (equivalent to not calling the hook).
 *
 * Scopes form a stack — the most recently pushed scope gets first crack
 * at matching keystrokes. Nested scopes (e.g. "preview" → "preview.modal")
 * naturally produce layered Escape behavior without priority fields.
 */
export function useKeyboardScope(scopeId: string, active: boolean = true): void {
  const visible = useContext(InteractionContext);
  useEffect(() => {
    if (!active || !visible) return;
    return keyboardManager.pushScope(scopeId);
  }, [scopeId, active, visible]);
}
