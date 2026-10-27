import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchChatConnection, withConnectionDeadline } from "./chatConnectionAttempt";

class Socket extends EventTarget {
  close = vi.fn(() => this.dispatchEvent(new Event("close")));
  receive(data: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}

describe("actual connection deadlines", () => {
  let socket: Socket;
  const fail = vi.fn();
  const phase = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); fail.mockClear(); phase.mockClear(); socket = new Socket();
    watchChatConnection(socket as unknown as WebSocket, fail, phase);
  });
  afterEach(() => vi.useRealTimers());

  it("fails a WebSocket that never opens", () => {
    vi.advanceTimersByTime(15000);
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("WebSocket connection"));
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it("does not let heartbeats hide an Agent that never becomes ready", () => {
    socket.dispatchEvent(new Event("open"));
    for (let i = 0; i < 6; i++) { socket.receive({ type: "heartbeat" }); vi.advanceTimersByTime(15000); }
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("Agent initialization"));
  });
  it("shows the real resume error even while transcript history is loading", () => {
    socket.dispatchEvent(new Event("open"));
    socket.receive({ type: "error", message: "Load session failed: Resource not found" });
    socket.receive({ type: "session_ended" });
    vi.advanceTimersByTime(200000);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith("Load session failed: Resource not found");
  });
  it("stops startup deadlines once session_ready arrives", () => {
    socket.dispatchEvent(new Event("open")); socket.receive({ type: "session_ready" });
    socket.receive({ type: "error", message: "a later prompt failed" });
    vi.advanceTimersByTime(200000);
    expect(fail).not.toHaveBeenCalled();
  });
  it("waits for human sign-in, then bounds the resumed initialization", () => {
    socket.dispatchEvent(new Event("open")); socket.receive({ type: "auth_required" });
    vi.advanceTimersByTime(600000); expect(fail).not.toHaveBeenCalled();
    socket.receive({ type: "auth_succeeded" }); vi.advanceTimersByTime(90000);
    expect(fail).toHaveBeenCalledOnce();
  });
  it("gives download its own deadline and updates startup progress", () => {
    socket.dispatchEvent(new Event("open")); socket.receive({ type: "connect_phase", phase: "downloading" });
    vi.advanceTimersByTime(120000); expect(fail).not.toHaveBeenCalled();
    socket.receive({ type: "connect_phase", phase: "session/load" });
    expect(phase).toHaveBeenLastCalledWith("session/load");
    vi.advanceTimersByTime(90000); expect(fail).toHaveBeenCalledWith(expect.stringContaining("session/load"));
  });
  it("cancels the old deadline when a socket is replaced", () => {
    socket.close(); vi.advanceTimersByTime(200000); expect(fail).not.toHaveBeenCalled();
  });
  it("bounds stalled HTTP/signing and aborts the underlying request", async () => {
    let requestSignal: AbortSignal | undefined;
    const pending = withConnectionDeadline((signal) => { requestSignal = signal; return new Promise(() => {}); }, 15000, "Reconnect stop timed out");
    const assertion = expect(pending).rejects.toThrow("Reconnect stop timed out");
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });
  it("cleans up a successful HTTP deadline", async () => {
    expect(await withConnectionDeadline(async () => "ok", 15000, "timeout")).toBe("ok");
    expect(vi.getTimerCount()).toBe(1); // only this test's socket watchdog
  });
});
