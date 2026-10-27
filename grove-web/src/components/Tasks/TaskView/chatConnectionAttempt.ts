/** Bound transport setup and Agent startup separately; heartbeats prove only
 * transport liveness. Human authentication is allowed to take as long as needed. */
export function watchChatConnection(
  socket: WebSocket,
  onFailure: (message: string) => void,
  onPhase: (phase: string) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const dispose = () => {
    stopped = true;
    clearTimeout(timer);
    socket.removeEventListener("open", opened);
    socket.removeEventListener("message", received);
    socket.removeEventListener("close", dispose);
  };
  const fail = (message: string) => {
    if (stopped) return;
    dispose();
    onFailure(message);
    socket.close();
  };
  const arm = (phase: string, ms: number) => {
    clearTimeout(timer);
    onPhase(phase);
    timer = setTimeout(() => fail(`Connection timed out during ${phase} after ${ms / 1000} seconds. Use Reconnect to retry.`), ms);
  };
  const opened = () => arm("Agent initialization", 90000);
  const received = (event: MessageEvent) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    switch (data?.type) {
      case "session_ready": dispose(); break;
      case "error": fail(typeof data.message === "string" ? data.message : "Agent connection failed."); break;
      case "session_ended": fail("Agent session ended before it became ready. Use Reconnect to retry."); break;
      case "auth_required": clearTimeout(timer); onPhase("Waiting for sign-in"); break;
      case "auth_succeeded": arm("Agent initialization", 90000); break;
      case "connect_phase":
        if (data.phase === "downloading") arm("Agent download", 150000);
        else arm(data.phase === "ready" ? "Agent initialization" : String(data.phase), 90000);
        break;
    }
  };
  socket.addEventListener("open", opened);
  socket.addEventListener("message", received);
  socket.addEventListener("close", dispose);
  arm("WebSocket connection", 15000);
  return dispose;
}

/** Also bounds async signing, which may precede fetch/WebSocket creation. */
export async function withConnectionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(message)); controller.abort(); }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
