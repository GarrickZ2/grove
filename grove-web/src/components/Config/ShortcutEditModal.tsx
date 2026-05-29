import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Keyboard,
  AlertTriangle,
  Info,
  Check,
  Plus,
  Trash2,
  ChevronDown,
  Search,
} from "lucide-react";
import type { CommandDef } from "../../keyboard";
import {
  formatKeyboardEvent,
  formatKeyDisplay,
  validateWhen,
  contextKeyService,
  keyboardManager,
} from "../../keyboard";
import { Checkbox } from "../ui/Checkbox";

/**
 * One editable binding row: a key plus its own when + scope. VSCode/Zed
 * model — a command can have several of these, each live in a different
 * context. (Empty `bindings` array = unbound.)
 */
export interface BindingDraft {
  key: string;
  when: string;
  scope: string;
}

interface Props {
  command: CommandDef;
  currentBindings: BindingDraft[];
  scopeOptions: string[];
  onSave: (bindings: BindingDraft[]) => void;
  onClose: () => void;
}

const KNOWN_CONTEXT_KEYS: { name: string; description: string }[] = [
  { name: "inWorkspace", description: "Inside a task workspace" },
  { name: "taskSelected", description: "A task is selected" },
  { name: "archived", description: "Selected task is archived" },
  { name: "canOperate", description: "Git operations allowed (no conflict)" },
  { name: "studioMode", description: "Studio page (ResourcePage) is mounted" },
  { name: "studioProject", description: "Task lives in a Studio project" },
  { name: "editorFocus", description: "Focus is in the code editor (Monaco)" },
  { name: "terminalFocus", description: "Focus is in the terminal (xterm)" },
  { name: "chatFocus", description: "Focus is in the chat input box" },
  { name: "chatPanelActive", description: "Chat panel is mounted" },
  { name: "terminalPanelActive", description: "Terminal panel is mounted" },
  { name: "paletteOpen", description: "Command palette is open" },
  { name: "panelOpen", description: "A workspace panel is open" },
  { name: "messageNotEmpty", description: "Chat message has content" },
  { name: "taskNameValid", description: "New-task name passes validation" },
  { name: "inBlitzMode", description: "Blitz mode is active" },
  { name: "inZenMode", description: "Zen mode is active" },
];

const OPERATORS = ["&&", "||", "!", "(", ")"];

// Shared field styling so the key recorder, when input, and scope selector
// read as one consistent control set inside a binding card.
const FIELD =
  "px-3 py-2 rounded-lg border bg-[var(--color-bg)] text-sm text-[var(--color-text)] outline-none transition-colors";
const FIELD_IDLE = "border-[var(--color-border)] hover:border-[var(--color-text-muted)]";
const FIELD_FOCUS = "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5";

