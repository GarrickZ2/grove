import type { CommandDef } from "../types";

/**
 * Audio / push-to-talk commands for the workspace.
 */
export const AUDIO_COMMANDS: CommandDef[] = [
  {
    id: "audio.ptt.start",
    name: "Push-to-Talk Start",
    category: "Audio",
    scope: "workspace",
    defaultWhen: "micEnabled",
  },
  {
    // Hold-to-talk release: fires on key *up*. No defaultBindings — the
    // actual PTT key lives in audio_config.pushToTalkKey and is driven by
    // GlobalAudioRecorder's raw listener (which also owns the warming delay
    // and window-blur stop). The `keyup` trigger keeps the catalog honest if
    // a user ever binds this command directly from Settings.
    id: "audio.ptt.stop",
    name: "Push-to-Talk Stop",
    category: "Audio",
    scope: "workspace",
    defaultWhen: "pttActive",
    trigger: "keyup",
  },
  {
    id: "audio.recording.cancel",
    name: "Cancel Recording",
    category: "Audio",
    scope: "workspace",
    defaultWhen: "recording",
  },
];
