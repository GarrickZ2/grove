import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check, Bot, Globe, Terminal, Settings } from "lucide-react";
import type { CustomAgentServer } from "../../api/config";
import type { CustomAgentPersona } from "../../api";
import { agentOptions, type AgentOption } from "../../data/agents";

// Re-export so existing call sites importing from "./ui/AgentPicker" or
// "../ui" keep working without churn. New consumers should import from
// `data/agents` directly to skip pulling in the picker UI tree.
// eslint-disable-next-line react-refresh/only-export-components
export { agentOptions };
export type { AgentOption };

interface AgentPickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Show "Custom command..." free-text input (Terminal mode) */
  allowCustom?: boolean;
  customPlaceholder?: string;
  options?: AgentOption[];
  /** ACP custom agent SERVERS shown in dropdown (Chat mode) */
  customAgents?: CustomAgentServer[];
  /** Custom Agents (personas) shown in dropdown (Chat mode). Selecting one
   *  passes the persona id back via onChange — caller resolves base agent. */
  customAgentPersonas?: CustomAgentPersona[];
  /** Open the custom agent server management modal (Chat mode) */
  onManageCustomAgents?: () => void;
  /**
   * Trigger button corner shape. Default `"rounded"` keeps the existing
   * `rounded-lg` look; `"pill"` switches to fully circular ends so the
   * picker fits inside pill-shaped surfaces (Graph toolbar).
   */
  triggerShape?: "rounded" | "pill";
  /**
   * Trigger size. `"default"` is the existing chunky look; `"compact"`
   * shrinks the height and font to match a 32-px input row so the picker
   * doesn't visually dominate alongside other controls in the same form.
   */
  triggerSize?: "default" | "compact";
}

interface DropdownPosition {
  /** Exactly one of `top` / `bottom` is set, depending on flip direction.
   *  When flipped, anchoring by `bottom` lets the menu hug the trigger from
   *  above regardless of how tall its actual content turns out to be — no
   *  giant gap when reserved maxHeight exceeds rendered content. */
  top: number | null;
  bottom: number | null;
  left: number;
  width: number;
  /** When true, the menu opens upward (its bottom edge sits above the
   *  trigger). Used by render to flip the entry animation direction. */
  flipped: boolean;
  /** Hard cap so the menu always fits within the side it picked. */
  maxHeight: number;
}

