import { useEffect, useRef, type DependencyList } from "react";

interface HotkeyDefinition {
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
/** Keys the app owns when combined with Meta (Cmd). Only these get to bypass
 *  the focus-based suppression below — everything else (Cmd+A, Cmd+C, Cmd+V,
 *  Cmd+Z, …) must reach the focused input / xterm so native editing works.
 *  Previously we passed *every* Meta combo through, which broke select-all
 *  and clipboard ops inside Monaco / xterm / chat textareas.
 *
 *  Maintenance gotchas (read before adding a binding):
 *  - Matching is on `e.key.toLowerCase()`, so add the LITERAL key as it
 *    appears in `KeyboardEvent.key`. Cmd+Shift+P yields `key === "p"` on
 *    macOS — `Shift` doesn't change the key here.
 *  - Cmd+Alt combos shift `e.key` to the option-mapped character on
 *    macOS (e.g. Cmd+Alt+/ → key="÷"). For those bindings prefer
 *    matching on `e.code` upstream (see useHotkeys' own matcher) and
 *    skip this list entirely.
 *  - Punctuation like `/`, `,`, `.` is fine to add (key === literal char).
 *  - Single letters: only add when the binding really is application-
 *    global; otherwise leave it out so the native editing surface sees it. */
const APP_OWNED_META_KEYS = new Set([
  "k", "p", "o",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

function shouldSuppress(_e: KeyboardEvent): "all" | "alpha" | false {
  // App-level Meta shortcuts (Cmd+K / Cmd+P / Cmd+O / Cmd+<digit>) should
  // fire regardless of where focus lives — otherwise the palette feels
  // broken in Tauri's WKWebView, where focus stays glued to the last-typed
  // textarea (TaskChat / ACP chat / Monaco) and Cmd+K silently no-ops.
  //
  // Everything else under Meta (Cmd+A/C/V/Z/X/F/...) MUST transparently
  // reach the focused element so native editing / clipboard / find work.
  if (_e.metaKey) {
    if (APP_OWNED_META_KEYS.has(_e.key.toLowerCase())) return false;
    // Fall through to normal suppression rules below so the keystroke
    // still reaches focused inputs without being preventDefault-ed.
  }

  // 1. Terminal focused — suppress all
  const active = document.activeElement;
  if (active?.closest(".xterm")) {
    return "all";
  }

  // 2. Monaco/CodeMirror editor focused — suppress all
  if (active?.closest(".monaco-editor") || active?.closest(".cm-editor") || active?.closest(".CodeMirror")) return "all";

  // 3. Dialog open — suppress all
  if (document.querySelector("[data-hotkeys-dialog]")) return "all";

  // 4. Textarea focused — suppress all (needs Enter for newlines)
  if (active instanceof HTMLTextAreaElement || (active as HTMLElement)?.isContentEditable) {
    return "all";
  }

  // 5. Input/select focused — suppress alpha keys, allow arrows/escape/alt combos
  if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) {
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
  "use no memo";
  const hotkeysRef = useRef(hotkeys);
  useEffect(() => {
    hotkeysRef.current = hotkeys;
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if already handled by another useHotkeys instance
      if (e.defaultPrevented) return;

      // Skip during IME composition (e.g. Chinese/Japanese input)
      if (e.isComposing || e.keyCode === 229) return;

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

    // Use capture phase to intercept browser shortcuts (Cmd+P, Cmd+T, etc.)
    // before the browser's default handler processes them
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps -- caller-supplied deps
}
