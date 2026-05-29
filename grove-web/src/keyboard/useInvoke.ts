import { useCallback } from "react";
import { commandRegistry } from "./CommandRegistry";

/**
 * Hook for UI surfaces (buttons / menu items / right-click actions) to
 * fire a command by id. Returns a stable callback so React doesn't
 * over-render when used in JSX.
 *
 *   const archive = useInvoke<{ taskId: string }>("task.archive");
 *   <button onClick={() => archive({ taskId: id })}>Archive</button>
 *
 * Returns boolean indicating dispatch happened. Callers usually ignore
 * the return; debugging / fallback paths can check it (e.g. show toast
 * "no handler registered for this command").
 */
export function useInvoke<TArgs = unknown>(id: string): (args?: TArgs) => boolean {
  return useCallback((args?: TArgs) => commandRegistry.invoke(id, args), [id]);
}

/** Non-hook variant for use outside React (event handlers in vanilla code). */
export function invoke<TArgs = unknown>(id: string, args?: TArgs): boolean {
  return commandRegistry.invoke(id, args);
}