export function AgentPicker({
  value,
  onChange,
  placeholder = "Select agent...",
  allowCustom = true,
  customPlaceholder = "Enter agent command...",
  options: externalOptions,
  customAgents = [],
  customAgentPersonas = [],
  onManageCustomAgents,
  triggerShape = "rounded",
  triggerSize = "default",
}: AgentPickerProps) {
  const displayOptions = externalOptions ?? agentOptions;
  const [isOpen, setIsOpen] = useState(false);

  // Check if current value matches any built-in option or custom agent
  const selectedOption = displayOptions.find((opt) => opt.value === value);
  const selectedCustomAgent = !selectedOption
    ? customAgents.find((a) => a.id === value)
    : null;
  const selectedPersona = !selectedOption && !selectedCustomAgent
    ? customAgentPersonas.find((p) => p.id === value)
    : null;
  const isCustomValue = value && !selectedOption && !selectedCustomAgent && !selectedPersona;

  // Helper for trigger button icon when value resolves to a persona
  const resolvePersonaIcon = (p: CustomAgentPersona): React.ReactNode => {
    const builtin = displayOptions.find((opt) => opt.id === p.base_agent);
    if (builtin?.icon) {
      const Ic = builtin.icon;
      return <Ic size={triggerSize === "compact" ? 14 : 18} />;
    }
    const server = customAgents.find((s) => s.id === p.base_agent);
    if (server?.type === "remote") {
      return <Globe className={triggerSize === "compact" ? "w-3.5 h-3.5 text-[var(--color-info)]" : "w-4 h-4 text-[var(--color-info)]"} />;
    }
    return <Terminal className={triggerSize === "compact" ? "w-3.5 h-3.5 text-[var(--color-text-muted)]" : "w-4 h-4 text-[var(--color-text-muted)]"} />;
  };

  // Initialize custom mode from initial props (lazy state initializer).
  // NOTE: This runs ONCE per mount. If `value` is a persona id but the
  // personas list arrives later, we'd misclassify it as a free-text custom
  // command and flip into custom-input mode showing the raw `ca-uuid`. The
  // useEffect below recomputes whenever any of the membership lists change,
  // skipping the recompute while the user is actively typing in custom mode.
  const [isCustomMode, setIsCustomMode] = useState(() => !!(allowCustom && value && !displayOptions.find((opt) => opt.value === value) && !customAgents.find((a) => a.id === value) && !customAgentPersonas.find((p) => p.id === value)));
  const [customValue, setCustomValue] = useState(() => (allowCustom && value && !displayOptions.find((opt) => opt.value === value) && !customAgents.find((a) => a.id === value) && !customAgentPersonas.find((p) => p.id === value)) ? value : "");
  /** True once the user has interacted with the custom-mode input. While
   *  set, the resync effect below does NOT touch `isCustomMode` /
   *  `customValue` — otherwise an in-flight persona fetch could yank the
   *  input out from under the user mid-keystroke. */
  const userTouchedCustomRef = useRef(false);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Calculate dropdown position (fixed positioning, viewport-relative).
  // Auto-flips above the trigger when there isn't enough room below — needed
  // for use inside the bottom-floating Graph toolbar where the trigger sits
  // near the viewport edge.
  const updateDropdownPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const preferredHeight = 360; // matches the menu's max-height target
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const flipped = spaceBelow < Math.min(220, preferredHeight) && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      preferredHeight,
      Math.max(160, flipped ? spaceAbove - gap : spaceBelow - gap),
    );
    setDropdownPosition({
      top: flipped ? null : rect.bottom + gap,
      // Anchoring upward by `bottom` keeps the menu glued to the trigger
      // even when actual content is much shorter than `maxHeight`.
      bottom: flipped ? window.innerHeight - rect.top + gap : null,
      left: rect.left,
      width: Math.max(rect.width, 280),
      flipped,
      maxHeight,
    });
  }, []);

  // Update position when opening
  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      window.addEventListener("scroll", updateDropdownPosition, true);
      window.addEventListener("resize", updateDropdownPosition);
      return () => {
        window.removeEventListener("scroll", updateDropdownPosition, true);
        window.removeEventListener("resize", updateDropdownPosition);
      };
    }
  }, [isOpen, updateDropdownPosition]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus input when entering custom mode
  useEffect(() => {
    if (isCustomMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCustomMode]);

  // Re-classify `value` whenever the membership lists change — so a persona
  // id that arrives via async fetch flips out of "custom command" mode the
  // moment the persona shows up in `customAgentPersonas`. Skip while the
  // user is actively typing (userTouchedCustomRef) so we don't yank the
  // field. This complements the lazy initializer above.
  useEffect(() => {
    if (userTouchedCustomRef.current) return;
    const known =
      !!displayOptions.find((opt) => opt.value === value) ||
      !!customAgents.find((a) => a.id === value) ||
      !!customAgentPersonas.find((p) => p.id === value);
    const shouldBeCustom = !!(allowCustom && value && !known);
    if (shouldBeCustom !== isCustomMode) setIsCustomMode(shouldBeCustom);
    if (shouldBeCustom) {
      if (customValue !== value) setCustomValue(value);
    } else if (customValue !== "") {
      setCustomValue("");
    }
    // `isCustomMode` / `customValue` intentionally not in deps — the effect
    // is a one-way "props → state" sync, not a state-watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, displayOptions, customAgents, customAgentPersonas, allowCustom]);

  const handleSelect = (option: AgentOption | "custom") => {
    if (option === "custom") {
      setIsCustomMode(true);
      setCustomValue("");
      setIsOpen(false);
    } else {
      setIsCustomMode(false);
      onChange(option.value);
      setIsOpen(false);
    }
  };

  const handleSelectCustomAgent = (agentId: string) => {
    setIsCustomMode(false);
    onChange(agentId);
    setIsOpen(false);
  };

  const handleCustomSubmit = () => {
    if (customValue.trim()) {
      onChange(customValue.trim());
      setIsOpen(false);
    }
  };

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCustomSubmit();
    } else if (e.key === "Escape") {
      setIsCustomMode(false);
      setIsOpen(false);
    }
  };

  const displayValue = isCustomMode
    ? customValue || customPlaceholder
    : selectedOption?.label || selectedPersona?.name || selectedCustomAgent?.name || (isCustomValue ? value : placeholder);

  const SelectedIcon = selectedOption?.icon;

  // Render dropdown using portal
  const renderDropdown = () => {
    if (!isOpen || isCustomMode || !dropdownPosition) return null;

    return createPortal(
      <AnimatePresence>
        <motion.div
          ref={dropdownRef}
          initial={{ opacity: 0, y: dropdownPosition.flipped ? 10 : -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: dropdownPosition.flipped ? 10 : -10 }}
          transition={{ duration: 0.15 }}
          style={{
            position: "fixed",
            ...(dropdownPosition.top != null
              ? { top: dropdownPosition.top }
              : { bottom: dropdownPosition.bottom ?? 0 }),
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            zIndex: 9999,
          }}
          className="py-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-y-auto"
        >
          <AgentPickerMenuItems
            displayOptions={displayOptions}
            customAgents={customAgents}
            customAgentPersonas={customAgentPersonas}
            value={value}
            triggerSize={triggerSize}
            onSelectBuiltin={(opt) => handleSelect(opt)}
            onSelectId={(id) => handleSelectCustomAgent(id)}
          />

          {/* Footer actions: "Custom command..." OR "Manage Custom Agents..." */}
          {allowCustom && (
            <button
              onClick={() => handleSelect("custom")}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] border-t border-[var(--color-border)] mt-1"
            >
              <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">
                <Bot className="w-5 h-5 text-[var(--color-text-muted)]" />
              </div>
              <span>Custom command...</span>
            </button>
          )}

          {onManageCustomAgents && (
            <button
              onClick={() => {
                setIsOpen(false);
                onManageCustomAgents();
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] ${
                !allowCustom ? "border-t border-[var(--color-border)] mt-1" : ""
              }`}
            >
              <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">
                <Settings className="w-5 h-5 text-[var(--color-text-muted)]" />
              </div>
              <span>Manage Custom Agents...</span>
            </button>
          )}
        </motion.div>
      </AnimatePresence>,
      document.body
    );
  };

  return (
    <div className="w-full" ref={containerRef}>
      <div className="relative">
        {/* Trigger button or custom input (Terminal mode free-text) */}
        {isCustomMode ? (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={customValue}
              onChange={(e) => {
                userTouchedCustomRef.current = true;
                setCustomValue(e.target.value);
              }}
              onKeyDown={handleCustomKeyDown}
              onBlur={() => {
                handleCustomSubmit();
                userTouchedCustomRef.current = false;
              }}
              placeholder={customPlaceholder}
              className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-highlight)] rounded-lg
                text-[var(--color-text)] placeholder-[var(--color-text-muted)] text-sm
                focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]
                transition-all duration-200"
            />
            <button
              // `onMouseDown` runs BEFORE the input's `onBlur`, letting us
              // switch out of custom mode without firing a stray
              // `handleCustomSubmit` on the (often empty) input value.
              onMouseDown={(e) => {
                e.preventDefault();
                setIsCustomMode(false);
                setIsOpen(true);
              }}
              className="px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)]
                transition-all duration-200"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            ref={triggerRef}
            onClick={() => setIsOpen(!isOpen)}
            className={`w-full flex items-center bg-[var(--color-bg-secondary)] border ${
              triggerShape === "pill" ? "rounded-full" : "rounded-lg"
            } ${
              triggerSize === "compact"
                ? "gap-2 px-3 h-8 text-[12.5px]"
                : "gap-3 px-3 py-2 text-sm"
            } transition-all duration-200
              ${isOpen
                ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
                : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
              }`}
          >
            <div
              className={`flex items-center justify-center flex-shrink-0 ${
                triggerSize === "compact" ? "w-4 h-4" : "w-5 h-5"
              }`}
            >
              {SelectedIcon ? (
                <SelectedIcon size={triggerSize === "compact" ? 14 : 18} />
              ) : selectedPersona ? (
                resolvePersonaIcon(selectedPersona)
              ) : selectedCustomAgent ? (
                selectedCustomAgent.type === "remote" ? (
                  <Globe
                    className={
                      triggerSize === "compact"
                        ? "w-3.5 h-3.5 text-[var(--color-info)]"
                        : "w-4 h-4 text-[var(--color-info)]"
                    }
                  />
                ) : (
                  <Terminal
                    className={
                      triggerSize === "compact"
                        ? "w-3.5 h-3.5 text-[var(--color-text-muted)]"
                        : "w-4 h-4 text-[var(--color-text-muted)]"
                    }
                  />
                )
              ) : (
                <Bot
                  className={
                    triggerSize === "compact"
                      ? "w-3.5 h-3.5 text-[var(--color-text-muted)]"
                      : "w-4 h-4 text-[var(--color-text-muted)]"
                  }
                />
              )}
            </div>
            <span className={`flex-1 text-left ${selectedOption || selectedCustomAgent || selectedPersona || isCustomValue ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
              {displayValue}
            </span>
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown
                className={
                  triggerSize === "compact"
                    ? "w-3.5 h-3.5 text-[var(--color-text-muted)]"
                    : "w-4 h-4 text-[var(--color-text-muted)]"
                }
              />
            </motion.div>
          </button>
        )}

        {/* Dropdown rendered via portal */}
        {renderDropdown()}
      </div>
    </div>
  );
}

// ─── Reusable dropdown items list ─────────────────────────────────────────
//
// Used internally by AgentPicker, and by other call sites that already manage
// their own portal/anchor (e.g. TaskChat's "+" new-chat picker) but want the
// same Base Agents (Builtin + Custom Server) + Custom Agents (personas)
// structure with a plain divider bar between them.

interface AgentPickerMenuItemsProps {
  displayOptions: AgentOption[];
  customAgents: CustomAgentServer[];
  customAgentPersonas: CustomAgentPersona[];
  /** Currently selected value/id; used to highlight + draw the check mark. */
  value?: string;
  triggerSize?: "default" | "compact";
  onSelectBuiltin: (opt: AgentOption) => void;
  /** Called for both Custom Server ids and Custom Agent (persona) ids. */
  onSelectId: (id: string) => void;
}

export function AgentPickerMenuItems({
  displayOptions,
  customAgents,
  customAgentPersonas,
  value,
  triggerSize = "default",
  onSelectBuiltin,
  onSelectId,
}: AgentPickerMenuItemsProps) {
  const resolvePersonaIcon = (p: CustomAgentPersona): React.ReactNode => {
    const builtin = displayOptions.find((opt) => opt.id === p.base_agent);
    if (builtin?.icon) {
      const Ic = builtin.icon;
      return <Ic size={triggerSize === "compact" ? 14 : 20} />;
    }
    const server = customAgents.find((s) => s.id === p.base_agent);
    if (server?.type === "remote") {
      return (
        <Globe
          className={
            triggerSize === "compact"
              ? "w-3.5 h-3.5 text-[var(--color-info)]"
              : "w-5 h-5 text-[var(--color-info)]"
          }
        />
      );
    }
    return (
      <Terminal
        className={
          triggerSize === "compact"
            ? "w-3.5 h-3.5 text-[var(--color-text-muted)]"
            : "w-5 h-5 text-[var(--color-text-muted)]"
        }
      />
    );
  };

  return (
    <>
      {/* Built-in agents */}
      {displayOptions.map((option) => {
        const Icon = option.icon;
        const isDisabled = !!option.disabled;
        return (
          <button
            key={option.id}
            onClick={() => !isDisabled && onSelectBuiltin(option)}
            disabled={isDisabled}
            title={isDisabled ? option.disabledReason : undefined}
            className={`w-full flex items-center transition-colors ${
              triggerSize === "compact"
                ? "gap-2 px-2.5 py-1.5 text-[12.5px]"
                : "gap-3 px-3 py-2.5 text-sm"
            }
              ${isDisabled
                ? "opacity-45 cursor-not-allowed"
                : option.value === value
                  ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
              }`}
          >
            <div
              className={`flex items-center justify-center flex-shrink-0 ${
                triggerSize === "compact" ? "w-4 h-4" : "w-6 h-6"
              }`}
            >
              {Icon ? (
                <Icon size={triggerSize === "compact" ? 14 : 20} />
              ) : (
                <Bot
                  className={
                    triggerSize === "compact"
                      ? "w-3.5 h-3.5 text-[var(--color-text-muted)]"
                      : "w-5 h-5 text-[var(--color-text-muted)]"
                  }
                />
              )}
            </div>
            <div className="flex-1 text-left">
              <div>{option.label}</div>
              <div
                className={
                  triggerSize === "compact"
                    ? "text-[10px] text-[var(--color-text-muted)]"
                    : "text-xs text-[var(--color-text-muted)]"
                }
              >
                {isDisabled ? option.disabledReason : option.value}
              </div>
            </div>
            {!isDisabled && option.value === value && (
              <Check
                className={
                  triggerSize === "compact"
                    ? "w-3.5 h-3.5 flex-shrink-0"
                    : "w-4 h-4 flex-shrink-0"
                }
              />
            )}
          </button>
        );
      })}

      {/* Custom Agent Servers — inline as base agents, no header */}
      {customAgents.map((agent) => (
        <button
          key={agent.id}
          onClick={() => onSelectId(agent.id)}
          className={`w-full flex items-center transition-colors ${
            triggerSize === "compact"
              ? "gap-2 px-2.5 py-1.5 text-[12.5px]"
              : "gap-3 px-3 py-2.5 text-sm"
          }
            ${agent.id === value
              ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
              : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
            }`}
        >
          <div
            className={`flex items-center justify-center flex-shrink-0 ${
              triggerSize === "compact" ? "w-4 h-4" : "w-6 h-6"
            }`}
          >
            {agent.type === "remote" ? (
              <Globe
                className={
                  triggerSize === "compact"
                    ? "w-3.5 h-3.5 text-[var(--color-info)]"
                    : "w-5 h-5 text-[var(--color-info)]"
                }
              />
            ) : (
              <Terminal
                className={
                  triggerSize === "compact"
                    ? "w-3.5 h-3.5 text-[var(--color-text-muted)]"
                    : "w-5 h-5 text-[var(--color-text-muted)]"
                }
              />
            )}
          </div>
          <div className="flex-1 text-left">
            <div>{agent.name}</div>
            <div
              className={
                triggerSize === "compact"
                  ? "text-[10px] text-[var(--color-text-muted)]"
                  : "text-xs text-[var(--color-text-muted)]"
              }
            >
              {agent.type === "remote" ? agent.url : agent.command}
            </div>
          </div>
          {agent.id === value && (
            <Check
              className={
                triggerSize === "compact"
                  ? "w-3.5 h-3.5 flex-shrink-0"
                  : "w-4 h-4 flex-shrink-0"
              }
            />
          )}
        </button>
      ))}

      {/* Custom Agents (personas) — separated by a plain divider bar */}
      {customAgentPersonas.length > 0 && (
        <>
          <div className="my-1 border-t border-[var(--color-border)]" />
          {customAgentPersonas.map((persona) => (
            <button
              key={persona.id}
              onClick={() => onSelectId(persona.id)}
              className={`w-full flex items-center transition-colors ${
                triggerSize === "compact"
                  ? "gap-2 px-2.5 py-1.5 text-[12.5px]"
                  : "gap-3 px-3 py-2.5 text-sm"
              }
                ${persona.id === value
                  ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                }`}
            >
              <div
                className={`flex items-center justify-center flex-shrink-0 ${
                  triggerSize === "compact" ? "w-4 h-4" : "w-6 h-6"
                }`}
              >
                {resolvePersonaIcon(persona)}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="truncate">{persona.name}</div>
                <div
                  className={
                    triggerSize === "compact"
                      ? "text-[10px] text-[var(--color-text-muted)] truncate"
                      : "text-xs text-[var(--color-text-muted)] truncate"
                  }
                >
                  {persona.duty || `Based on ${persona.base_agent}`}
                </div>
              </div>
              {persona.id === value && (
                <Check
                  className={
                    triggerSize === "compact"
                      ? "w-3.5 h-3.5 flex-shrink-0"
                      : "w-4 h-4 flex-shrink-0"
                  }
                />
              )}
            </button>
          ))}
        </>
      )}
    </>
  );
}
