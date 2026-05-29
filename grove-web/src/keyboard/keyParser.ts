import type { ModifierMatch, ModifierSides, ParsedKey } from "./types";

/**
 * Parse a hotkey string into structured form.
 *
 * Supports modifiers: Alt, Ctrl, Meta, Cmd (alias for Meta), Shift, Mod.
 * "Mod" is a cross-platform alias that matches Meta OR Ctrl — it lets a
 * single binding cover both macOS (Cmd) and Linux/Windows (Ctrl) without
 * platform-specific code.
 *
 * Examples:
 *   "j"           → bare key
 *   "Meta+f"      → Cmd+F on mac, Win+F on Windows
 *   "Mod+f"       → Cmd+F on mac, Ctrl+F elsewhere (matches both)
 *   "Shift+?"     → explicit Shift required
 *   "Alt+1"       → matched via e.code on macOS (Alt remaps e.key)
 */
export function parseHotkey(hotkey: string): ParsedKey {
  const parts = hotkey.split("+");
  let key = parts[parts.length - 1];
  let alt: ModifierMatch = false;
  let ctrl: ModifierMatch = false;
  let meta: ModifierMatch = false;
  let shift: ModifierMatch = false;
  let mod = false;

  for (let i = 0; i < parts.length - 1; i++) {
    let m = parts[i].toLowerCase();
    // Optional Left/Right prefix pins the modifier to a physical side
    // ("LeftMeta", "RightAlt", …). Bare modifier = "any" side.
    let side: ModifierMatch = "any";
    if (m.startsWith("left")) {
      side = "left";
      m = m.slice(4);
    } else if (m.startsWith("right")) {
      side = "right";
      m = m.slice(5);
    }
    if (m === "alt" || m === "opt" || m === "option") alt = side;
    else if (m === "ctrl" || m === "control") ctrl = side;
    else if (m === "meta" || m === "cmd" || m === "command") meta = side;
    else if (m === "shift") shift = side;
    else if (m === "mod") mod = true; // cross-platform; never side-specific
  }

  if (key === "Space") key = " ";

  return { key, alt, ctrl, meta, shift, mod };
}

/**
 * Match one modifier flag against a requirement. `false` → must be up;
 * `"any"` → down on any side; `"left"`/`"right"` → down on that physical
 * side (needs `side` from the location tracker — fails closed if unknown).
 */
function matchModifier(
  down: boolean,
  want: ModifierMatch,
  side: "left" | "right" | null,
): boolean {
  if (want === false) return !down;
  if (!down) return false;
  if (want === "any") return true;
  return side === want;
}

/**
 * Does this event match the parsed hotkey? `sides` (from KeyboardManager's
 * modifier-location tracker) is needed to confirm left/right-specific
 * requirements; without it a side requirement fails closed.
 */
export function matchesHotkey(
  e: KeyboardEvent,
  parsed: ParsedKey,
  sides?: ModifierSides,
): boolean {
  if (!matchModifier(e.altKey, parsed.alt, sides?.alt ?? null)) return false;

  if (parsed.mod) {
    // Mod accepts either Meta or Ctrl (but not neither); side-agnostic.
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    if (!matchModifier(e.ctrlKey, parsed.ctrl, sides?.ctrl ?? null)) return false;
    if (!matchModifier(e.metaKey, parsed.meta, sides?.meta ?? null)) return false;
  }

  // Shift only enforced when required. "?" naturally needs shift on US
  // keyboards but a bare "?" binding should still match — only an explicit
  // Shift requirement forces it. A side-specific Shift is honoured when the
  // tracker knows the side.
  if (parsed.shift) {
    if (!e.shiftKey) return false;
    if (parsed.shift !== "any" && (sides?.shift ?? null) !== parsed.shift) return false;
  }

  // macOS Alt remaps the printable key (Opt+C → "ç", Alt+1 → "¡"), so when
  // Alt is required we match on the physical e.code instead of e.key. This is
  // what makes Mod+Alt+<letter> bindings actually fire on macOS.
  if (parsed.alt && parsed.key.length === 1) {
    const k = parsed.key;
    if (/^[a-z]$/i.test(k)) return e.code === `Key${k.toUpperCase()}`;
    if (/^\d$/.test(k)) return e.code === `Digit${k}`;
  }

  if (parsed.key.length === 1) {
    return e.key.toLowerCase() === parsed.key.toLowerCase();
  }

  return e.key === parsed.key;
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const KEY_DISPLAY_MAP: Record<string, string> = {
  Escape: "Esc",
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  " ": "Space",
};

/**
 * Render a canonical hotkey string ("Mod+Shift+P") in display form
 * appropriate for the current platform. Used by Settings UI / HelpOverlay
 * / Palette to show keys the way the user sees them on their keyboard.
 */
export function formatKeyDisplay(hotkey: string): string {
  const parts = hotkey.split("+");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const p = parts[i];
    if (isLast) {
      out.push(KEY_DISPLAY_MAP[p] ?? (p.length === 1 ? p.toUpperCase() : p));
    } else {
      let lower = p.toLowerCase();
      let sidePfx = "";
      if (lower.startsWith("left")) {
        sidePfx = "L";
        lower = lower.slice(4);
      } else if (lower.startsWith("right")) {
        sidePfx = "R";
        lower = lower.slice(5);
      }
      if (lower === "mod") out.push(IS_MAC ? "⌘" : "Ctrl");
      else if (lower === "meta" || lower === "cmd" || lower === "command") out.push(sidePfx + "⌘");
      else if (lower === "ctrl" || lower === "control") out.push(sidePfx + "Ctrl");
      else if (lower === "alt" || lower === "opt" || lower === "option")
        out.push(sidePfx + (IS_MAC ? "⌥" : "Alt"));
      else if (lower === "shift") out.push(sidePfx + (IS_MAC ? "⇧" : "Shift"));
      else out.push(p);
    }
  }
  // On macOS, separate the symbols with a hair-space (U+200A) so a
  // combo like ⌘⌥N renders as "⌘ ⌥ N" — the symbols are otherwise
  // visually identical strips and run together. The hair-space is
  // narrow enough that it still reads as one combo, just legibly.
  return IS_MAC ? out.join(" ") : out.join("+");
}

