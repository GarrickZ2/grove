import { isIosClient } from "./platform";

export type TauriInternals = {
  invoke: (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<unknown>;
};

/** The desktop bridge; null in browsers and in the iOS app. */
export function getTauriInternals(): TauriInternals | null {
  const w = window as Window & { __TAURI_INTERNALS__?: TauriInternals };
  return isIosClient ? null : w.__TAURI_INTERNALS__ ?? null;
}
