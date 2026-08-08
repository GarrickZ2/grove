export interface KeyBinding {
  key: string;
  when?: string;
  // Per-binding scope. VSCode/Zed style: one command can have several
  // bindings, each live in its own scope + when. Falls back to the command's
  // scope when unset.
  scope?: string;
}

export interface MenuContribution {
  menuId: string;
  group?: string;
  order?: number;
  when?: string;
}

export interface CommandDef {
  id: string;
  name: string;
  category: string;
  description?: string;
  defaultBindings?: KeyBinding[];
  defaultWhen?: string;
  scope?: string;
  readonly?: boolean;
  hidden?: boolean;
  preventDefault?: boolean;
  passThroughTextInput?: boolean;
  menus?: MenuContribution[];
  /**
   * Which key event fires this command. Defaults to "keydown" — the
   * standard "press a shortcut" semantics. "keyup" is for hold-to-talk
   * style bindings (e.g. audio.ptt.stop fires when the user releases
   * the push-to-talk key after audio.ptt.start fired on keydown).
   */
  trigger?: "keydown" | "keyup";
  /**
   * When true, auto-repeat keydowns (key held down) are ignored — the command
   * fires once per physical press. Use for toggles where holding the key
   * shouldn't flip state repeatedly (e.g. blitz.grid.toggle).
   */
  ignoreRepeat?: boolean;
}

export type CommandHandler<TArgs = unknown> = (args?: TArgs) => void | Promise<void>;

export interface RegisteredCommand {
  def: CommandDef;
  handler: CommandHandler;
  enabled?: () => boolean;
}

/**
 * How a modifier must match: `false` = must be up; `"any"` = held on either
 * physical side; `"left"`/`"right"` = held on that specific side. Side
 * matching needs the live modifier-location tracker (KeyboardManager) because
 * a KeyboardEvent's `metaKey`/`altKey` flags don't reveal which physical key.
 */
export type ModifierMatch = false | "any" | "left" | "right";

export interface ParsedKey {
  key: string;
  alt: ModifierMatch;
  ctrl: ModifierMatch;
  meta: ModifierMatch;
  shift: ModifierMatch;
  mod: boolean;
}

/**
 * Which physical side each modifier is currently held on (null = not held, or
 * side unknown). Maintained by KeyboardManager from MetaLeft/MetaRight/…
 * keydown/keyup, consumed by matchesHotkey / formatKeyboardEvent so a binding
 * can pin to e.g. left Cmd vs right Cmd.
 */
export interface ModifierSides {
  meta: "left" | "right" | null;
  alt: "left" | "right" | null;
  ctrl: "left" | "right" | null;
  shift: "left" | "right" | null;
}

export interface Conflict {
  key: string;
  scope: string;
  when: string;
  commandIds: string[];
}

export interface KeymapOverride {
  command_id: string;
  key: string;
  when_ctx?: string;
  scope?: string;
}

export type ContextSnapshot = Record<string, unknown>;
