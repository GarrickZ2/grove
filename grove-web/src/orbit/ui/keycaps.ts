import { formatKeyDisplay } from "../../keyboard";

/** Display parts of a hotkey ("Cmd+Shift+K" → ["⌘", "⇧", "K"] on macOS). */
export function keycapParts(hotkey: string): string[] {
  const display = formatKeyDisplay(hotkey);
  const parts = display.includes(" ") ? display.split(" ") : display.split("+");
  const keys = parts.filter(Boolean);
  return keys.length > 0 ? keys : [display];
}
