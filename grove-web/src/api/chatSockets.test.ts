import { describe, expect, it, vi } from "vitest";
import { getChatSocket, registerChatSocket, sendSessionInput } from "./chatSockets";

class Socket extends EventTarget {
  url = "ws://localhost/api/v1/projects/project/tasks/_local/chats/chat/ws";
  readyState = WebSocket.OPEN;
  send = vi.fn();
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  close() { this.dispatchEvent(new Event("close")); }
}
describe("shared session transport", () => {
  it("waits for readiness and ignores stale sockets after replacement", () => {
    const first = new Socket(); const next = new Socket();
    registerChatSocket(first as unknown as WebSocket);
    expect(getChatSocket("project", "_local", "chat")).toBeNull();
    first.receive({ type: "session_ready" });
    expect(getChatSocket("project", "_local", "chat")).toBe(first);
    registerChatSocket(next as unknown as WebSocket);
    first.receive({ type: "session_ready" });
    expect(getChatSocket("project", "_local", "chat")).toBeNull();
    next.receive({ type: "session_ready" }); first.close();
    expect(getChatSocket("project", "_local", "chat")).toBe(next);
    next.close();
    expect(getChatSocket("project", "_local", "chat")).toBeNull();
  });
  it("waits for matching acceptance and uses the queue when busy", async () => {
    const socket = new Socket();
    const send = sendSessionInput(socket as unknown as WebSocket, { text: "hello", attachments: [], id: "input", busy: true }, new AbortController().signal);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: "queue_message", text: "hello", client_message_id: "input" });
    socket.receive({ type: "input_accepted", client_message_id: "other" });
    socket.receive({ type: "input_accepted", client_message_id: "input" });
    await expect(send).resolves.toBeUndefined();
  });
  it("surfaces rejection and disconnection without retrying", async () => {
    const socket = new Socket();
    const send = sendSessionInput(socket as unknown as WebSocket, { text: "hello", attachments: [], id: "input", busy: false }, new AbortController().signal);
    socket.receive({ type: "input_rejected", client_message_id: "input", message: "Not allowed" });
    await expect(send).rejects.toThrow("Not allowed");
    const retry = sendSessionInput(socket as unknown as WebSocket, { text: "hello", attachments: [], id: "retry", busy: false }, new AbortController().signal);
    socket.close(); await expect(retry).rejects.toThrow("Connection lost");
    expect(socket.send).toHaveBeenCalledTimes(2);
  });
});
