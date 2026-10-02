export interface ChatHistoryPreferences {
  /** 0 loads the entire available history. Counted in user turns. */
  recentTurns: number;
  includeMedia: boolean;
  includeToolDetails: boolean;
  renderWindowLimit: number;
  renderWindowTrigger: number;
}

export const CHAT_HISTORY_PREFERENCES_KEY = "grove:chat-history-preferences:v1";
export const CHAT_HISTORY_PREFERENCES_CHANGED = "grove:chat-history-preferences-changed";

export const DEFAULT_CHAT_HISTORY_PREFERENCES: ChatHistoryPreferences = {
  recentTurns: 0,
  includeMedia: true,
  includeToolDetails: true,
  renderWindowLimit: 0,
  renderWindowTrigger: 1500,
};

export function loadChatHistoryPreferences(legacy?: { render_window_limit?: number; render_window_trigger?: number }): ChatHistoryPreferences {
  try {
    const raw = window.localStorage.getItem(CHAT_HISTORY_PREFERENCES_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ChatHistoryPreferences>;
      return {
        recentTurns: Number.isSafeInteger(saved.recentTurns) && saved.recentTurns! >= 0 ? saved.recentTurns! : 0,
        includeMedia: saved.includeMedia !== false,
        includeToolDetails: saved.includeToolDetails !== false,
        renderWindowLimit: Number.isSafeInteger(saved.renderWindowLimit) && saved.renderWindowLimit! >= 0 ? saved.renderWindowLimit! : 0,
        renderWindowTrigger: Number.isSafeInteger(saved.renderWindowTrigger) && saved.renderWindowTrigger! > 0 ? saved.renderWindowTrigger! : 1500,
      };
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return {
    ...DEFAULT_CHAT_HISTORY_PREFERENCES,
    renderWindowLimit: legacy?.render_window_limit ?? 0,
    renderWindowTrigger: legacy?.render_window_trigger ?? 1500,
  };
}

export function saveChatHistoryPreferences(value: ChatHistoryPreferences): void {
  try {
    const serialized = JSON.stringify(value);
    if (window.localStorage.getItem(CHAT_HISTORY_PREFERENCES_KEY) === serialized) return;
    window.localStorage.setItem(CHAT_HISTORY_PREFERENCES_KEY, serialized);
  } catch { /* Best effort. */ }
  window.dispatchEvent(new Event(CHAT_HISTORY_PREFERENCES_CHANGED));
}
