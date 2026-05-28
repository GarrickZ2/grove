import type { ParsedKey } from "./types";

export function parseHotkey(hotkey: string): ParsedKey {
  const parts = hotkey.split("+");
  let key = parts[parts.length - 1];
  let alt = false;
  let ctrl = false;
  let meta = false;
  let shift = false;

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "alt") alt = true;
    else if (mod === "ctrl") ctrl = true;
    else if (mod === "meta" || mod === "cmd") meta = true;
    else if (mod === "shift") shift = true;
  }

  if (key === "Space") key = " ";

  return { key, alt, ctrl, meta, shift };
}

export function matchesHotkey(e: KeyboardEvent, parsed: ParsedKey): boolean {
  if (e.altKey !== parsed.alt) return false;
  if (e.ctrlKey !== parsed.ctrl) return false;
  if (e.metaKey !== parsed.meta) return false;

  // Shift only enforced when explicit (e.g. "Shift+?" requires it,
  // but bare "?" tolerates the implicit shift most keyboards need).
  if (parsed.shift && !e.shiftKey) return false;

  // macOS Alt+digit changes e.key to a special char — match by e.code instead.
  if (parsed.alt && /^\d$/.test(parsed.key)) {
    return e.code === `Digit${parsed.key}`;
  }

  if (parsed.key.length === 1) {
    return e.key.toLowerCase() === parsed.key.toLowerCase();
  }

  return e.key === parsed.key;
}