/**
 * Format a KeyboardEvent back to a canonical hotkey string. Used by
 * Settings UI when recording a new binding from the user.
 *
 * Always emits "Mod+" rather than "Meta+" / "Ctrl+" so the resulting
 * binding works cross-platform automatically. Pass `prefer = "platform"`
 * to emit the literal modifier the user pressed.
 */
export function formatKeyboardEvent(
  e: KeyboardEvent,
  options: {
    prefer?: "mod" | "platform";
    sides?: ModifierSides;
    distinguishSide?: boolean;
  } = {},
): string {
  const prefer = options.prefer ?? "mod";
  const sides = options.sides;
  const withSide = options.distinguishSide === true;
  // Prefix a modifier token with Left/Right only when distinguishing sides
  // AND the tracker knows which side is held.
  const pre = (side: "left" | "right" | null | undefined): string =>
    withSide && side === "left" ? "Left" : withSide && side === "right" ? "Right" : "";
  const parts: string[] = [];
  if (e.altKey) parts.push(pre(sides?.alt) + "Alt");
  if (prefer === "mod" && !withSide && (e.metaKey || e.ctrlKey)) {
    // Cross-platform Mod is side-agnostic; only emitted when NOT distinguishing.
    parts.push("Mod");
  } else {
    if (e.ctrlKey) parts.push(pre(sides?.ctrl) + "Ctrl");
    if (e.metaKey) parts.push(pre(sides?.meta) + "Meta");
  }
  let key = e.key;
  if (key === " ") key = "Space";

  // macOS Option(Alt) maps physical keys to "composed" characters
  // (Option+A → "å", Option+1 → "¡", Option+/ → "÷", …). The user
  // pressed A, not å — record the physical key so the binding stays
  // readable + cross-platform. Same idea for any combination involving
  // a real modifier (Cmd/Ctrl/Alt): the OS may localize the character,
  // but the physical key is what the binding should track. Shift is
  // excluded because Shift+/ → "?" is the keyboard label we want.
  if ((e.altKey || e.metaKey || e.ctrlKey) && e.code) {
    const letter = /^Key([A-Z])$/.exec(e.code);
    if (letter) {
      key = letter[1].toLowerCase();
    } else {
      const digit = /^Digit(\d)$/.exec(e.code);
      if (digit) key = digit[1];
    }
  }

  // Shift + a punctuation single character (?, !, @, … but NOT letters
  // or digits) is a "shifted character" — the Shift is already encoded
  // in the character (Shift+/ → "?"). Suppress the redundant Shift+
  // prefix in that case. Letters keep "Shift+a" because that reads
  // better than "A" in a hint; digits keep "Shift+1" because we
  // already normalized the key back to "1" via e.code earlier (so the
  // user can still distinguish Shift+1 from plain 1).
  const isSingleChar = key.length === 1;
  const isLetter = isSingleChar && key.toUpperCase() !== key.toLowerCase();
  const isDigit = isSingleChar && key >= "0" && key <= "9";
  const shiftIsImplicit = e.shiftKey && isSingleChar && !isLetter && !isDigit;
  if (e.shiftKey && !shiftIsImplicit) parts.push("Shift");

  parts.push(key);
  return parts.join("+");
}
