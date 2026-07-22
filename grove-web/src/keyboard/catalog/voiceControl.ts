import type { CommandDef } from "../types";

/**
 * Voice Control commands — push-to-talk and toggle recording.
 *
 * No defaultBindings: the actual keys are stored in voice_control config
 * (pushToTalkKey / toggleShortcut) and driven by GlobalVoiceControlRecorder's
 * raw listeners. The catalog entries exist so that persistOverride rows are
 * meaningful (conflict detection, Settings UI keybindings display).
 */
export const VOICE_CONTROL_COMMANDS: CommandDef[] = [
  {
    id: "voiceControl.ptt.start",
    name: "Voice Control Push-to-Talk Start",
    category: "Voice Control",
    description: "Start push-to-talk voice recording (hold to record)",
    scope: "workspace",
    defaultWhen: "voiceControlEnabled",
  },
  {
    id: "voiceControl.ptt.stop",
    name: "Voice Control Push-to-Talk Stop",
    category: "Voice Control",
    description: "Stop push-to-talk voice recording (key release)",
    scope: "workspace",
    defaultWhen: "voiceControlEnabled",
    trigger: "keyup",
  },
  {
    id: "voiceControl.toggle",
    name: "Voice Control Toggle Recording",
    category: "Voice Control",
    description: "Toggle voice control recording on/off",
    scope: "workspace",
    defaultWhen: "voiceControlEnabled",
  },
];
