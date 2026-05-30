// Core dispatcher + scope stack
export { keyboardManager, KeyboardManagerImpl } from "./KeyboardManager";
export { useKeyboardScope } from "./useKeyboardScope";

// Command registry
export { commandRegistry, CommandRegistryImpl } from "./CommandRegistry";

// Component hooks
export { useCommand, useCommands } from "./useCommand";
export { useInvoke, invoke } from "./useInvoke";
export { useDefineCommand } from "./useDefineCommand";

// Context keys (for when expressions)
export { contextKeyService, ContextKeyServiceImpl, ContextKey } from "./ContextKeyService";
export { useContextKey } from "./useContextKey";

// User keymap (Phase 2 wires this up to backend)
export { userKeymapStore, UserKeymapStoreImpl } from "./userKeymapStore";
export {
  initUserKeymap,
  persistOverride,
  persistOverrides,
  persistRemoveOverride,
  persistDisabled,
  persistResetAll,
} from "./userKeymapSync";

// Help-key display hint
export { useHelpKeyDisplay } from "./useHelpKeyDisplay";

// Parsers / evaluators
export { parseHotkey, matchesHotkey, formatKeyboardEvent, formatKeyDisplay } from "./keyParser";
export { parseWhen, validateWhen, extractContextKeys, WhenParseError } from "./whenExpression";

// Conflict detection (Settings UI + catalog lint)
export { detectConflicts, effectiveBindings, effectiveScope } from "./conflict";

// Types
export type {
  CommandDef,
  CommandHandler,
  KeyBinding,
  MenuContribution,
  RegisteredCommand,
  ParsedKey,
  Conflict,
  KeymapOverride,
  ContextSnapshot,
} from "./types";
