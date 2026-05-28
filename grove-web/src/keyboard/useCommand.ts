import { useEffect, useRef, type DependencyList } from "react";
import { keyboardManager } from "./KeyboardManager";
import type { CommandDef } from "./types";

/**
 * Register a command for the lifetime of the component. The command
 * triggers when its scope is active (or when no scope is given, as a
 * global fallback) and the key combination matches.
 *
 * Handler / enabled closures are forwarded through a ref so callers
 * don't have to list them in `deps` — only re-register if the static
 * properties (id, key, scope, modifiers) change.
 */
export function useCommand(def: CommandDef, deps: DependencyList = []): void {
  "use no memo";
  const defRef = useRef(def);
  useEffect(() => {
    defRef.current = def;
  });

  useEffect(() => {
    return keyboardManager.registerCommand({
      id: def.id,
      key: def.key,
      scope: def.scope,
      preventDefault: def.preventDefault,
      passThroughTextInput: def.passThroughTextInput,
      handler: () => defRef.current.handler(),
      enabled: def.enabled
        ? () => defRef.current.enabled?.() ?? true
        : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
  }, deps);
}

/**
 * Batch variant — registers multiple commands under the same lifecycle.
 * Useful when a component owns many commands in one scope (e.g. TasksPage).
 */
export function useCommands(defs: CommandDef[], deps: DependencyList = []): void {
  "use no memo";
  const defsRef = useRef(defs);
  useEffect(() => {
    defsRef.current = defs;
  });

  useEffect(() => {
    const disposes = defs.map((def, index) =>
      keyboardManager.registerCommand({
        id: def.id,
        key: def.key,
        scope: def.scope,
        preventDefault: def.preventDefault,
        passThroughTextInput: def.passThroughTextInput,
        handler: () => defsRef.current[index]?.handler(),
        enabled: def.enabled
          ? () => defsRef.current[index]?.enabled?.() ?? true
          : undefined,
      }),
    );
    return () => {
      for (const dispose of disposes) dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
  }, deps);
}
