import { describe, expect, it } from "vitest";
import { chatConnectionStatusAfterClose, MAX_CHAT_RECONNECT_ATTEMPTS } from "./chatConnectionStatus";

describe("chat connection lifecycle", () => {
  it("stops showing Connecting when the agent never became ready", () => {
    expect(chatConnectionStatusAfterClose("connecting", {
      intentional: false, wasReady: false, attempt: 0,
    })).toBe("failed");
  });

  it("shows Reconnecting only while another retry will actually be scheduled", () => {
    for (let attempt = 0; attempt < MAX_CHAT_RECONNECT_ATTEMPTS; attempt++) {
      expect(chatConnectionStatusAfterClose("connected", {
        intentional: false, wasReady: true, attempt,
      })).toBe("reconnecting");
    }
    expect(chatConnectionStatusAfterClose("reconnecting", {
      intentional: false, wasReady: true, attempt: MAX_CHAT_RECONNECT_ATTEMPTS,
    })).toBe("failed");
  });

  it("shows failure if an automatic retry cannot initialize the agent", () => {
    expect(chatConnectionStatusAfterClose("reconnecting", {
      intentional: false, wasReady: false, attempt: 1,
    })).toBe("failed");
  });

  it("shows Disconnected when the connection is deliberately released", () => {
    expect(chatConnectionStatusAfterClose("connected", {
      intentional: true, wasReady: true, attempt: 0,
    })).toBe("disconnected");
    expect(chatConnectionStatusAfterClose("connecting", {
      intentional: true, wasReady: false, attempt: 0,
    })).toBe("disconnected");
  });

  it("keeps a permanent startup error visible when retries are intentionally suppressed", () => {
    expect(chatConnectionStatusAfterClose("failed", {
      intentional: true, wasReady: false, attempt: 0,
    })).toBe("failed");
  });
});
