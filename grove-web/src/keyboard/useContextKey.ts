import { useEffect } from "react";
import { contextKeyService } from "./ContextKeyService";

/**
 * Declare that this component owns a boolean context key while mounted.
 * The key auto-resets to false on unmount.
 *
 *   useContextKey("chatFocus", isFocused);
 *
 * Whenever `value` changes the key updates; whenever the component
 * unmounts the key resets to its default (false). Multiple components
 * owning the same key is allowed but last-write-wins — there is no
 * ref-counting at this layer (use distinct key names instead).
 */
export function useContextKey(name: string, value: boolean): void {
  useEffect(() => {
    const key = contextKeyService.createKey<boolean>(name, false);
    key.set(value);
    return () => {
      key.reset();
    };
  }, [name, value]);
}
