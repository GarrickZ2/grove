import { useEffect, useRef, useSyncExternalStore } from "react";
import { COMMAND_CATALOG } from "../../keyboard/catalog";
import { effectiveBindings, formatKeyDisplay, matchesHotkey, parseHotkey, userKeymapStore } from "../../keyboard";

function taskNewHotkeys(): string[] {
  const command = COMMAND_CATALOG.find((candidate) => candidate.id === "task.new");
  if (!command || userKeymapStore.getDisabled().has(command.id)) return [];
  return effectiveBindings(command, userKeymapStore.getAllOverrides().get(command.id)).map((binding) => binding.key);
}

/**
 * The user's `task.new` binding, honoured on the Dashboard. The command is
 * scoped to the Tasks page, and pushing that scope here would also wake the
 * (always-mounted) Tasks page's other shortcuts, so the Dashboard matches the
 * same binding itself. Returns the key label to show on the button.
 */
export function useNewTaskShortcut(onTrigger: () => void, enabled: boolean): string | null {
  useSyncExternalStore((callback) => userKeymapStore.subscribe(callback), () => userKeymapStore.getVersion());
  const hotkeys = taskNewHotkeys();
  const triggerRef = useRef(onTrigger);
  useEffect(() => { triggerRef.current = onTrigger; });
  const key = hotkeys.join("\u0000");

  useEffect(() => {
    if (!enabled || !key) return;
    const parsed = key.split("\u0000").flatMap((hotkey) => {
      try { return [parseHotkey(hotkey)]; } catch { return []; }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!parsed.some((hotkey) => matchesHotkey(event, hotkey))) return;
      event.preventDefault();
      triggerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, key]);

  return enabled && hotkeys[0] ? formatKeyDisplay(hotkeys[0]) : null;
}