export function ShortcutEditModal({
  command,
  currentBindings,
  scopeOptions,
  onSave,
  onClose,
}: Props) {
  const [bindings, setBindings] = useState<BindingDraft[]>(currentBindings);
  const [recordingIndex, setRecordingIndex] = useState<number | null>(null);
  const [distinguishSide, setDistinguishSide] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [showHelper, setShowHelper] = useState(false);
  const lastFocusedWhen = useRef(-1);
  const whenRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (recordingIndex === null) return;
    const release = keyboardManager.pushSuppress();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") return;
      e.preventDefault();
      e.stopPropagation();
      // Reject only printable single characters (letters / digits /
      // punctuation) without a modifier — those misfire while typing. Function
      // and navigation keys (F1–F12, Enter, Escape, arrows, Tab, Space) may
      // stand alone, matching the catalog's exempt keys.
      const printableSingle = e.key.length === 1 && e.key !== " ";
      if (printableSingle && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setRecordError(
          "A printable key needs a modifier (⌘ / Ctrl / ⌥). Function keys (F1–F12, Enter, arrows…) can stand alone.",
        );
        setRecordingIndex(null);
        return;
      }
      setRecordError(null);
      const combo = distinguishSide
        ? formatKeyboardEvent(e, {
            distinguishSide: true,
            sides: keyboardManager.getModifierSides(),
          })
        : formatKeyboardEvent(e);
      setBindings((prev) =>
        prev.map((b, i) => (i === recordingIndex ? { ...b, key: combo } : b)),
      );
      setRecordingIndex(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      release();
    };
  }, [recordingIndex, distinguishSide]);

  useEffect(() => {
    if (recordingIndex !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingIndex, onClose]);

  const contextKeysForHelper = useMemo(() => {
    const snapshot = contextKeyService.getSnapshot();
    const seen = new Set<string>();
    const out: { name: string; description?: string; value: boolean }[] = [];
    for (const k of KNOWN_CONTEXT_KEYS) {
      seen.add(k.name);
      out.push({ name: k.name, description: k.description, value: !!snapshot[k.name] });
    }
    for (const name of Object.keys(snapshot).sort()) {
      if (seen.has(name)) continue;
      out.push({ name, value: !!snapshot[name] });
    }
    return out;
  }, []);

  const whenErrors = bindings.map((b) => validateWhen(b.when));
  const canSave = whenErrors.every((e) => !e);

  const addBinding = () =>
    setBindings((prev) => [
      ...prev,
      { key: "", when: command.defaultWhen ?? "", scope: command.scope ?? "" },
    ]);
  const removeBinding = (i: number) =>
    setBindings((prev) => prev.filter((_, j) => j !== i));
  const patchBinding = (i: number, patch: Partial<BindingDraft>) =>
    setBindings((prev) => prev.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const insertIntoWhen = (text: string) => {
    if (bindings.length === 0) return;
    // Insert into the last-focused When field; if none was focused yet, fall
    // back to the first binding so a click always lands somewhere.
    const focused = lastFocusedWhen.current;
    const i = focused >= 0 && focused < bindings.length ? focused : 0;
    const input = whenRefs.current[i];
    const when = bindings[i].when;
    const cur = input?.selectionStart ?? when.length;
    const end = input?.selectionEnd ?? when.length;
    const padBefore = cur > 0 && !/[\s(]/.test(when[cur - 1]) ? " " : "";
    const padAfter = end < when.length && !/[\s)]/.test(when[end]) ? " " : "";
    const insertion = `${padBefore}${text}${padAfter}`;
    const next = when.slice(0, cur) + insertion + when.slice(end);
    patchBinding(i, { when: next });
    requestAnimationFrame(() => {
      input?.focus();
      const c = cur + insertion.length;
      input?.setSelectionRange(c, c);
    });
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="w-[560px] max-w-[94vw] max-h-[88vh] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          data-hotkeys-dialog="true"
        >
          {/* Header */}
          <div className="flex items-start gap-3 p-5 border-b border-[var(--color-border)] flex-shrink-0">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/15 flex-shrink-0">
              <Keyboard className="w-4 h-4 text-[var(--color-highlight)]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[var(--color-text)] text-sm">{command.name}</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                <code className="font-mono">{command.id}</code>
              </div>
              {command.description && (
                <div className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
                  {command.description}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="p-5 space-y-3 overflow-y-auto flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--color-text)] select-none">
              <span>Bindings</span>
              <span className="text-[var(--color-text-muted)] font-normal">
                each fires in its own context
              </span>
            </div>

            {bindings.length === 0 && recordingIndex === null && (
              <div className="px-3 py-4 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-muted)] text-center">
                No bindings —{" "}
                <span className="text-[var(--color-text)]">unbound</span>. The command still runs
                from the Command Palette.
              </div>
            )}

            {bindings.map((b, i) => (
              <div
                key={i}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2.5"
              >
                {/* Key recorder + delete */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRecordError(null);
                      setRecordingIndex(i);
                    }}
                    className={[
                      FIELD,
                      "flex-1 text-left font-mono",
                      recordingIndex === i ? FIELD_FOCUS : FIELD_IDLE,
                    ].join(" ")}
                  >
                    {recordingIndex === i ? (
                      <span className="text-[var(--color-text-muted)] italic font-sans">
                        Press a key combination…
                      </span>
                    ) : b.key ? (
                      <span className="text-[var(--color-text)]">
                        {formatKeyDisplay(b.key)}
                        <span className="text-[var(--color-text-muted)] ml-2 text-xs">({b.key})</span>
                      </span>
                    ) : (
                      <span className="text-[var(--color-text-muted)] italic font-sans">
                        Click to record a key…
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeBinding(i)}
                    title="Remove this binding"
                    className="w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-warning)] hover:border-[var(--color-warning)]/40 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* When + scope */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0 relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] select-none pointer-events-none">
                      when
                    </span>
                    <input
                      ref={(el) => {
                        whenRefs.current[i] = el;
                      }}
                      value={b.when}
                      onFocus={() => {
                        lastFocusedWhen.current = i;
                      }}
                      onChange={(e) => patchBinding(i, { when: e.target.value })}
                      placeholder={command.defaultWhen || "always"}
                      spellCheck={false}
                      className={[
                        FIELD,
                        "w-full pl-14 font-mono",
                        whenErrors[i]
                          ? "border-[var(--color-warning)] focus:border-[var(--color-warning)]"
                          : FIELD_IDLE + " focus:border-[var(--color-highlight)]",
                      ].join(" ")}
                    />
                  </div>
                  <ScopeSelect
                    value={b.scope}
                    options={scopeOptions}
                    onChange={(s) => patchBinding(i, { scope: s })}
                  />
                </div>
                {whenErrors[i] && (
                  <div className="flex items-start gap-1 text-[11px] text-[var(--color-warning)]">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>{whenErrors[i]}</span>
                  </div>
                )}
              </div>
            ))}

            {recordError && (
              <div className="flex items-start gap-1 text-[11px] text-[var(--color-warning)]">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                <span>{recordError}</span>
              </div>
            )}

            <button
              type="button"
              onClick={addBinding}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-muted)] hover:border-[var(--color-highlight)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/5 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add binding
            </button>

            <Checkbox
              checked={distinguishSide}
              onChange={setDistinguishSide}
              label="Distinguish left/right modifiers (left ⌘ vs right ⌘, left ⌥ vs right ⌥)"
              className="text-[11px] text-[var(--color-text-muted)] pt-1"
            />

            {/* When helper */}
            <div>
              <button
                type="button"
                onClick={() => setShowHelper((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                <Info className="w-3 h-3" />
                {showHelper ? "Hide" : "Show"} when-expression helper
              </button>
              {showHelper && (
                <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-3">
                  <div className="text-[10px] text-[var(--color-text-muted)] italic">
                    Click a key to insert it into the focused When field (or the first binding's). Green dot = currently true.
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {OPERATORS.map((op) => (
                      <button
                        key={op}
                        type="button"
                        onClick={() => insertIntoWhen(op)}
                        className="px-2 py-1 text-[11px] font-mono rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-highlight)] hover:text-[var(--color-highlight)] transition-colors"
                      >
                        {op}
                      </button>
                    ))}
                  </div>
                  <div className="max-h-40 overflow-y-auto pr-1 space-y-0.5">
                    {contextKeysForHelper.map((k) => (
                      <button
                        key={k.name}
                        type="button"
                        onClick={() => insertIntoWhen(k.name)}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left hover:bg-[var(--color-bg)] transition-colors"
                      >
                        <span
                          className={[
                            "w-2 h-2 rounded-full flex-shrink-0",
                            k.value
                              ? "bg-[var(--color-success)]"
                              : "border border-[var(--color-border)]",
                          ].join(" ")}
                          title={k.value ? "currently true" : "currently false"}
                        />
                        <code className="font-mono text-[11px] text-[var(--color-text)] flex-shrink-0">
                          {k.name}
                        </code>
                        {k.description && (
                          <span className="text-[10px] text-[var(--color-text-muted)] truncate">
                            {k.description}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 p-4 bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] flex-shrink-0">
            <span className="text-[11px] text-[var(--color-text-muted)]">
              Remove all bindings to unbind.
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-1.5 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => onSave(bindings)}
                disabled={!canSave}
                className={[
                  "px-4 py-1.5 text-sm rounded-lg transition-colors",
                  canSave
                    ? "bg-[var(--color-highlight)] text-white hover:opacity-90"
                    : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] cursor-not-allowed",
                ].join(" ")}
              >
                Save
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Custom scope dropdown — matches the app's design language (rounded field,
 * portal'd menu with viewport-aware flip + filter), unlike a native <select>.
 */
function ScopeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (scope: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number | null;
    bottom: number | null;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const margin = 8;
      const preferred = 300;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const flip = spaceBelow < Math.min(180, preferred) && spaceAbove > spaceBelow;
      const maxHeight = Math.min(preferred, Math.max(140, flip ? spaceAbove - 4 : spaceBelow - 4));
      setPos({
        top: flip ? null : rect.bottom + 4,
        bottom: flip ? window.innerHeight - rect.top + 4 : null,
        left: rect.left,
        width: Math.max(rect.width, 180),
        maxHeight,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((s) => s.toLowerCase().includes(q));
  }, [options, search]);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={() => {
          setOpen((v) => !v);
          setSearch("");
        }}
        title="Scope — where this binding is active"
        className={[
          "flex items-center justify-between gap-1.5 w-[150px] flex-shrink-0",
          FIELD,
          open ? "border-[var(--color-highlight)]" : FIELD_IDLE,
        ].join(" ")}
      >
        <span className="truncate font-mono text-xs">
          {value || <span className="italic font-sans text-[var(--color-text-muted)]">(global)</span>}
        </span>
        <ChevronDown
          className={[
            "w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform flex-shrink-0",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={menuRef}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl overflow-hidden flex flex-col"
            style={{
              position: "fixed",
              ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom ?? 0 }),
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              zIndex: 10000,
            }}
          >
            <div className="border-b border-[var(--color-border)] p-2 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter scopes…"
                  autoFocus
                  className="w-full pl-7 pr-2 py-1.5 rounded text-xs bg-[var(--color-bg-secondary)] border border-transparent outline-none focus:border-[var(--color-highlight)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
                />
              </div>
            </div>
            <div className="overflow-y-auto py-1 flex-1">
              <ScopeOption
                label="(global)"
                sub="no scope — runs everywhere"
                active={value === ""}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              />
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                  No scopes match “{search}”
                </div>
              ) : (
                filtered.map((s) => (
                  <ScopeOption
                    key={s}
                    label={s}
                    active={value === s}
                    onClick={() => {
                      onChange(s);
                      setOpen(false);
                    }}
                  />
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function ScopeOption({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
        active
          ? "bg-[var(--color-highlight)]/10 text-[var(--color-text)]"
          : "hover:bg-[var(--color-bg-secondary)] text-[var(--color-text)]",
      ].join(" ")}
    >
      <span className="w-3 h-3 flex-shrink-0 flex items-center justify-center">
        {active && <Check className="w-3 h-3 text-[var(--color-highlight)]" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono truncate">{label}</div>
        {sub && <div className="text-[10px] text-[var(--color-text-muted)] truncate">{sub}</div>}
      </div>
    </button>
  );
}
