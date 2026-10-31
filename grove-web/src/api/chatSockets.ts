/** Ready session transports shared by chat surfaces and composers. */
const sockets = new Map<string, WebSocket>();
const latest = new Map<string, WebSocket>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function subscribeChatSockets(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getChatSocket(project: string, task: string, chat: string): WebSocket | null {
  return sockets.get(`/api/v1/projects/${project}/tasks/${task}/chats/${chat}/ws`) ?? null;
}
export function registerChatSocket(socket: WebSocket) {
  if (!socket.url) return;
  const path = decodeURIComponent(new URL(socket.url).pathname);
  latest.set(path, socket);
  sockets.delete(path); emit();
  const onMessage = (event: MessageEvent) => {
    if (latest.get(path) !== socket) return;
    let data: { type?: string };
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === "session_ready") { sockets.set(path, socket); emit(); }
    if (data.type === "session_ended" && sockets.get(path) === socket) { sockets.delete(path); emit(); }
  };
  const onClose = () => {
    socket.removeEventListener("message", onMessage);
    if (sockets.get(path) === socket) { sockets.delete(path); emit(); }
    if (latest.get(path) === socket) latest.delete(path);
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose, { once: true });
}

export function sendSessionInput(socket: WebSocket, input: { text: string; attachments: unknown[]; id: string; busy: boolean }, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN || signal.aborted) { reject(new Error("Session disconnected. Your draft is kept.")); return; }
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", message); socket.removeEventListener("close", closed); signal.removeEventListener("abort", closed); };
    const done = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
    const closed = () => done(new Error("Connection lost. Check the conversation before retrying; your draft is kept."));
    const message = (event: MessageEvent) => {
      let data: { type?: string; client_message_id?: string; message?: string };
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.client_message_id !== input.id) return;
      if (data.type === "input_accepted" || data.type === "user_message") done();
      else if (data.type === "input_rejected") done(new Error(data.message || "Message rejected. Your draft is kept."));
    };
    const timer = setTimeout(() => done(new Error("No confirmation received. Check the conversation before retrying; your draft is kept.")), 30000);
    socket.addEventListener("message", message);
    socket.addEventListener("close", closed);
    signal.addEventListener("abort", closed, { once: true });
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "buddy_input", client_message_id: input.id, text: input.text, attachments: input.attachments }) }));
    try { socket.send(JSON.stringify({ type: input.busy ? "queue_message" : "prompt", client_message_id: input.id, sent_at: Date.now(), text: input.text, attachments: input.attachments })); }
    catch (reason) { done(reason instanceof Error ? reason : new Error("Message could not be sent")); }
  });
}
