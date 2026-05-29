import type { CommandDef } from "../types";

/**
 * Radio (voice walkie-talkie) commands. The two volume-key bindings
 * default to hardware AudioVolumeUp / AudioVolumeDown, which the OS
 * forwards to the focused webview on physical keyboards and most
 * Bluetooth headset controllers. iOS Safari does NOT forward them.
 *
 * Scope:
 *   radio  — pushed by RadioPage while it's mounted
 */
export const RADIO_COMMANDS: CommandDef[] = [
  {
    id: "radio.chat.prev",
    name: "Previous Chat (Radio)",
    category: "Radio",
    description: "Switch to the previous chat in the active radio group",
    defaultBindings: [{ key: "AudioVolumeUp" }],
    scope: "radio",
    defaultWhen: "radioActive",
  },
  {
    id: "radio.chat.next",
    name: "Next Chat (Radio)",
    category: "Radio",
    description: "Switch to the next chat in the active radio group",
    defaultBindings: [{ key: "AudioVolumeDown" }],
    scope: "radio",
    defaultWhen: "radioActive",
  },
];
