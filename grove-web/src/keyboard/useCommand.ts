import { useEffect, useRef, type DependencyList } from "react";
import { commandRegistry } from "./CommandRegistry";
import type { CommandHandler } from "./types";

interface UseCommandOptions {
  enabled?: () => boolean;
}

/**
 * Legacy def-style for PoC backward compat.
 * Phase 5 migration replaces these with useDefineCommand (full metadata)
 * or static catalog + useCommand(id, handler).
 */
interface LegacyCommandDef {
  id: string;
  key: string;
  scope?: string;
  enabled?: () => boolean;
  handler: () => void;
  preventDefault?: boolean;
  passThroughTextInput?: boolean;
}

/**
 * Register a handler for a command id.
 *
 * Two call signatures:
 *
 *   New (preferred — catalog declares id + key + scope):
 *     useCommand("task.archive", (args) => archive(args.taskId), { enabled: ... }, [deps])
 *
 *   Legacy (PoC backward compat — single-call full def):
 *     useCommand({ id, key, scope, handler, enabled, ... }, [deps])
 */
export function useCommand(
  arg1: string | LegacyCommandDef,
  arg2?: CommandHandler | DependencyList,
  arg3?: UseCommandOptions | DependencyList,
  arg4?: DependencyList,
): void {
  "use no memo";

  if (typeof arg1 === "string") {
    const id = arg1;
    const handler = arg2 as CommandHandler;
    let opts: UseCommandOptions | undefined;
    let deps: DependencyList | undefined;
    if (Array.isArray(arg3)) {
      deps = arg3;
    } else {
      opts = arg3 as UseCommandOptions | undefined;
      deps = arg4;
    }
    // Per-component the signature is stable, so the conditional hook
    // call is safe — react-hooks lint can't prove that statically.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useHandlerRegistration(id, handler, opts?.enabled, deps);
    return;
  }

  const def = arg1;
  const deps = (arg2 as DependencyList | undefined) ?? [];
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useLegacyDefRegistration(def, deps);
}

function useHandlerRegistration(
  id: string,
  handler: CommandHandler,
  enabled: (() => boolean) | undefined,
  deps: DependencyList | undefined,
): void {
  const handlerRef = useRef(handler);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    handlerRef.current = handler;
    enabledRef.current = enabled;
  });

  useEffect(() => {
    return commandRegistry.registerHandler(
      id,
      (args) => handlerRef.current(args),
      enabled
        ? () => {
            const cur = enabledRef.current;
            return cur ? cur() : true;
          }
        : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller deps
  }, [id, ...(deps ?? [])]);
}

function useLegacyDefRegistration(def: LegacyCommandDef, deps: DependencyList): void {
  const defRef = useRef(def);
  useEffect(() => {
    defRef.current = def;
  });

  useEffect(() => {
    return commandRegistry.contribute(
      {
        id: def.id,
        name: def.id,
        category: "Uncategorized",
        defaultBindings: [{ key: def.key }],
        scope: def.scope,
        preventDefault: def.preventDefault,
        passThroughTextInput: def.passThroughTextInput,
      },
      () => defRef.current.handler(),
      def.enabled
        ? () => {
            const cur = defRef.current.enabled;
            return cur ? cur() : true;
          }
        : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller deps
  }, deps);
}

/**
 * Batch legacy variant — register multiple command defs in one lifecycle.
 * Useful where a component owns many shortcuts in one scope (e.g. TasksPage).
 */
export function useCommands(defs: LegacyCommandDef[], deps: DependencyList = []): void {
  "use no memo";
  const defsRef = useRef(defs);
  useEffect(() => {
    defsRef.current = defs;
  });

  useEffect(() => {
    const disposes = defs.map((def, index) =>
      commandRegistry.contribute(
        {
          id: def.id,
          name: def.id,
          category: "Uncategorized",
          defaultBindings: [{ key: def.key }],
          scope: def.scope,
          preventDefault: def.preventDefault,
          passThroughTextInput: def.passThroughTextInput,
        },
        () => defsRef.current[index]?.handler(),
        def.enabled
          ? () => {
              const cur = defsRef.current[index]?.enabled;
              return cur ? cur() : true;
            }
          : undefined,
      ),
    );
    return () => {
      for (const d of disposes) d();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller deps
  }, deps);
}
