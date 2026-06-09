export type TabId = "audio" | "providers";

export type ProviderStatus = "verified" | "draft" | "failed";

export type ProviderProfile = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  status: ProviderStatus;
};

export type ReplacementRule = { from: string; to: string };

export type TranscribeMode = "batch" | "streaming";

export type AudioSettings = {
  enabled: boolean;
  /** Transcription mode: 'batch' (record then transcribe) or 'streaming' (live) */
  transcribeMode: TranscribeMode;
  /** Whether OS-wide global voice mode is enabled (global shortcut + floating widget) */
  globalModeEnabled: boolean;
  transcribeProvider: string;
  preferredLanguages: string[];
  /** Combo key shortcut for toggle mode (e.g. "Cmd+Shift+.") — empty = disabled */
  toggleShortcut: string;
  /** Single key for push-to-talk mode (e.g. "F5") — empty = disabled */
  pushToTalkKey: string;
  /** How long the PTT key must be held before recording starts (ms, default 500) */
  pttActivationDelayMs: number;
  /** Max recording duration in seconds (default 60) */
  maxDuration: number;
  /** Min recording duration in seconds; below = discard as accidental (default 2) */
  minDuration: number;
  reviseEnabled: boolean;
  reviseProvider: string;
  revisePromptGlobal: string;
  revisePromptProject: string;
  preferredTermsGlobal: string[];
  preferredTermsProject: string[];
  forbiddenTermsGlobal: string[];
  forbiddenTermsProject: string[];
  replacementsGlobal: ReplacementRule[];
  replacementsProject: ReplacementRule[];
};
