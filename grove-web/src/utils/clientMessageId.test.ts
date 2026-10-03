import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientMessageId } from "./clientMessageId";

afterEach(() => vi.unstubAllGlobals());

describe("client message ids", () => {
  it("generates UUIDs when randomUUID is unavailable on an HTTP LAN origin", () => {
    let next = 0;
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.set(Array.from({ length: bytes.length }, () => next++));
        return bytes;
      },
    });

    const first = createClientMessageId();
    const second = createClientMessageId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
