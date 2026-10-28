import { useId } from "react";
import { useDefineCommand } from "./useDefineCommand";
import { useKeyboardScope } from "./useKeyboardScope";

/** Give an open transient surface first refusal on Escape. */
export function useEscapeScope(active: boolean, onEscape: () => void): void {
  const scope = `escape.${useId()}`;
  useKeyboardScope(scope, active);
  useDefineCommand({
    id: `${scope}.close`,
    name: "Close active surface",
    category: "Navigation",
    defaultBindings: [{ key: "Escape" }],
    scope,
    hidden: true,
    handler: onEscape,
  });
}
