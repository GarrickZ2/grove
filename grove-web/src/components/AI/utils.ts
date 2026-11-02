import type { AudioSettings } from "./types";

/** Languages offered as recognition hints; users can add any other by name. */
export const voiceLanguageOptions = [
  { id: "zh", label: "Chinese", value: "Chinese" },
  { id: "en", label: "English", value: "English" },
  { id: "ja", label: "Japanese", value: "Japanese" },
  { id: "ko", label: "Korean", value: "Korean" },
  { id: "de", label: "German", value: "German" },
  { id: "fr", label: "French", value: "French" },
];

export type VocabularyTab = "preferred" | "forbidden" | "replacement";

export type VocabularyRow = {
  id: string;
  scope: "Global" | "Project";
  scopeKey: "global" | "project";
  from: string;
  to: string;
  tab: VocabularyTab;
  index: number;
};

export function buildVocabularyRows(audio: AudioSettings): VocabularyRow[] {
  return [
    ...audio.preferredTermsGlobal.map((term, index) => ({
      id: `preferred-global-${index}-${term}`,
      scope: "Global" as const,
      scopeKey: "global" as const,
      from: term,
      to: "Keep this wording",
      tab: "preferred" as const,
      index,
    })),
    ...audio.preferredTermsProject.map((term, index) => ({
      id: `preferred-project-${index}-${term}`,
      scope: "Project" as const,
      scopeKey: "project" as const,
      from: term,
      to: "Keep this wording",
      tab: "preferred" as const,
      index,
    })),
    ...audio.forbiddenTermsGlobal.map((term, index) => ({
      id: `forbidden-global-${index}-${term}`,
      scope: "Global" as const,
      scopeKey: "global" as const,
      from: term,
      to: "Rewrite or remove",
      tab: "forbidden" as const,
      index,
    })),
    ...audio.forbiddenTermsProject.map((term, index) => ({
      id: `forbidden-project-${index}-${term}`,
      scope: "Project" as const,
      scopeKey: "project" as const,
      from: term,
      to: "Rewrite or remove",
      tab: "forbidden" as const,
      index,
    })),
    ...audio.replacementsGlobal.map((rule, index) => ({
      id: `replacement-global-${index}-${rule.from}`,
      scope: "Global" as const,
      scopeKey: "global" as const,
      from: rule.from,
      to: rule.to,
      tab: "replacement" as const,
      index,
    })),
    ...audio.replacementsProject.map((rule, index) => ({
      id: `replacement-project-${index}-${rule.from}`,
      scope: "Project" as const,
      scopeKey: "project" as const,
      from: rule.from,
      to: rule.to,
      tab: "replacement" as const,
      index,
    })),
  ];
}

/** Format a combo key shortcut (e.g. "Cmd+Shift+H") — requires modifier(s) + a non-modifier key */
export function formatShortcut(event: KeyboardEvent): string | null {
  const modifiers = [
    event.metaKey ? "Cmd" : null,
    event.ctrlKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter(Boolean) as string[];

  // Need at least one modifier
  if (modifiers.length === 0) return null;

  const ignoredKeys = new Set(["Meta", "Control", "Alt", "Shift"]);
  if (ignoredKeys.has(event.key)) {
    // Only modifier keys pressed — wait for a non-modifier key
    return null;
  }

  // Use event.code to get the physical key — avoids macOS Alt+key producing
  // special characters (e.g. Alt+C → "ç" instead of "C")
  const normalizedKey = codeToKey(event.code) ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return [...modifiers, normalizedKey].join("+");
}

/** Map event.code to a display key name (physical key, ignoring Alt-modified chars) */
function codeToKey(code: string): string | null {
  // Letters: "KeyA" → "A"
  if (code.startsWith("Key")) return code.slice(3);
  // Digits: "Digit0" → "0"
  if (code.startsWith("Digit")) return code.slice(5);
  // Common keys
  const map: Record<string, string> = {
    Space: "Space", Backspace: "Backspace", Enter: "Enter", Tab: "Tab",
    Escape: "Escape", Delete: "Delete",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=",
    Backquote: "`",
    F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
    F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  };
  return map[code] ?? null;
}

// ─── PTT key helpers ────────────────────────────────────────────────────────

const PTT_CODE_LABELS: Record<string, string> = {
  MetaLeft: "Left Cmd", MetaRight: "Right Cmd",
  AltLeft: "Left Option", AltRight: "Right Option",
  ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
};

/** Format a PTT key from a KeyboardEvent.
 *  Supports modifier keys (using event.code to distinguish left/right)
 *  and regular single keys (no modifiers held). */
export function formatPTTKey(event: KeyboardEvent): string | null {
  // Modifier key pressed alone → use event.code for left/right
  const modifierKeys = new Set(["Meta", "Control", "Alt", "Shift"]);
  if (modifierKeys.has(event.key)) {
    return event.code; // e.g. "MetaLeft", "AltRight"
  }
  // Regular key — reject if any modifier is held (that would be a combo, not PTT)
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

/** Get display label for a PTT key code */
export function pttKeyLabel(code: string): string {
  return PTT_CODE_LABELS[code] ?? code;
}

// ─── Shortcut matching ──────────────────────────────────────────────────────

/** Parse a shortcut string to check if a KeyboardEvent matches it */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1];
  const needCmd = parts.includes("Cmd");
  const needCtrl = parts.includes("Ctrl");
  const needAlt = parts.includes("Alt");
  const needShift = parts.includes("Shift");

  if (needCmd !== event.metaKey) return false;
  if (needCtrl !== event.ctrlKey) return false;
  if (needAlt !== event.altKey) return false;
  if (needShift !== event.shiftKey) return false;

  // Use event.code for physical key matching (handles Alt+key on macOS)
  const eventKey = codeToKey(event.code) ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return eventKey === key;
}

/** Check if a keydown/keyup event matches a PTT key (by event.code or event.key) */
export function matchesPTTKey(event: KeyboardEvent, pttKey: string): boolean {
  if (!pttKey) return false;
  // Match by event.code (e.g. "MetaLeft", "ShiftRight")
  if (event.code === pttKey) return true;
  // Match by normalised key (e.g. "F5", "X")
  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return eventKey === pttKey;
}

// ─── Transcription errors ───────────────────────────────────────────────────

const STATUS_HINTS: Record<number, string> = {
  400: "Bad request — check transcribe provider config",
  401: "Unauthorized — check API key",
  403: "Forbidden — provider rejected the request",
  413: "Recording too large",
  429: "Rate limited — slow down",
  502: "Provider unreachable",
  503: "Provider unavailable",
};

export function formatTranscribeError(err: unknown): string {
  if (!err || typeof err !== "object") return "Transcription failed";
  const e = err as { status?: number; message?: string };
  const parts: string[] = [];
  if (typeof e.status === "number") {
    const hint = STATUS_HINTS[e.status];
    parts.push(hint ? `${e.status}: ${hint}` : `HTTP ${e.status}`);
  }
  if (e.message && e.message.trim()) {
    parts.push(e.message.trim().slice(0, 120));
  }
  return parts.length > 0 ? parts.join(" — ") : "Transcription failed";
}
