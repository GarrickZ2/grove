import { useEffect, useRef, type DependencyList } from "react";

export interface HotkeyDefinition {
  key: string; // e.g. "j", "ArrowDown", "Alt+1", "Space", "?"
  handler: () => void;
  options?: {
    enabled?: boolean;
    preventDefault?: boolean; // default true
  };
}

/**
 * Parse a hotkey string into its components.
 * Supports: "j", "ArrowDown", "Alt+1", "Shift+?", "Space", "Escape"
 */
function parseHotkey(hotkey: string) {
  const parts = hotkey.split("+");
  const modifiers = {
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
  };

  let key = parts[parts.length - 1];

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "alt") modifiers.alt = true;
    else if (mod === "ctrl") modifiers.ctrl = true;
    else if (mod === "meta" || mod === "cmd") modifiers.meta = true;
    else if (mod === "shift") modifiers.shift = true;
  }

  // Normalize key aliases
  if (key === "Space") key = " ";

  return { key, modifiers };
}

/**
 * Check if a keyboard event matches a parsed hotkey.
 * Uses e.code for Alt+digit combos (macOS Alt produces special chars).
 */
function matchesHotkey(
  e: KeyboardEvent,
  hotkey: ReturnType<typeof parseHotkey>
): boolean {
  const { key, modifiers } = hotkey;

  // Check modifiers
  if (e.altKey !== modifiers.alt) return false;
  if (e.ctrlKey !== modifiers.ctrl) return false;
  if (e.metaKey !== modifiers.meta) return false;

  // For Shift, only enforce if explicitly specified in the hotkey
  // (e.g. "Shift+?" requires shift, but "?" also needs shift on most keyboards)
  if (modifiers.shift && !e.shiftKey) return false;

  // For Alt+digit, use e.code since macOS Alt changes e.key
  if (modifiers.alt && /^\d$/.test(key)) {
    return e.code === `Digit${key}`;
  }

  // Match by key (case-insensitive for single letters)
  if (key.length === 1) {
    return e.key.toLowerCase() === key.toLowerCase();
  }

  return e.key === key;
}

/**
 * Check if the current focus context should suppress hotkeys.
 */
function shouldSuppress(_e: KeyboardEvent): "all" | "alpha" | false {
  // 1. Terminal focused — suppress all
  const active = document.activeElement;
  if (active?.closest(".xterm")) return "all";

  // 2. Dialog open — suppress all
  if (document.querySelector("[data-hotkeys-dialog]")) return "all";

  // 3. Input/textarea focused — suppress alpha keys, allow arrows/escape/alt combos
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    (active as HTMLElement)?.isContentEditable
  ) {
    return "alpha";
  }

  return false;
}

function isAlphaKey(e: KeyboardEvent): boolean {
  // Single character keys that are not special
  return e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey;
}

export function useHotkeys(
  hotkeys: HotkeyDefinition[],
  deps: DependencyList = []
): void {
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if already handled
      if (e.defaultPrevented) return;

      const suppression = shouldSuppress(e);
      if (suppression === "all") return;

      for (const def of hotkeysRef.current) {
        // Check enabled
        if (def.options?.enabled === false) continue;

        const parsed = parseHotkey(def.key);

        // If input is focused and this is an alpha key, skip
        if (suppression === "alpha" && isAlphaKey(e)) continue;

        if (matchesHotkey(e, parsed)) {
          if (def.options?.preventDefault !== false) {
            e.preventDefault();
          }
          def.handler();
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
