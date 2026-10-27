export type ChatConnectionStatus = "connecting" | "reconnecting" | "connected" | "disconnected" | "failed";

export const MAX_CHAT_RECONNECT_ATTEMPTS = 5;

export const chatConnectionLabels: Record<ChatConnectionStatus, string> = {
  connecting: "Connecting...",
  reconnecting: "Reconnecting...",
  connected: "Connected",
  disconnected: "Disconnected",
  failed: "Connect Failed",
};

export function chatConnectionStatusAfterClose(
  current: ChatConnectionStatus,
  { intentional, wasReady, attempt }: { intentional: boolean; wasReady: boolean; attempt: number },
): ChatConnectionStatus {
  // A permanent startup error deliberately suppresses retries. Keep its
  // failure visible when the corresponding close callback arrives.
  if (intentional) return current === "failed" ? "failed" : "disconnected";
  if (!wasReady || attempt >= MAX_CHAT_RECONNECT_ATTEMPTS) return "failed";
  return "reconnecting";
}
