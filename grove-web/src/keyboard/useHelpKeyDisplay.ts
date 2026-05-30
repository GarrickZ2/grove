import { useSyncExternalStore } from "react";
import { COMMAND_CATALOG } from "./catalog";
import { effectiveBindings } from "./conflict";
import { formatKeyDisplay } from "./keyParser";
import { userKeymapStore } from "./userKeymapStore";

/**
 * Live display string for the `help.toggle` binding (e.g. "⌘/"), tracking
 * user overrides. Falls back to "?" if the command somehow has no binding.
 * Used by the small "Press <key> for shortcuts" hints so they stay correct
 * after the user rebinds the help key.
 */
export function useHelpKeyDisplay(): string {
  useSyncExternalStore(
    (cb) => userKeymapStore.subscribe(cb),
    () => userKeymapStore.getVersion(),
  );
  const cmd = COMMAND_CATALOG.find((c) => c.id === "help.toggle");
  if (!cmd) return "?";
  const overrides = userKeymapStore.getAllOverrides();
  const keys = effectiveBindings(cmd, overrides.get(cmd.id)).map((b) => formatKeyDisplay(b.key));
  return keys[0] ?? "?";
}
